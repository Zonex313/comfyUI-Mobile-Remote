const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../mobile/settings-sync.js');
const P = 'comfy-mobile-remote.';
const MODEL = P + 'draft.0123456789abcdefabcd';
const KEY = P + 'repeatCount';
const MINUTE = 60000;
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Storage {
  constructor(values = {}) { this.data = new Map(Object.entries(values)); }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
}
function fixture({values = {}, exists = true, storage = new Storage(), now = 0} = {}) {
  const clock = { now, id: 0, timers: new Map() };
  const server = { ok:true, revision:exists ? 1 : 0, saved_at:exists ? 500 : 0, exists, retry_after_ms:0, values:{...values} };
  const requests = [], statuses = [];
  let intercept = null;
  const setTimeout = (fn, ms) => { const id = ++clock.id; clock.timers.set(id, {time:clock.now+ms, fn}); return id; };
  const clearTimeout = id => clock.timers.delete(id);
  const json = (status, body) => ({status, ok:status>=200&&status<300, json:async()=>structuredClone(body)});
  const fetch = async (_url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({time:clock.now, method:options.method, body});
    if (intercept) { const override = intercept(body, options, json); if (override) return override; }
    if (!body) return json(200, server);
    if (body.base_revision !== server.revision) return json(409, {...server, ok:false, conflict:true});
    Object.entries(body.changes).forEach(([k,v])=>{ if(v===null) delete server.values[k]; else server.values[k]=v; });
    server.revision++; server.saved_at=clock.now; server.exists=true;
    return json(200, server);
  };
  const make = () => new Sync({storage, fetch, clock:()=>clock.now, setTimeout, clearTimeout, locks:null, onStatus:s=>statuses.push(s)});
  const tick = async milliseconds => {
    const until = clock.now + milliseconds;
    let loops=0;
    while (true) {
      await settle();
      const next = [...clock.timers].filter(([,t])=>t.time<=until).sort((a,b)=>a[1].time-b[1].time)[0];
      if (!next) break;
      if (++loops>500) throw Error('timer storm');
      clock.now=next[1].time; clock.timers.delete(next[0]); next[1].fn();
    }
    clock.now=until; await settle();
  };
  return {clock,server,requests,statuses,storage,make,tick,json,setIntercept:f=>{intercept=f;},posts:()=>requests.filter(r=>r.body)};
}

