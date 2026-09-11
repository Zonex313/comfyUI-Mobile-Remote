const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const MobilePresetCatalog = require('../mobile/preset-catalog.js');

class Storage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

class Settings {
  constructor(storage) { this.storage = storage; this.known = true; this.serverCatalogInvalid = false; }
  getItem(key) { return this.storage.getItem(key); }
  setItem(key, value) { this.storage.setItem(key, value); }
}

function makeDocument() {
  return {
    getElementById: () => null,
    createElement: () => ({
      className: '', innerHTML: '', append() {}, remove() {},
      classList: { add() {}, remove() {}, toggle() {} },
    }),
  };
}

function loadApp(storage = new Storage()) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'app.js'), 'utf8');
  const marker = '\n  start();\n})();';
  assert.ok(source.includes(marker), 'app.js start marker must remain stable');
  const instrumented = source.replace(marker, `
    return {
      state,
      phoneSettings,
      loadPresetState,
      applyCatalogFromSettings,
      savePresetState,
      savePresetCatalog,
      activeSlotValues,
      randomizePresetSlots,
      randomSlotPool,
      slotPool,
      skippedCategoryIds,
      composePresetPrompt,
      collectPresetConflicts,
      canSelectPresetTag,
      presetSubmissionHasConflicts,
      restorePresetSnapshot,
      removePresetCustomTag,
      presetTagStatus,
    };
})();`);
  const context = {
    console,
    document: makeDocument(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => { throw new Error('network is not used by rules tests'); },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { origin: 'http://test', protocol: 'http:', host: 'test' },
    localStorage: storage,
    crypto: { randomUUID: () => 'test-client' },
    MobilePresetCatalog,
    window: {
      MobileProgressStore: class {},
      MobileSingleFlight: class { constructor() {} },
      MobileSettingsSync: class {
        constructor() { return new Settings(storage); }
      },
    },
  };
  context.window.MobilePresetCatalog = MobilePresetCatalog;
  vm.createContext(context);
  const api = vm.runInContext(instrumented, context, { filename: 'mobile/app.js' });
  return { api, storage };
}

function setup(api, categories, rules = {}, catalog = MobilePresetCatalog.empty(), slots = {}) {
  api.state.presetCatalog = categories;
  api.state.presetRules = rules;
  api.state.presetState = {
    slots: structuredClone(slots),
    custom: structuredClone(catalog.custom || {}),
    freeText: '',
    extraText: '',
    catalog: structuredClone(catalog),
  };
  api.state.presetEnabled = true;
}

test('conflicting locked presets block tag submission but never block free-text mode', () => {
  const { api } = loadApp();
  const categories = [category('a', [slot('tag', ['A'])]), category('b', [slot('tag', ['B'])])];
  setup(api, categories, { mutex: [['A', 'B']] }, MobilePresetCatalog.empty(), {
    'a.tag': { value: 'A', locked: true },
    'b.tag': { value: 'B', locked: true },
  });
  assert.equal(api.presetSubmissionHasConflicts(), true);
  api.state.presetEnabled = false;
  assert.equal(api.presetSubmissionHasConflicts(), false);
});

const slot = (id, pool) => ({ id, label: id, pool });
const category = (id, slots) => ({ id, label: id, slots });

 test('skipped tags stay in prompt but leave the random pool', () => {
  const { api } = loadApp();
  const categories = [category('body', [slot('tag', ['keep', 'skip-me'])])];
  const catalog = MobilePresetCatalog.normalize({ skipped: { 'body.tag': ['skip-me'] } });
  setup(api, categories, {}, catalog, { 'body.tag': { value: 'skip-me' } });
  assert.deepEqual(Array.from(api.randomSlotPool('body', categories[0].slots[0])), ['keep']);
  assert.deepEqual(JSON.parse(JSON.stringify(api.activeSlotValues(categories[0]))), { tag: 'skip-me' });
  assert.equal(api.composePresetPrompt(), 'skip-me');
});

