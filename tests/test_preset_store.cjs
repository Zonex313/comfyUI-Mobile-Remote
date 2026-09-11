const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Model = require('../mobile/preset-catalog.js');
const Sync = require('../mobile/settings-sync.js');
const source = fs.readFileSync(path.join(__dirname, '../web/preset-store.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const context = vm.createContext({ MobilePresetCatalog: Model, AbortController, console });
vm.runInContext(source + '\nglobalThis.Store = CatalogStore;', context);
const Store = context.Store;
const clone = (v) => JSON.parse(JSON.stringify(v));
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
class Storage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
}
const LEGACY_KEY = 'comfy-mobile-remote.catalog-editor.v2';
const TAB_KEY = 'comfy-mobile-remote.catalog-editor.tab';
const PREFIX = 'comfy-mobile-remote.catalog-editor.v3.';
const journalKeys = (storage) => [...storage.data.keys()].filter((key) => key.startsWith(PREFIX));
function fixture(catalog = Model.empty()) {
  const clock = { now: 0, id: 0, timers: new Map() };
  const setTimeout = (fn, ms) => { const id = ++clock.id; clock.timers.set(id, { at: clock.now + ms, fn }); return id; };
  const clearTimeout = (id) => clock.timers.delete(id);
  const storage = new Storage();
  const server = { ok: true, revision: 1, saved_at: 0, exists: true, retry_after_ms: 0,
    values: { [Model.key]: JSON.stringify(catalog), [Model.legacyKey]: JSON.stringify({ enabled: true, slots: {} }) } };
  const posts = [];
  let intercept = null;
  const json = (status, body) => ({ status, ok: status === 200, json: async () => clone(body) });
  const accept = (body) => {
    if (body.base_revision !== server.revision) return json(409, { ...server, ok: false });
    Object.assign(server.values, body.changes); server.revision++; return json(200, server);
  };
  const fetch = async (_url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body) posts.push(body);
    if (intercept) { const result = intercept(body); if (result) return result; }
    return body ? accept(body) : json(200, server);
  };
  const tick = async (ms) => {
    const end = clock.now + ms;
    for (let loop = 0; loop < 200; loop++) {
      await settle();
      const next = [...clock.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { clock.now = end; await settle(); return; }
      clock.now = next[1].at; clock.timers.delete(next[0]); next[1].fn();
    }
    throw new Error('timer storm');
  };
  const options = { fetch, storage, clock: () => clock.now, setTimeout, clearTimeout, locks: null };
  return { options, make: () => new Store(options), makePhone: () => new Sync(options), posts, clock, server, tick, accept, json,
    intercept: (fn) => { intercept = fn; }, read: () => Model.fromValues(server.values) };
}
const skip = (store, ...tags) => store.change((c) => { if (tags.length) c.skipped['hair.style'] = tags; else delete c.skipped['hair.style']; });

test('slow save acknowledges only transmitted snapshot and keeps newer edits', async () => {
  const f = fixture(), s = f.make(); await s.load(); let complete;
  f.intercept((body) => body ? new Promise((resolve) => { complete = () => resolve(f.accept(body)); }) : null);
  skip(s, 'A'); await f.tick(400); skip(s, 'A', 'B'); complete(); await settle();
  assert.deepEqual(clone(s.snapshot()).catalog.skipped['hair.style'], ['A', 'B']); assert.equal(s.dirty, true);
  f.intercept(null); await f.tick(400); assert.deepEqual(f.read().skipped['hair.style'], ['A', 'B']);
  assert.equal(s.dirty, false); s.destroy();
});
test('undo made during POST is saved rather than acknowledged away', async () => {
  const f = fixture(), s = f.make(); await s.load(); let complete;
  f.intercept((body) => body ? new Promise((resolve) => { complete = () => resolve(f.accept(body)); }) : null);
  skip(s, 'A'); await f.tick(400); skip(s); complete(); await settle();
  f.intercept(null); await f.tick(400); assert.equal(f.read().skipped['hair.style'], undefined); s.destroy();
});
test('409 cancellation of final skipped entry remains deleted', async () => {
  const catalog = Model.empty(); catalog.skipped['hair.style'] = ['A'];
  const f = fixture(catalog), s = f.make(); await s.load(); skip(s);
  f.server.revision++; f.server.values['comfy-mobile-remote.repeatCount'] = '2'; await f.tick(400);
  assert.equal(f.read().skipped['hair.style'], undefined); assert.equal(f.posts.length, 2); s.destroy();
});
test('409 preserves concurrent tags in the same slot and ongoing local edit', async () => {
  const f = fixture(), s = f.make(); await s.load();
  s.change((c) => { c.custom['hair.style'] = ['A']; });
  const remote = Model.empty(); remote.custom['hair.style'] = ['B'];
  f.server.values[Model.key] = JSON.stringify(remote); f.server.revision++;
  await f.tick(400); assert.deepEqual(new Set(f.read().custom['hair.style']), new Set(['A', 'B'])); s.destroy();
});
test('429 new edits share one deadline and one retry', async () => {
  const f = fixture(), s = f.make(); await s.load(); let blocked = true;
  f.intercept((body) => body && blocked ? f.json(429, { ...f.server, ok: false, retry_after_ms: 60000 }) : null);
  skip(s, 'A'); await f.tick(400);
  for (let i = 0; i < 10; i++) { skip(s, 'A', String(i)); await f.tick(500); }
  assert.equal(f.posts.length, 1);
  assert.ok([...f.clock.timers.values()].some((timer) => timer.at >= f.clock.now + 50000));
  blocked = false; await f.tick(55000); assert.equal(f.posts.length, 2);
  assert.deepEqual(f.read().skipped['hair.style'], ['A', '9']); s.destroy();
});
test('load while dirty rebases without overwriting local state', async () => {
  const f = fixture(), s = f.make(); await s.load(); skip(s, 'A'); await s.load();
  assert.deepEqual(clone(s.snapshot()).catalog.skipped['hair.style'], ['A']); await f.tick(400);
  assert.deepEqual(f.read().skipped['hair.style'], ['A']); s.destroy();
});
test('journal survives destroy and reload during save cooldown', async () => {
  const f = fixture(), s = f.make(); await s.load(); skip(s, 'A');
  f.intercept((body) => body ? f.json(429, { ...f.server, ok: false, retry_after_ms: 60000 }) : null);
  await f.tick(400); s.destroy(); assert.equal(f.clock.timers.size, 0);
  const next = f.make(); await next.load(); assert.equal(next.dirty, true);
  f.intercept(null); await f.tick(59999); assert.equal(f.posts.length, 1);
  await f.tick(1); assert.equal(f.posts.length, 2); assert.deepEqual(f.read().skipped['hair.style'], ['A']); next.destroy();
});
test('network failure schedules one retry and keeps edits', async () => {
  const f = fixture(), s = f.make(); await s.load();
  f.intercept((body) => body ? Promise.reject(new Error('offline')) : null);
  skip(s, 'A'); await f.tick(400); assert.equal(s.dirty, true);
  f.intercept(null); await f.tick(5000); assert.deepEqual(f.read().skipped['hair.style'], ['A']); s.destroy();
});
test('tag editing never writes phone draft or preset fields', async () => {
  const f = fixture(), s = f.make(); await s.load(); const before = f.server.values[Model.legacyKey];
  skip(s, 'A'); await f.tick(400);
  assert.deepEqual(Object.keys(f.posts[0].changes), [Model.key]); assert.equal(f.server.values[Model.legacyKey], before); s.destroy();
});
test('phone catalog conflict merges tag increments with desktop changes', async () => {
  const f = fixture(), s = f.makePhone(); await s.init();
  const mine = Model.empty(); mine.custom['hair.style'] = ['phone']; s.setItem(Model.key, JSON.stringify(mine));
  const remote = Model.empty(); remote.custom['hair.style'] = ['desktop']; f.server.values[Model.key] = JSON.stringify(remote); f.server.revision++;
  await f.tick(60000); assert.deepEqual(new Set(f.read().custom['hair.style']), new Set(['phone', 'desktop'])); s.destroy();
});
test('phone cancellation survives conflict with unrelated desktop preference', async () => {
  const base = Model.empty(); base.skipped['hair.style'] = ['A']; const f = fixture(base), s = f.makePhone(); await s.init();
  s.setItem(Model.key, JSON.stringify(Model.empty())); f.server.revision++;
  await f.tick(60000); assert.equal(f.read().skipped['hair.style'], undefined); s.destroy();
});
test('repeated 409 while a newer edit arrives keeps local and remote increments', async () => {
  const f = fixture(), s = f.make(); await s.load(); let finish;
  f.intercept((body) => body ? new Promise((resolve) => { finish = () => {
    const remote = Model.empty(); remote.custom['hair.style'] = ['remote'];
    f.server.values[Model.key] = JSON.stringify(remote); f.server.revision++;
    f.intercept(null); resolve(f.json(409, { ...f.server, ok: false }));
  }; }) : null);
  s.change((c) => { c.custom['hair.style'] = ['A']; }); await f.tick(400);
  s.change((c) => { c.custom['hair.style'].push('B'); }); finish(); await settle();
  assert.deepEqual(new Set(f.read().custom['hair.style']), new Set(['A', 'B', 'remote'])); s.destroy();
});
test('successful slow read cannot discard edits made during its GET', async () => {
  const f = fixture(), s = f.make(); await s.load(); let finish;
  f.intercept((body) => !body ? new Promise((resolve) => { finish = () => resolve(f.json(200, f.server)); }) : null);
  const reading = s.load(); skip(s, 'late'); finish(); await reading;
  f.intercept(null); await f.tick(400); assert.deepEqual(f.read().skipped['hair.style'], ['late']); s.destroy();
});
test('malformed authoritative catalog is rejected, not replaced with legacy values', async () => {
  const f = fixture(), s = f.make(); f.server.values[Model.key] = '{broken';
  await assert.rejects(() => s.load()); assert.equal(s.known, false);
  assert.throws(() => skip(s, 'A')); assert.equal(f.posts.length, 0); s.destroy();
});
test('defaults to localStorage rather than a shared session blob', () => {
  const local = new Storage();
  context.localStorage = local;
  const f = fixture();
  const s = new Store({ fetch: f.options.fetch, clock: f.options.clock,
    setTimeout: f.options.setTimeout, clearTimeout: f.options.clearTimeout });
  assert.equal(s.storage, local);
  assert.notEqual(s.session, local);
  s.destroy();
  delete context.localStorage;
});
test('closed tab journal is restored in a new session from localStorage', async () => {
  const f = fixture();
  const local = new Storage();
  const session = new Storage();
  const s = new Store({ ...f.options, storage: local, session });
  await s.load(); skip(s, 'A'); s.destroy();
  session.data.clear();
  const next = new Store({ ...f.options, storage: local, session: new Storage() });
  assert.equal(next.dirty, true);
  assert.deepEqual(clone(next.snapshot()).catalog.skipped['hair.style'], ['A']);
  assert.equal(journalKeys(local).length, 1);
  assert.equal(journalKeys(local)[0], PREFIX + next.journalId);
  next.destroy();
});
test('a live tab journal is not cleared or adopted by another tab', async () => {
  const f = fixture();
  const local = new Storage();
  const a = new Store({ ...f.options, storage: local, session: new Storage() });
  const b = new Store({ ...f.options, storage: local, session: new Storage() });
  await a.load(); await b.load();
  skip(a, 'A');
  const aKey = PREFIX + a.journalId;
  assert.equal(local.getItem(aKey) != null, true);
  skip(b, 'B');
  b.destroy();
  assert.equal(local.getItem(aKey) != null, true);
  assert.deepEqual(clone(a.snapshot()).catalog.skipped['hair.style'], ['A']);
  const c = new Store({ ...f.options, storage: local, session: new Storage() });
  assert.deepEqual(clone(a.snapshot()).catalog.skipped['hair.style'], ['A']);
  assert.deepEqual(clone(c.snapshot()).catalog.skipped['hair.style'], ['B']);
  assert.equal(local.getItem(aKey) != null, true);
  a.destroy(); c.destroy();
});
test('refresh reclaims the same tab journal id from sessionStorage', async () => {
  const f = fixture();
  const local = new Storage();
  const session = new Storage();
  const s = new Store({ ...f.options, storage: local, session });
  await s.load(); skip(s, 'A');
  const id = s.journalId;
  s.destroy();
  assert.equal(session.getItem(TAB_KEY), id);
  const refreshed = new Store({ ...f.options, storage: local, session });
  assert.equal(refreshed.journalId, id);
  assert.deepEqual(clone(refreshed.snapshot()).catalog.skipped['hair.style'], ['A']);
  refreshed.destroy();
});
test('new session merges orphaned journals from multiple closed tabs', async () => {
  const f = fixture();
  const local = new Storage();
  const a = new Store({ ...f.options, storage: local, session: new Storage() });
  const b = new Store({ ...f.options, storage: local, session: new Storage() });
  await a.load(); await b.load();
  skip(a, 'A'); skip(b, 'B');
  a.destroy(); b.destroy();
  const next = new Store({ ...f.options, storage: local, session: new Storage() });
  assert.deepEqual(new Set(clone(next.snapshot()).catalog.skipped['hair.style']), new Set(['A', 'B']));
  assert.equal(journalKeys(local).length, 1);
  next.destroy();
});
test('migrates legacy v2 journals from sessionStorage and localStorage', () => {
  const catalog = Model.empty(); catalog.skipped['hair.style'] = ['legacy-session'];
  const payload = { schema: 1, base: Model.empty(), value: catalog, revision: 1, retryUntil: 0 };
  const f = fixture();
  const session = new Storage();
  const local = new Storage();
  session.setItem(LEGACY_KEY, JSON.stringify(payload));
  const fromSession = new Store({ ...f.options, storage: local, session });
  assert.deepEqual(clone(fromSession.snapshot()).catalog.skipped['hair.style'], ['legacy-session']);
  assert.equal(session.getItem(LEGACY_KEY), null);
  assert.equal(local.getItem(LEGACY_KEY), null);
  fromSession.destroy();

  const other = Model.empty(); other.skipped['hair.style'] = ['legacy-local'];
  const localOnly = new Storage();
  localOnly.setItem(LEGACY_KEY, JSON.stringify({ schema: 1, base: Model.empty(), value: other, revision: 2, retryUntil: 0 }));
  const fromLocal = new Store({ ...f.options, storage: localOnly, session: new Storage() });
  assert.deepEqual(clone(fromLocal.snapshot()).catalog.skipped['hair.style'], ['legacy-local']);
  assert.equal(localOnly.getItem(LEGACY_KEY), null);
  fromLocal.destroy();
});
test('retry clears blocked validation errors and posts the latest snapshot', async () => {
  const f = fixture(), s = f.make(); await s.load();
  f.intercept((body) => body ? f.json(400, { error: 'bad catalog' }) : null);
  skip(s, 'A'); await f.tick(400);
  assert.equal(s.blocked, true);
  assert.equal(f.posts.length, 1);
  f.intercept(null);
  await s.retry();
  assert.equal(s.blocked, false);
  assert.deepEqual(f.read().skipped['hair.style'], ['A']);
  s.destroy();
});
