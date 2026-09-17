const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/sync.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
const clone = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function createDesktop() {
  const workflow = { nodes: [{ id: 1, widgets_values: ['desktop value'] }] };
  const active = { path: 'saved.json', name: 'saved.json', isTemporary: false, isModified: true };
  const store = { activeWorkflow: active, openWorkflows: [active] };
  const requests = [];
  const timeouts = new Map();
  const intervals = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const queuedCommands = [
    { id: 'old-widget', node_id: '1', input: 'text', value: 'phone value' },
    { id: 'old-delete', node_id: '1', action: 'delete' },
  ];
  let timerId = 0;
  let extension;
  let conversions = 0;
  let graphMutations = 0;
  const mutation = () => { graphMutations += 1; };
  const node = {
    id: 1,
    widgets: [{ name: 'text', value: 'desktop value', callback: mutation }],
    onWidgetChanged: mutation,
    setDirtyCanvas: mutation,
  };
  const app = {
    extensionManager: { workflow: store },
    graph: {
      serialize: () => clone(workflow),
      getNodeById: () => node,
      remove: mutation,
      add: mutation,
      setDirtyCanvas: mutation,
    },
    graphToPrompt: async () => {
      conversions += 1;
      return {
        output: { '1': { class_type: 'ExampleNode', inputs: { text: workflow.nodes[0].widgets_values[0] } } },
        workflow: clone(workflow),
      };
    },
    registerExtension(value) { extension = value; },
  };
  const document = {
    visibilityState: 'visible',
    addEventListener(name, callback) { documentListeners.set(name, callback); },
  };
  const context = vm.createContext({
    app,
    api: { addEventListener(name, callback) { windowListeners.set(name, callback); } },
    t: (value) => value,
    document,
    console: { info() {}, warn() {}, debug() {} },
    window: {
      clearTimeout(id) { timeouts.delete(id); },
      setTimeout(callback, delay) { timeouts.set(++timerId, { callback, delay }); return timerId; },
      setInterval(callback, delay) { intervals.push({ callback, delay }); },
      addEventListener(name, callback) { windowListeners.set(name, callback); },
    },
    async fetch(url, options = {}) {
      requests.push({ url, ...options, payload: options.body ? JSON.parse(options.body) : null });
      const body = url.startsWith('/mobile/api/desktop/commands')
        ? { ok: true, commands: clone(queuedCommands) }
        : { ok: true, workflow: { id: 'saved-workflow', name: active.name } };
      return { ok: true, json: async () => body };
    },
  });
  vm.runInContext(source, context, { filename: 'web/sync.js' });
  return {
    workflow, active, store, requests, intervals, timeouts, document,
    documentListeners, windowListeners, node, context,
    get extension() { return extension; },
    get conversions() { return conversions; },
    get graphMutations() { return graphMutations; },
    async runTimeout() {
      assert.equal(timeouts.size, 1);
      const [id, scheduled] = [...timeouts.entries()][0];
      timeouts.delete(id);
      await scheduled.callback();
      await settle();
    },
    async tick() {
      for (const interval of intervals) await interval.callback();
      await settle();
    },
  };
}

const syncRequests = (desktop) => desktop.requests.filter((request) => request.url === '/mobile/api/workflows/sync');
const activeRequests = (desktop) => desktop.requests.filter((request) => request.url === '/mobile/api/workflows/active');

test('desktop never retrieves or applies queued mobile commands during any sync trigger', async () => {
  const desktop = createDesktop();
  const before = clone(desktop.workflow);
  await desktop.extension.setup();
  await desktop.extension.setup();
  assert.deepEqual(desktop.intervals.map((interval) => interval.delay), [15000]);
  assert.equal([...desktop.timeouts.values()][0].delay, 2500);
  await desktop.runTimeout();
  await desktop.tick();
  desktop.documentListeners.get('visibilitychange')();
  assert.equal([...desktop.timeouts.values()][0].delay, 800);
  await desktop.runTimeout();
  await desktop.extension.afterConfigureGraph();
  assert.equal([...desktop.timeouts.values()][0].delay, 1500);
  await desktop.runTimeout();
  await desktop.tick();

  assert.equal(desktop.requests.some((request) => request.url.includes('/desktop/commands')), false);
  assert.equal(desktop.context.__MTR_SYNC_RUNTIME.pollDesktopCommands, undefined);
  assert.equal(desktop.context.__MTR_SYNC_RUNTIME.applyDesktopCommand, undefined);
  assert.equal(desktop.graphMutations, 0);
  assert.equal(desktop.node.widgets[0].value, 'desktop value');
  assert.deepEqual(desktop.workflow, before);
  assert.equal(syncRequests(desktop).length, 2);
});

