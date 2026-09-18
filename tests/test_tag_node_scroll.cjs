/* 电脑端「CLIP文本编码丨随机标签」节点：点分类名 / 点「随机」重建标签列表时，
 * 列表的滚动位置必须原地不动。
 *
 * 真前端里每点一次会自己往上跑 10px：排查下来是浏览器的滚动锚定在整块重建时
 * 改写了 scrollTop（scrollHeight / clientHeight / 节点高度全程不变，只有 scrollTop 变），
 * 用 .mtr-rows{overflow-anchor:none} + render() 自己还原位置修掉。
 * 这个假页面里 Chromium 不触发那套锚定，所以第三条用计算样式把这层约定钉住。
 *
 * 用 node --test tests/test_tag_node_scroll.cjs 运行。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");

function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try { return require("playwright"); } catch {}
  try { return require("playwright-core"); } catch {}
  const cache = path.join(os.homedir(), "AppData", "Local", "npm-cache", "_npx");
  for (const entry of fs.readdirSync(cache)) {
    const candidate = path.join(cache, entry, "node_modules", "playwright-core");
    if (fs.existsSync(path.join(candidate, "package.json"))) return require(candidate);
  }
  throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), ".agent-browser", "browsers");
  for (const entry of fs.readdirSync(root)) {
    const candidate = path.join(root, entry, "chrome.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const APP_STUB = `export const app = {
  registerExtension(extension) { globalThis.__mtrExtension = extension; },
  api: { queuePrompt: async () => {} },
  graph: { _nodes: [] },
};`;

function pageHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <style>
      html,body{margin:0;background:#10121a;font:12px Arial,sans-serif}
      /* 前端给 DOM 控件的那层容器：固定高度、裁剪 */
      .dom-widget{position:relative;width:340px;height:202px;overflow:hidden}
    </style>
    </head><body>
    <script type="module" src="/extensions/ComfyUI-Mobile-Remote/tag-node.js"></script>
    </body></html>`;
}

function startFixture() {
  const files = new Map();
  const put = (url, file, type) => files.set(url, { body: fs.readFileSync(path.join(ROOT, file)), type });
  put("/extensions/ComfyUI-Mobile-Remote/tag-node.js", "web/tag-node.js", "text/javascript");
  put("/extensions/ComfyUI-Mobile-Remote/tag-node.css", "web/tag-node.css", "text/css");
  put("/extensions/ComfyUI-Mobile-Remote/i18n.js", "web/i18n.js", "text/javascript");
  for (const name of ["preset-catalog.js", "preset-engine.js"]) put(`/mobile/assets/${name}`, `mobile/${name}`, "text/javascript");
  put("/mobile/assets/prompt-presets.json", "mobile/prompt-presets.json", "application/json");
  for (const lang of ["en", "ja", "ko"]) put(`/mobile/api/i18n/${lang}`, `i18n/${lang}.json`, "application/json");
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const send = (body, type) => { response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); response.end(body); };
    if (pathname === "/scripts/app.js") return send(APP_STUB, "text/javascript");
    if (pathname === "/node") return send(pageHtml(), "text/html");
    if (pathname === "/mobile/api/settings") return send(JSON.stringify({ ok: true, values: {} }), "application/json");
    const file = files.get(pathname);
    if (file) return send(file.body, file.type);
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/node` });
    });
  });
}

const stopFixture = async (server) => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };

