const test = require('node:test');
const assert = require('node:assert/strict');
const { MobileProgressStore, MobileSingleFlight } = require('../mobile/progress-sync.js');

const node = (id, value, max, state = 'running', extra = {}) => ({
  node_id: id, display_node_id: id, value, max, state, ...extra,
});

test('progress_state picks a measured leaf and ignores finished nodes', () => {
  const store = new MobileProgressStore();
  assert.equal(store.acceptProgressState({prompt_id:'a', nodes:{
    parent: node('parent', 0, 1, 'running'),
    sampler: node('sampler', 4, 8, 'running', {parent_node_id:'parent'}),
    done: node('done', 8, 8, 'finished'),
  }}), true);
  assert.equal(store.get('a').percent, 50);
  assert.equal(store.get('a').nodeId, 'sampler');
});

test('preparation progress is visible as unknown, never a fake percentage', () => {
  const store = new MobileProgressStore();
  store.acceptProgressState({prompt_id:'a', nodes:{loader: node('loader', 0, 1)}});
  assert.equal(store.get('a').percent, null);
});

test('late events from a retired prompt cannot overwrite the active prompt', () => {
  const store = new MobileProgressStore();
  store.begin('a');
  store.progress({prompt_id:'a', node:'sampler', value:2, max:8});
  store.finish('a');
  store.begin('b');
  assert.equal(store.progress({prompt_id:'a', node:'sampler', value:8, max:8}), false);
  assert.equal(store.progress({prompt_id:'b', node:'sampler', value:1, max:4}), true);
  assert.equal(store.get('b').percent, 25);
});

test('stale HTTP snapshot cannot replace a newer websocket update', () => {
  const store = new MobileProgressStore();
  store.begin('a');
  const revision = store.revision;
  store.progress({prompt_id:'a', node:'sampler', value:7, max:8});
  assert.equal(store.applySnapshot({ok:true, prompt_id:'a', nodes:{sampler:node('sampler', 2, 8)}, active_job:{id:'a', status:'in_progress'}}, revision), false);
  assert.equal(store.get('a').percent, 87.5);
});

test('single flight runs one trailing urgent refresh after a slow request', async () => {
  let calls = 0;
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const flight = new MobileSingleFlight(async () => {
    calls += 1;
    if (calls === 1) await first;
  });
  const running = flight.run();
  flight.run(true);
  release();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});

test('idle snapshot clears active progress once and repeated idle is a no-op', () => {
  const store = new MobileProgressStore();
  store.begin('a');
  store.progress({prompt_id:'a', node:'sampler', value:1, max:4});
  const idleRevision = store.revision;
  assert.equal(store.applySnapshot({ok:true, active_job:null, nodes:{}}, idleRevision), true);
  assert.equal(store.activeId, '');
  assert.equal(store.get('a'), null);
  const repeatedRevision = store.revision;
  assert.equal(store.applySnapshot({ok:true, active_job:null, nodes:{}}, repeatedRevision), false);
  assert.equal(store.revision, repeatedRevision);
});

test('unknown-to-idle snapshot clears stale node UI', () => {
  const store = new MobileProgressStore();
  store.activeJob = {id:'unknown', status:'in_progress'};
  store.nodes.set('loader', {nodeId:'loader', value:0, max:0, measured:false});
  const revision = store.revision;
  assert.equal(store.applySnapshot({ok:true, active_job:null, nodes:{}}, revision), true);
  assert.equal(store.nodes.size, 0);
});