test('category skip resolves by category priority without hidden-category trigger leakage', () => {
  const { api } = loadApp();
  const categories = [
    category('A', [slot('tag', ['A-trigger'])]),
    category('B', [slot('tag', ['B-trigger'])]),
    category('C', [slot('tag', ['C-visible'])]),
  ];
  const rules = { skipCategories: [
    { whenAny: ['A-trigger'], skip: ['B'] },
    { whenAny: ['B-trigger'], skip: ['C'] },
  ] };
  setup(api, categories, rules, MobilePresetCatalog.empty(), {
    'A.tag': { value: 'A-trigger' },
    'B.tag': { value: 'B-trigger' },
    'C.tag': { value: 'C-visible' },
  });
  assert.deepEqual([...api.skippedCategoryIds()], ['B']);
  assert.equal(api.composePresetPrompt(), 'A-trigger, C-visible');
});

test('skip dependency topology suppresses a hidden source without leaking its downstream rule', () => {
  const { api } = loadApp();
  const categories = [
    category('B', [slot('tag', ['B-trigger'])]),
    category('C', [slot('tag', ['C-trigger'])]),
    category('D', [slot('tag', ['D-visible'])]),
  ];
  const rules = { skipCategories: [
    { whenAny: ['C-trigger'], skip: ['B'] },
    { whenAny: ['B-trigger'], skip: ['D'] },
  ] };
  setup(api, categories, rules, MobilePresetCatalog.empty(), {
    'B.tag': { value: 'B-trigger' },
    'C.tag': { value: 'C-trigger' },
    'D.tag': { value: 'D-visible' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify([...api.skippedCategoryIds()])), ['B']);
  assert.equal(api.composePresetPrompt(), 'C-trigger, D-visible');
});

test('changing the outfit removes a previous skip before the next category is randomized', () => {
  const { api } = loadApp();
  const categories = [
    category('outfitState', [slot('type', ['trigger', 'other'])]),
    category('top', [slot('type', ['old-top', 'new-top'])]),
  ];
  const rules = { skipCategories: [{ whenAny: ['trigger'], skip: ['top'] }] };
  setup(api, categories, rules, MobilePresetCatalog.empty(), {
    'outfitState.type': { value: 'trigger' },
    'top.type': { value: 'old-top' },
  });
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    api.randomizePresetSlots();
  } finally {
    Math.random = originalRandom;
  }
  assert.equal(api.state.presetState.slots['outfitState.type'].value, 'other');
  assert.equal(api.state.presetState.slots['top.type'].value, 'new-top');
});

test('one-piece tops skip bottoms while a bottom one-piece does not skip itself', () => {
  const { api } = loadApp();
  const categories = [
    category('top', [slot('type', ['泳衣', '衬衫'])]),
    category('bottom', [slot('type', ['连体衣', '短裙'])]),
  ];
  const rules = { skipCategories: [
    { whenAny: ['泳衣', '连体衣'], skip: ['bottom'] },
  ] };
  setup(api, categories, rules, MobilePresetCatalog.empty(), {
    'top.type': { value: '泳衣' },
    'bottom.type': { value: '短裙' },
  });
  assert.deepEqual([...api.skippedCategoryIds()], ['bottom']);
  setup(api, categories, rules, MobilePresetCatalog.empty(), {
    'top.type': { value: '衬衫' },
    'bottom.type': { value: '连体衣' },
  });
  assert.deepEqual([...api.skippedCategoryIds()], []);
});

test('a category tag does not skip its own row', () => {
  const { api } = loadApp();
  const categories = [
    category('socks', [slot('type', ['光腿', '丝袜'])]),
    category('shoes', [slot('type', ['赤足', '高跟鞋'])]),
    category('bottom', [slot('type', ['连体衣', '短裙'])]),
  ];
  const rules = { skipCategories: [
    { whenAny: ['光腿'], skip: ['socks'] },
    { whenAny: ['赤足'], skip: ['shoes'] },
    { whenAny: ['连体衣'], skip: ['bottom'] },
  ] };
  setup(api, categories, rules, MobilePresetCatalog.empty(), {
    'socks.type': { value: '光腿' },
    'shoes.type': { value: '赤足' },
    'bottom.type': { value: '连体衣' },
  });
  assert.deepEqual([...api.skippedCategoryIds()], []);
});