/* 每个用例起一份干净页面：一个浏览器里跑完就关，避免互相串状态。 */
async function withPage(run) {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const { server, url } = await startFixture();
  try {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => Boolean(globalThis.__mtrExtension), null, { timeout: 20000 });
    await page.evaluate(async () => {
      const extension = globalThis.__mtrExtension;
      const proto = {};
      await extension.beforeRegisterNodeDef({ prototype: proto }, { name: "MobileTagCLIPTextEncode" });
      const node = {
        type: "MobileTagCLIPTextEncode",
        properties: {},
        size: [340, 320],
        widgets: [
          { name: "text", value: "my own words" },
          { name: "标签模式", value: true },
          { name: "每次随机", value: false },
        ],
        computeSize: () => [340, 300],
        setSize() {},
        setDirtyCanvas() {},
        graph: { setDirtyCanvas() {} },
        addDOMWidget(name, kind, element) {
          const wrap = document.createElement("div");
          wrap.className = "dom-widget";
          wrap.append(element);
          document.body.append(wrap);
          return { name, element };
        },
      };
      proto.onNodeCreated.call(node);
      globalThis.__node = node;
    });
    await page.waitForFunction(() => document.querySelectorAll(".mtr-row").length > 0, null, { timeout: 30000 });
    await run(page);
    assert.deepEqual(errors, [], "节点面板不应抛出未捕获异常");
    await context.close();
  } finally {
    await browser.close();
    await stopFixture(server);
  }
}

const scrollState = () => {
  const rows = document.querySelector(".mtr-rows");
  return {
    top: Math.round(rows.scrollTop * 100) / 100,
    max: rows.scrollHeight - rows.clientHeight,
    value: rows.querySelector(".mtr-chip-text")?.textContent || "",
  };
};

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test("滚到底再点「随机」：列表一动不动", { timeout: 120000 }, async () => {
  await withPage(async (page) => {
    const start = await page.evaluate(() => {
      const rows = document.querySelector(".mtr-rows");
      rows.scrollTop = rows.scrollHeight;
      return { top: rows.scrollTop, max: rows.scrollHeight - rows.clientHeight };
    });
    assert.ok(start.max > 0, "标签列表必须真的能滚动");

    const trail = [];
    for (let i = 0; i < 3; i += 1) {
      await page.click(".mtr-random");
      await settle(page);
      trail.push(await page.evaluate(scrollState));
    }
    for (const state of trail) {
      assert.ok(Math.abs(state.top - state.max) <= 1, "点随机之后必须还停在最底下：" + JSON.stringify(trail));
    }
    assert.ok(new Set(trail.map((s) => s.value)).size > 1, "点了随机标签值应当真的换过：" + JSON.stringify(trail.map((s) => s.value)));
  });
});

test("停在中间点随机 / 点分类名：位置原样保留", { timeout: 120000 }, async () => {
  await withPage(async (page) => {
    const middle = await page.evaluate(() => {
      const rows = document.querySelector(".mtr-rows");
      rows.scrollTop = Math.round((rows.scrollHeight - rows.clientHeight) / 2);
      return Math.round(rows.scrollTop * 100) / 100;
    });
    assert.ok(middle > 0, "中间位置应当是个能滚动的值");

    await page.click(".mtr-random");
    await settle(page);
    assert.ok(Math.abs((await page.evaluate(scrollState)).top - middle) <= 1, "点随机不该动位置");

    // 点一个当前可见的分类名（不做自动滚动，避免把浏览器自己的 scrollIntoView 算进来）
    const hit = await page.evaluate(() => {
      const rows = document.querySelector(".mtr-rows");
      const rect = rows.getBoundingClientRect();
      const node = [...rows.querySelectorAll(".mtr-row-label")].find((n) => {
        const r = n.getBoundingClientRect();
        return r.top > rect.top + 12 && r.bottom < rect.bottom - 12;
      });
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    assert.ok(hit, "应当能找到一行可见的分类名");
    await page.mouse.click(hit.x, hit.y);
    await settle(page);
    assert.ok(Math.abs((await page.evaluate(scrollState)).top - middle) <= 1, "点分类名不该动位置");
  });
});

test("列表退出浏览器滚动锚定", { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    const anchor = await page.evaluate(() => getComputedStyle(document.querySelector(".mtr-rows")).overflowAnchor);
    assert.equal(anchor, "none", "整块重建的列表必须自己管位置：.mtr-rows{overflow-anchor:none}");
  });
});
