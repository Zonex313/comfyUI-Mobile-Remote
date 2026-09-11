const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const SESSION = 'tag-fix-final';
function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try { return require('playwright'); } catch {}
  try { return require('playwright-core'); } catch {}
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  for (const entry of fs.readdirSync(cache)) {
    const candidate = path.join(cache, entry, 'node_modules', 'playwright-core');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return require(candidate);
  }
  throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module');
}
const chromium = resolvePlaywright().chromium;
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), '.agent-browser', 'browsers');
  for (const entry of fs.readdirSync(root)) {
    const candidate = path.join(root, entry, 'chrome.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
let browserInstance;
let page;
async function browser(args, { allowFailure = false } = {}) {
  try {
    if (args[0] === 'close') {
      await browserInstance?.close(); browserInstance = null; page = null;
      return { success: true, data: {} };
    }
    if (args[0] === 'session') return { success: true, data: { sessions: browserInstance ? [SESSION] : [] } };
    if (!browserInstance) {
      browserInstance = await chromium.launch({ executablePath: chromePath(), headless: true });
      page = await browserInstance.newPage();
      page.on('pageerror', error => console.error('PAGE ERROR:', error.message));
    }
    let value;
    if (args[0] === 'set') await page.setViewportSize({ width: Number(args[2]), height: Number(args[3]) });
    else if (args[0] === 'open') await page.goto(args[1]);
    else if (args[0] === 'eval') value = await page.evaluate(args[1]);
    return { success: true, data: { result: value } };
  } catch (error) {
    if (!allowFailure) throw error;
    return { success: true, data: {} };
  }
}

async function result(payload) {
  if (!payload || payload.success === false || payload.error) {
    throw new Error(`browser command failed: ${JSON.stringify(payload)}`);
  }
  return payload.data?.result;
}

async function evaluate(script) {
  return result(await browser(['eval', script]));
}

function writeResponse(response, status, contentType, body) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function fixtureCatalog() {
  const longTag = `超长标签-${'换行测试'.repeat(24)}`;
  const tailCandidates = Array.from({ length: 40 }, (_, index) => `候选标签-${String(index).padStart(2, '0')}`);
  return {
    categories: [
      {
        id: 'main',
        label: '主要分类',
        slots: [{
          id: 'tags',
          label: '标签',
          pool: [
            '内置A', '内置B', '内置C',
            ...tailCandidates,
            longTag,
          ],
        }],
      },
      {
        id: 'other',
        label: '其他分类',
        slots: [{ id: 'tags', label: '其他标签', pool: ['另一分类标签'] }],
      },
    ],
    rules: {
      mutex: [['内置A', '内置B', '内置C']],
      singletons: [],
      skipCategories: [],
    },
  };
}

function pageHtml(catalog) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/web/remote.css">
  <style>
    html, body, #fixture { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: #0a0d16; }
  </style>
</head>
<body>
  <main id="fixture" class="mobile-remote-panel"></main>
  <script type="module">
    import { createPresetManager } from '/web/preset-manager.js';
    import { CatalogStore } from '/web/preset-store.js';

    const KEY = globalThis.MobilePresetCatalog.key;
    const catalog = ${JSON.stringify(catalog)};
    const initial = globalThis.MobilePresetCatalog.empty();
    const server = { revision: 1, values: { [KEY]: JSON.stringify(initial) } };
    const timers = new Map();
    let timerId = 0;

    function delayedTimer(fn, ms) {
      const id = ++timerId;
      timers.set(id, { fn, ms });
      return id;
    }
    function clearDelayedTimer(id) { timers.delete(id); }
    function response(status, body) {
      return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) };
    }
    async function fakeFetch(_url, options = {}) {
      if (options.body) {
        const payload = JSON.parse(options.body);
        const changed = payload.changes?.[KEY];
        if (changed !== undefined) {
          server.values[KEY] = changed;
          server.revision += 1;
        }
      }
      return response(200, { revision: server.revision, values: structuredClone(server.values) });
    }
    function element(tag, className, text) {
      const node = document.createElement(tag);
      node.className = className || '';
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function button(label, _icon, text = '') {
      const node = element('button', 'mobile-remote-button', text);
      node.type = 'button';
      node.title = label;
      node.setAttribute('aria-label', label);
      return { node };
    }
    function setText(node, text) { node.textContent = text; }

    const store = new CatalogStore({
      fetch: fakeFetch,
      storage: window.sessionStorage,
      setTimeout: delayedTimer,
      clearTimeout: clearDelayedTimer,
    });
    const manager = createPresetManager({
      element,
      button,
      setText,
      store,
      fetchCatalog: async () => structuredClone(catalog),
    });
    document.querySelector('#fixture').append(manager.node);
    window.confirm = () => true;
    window.__fixture = { catalog, server, store, manager, timers };
    window.__fixtureReady = manager.open();
  </script>
</body>
</html>`;
}

function startFixtureServer(catalog) {
  const files = new Map([
    ['/web/preset-manager.js', ['text/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'web', 'preset-manager.js'))]],
    ['/web/preset-store.js', ['text/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'web', 'preset-store.js'))]],
    ['/mobile/assets/preset-catalog.js', ['text/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'mobile', 'preset-catalog.js'))]],
    ['/web/remote.css', ['text/css; charset=utf-8', fs.readFileSync(path.join(ROOT, 'web', 'remote.css'))]],
  ]);
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') return writeResponse(response, 200, 'text/html; charset=utf-8', pageHtml(catalog));
    const file = files.get(pathname);
    if (file) return writeResponse(response, 200, file[0], file[1]);
    return writeResponse(response, 404, 'text/plain; charset=utf-8', 'not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

async function stopFixtureServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function openFixture(url) {
  await result(await browser(['open', url]));
  return evaluate('window.__fixtureReady.then(() => ({ ready: true, width: innerWidth }))');
}

async function layoutSnapshot() {
  return evaluate(`(() => {
    const root = document.querySelector('.mobile-remote-tags');
    const list = document.querySelector('.mobile-remote-tags-list');
    const rootRect = root.getBoundingClientRect();
    const visible = [...root.querySelectorAll('*')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return !node.hidden && rect.width > 0 && rect.height > 0;
    });
    const overflow = visible
      .map((node) => ({ node: node.tagName + '.' + node.className, rect: node.getBoundingClientRect().toJSON() }))
      .filter(({ rect }) => rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1);
    const controls = [...root.querySelectorAll('.mobile-remote-chip-btn')].map((node) => {
      const rect = node.getBoundingClientRect();
      return { className: node.className, width: rect.width, height: rect.height };
    });
    const long = [...root.querySelectorAll('.mobile-remote-chip-name')]
      .find((node) => node.textContent.startsWith('超长标签-'));
    const longRect = long?.getBoundingClientRect();
    return {
      rootWidth: rootRect.width,
      listWidth: list.getBoundingClientRect().width,
      listScrollWidth: list.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflow,
      controls,
      longHeight: longRect?.height || 0,
      longWidth: longRect?.width || 0,
      longText: long?.textContent || '',
    };
  })()`);
}

async function clickSummary() {
  return evaluate(`(() => {
    const summary = document.querySelector('.mobile-remote-tag-summary');
    if (!summary.closest('details').open) summary.click();
    return { open: summary.closest('details').open };
  })()`);
}

async function addCustom(text, { group = false, peer = '' } = {}) {
  return evaluate(`(async () => {
    const add = [...document.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === JSON.stringify(['main.tags', 'add']));
    if (!add) throw new Error('main add control missing');
    add.click();
    const form = document.querySelector('.mobile-remote-tags-form');
    const input = form.querySelector('input[name=tag]');
    input.value = ${JSON.stringify(text)};
    ${group ? `form.querySelector('input[name=mutex-group]')?.click();` : ''}
    ${peer ? `const peer = [...form.querySelectorAll('input[type=checkbox]')].find((node) => node.value === ${JSON.stringify(peer)}); if (!peer) throw new Error('peer candidate missing'); peer.click();` : ''}
    form.requestSubmit();
    await Promise.resolve();
    return { text: input.value, dirty: window.__fixture.store.snapshot().dirty };
  })()`);
}

async function closeBrowserSession() {
  await browser(['close'], { allowFailure: true });
  const sessions = await browser(['session', 'list'], { allowFailure: true });
  const names = sessions?.data?.sessions || [];
  assert.equal(names.includes(SESSION), false, `dedicated browser session still active: ${names.join(', ')}`);
}

test('desktop preset manager browser regression fixture', { timeout: 60000 }, async () => {
  const catalog = fixtureCatalog();
  const { server, url } = await startFixtureServer(catalog);
  const failures = [];
  const check = (condition, message, details) => {
    if (!condition) failures.push(`${message}${details ? `: ${JSON.stringify(details)}` : ''}`);
  };
  try {
    console.error('phase: set initial viewport');
    await result(await browser(['set', 'viewport', '360', '800']));
    console.error('phase: open initial fixture');
    await openFixture(url);
    console.error('phase: initial assertions');
    const initial = await evaluate(`(() => ({
      categoryCount: document.querySelectorAll('details.mobile-remote-tag-category').length,
      allCollapsed: [...document.querySelectorAll('details.mobile-remote-tag-category')].every((node) => !node.open),
      hasForm: document.querySelector('.mobile-remote-tags-form').hidden,
    }))()`);
    console.error('phase: initial evaluated');
    check(initial.categoryCount === 2, 'default catalog categories rendered');
    check(initial.allCollapsed, 'categories are collapsed by default');
    check(initial.hasForm, 'editor form is hidden by default');

    console.error('phase: expand summary');
    await clickSummary();
    console.error('phase: focus before');
    const focusBefore = await evaluate(`(() => {
      const node = [...document.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === JSON.stringify(['main.tags', '内置A', 'skip']));
      node.focus();
      return { id: node.dataset.focus, active: document.activeElement === node };
    })()`);
    console.error('phase: focus before evaluated');
    const focusAfter = await evaluate(`(() => {
      const node = [...document.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === JSON.stringify(['main.tags', '内置A', 'skip']));
      node.click();
      return { id: node.dataset.focus, active: document.activeElement?.dataset?.focus || '' };
    })()`);
    check(focusBefore.active, 'same-slot skip control can receive focus');
    check(focusAfter.active === focusAfter.id, 'skip restores exact same-slot control focus', focusAfter);

    await result(await browser(['set', 'viewport', '360', '800']));
    const wideLayout = await layoutSnapshot();
    await result(await browser(['set', 'viewport', '280', '800']));
    const narrowLayout = await layoutSnapshot();
    const imageDir = path.join(os.tmpdir(), 'comfy-tag-manager-review');
    fs.mkdirSync(imageDir, { recursive: true });
    await page.screenshot({ path: path.join(imageDir, 'tags-280.png') });
    console.log('screenshot:', path.join(imageDir, 'tags-280.png'));
    for (const [name, layout] of [['360px', wideLayout], ['280px', narrowLayout]]) {
      check(layout.overflow.length === 0, `${name} layout has no horizontal child overflow`, layout.overflow.slice(0, 4));
      check(layout.listScrollWidth <= layout.listWidth + 1, `${name} tag list has no horizontal scroll`, layout);
      check(layout.documentWidth <= Number(name.replace('px', '')) + 1, `${name} page has no horizontal overflow`, layout);
      check(layout.longHeight > 22, `${name} long labels wrap instead of staying one-line`, layout);
      check(layout.longWidth <= layout.rootWidth + 1, `${name} long label stays within root`, layout);
      for (const control of layout.controls) {
        check(Math.abs(control.width - 24) < 0.1 && Math.abs(control.height - 24) < 0.1,
          `${name} chip control is 24px`, control);
      }
    }

    await result(await browser(['set', 'viewport', '360', '800']));
    await openFixture(url);
    await clickSummary();
    const addFocus = await evaluate(`(() => {
      const add = [...document.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === JSON.stringify(['main.tags', 'add']));
      add.focus();
      add.click();
      return {
        inputFocused: document.activeElement === document.querySelector('input[name=tag]'),
        addId: add.dataset.focus,
      };
    })()`);
    check(addFocus.inputFocused, 'new-tag editor focuses its input');
    const cancelFocus = await evaluate(`(() => {
      document.querySelector('.mobile-remote-tags-form button[aria-label="取消编辑"]').click();
      return {
        active: document.activeElement?.dataset?.focus || '',
        expected: '["main.tags","add"]',
      };
    })()`);
    check(cancelFocus.active === cancelFocus.expected, 'cancel returns focus to originating add control', cancelFocus);

    await addCustom('自定义恢复测试');
    const customState = await evaluate(`(() => {
      const key = 'main.tags';
      const chip = [...document.querySelectorAll('.mobile-remote-chip-name')].find((node) => node.textContent === '自定义恢复测试');
      return { present: Boolean(chip), custom: window.__fixture.store.snapshot().catalog.custom[key] || [] };
    })()`);
    check(customState.present && customState.custom.includes('自定义恢复测试'), 'custom tag is added', customState);
    await evaluate(`(() => {
      const chip = [...document.querySelectorAll('.mobile-remote-chip-name')].find((node) => node.textContent === '自定义恢复测试');
      chip.parentElement.querySelector('[aria-label="删除 自定义恢复测试"]').click();
      return true;
    })()`);
    const removedState = await evaluate(`(() => {
      const key = 'main.tags';
      document.querySelector('.mobile-remote-tags-toggle input[type=checkbox]').checked = true;
      document.querySelector('.mobile-remote-tags-toggle input[type=checkbox]').dispatchEvent(new Event('change', { bubbles: true }));
      const removed = [...document.querySelectorAll('.mobile-remote-chip-name')].find((node) => node.textContent === '自定义恢复测试');
      return {
        removedVisible: Boolean(removed),
        removedCustom: window.__fixture.store.snapshot().catalog.removedCustom[key] || [],
      };
    })()`);
    check(removedState.removedVisible && removedState.removedCustom.includes('自定义恢复测试'), 'custom delete is recoverable in deleted view', removedState);
    const restoredState = await evaluate(`(() => {
      const chip = [...document.querySelectorAll('.mobile-remote-chip-name')].find((node) => node.textContent === '自定义恢复测试');
      chip.parentElement.querySelector('[aria-label="恢复 自定义恢复测试"]').click();
      const key = 'main.tags';
      return {
        pool: window.__fixture.store.snapshot().catalog.custom[key] || [],
        removedCustom: window.__fixture.store.snapshot().catalog.removedCustom[key] || [],
      };
    })()`);
    check(restoredState.pool.includes('自定义恢复测试') && restoredState.removedCustom.length === 0,
      'custom restore returns tag to active pool', restoredState);

    await openFixture(url);
    await clickSummary();
    await addCustom('关闭重开仍保留');
    const dirtyBeforeReopen = await evaluate(`window.__fixture.store.snapshot()`);
    const dirtyAfterReopen = await evaluate(`(async () => {
      window.__fixture.manager.close();
      await window.__fixture.manager.open();
      return window.__fixture.store.snapshot();
    })()`);
    const reopenKey = 'main.tags';
    check(dirtyBeforeReopen.dirty, 'custom edit marks shared store dirty before close');
    check(dirtyAfterReopen.dirty && dirtyAfterReopen.catalog.custom[reopenKey]?.includes('关闭重开仍保留'),
      'close and reopen preserves dirty custom edits', dirtyAfterReopen);

    await openFixture(url);
    await clickSummary();
    const editorForSearch = await evaluate(`(() => {
      [...document.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === JSON.stringify(['main.tags', 'add'])).click();
      const peerSection = [...document.querySelectorAll('.mobile-remote-rule-section')][1];
      peerSection.open = true;
      return true;
    })()`);
    assert.equal(editorForSearch, true);
    const searchEnd = await evaluate(`(() => {
      const search = document.querySelector('input[aria-label="搜索互斥候选"]');
      search.value = '候选标签-39';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const candidate = [...document.querySelectorAll('.mobile-remote-peer-list input[type=checkbox]')]
        .find((node) => node.value === '候选标签-39');
      if (!candidate) return { found: false };
      candidate.click();
      return { found: true, checked: candidate.checked, count: document.querySelector('.mobile-remote-note')?.textContent || '' };
    })()`);
    check(searchEnd.found && searchEnd.checked, 'search can select a candidate beyond first 24 entries', searchEnd);

    await openFixture(url);
    await clickSummary();
    await addCustom('X', { group: true });
    await addCustom('Y', { group: true });
    const mutexState = await evaluate(`(() => {
      const groups = window.__fixture.store.snapshot().catalog.mutex;
      return { groups, sameGroup: groups.some((group) => group.includes('X') && group.includes('Y')) };
    })()`);
    check(mutexState.sameGroup, 'serial additions to one builtin mutex group remain mutually exclusive', mutexState);

    if (failures.length) {
      assert.fail(`preset manager browser regression failures:\n- ${failures.join('\n- ')}`);
    }
  } catch (error) {
    console.error(error.stack || error);
    throw error;
  } finally {
    try { await closeBrowserSession(); }
    finally { await stopFixtureServer(server); }
  }
});