test('hidden locked tags do not clear visible mutex partners after skip', () => {
  const { api } = loadApp();
  const categories = [
    category('outfitState', [slot('type', ['着装', '全裸'])]),
    category('clothing', [slot('type', ['裙子'])]),
    category('body', [slot('tag', ['裸体'])]),
  ];
  const rules = {
    mutex: [['裙子', '裸体']],
    skipCategories: [{ whenAny: ['全裸'], skip: ['clothing'] }],
  };
  setup(api, categories, rules, MobilePresetCatalog.empty(), {
    'outfitState.type': { value: '着装' },
    'clothing.type': { value: '裙子', locked: true },
    'body.tag': { value: '裸体' },
  });
  const originalRandom = Math.random;
  Math.random = () => 0;
  try { api.randomizePresetSlots('', { persist: false }); }
  finally { Math.random = originalRandom; }
  assert.equal(api.state.presetState.slots['outfitState.type'].value, '全裸');
  assert.equal(api.state.presetState.slots['body.tag'].value, '裸体');
  assert.equal(api.collectPresetConflicts().size, 0);
});

test('randomization clears a conflicting editable value when no allowed candidate exists', () => {
  const { api } = loadApp();
  const categories = [
    category('left', [slot('tag', ['left'])]),
    category('right', [slot('tag', ['right'])]),
  ];
  const rules = { mutex: [['left', 'right']] };
  setup(api, categories, rules, MobilePresetCatalog.empty(), {
    'left.tag': { value: 'left', locked: true },
    'right.tag': { value: 'right' },
  });
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    api.randomizePresetSlots('right');
  } finally {
    Math.random = originalRandom;
  }
  assert.equal(api.state.presetState.slots['right.tag'].value, '');
});

test('deleted custom current values are marked and omitted while unknown manual text remains prompt-visible', () => {
  const { api } = loadApp();
  const categories = [
    category('custom', [slot('tag', ['builtin'])]),
    category('free', [slot('tag', ['listed'])]),
  ];
  const catalog = MobilePresetCatalog.normalize({
    custom: { 'custom.tag': ['old-custom'] },
    removedCustom: { 'custom.tag': ['old-custom'] },
  });
  setup(api, categories, {}, catalog, {
    'custom.tag': { value: 'old-custom' },
    'free.tag': { value: 'typed-free-tag' },
  });
  assert.equal(api.presetTagStatus('custom', 'tag', 'old-custom'), 'deleted');
  assert.deepEqual(Array.from(api.slotPool('custom', categories[0].slots[0])), ['builtin']);
  assert.equal(api.composePresetPrompt(), 'typed-free-tag');
});

test('custom removal keeps the original custom tag as a tombstoned catalog entry', () => {
  const storage = new Storage();
  const { api } = loadApp(storage);
  const categories = [category('custom', [slot('tag', ['builtin'])])];
  const catalog = MobilePresetCatalog.normalize({ custom: { 'custom.tag': ['old-custom'] } });
  setup(api, categories, {}, catalog, { 'custom.tag': { value: 'old-custom' } });
  api.removePresetCustomTag('custom', 'tag', 'old-custom');
  assert.deepEqual(JSON.parse(JSON.stringify(api.state.presetState.catalog.custom)), { 'custom.tag': ['old-custom'] });
  assert.deepEqual(JSON.parse(JSON.stringify(api.state.presetState.catalog.removedCustom)), { 'custom.tag': ['old-custom'] });
  assert.equal(api.presetTagStatus('custom', 'tag', 'old-custom'), 'deleted');
  assert.equal(api.composePresetPrompt(), '');
});

test('slot snapshots contain only the backend contract fields', () => {
  const storage = new Storage();
  const { api } = loadApp(storage);
  setup(api, [category('x', [slot('tag', ['one'])])], {}, MobilePresetCatalog.empty(), {
    'x.tag': { value: 'one', locked: true, ignored: false, conflict: true, transient: 'drop' },
  });
  api.savePresetState();
  const saved = JSON.parse(storage.getItem('comfy-mobile-remote.preset'));
  assert.deepEqual(saved.slots['x.tag'], { value: 'one', locked: true, ignored: false });
  assert.deepEqual(Object.keys(saved.slots['x.tag']).sort(), ['ignored', 'locked', 'value']);
});