test('saved desktop workflow sync preserves snapshots, heartbeat, changes and source identity', async () => {
  const desktop = createDesktop();
  desktop.store.openWorkflows.push({ path: 'background.json' }, { path: 'draft.json', isTemporary: true });
  await desktop.extension.setup();
  await desktop.runTimeout();
  const initial = syncRequests(desktop)[0];
  assert.equal(initial.method, 'POST');
  assert.equal(initial.cache, 'no-store');
  assert.deepEqual(initial.payload, {
    name: 'saved', source: 'saved.json',
    prompt: { '1': { class_type: 'ExampleNode', inputs: { text: 'desktop value' } } },
    workflow: desktop.workflow,
  });
  assert.deepEqual(activeRequests(desktop).at(-1).payload, { sources: ['saved.json', 'background.json'] });
  await desktop.tick();
  assert.equal(desktop.conversions, 1);
  assert.equal(syncRequests(desktop).length, 1);
  assert.equal(activeRequests(desktop).length, 2);

  desktop.workflow.nodes[0].widgets_values[0] = 'desktop edit';
  await desktop.tick();
  assert.equal(syncRequests(desktop).at(-1).payload.prompt['1'].inputs.text, 'desktop edit');
  desktop.active.path = 'saved-copy.json';
  await desktop.tick();
  assert.equal(syncRequests(desktop).at(-1).payload.source, 'saved-copy.json');
  assert.equal(desktop.conversions, 3);

  desktop.document.visibilityState = 'hidden';
  const requestCount = desktop.requests.length;
  await desktop.tick();
  assert.equal(desktop.requests.length, requestCount);
  desktop.windowListeners.get('beforeunload')();
  assert.deepEqual(activeRequests(desktop).at(-1).payload, { sources: [] });
  assert.equal(activeRequests(desktop).at(-1).keepalive, true);
});

test('unsaved drafts stay excluded while a saved Untitled workflow still syncs', async () => {
  const desktop = createDesktop();
  desktop.active.isTemporary = true;
  desktop.store.openWorkflows.push({ path: 'background.json' });
  await desktop.extension.setup();
  await desktop.runTimeout();
  assert.equal(desktop.conversions, 0);
  assert.equal(syncRequests(desktop).length, 0);
  assert.deepEqual(activeRequests(desktop).at(-1).payload, { sources: ['background.json'] });

  desktop.active.path = 'Untitled.json';
  desktop.active.name = 'Untitled.json';
  desktop.active.isTemporary = false;
  await desktop.tick();
  assert.equal(syncRequests(desktop).length, 1);
  assert.equal(syncRequests(desktop)[0].payload.source, 'Untitled.json');
  assert.equal(syncRequests(desktop)[0].payload.name, 'Untitled');
});

test('phone reset requests a fresh matching source without editing the canvas', async () => {
  const desktop = createDesktop();
  await desktop.extension.setup();
  await desktop.runTimeout();
  const refresh = desktop.windowListeners.get('mtr_refresh_source');
  refresh({detail:{source:'other.json',request_id:'ignore'}});
  await settle();
  assert.equal(syncRequests(desktop).length,1);
  desktop.workflow.nodes[0].widgets_values[0] = 'fresh desktop source';
  refresh({detail:{source:'saved.json',request_id:'phone-reset'}});
  await settle();
  assert.equal(syncRequests(desktop).length,2);
  const payload = syncRequests(desktop).at(-1).payload;
  assert.equal(payload.refresh_request_id,'phone-reset');
  assert.equal(payload.prompt['1'].inputs.text,'fresh desktop source');
  assert.equal(desktop.graphMutations,0);
  assert.equal(desktop.requests.some(r=>r.url.includes('/desktop/commands')),false);
});

test('reset queued during desktop serialization is acknowledged after the ongoing sync', async () => {
  const desktop = createDesktop();
  let release;
  const gate = new Promise(resolve=>{ release=resolve; });
  const original = desktop.context.app.graphToPrompt;
  let first = true;
  desktop.context.app.graphToPrompt = async () => { if(first){first=false;await gate;} return original(); };
  await desktop.extension.setup();
  const running = desktop.runTimeout();
  await settle();
  desktop.windowListeners.get('mtr_refresh_source')({detail:{source:'saved.json',request_id:'queued-reset'}});
  release();
  await running;
  await settle();
  assert.equal(syncRequests(desktop).at(-1).payload.refresh_request_id,'queued-reset');
  assert.equal(desktop.graphMutations,0);
});