test('unchanged pages never upload; first edit after long idle waits a fresh minute', async()=>{
  const f=fixture({values:{[KEY]:'1'}}), s=f.make(); await s.init();
  await f.tick(10*MINUTE); assert.equal(f.posts().length,0);
  s.setItem(KEY,'10'); await f.tick(MINUTE-1); assert.equal(f.posts().length,0);
  await f.tick(1); assert.equal(f.posts().length,1); assert.equal(f.server.values[KEY],'10');
  await f.tick(20*MINUTE); assert.equal(f.posts().length,1);
  s.setItem(KEY,'2'); await f.tick(MINUTE-1); assert.equal(f.posts().length,1);
  await f.tick(1); assert.equal(f.posts().length,2); s.destroy();
});
test('ten quick edits coalesce without resetting the first-edit deadline',async()=>{
  const f=fixture(),s=f.make();await s.init();
  for(let i=1;i<=10;i++){s.setItem(KEY,String(i));await f.tick(200);}
  await f.tick(57999);assert.equal(f.posts().length,0);
  await f.tick(1);assert.equal(f.posts().length,1);assert.deepEqual(f.posts()[0].body.changes,{[KEY]:'10'});s.destroy();
});
test('batch spanning deadline waits for end and uploads final state once',async()=>{
  const f=fixture(),s=f.make();await s.init();s.beginBatch();s.setItem(KEY,'1');
  await f.tick(65000);s.setItem(KEY,'10');assert.equal(f.posts().length,0);
  s.endBatch();await f.tick(0);assert.equal(f.posts().length,1);assert.equal(f.server.values[KEY],'10');s.destroy();
});
test('failed upload retries at least one minute later and retains latest edits',async()=>{
  const f=fixture(),s=f.make();await s.init();let fail=true;
  f.setIntercept(body=>body&&fail?Promise.reject(Error('offline')):null);
  s.setItem(KEY,'2');await f.tick(MINUTE);assert.equal(f.posts().length,1);assert.equal(s.dirty,true);
  s.setItem(KEY,'3');fail=false;await f.tick(MINUTE-1);assert.equal(f.posts().length,1);
  await f.tick(1);assert.equal(f.posts().length,2);assert.equal(f.server.values[KEY],'3');s.destroy();
});
test('reload restores pending state and does not bypass the upload interval',async()=>{
  const f=fixture(),s=f.make();await s.init();s.setItem(KEY,'7');await f.tick(25000);s.destroy();
  const second=f.make();await second.init();assert.equal(second.getItem(KEY),'7');
  await f.tick(34999);assert.equal(f.posts().length,0);await f.tick(1);assert.equal(f.posts().length,1);second.destroy();
});
test('server wins over stale origin-local model, preset and workflow caches',async()=>{
  const key=P+'preset',wf=P+'workflow';
  const remote=JSON.stringify({enabled:true,slots:{'hair.color':{value:'黑色',locked:true,ignored:false}},custom:{},freeText:'',extraText:''});
  const f=fixture({values:{[MODEL]:'{"model":"new.safetensors"}',[key]:remote,[wf]:'0123456789abcdefabcd'},
    storage:new Storage({[MODEL]:'{"model":"old.safetensors"}',[key]:'{"enabled":false}'})});
  const s=f.make();await s.init();assert.equal(s.getItem(key),remote);assert.equal(s.getItem(MODEL),f.server.values[MODEL]);
  await f.tick(2*MINUTE);assert.equal(f.posts().length,0);s.destroy();
});
test('first migration preserves legacy preferences but waits a minute to upload',async()=>{
  const f=fixture({exists:false,storage:new Storage({[KEY]:'10',[P+'client-id']:'ignore-me'})}),s=f.make();await s.init();
  assert.equal(s.getItem(KEY),'10');await f.tick(MINUTE-1);assert.equal(f.posts().length,0);
  await f.tick(1);assert.deepEqual(f.posts()[0].body.changes,{[KEY]:'10'});s.destroy();
});
test('overlapping remote change keeps this page and retries against the latest revision',async()=>{
  const f=fixture({values:{[KEY]:'1'}}),s=f.make();await s.init();s.setItem(KEY,'2');
  f.server.revision++;f.server.values[KEY]='3';await f.tick(MINUTE);
  assert.equal(f.posts().length,2);assert.equal(f.server.values[KEY],'2');
  assert.notEqual(f.statuses.at(-1).state,'conflict');s.destroy();
  const restored=f.make();await restored.init();
  assert.notEqual(f.statuses.at(-1).state,'conflict');
  assert.equal(restored.getItem(KEY),'2');restored.destroy();
});
test('unrelated remote keys rebase under local pending without a conflict banner',async()=>{
  const other=P+'historyCols';
  const f=fixture({values:{[KEY]:'1',[other]:'2'}}),s=f.make();await s.init();s.setItem(KEY,'10');
  f.server.revision++;f.server.values[other]='3';await f.tick(MINUTE);
  assert.equal(f.posts().length,2);assert.equal(f.server.values[KEY],'10');assert.equal(f.server.values[other],'3');
  assert.notEqual(f.statuses.at(-1).state,'conflict');s.destroy();
});
test('cached conflict is ignored when the live server can be merged',async()=>{
  const f=fixture({values:{[KEY]:'3'}});
  f.storage.setItem('comfy-mobile-remote.settings-cache', JSON.stringify({
    revision:1,savedAt:1,exists:true,values:{[KEY]:'1'},pending:{[KEY]:'3'},firstDirty:0,known:true,
    conflict:{ok:true,revision:2,saved_at:2,exists:true,values:{[KEY]:'3'}},
  }));
  const s=f.make();await s.init();
  assert.notEqual(f.statuses.at(-1).state,'conflict');
  assert.equal(s.getItem(KEY),'3');assert.equal(s.dirty,false);s.destroy();
});
test('429 obeys server wait and never loops requests',async()=>{
  const f=fixture(),s=f.make();await s.init();let busy=true;
  f.setIntercept((body,_opt,json)=>body&&busy?json(429,{...f.server,ok:false,retry_after_ms:90000}):null);
  s.setItem(KEY,'4');await f.tick(MINUTE);busy=false;await f.tick(89999);assert.equal(f.posts().length,1);
  await f.tick(1);assert.equal(f.posts().length,2);s.destroy();
});
test('edits during an upload are not acknowledged by its older response',async()=>{
  const f=fixture({values:{[KEY]:'1'}}),s=f.make();await s.init();let finish;
  f.setIntercept((body,_opts,json)=>body?new Promise(resolve=>{finish=()=>{f.server.values[KEY]=body.changes[KEY];f.server.revision++;f.server.saved_at=f.clock.now;resolve(json(200,f.server));};}):null);
  s.setItem(KEY,'2');await f.tick(MINUTE);await f.tick(1000);s.setItem(KEY,'1');finish();await settle();
  assert.equal(s.getItem(KEY),'1');assert.equal(s.dirty,true);f.setIntercept(null);
  await f.tick(MINUTE-1);assert.equal(f.posts().length,1);await f.tick(1);assert.equal(f.posts().length,2);assert.equal(f.server.values[KEY],'1');s.destroy();
});
test('offline initialization recovers server revision before the first POST',async()=>{
  const f=fixture({exists:false}),s=f.make();let offline=true;f.setIntercept(()=>offline?Promise.reject(Error('offline')):null);
  await s.init();s.setItem(KEY,'9');await f.tick(30000);offline=false;await f.tick(30000);
  assert.equal(f.posts().length,1);assert.equal(f.server.values[KEY],'9');s.destroy();
});
test('multi-model preference keys are stored as plain strings',async()=>{
  const f=fixture(),s=f.make();await s.init();
  const models=JSON.stringify({'0123456789abcdefabcd':['a.safetensors','b.safetensors']});
  s.setItem(P+'multiModel','1');s.setItem(P+'fixedSeed','1');s.setItem(P+'multiModels',models);
  await f.tick(MINUTE);
  assert.equal(f.server.values[P+'multiModel'],'1');
  assert.equal(f.server.values[P+'fixedSeed'],'1');
  assert.equal(f.server.values[P+'multiModels'],models);
  s.destroy();
});
test('refresh reads shared values without creating any upload',async()=>{
  const f=fixture({values:{[KEY]:'1'}}),s=f.make();await s.init();f.server.revision++;f.server.values[KEY]='5';
  assert.equal(await s.refresh(),true);assert.equal(s.getItem(KEY),'5');await f.tick(5*MINUTE);assert.equal(f.posts().length,0);s.destroy();
});
test('reverted edits cause no upload; second origin gets last committed settings',async()=>{
  const f=fixture({values:{[KEY]:'1'}}),s=f.make();await s.init();s.setItem(KEY,'2');s.setItem(KEY,'1');
  await f.tick(2*MINUTE);assert.equal(f.posts().length,0);s.setItem(KEY,'6');await f.tick(MINUTE);
  const fresh=fixture({values:f.server.values,storage:new Storage()});const second=fresh.make();await second.init();
  assert.equal(second.getItem(KEY),'6');assert.equal(second.dirty,false);s.destroy();second.destroy();
});
const CATALOG_KEY = P + 'presetCatalog';
test('409 rebases pending catalog with remote tags and uploads the union',async()=>{
  const base = JSON.stringify({custom:{},removed:{},removedCustom:{},skipped:{},mutex:[],singletons:[],skipCategories:[]});
  const f = fixture({values:{[CATALOG_KEY]: base}}), s = f.make(); await s.init();
  const mine = JSON.stringify({...JSON.parse(base), custom:{'body.tag':['phone']}});
  s.setItem(CATALOG_KEY, mine);
  const remoteCatalog = JSON.stringify({...JSON.parse(base), custom:{'body.tag':['desktop']}});
  f.server.values[CATALOG_KEY] = remoteCatalog; f.server.revision++;
  await f.tick(MINUTE);
  const uploads = f.posts().filter((post) => post.body.changes[CATALOG_KEY] !== undefined);
  assert.ok(uploads.length >= 1);
  const uploaded = JSON.parse(uploads.at(-1).body.changes[CATALOG_KEY]);
  assert.deepEqual(new Set(uploaded.custom['body.tag']), new Set(['phone','desktop']));
  s.destroy();
});
test('corrupt pending catalog is dropped without blocking other settings uploads',async()=>{
  const f = fixture(), s = f.make();
  f.storage.setItem('comfy-mobile-remote.settings-cache', JSON.stringify({
    revision:0,savedAt:0,exists:false,values:{},pending:{[CATALOG_KEY]:'{broken'},
    firstDirty:0,known:true,
  }));
  await s.init();
  s.setItem(KEY,'7');
  await f.tick(MINUTE);
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0].body.changes[KEY], '7');
  assert.equal(f.posts()[0].body.changes[CATALOG_KEY], undefined);
  assert.equal(f.server.values[KEY], '7');
  s.destroy();
});
test('repaired remote catalog clears the invalid flag and merges both sides',async()=>{
  const empty = {custom:{},removed:{},removedCustom:{},skipped:{},mutex:[],singletons:[],skipCategories:[]};
  const mine = JSON.stringify({...empty, custom:{'body.tag':['phone']}});
  const f = fixture({values:{[CATALOG_KEY]:'{broken',[KEY]:'1'}}), s = f.make();
  await s.init();
  assert.equal(s.serverCatalogInvalid, true);
  s.setItem(CATALOG_KEY, mine);
  f.server.values[CATALOG_KEY] = JSON.stringify({...empty, custom:{'body.tag':['desktop']}});
  f.server.revision++;
  await f.tick(MINUTE);
  assert.equal(s.serverCatalogInvalid, false);
  const uploaded = JSON.parse(f.posts().at(-1).body.changes[CATALOG_KEY]);
  assert.deepEqual(new Set(uploaded.custom['body.tag']), new Set(['phone','desktop']));
  s.destroy();
});
test('refresh strips a corrupt remote catalog instead of adopting it',async()=>{
  const empty = {custom:{},removed:{},removedCustom:{},skipped:{},mutex:[],singletons:[],skipCategories:[]};
  const f = fixture({values:{[CATALOG_KEY]: JSON.stringify(empty)}}), s = f.make();
  await s.init();
  f.server.values[CATALOG_KEY] = '{broken';
  f.server.revision++;
  await s.refresh();
  assert.equal(s.base[CATALOG_KEY], undefined);
  assert.equal(s.serverCatalogInvalid, true);
  s.destroy();
});
test('corrupt remote catalog keeps local pending catalog and still uploads other keys',async()=>{
  const empty = {custom:{},removed:{},removedCustom:{},skipped:{},mutex:[],singletons:[],skipCategories:[]};
  const base = JSON.stringify(empty);
  const mine = JSON.stringify({...empty, custom:{'body.tag':['phone']}});
  const f = fixture({values:{[CATALOG_KEY]: base, [KEY]:'1'}}), s = f.make();
  await s.init();
  s.setItem(CATALOG_KEY, mine);
  s.setItem(KEY, '8');
  f.server.values[CATALOG_KEY] = '{broken';
  f.server.revision++;
  await f.tick(MINUTE);
  assert.equal(s.getItem(CATALOG_KEY), mine);
  assert.equal(s.serverCatalogInvalid, true);
  const last = f.posts().at(-1);
  assert.equal(last.body.changes[KEY], '8');
  assert.equal(JSON.parse(last.body.changes[CATALOG_KEY]).custom['body.tag'][0], 'phone');
  s.destroy();
});