test('catalog key is authoritative and missing key migrates exactly once', () => {
  const old = JSON.stringify({ custom: { 'x.tag': ['legacy'] }, catalog: { removed: { 'x.tag': ['gone'] } } });
  const shared = JSON.stringify({ custom: { 'x.tag': ['authoritative'] }, removed: {} });
  const first = loadApp(new Storage({ 'comfy-mobile-remote.preset': old, 'comfy-mobile-remote.presetCatalog': shared }));
  first.api.loadPresetState();
  assert.deepEqual(first.api.state.presetState.catalog.custom, { 'x.tag': ['authoritative'] });
  assert.deepEqual(first.api.state.presetState.catalog.removed, {});

  const migratedStorage = new Storage({ 'comfy-mobile-remote.preset': old });
  const migrated = loadApp(migratedStorage);
  migrated.api.loadPresetState();
  const migratedCatalog = JSON.parse(migratedStorage.getItem('comfy-mobile-remote.presetCatalog'));
  assert.deepEqual(migratedCatalog.custom, { 'x.tag': ['legacy'] });
  assert.deepEqual(migratedCatalog.removed, { 'x.tag': ['gone'] });
  migrated.api.state.presetState.slots['x.tag'] = { value: 'changed' };
  migrated.api.savePresetState();
  assert.deepEqual(JSON.parse(migratedStorage.getItem('comfy-mobile-remote.presetCatalog')), migratedCatalog);
});

test('invalid authoritative catalog data is surfaced instead of replaced with an empty catalog', () => {
  for (const raw of ['{bad json', JSON.stringify({ unknown: true }), 'null']) {
    const storage = new Storage({ 'comfy-mobile-remote.presetCatalog': raw });
    const { api } = loadApp(storage);
    assert.throws(() => api.loadPresetState(), /Invalid|Unexpected|JSON|unknown|catalog/i);
  }
});

test('unknown server catalog does not mint an empty authoritative key', () => {
  const storage = new Storage({ 'comfy-mobile-remote.preset': JSON.stringify({ enabled: true, custom: { 'x.tag': ['keep'] } }) });
  const { api } = loadApp(storage);
  api.phoneSettings.known = false;
  api.loadPresetState();
  assert.equal(storage.getItem('comfy-mobile-remote.presetCatalog'), null);
});

test('catalog rebase keeps current slots and merges remote custom tags', () => {
  const { api } = loadApp();
  const categories = [category('body', [slot('tag', ['one'])])];
  const catalog = MobilePresetCatalog.normalize({ custom: { 'body.tag': ['local'] } });
  setup(api, categories, {}, catalog, { 'body.tag': { value: 'one', locked: true } });
  api.phoneSettings.setItem('comfy-mobile-remote.presetCatalog', JSON.stringify(
    MobilePresetCatalog.normalize({ custom: { 'body.tag': ['local', 'remote'] } })));
  api.applyCatalogFromSettings();
  assert.equal(api.state.presetState.slots['body.tag'].value, 'one');
  assert.equal(api.state.presetState.slots['body.tag'].locked, true);
  assert.deepEqual(new Set(api.state.presetState.catalog.custom['body.tag']), new Set(['local', 'remote']));
});

test('manual conflict is reported, while history restores custom without replacing global management', () => {
  const { api } = loadApp();
  const categories = [
    category('body', [slot('tag', ['one'])]),
    category('other', [slot('tag', ['two'])]),
  ];
  const catalog = MobilePresetCatalog.normalize({
    custom: { 'body.tag': ['custom', 'newer'], 'other.tag': ['keep'] },
    mutex: [['one', 'two']],
    skipped: { 'body.tag': ['one'] },
  });
  setup(api, categories, {}, catalog, {
    'body.tag': { value: 'one', locked: true },
    'other.tag': { value: 'two' },
  });
  assert.equal(api.canSelectPresetTag('body', 'tag', 'one'), true, 'skipped manual tags are selectable');
  assert.equal(api.collectPresetConflicts().size, 2, 'manual skipped tags remain active prompt conflicts');
  api.state.presetState.catalog.skipped = {};
  api.state.effectiveRulesCache = null;
  assert.equal(api.collectPresetConflicts().size, 2, 'both sides of a valid conflict are explicitly reported');

  api.restorePresetSnapshot({
    enabled: true,
    slots: { 'body.tag': { value: 'custom', locked: false, ignored: false } },
    custom: { 'body.tag': ['custom'] },
    catalog: { custom: { 'body.tag': ['custom'] }, mutex: [['custom', 'other']], skipped: { 'body.tag': ['custom'] } },
    extraText: '',
  }, '');
  assert.deepEqual(api.state.presetState.catalog.mutex, [['one', 'two']]);
  assert.deepEqual(api.state.presetState.catalog.skipped, {});
  assert.deepEqual(api.state.presetState.catalog.custom, {
     'body.tag': ['custom', 'newer'],
     'other.tag': ['keep'],
   });
});
