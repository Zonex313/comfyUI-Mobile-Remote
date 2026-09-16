/* 「高级」页（节点/组控制）浏览器用例。
 * 真浏览器 + 全内存夹具：只读源码资源（advanced.js / advanced.css / styles.css），
 * 不碰真实历史/收藏/设置，也不修改任何已存在的文件。
 * 运行：node --test tests/test_advanced_page.cjs
 * 截图默认写到 tests/screenshots/advanced/（可用 ADVANCED_SHOT_DIR 覆盖）。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SHOT_DIR = process.env.ADVANCED_SHOT_DIR || path.join(ROOT, "tests", "screenshots", "advanced");

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

/* ------------------------------------------------------------------ 夹具数据 */
/* 3 个组 + 未分组，8 个节点：有入边有出边、有可编辑也有不可编辑。 */

const FIELDS = [
  { id: "4::ckpt_name", node_id: "4", input: "ckpt_name", label: "模型", kind: "select",
    value: "sd_xl_base_1.0.safetensors", options: ["sd_xl_base_1.0.safetensors", "sdxl_lightning_4step.safetensors"] },
  { id: "5::text", node_id: "5", input: "text", label: "文本", kind: "textarea", value: "a landscape" },
  { id: "6::text", node_id: "6", input: "text", label: "文本", kind: "textarea", value: "" },
  { id: "7::seed", node_id: "7", input: "seed", label: "种子", kind: "number", value: 123456789 },
  { id: "7::steps", node_id: "7", input: "steps", label: "采样步数", kind: "number", value: 20, min: 1, max: 100, step: 1 },
  { id: "9::filename_prefix", node_id: "9", input: "filename_prefix", label: "文件名前缀", kind: "text", value: "ComfyUI" },
  { id: "11::batch_size", node_id: "11", input: "batch_size", label: "批量数量", kind: "number", value: 1, min: 1, max: 64, step: 1 },
];

const STEP_INDEX = FIELDS.findIndex((field) => field.id === "7::steps");

const GRAPH = {
  nodes: [
    { id: "4", type: "CheckpointLoaderSimple", title: "Checkpoint 加载器", pos: [0, 0], group: "文本编码",
      links: [], field_ids: ["4::ckpt_name"], has_editable: true },
    { id: "5", type: "CLIPTextEncode", title: "CLIP文本编码丨正向", pos: [400, 0], group: "文本编码",
      links: [{ name: "clip", node: "4", slot: 1 }], field_ids: ["5::text"], has_editable: true },
    { id: "6", type: "CLIPTextEncode", title: "CLIP文本编码丨反向", pos: [400, 300], group: "文本编码",
      links: [{ name: "clip", node: "4", slot: 2 }], field_ids: ["6::text"], has_editable: true },
    { id: "7", type: "KSampler", title: "K采样器", pos: [800, 150], group: "采样",
      links: [{ name: "model", node: "4", slot: 0 }, { name: "positive", node: "5", slot: 0 }, { name: "negative", node: "6", slot: 0 }],
      field_ids: ["7::seed", "7::steps"], has_editable: true },
    { id: "8", type: "VAEDecode", title: "VAE 解码", pos: [1200, 150], group: "输出",
      links: [{ name: "samples", node: "7", slot: 0 }], field_ids: [], has_editable: false },
    { id: "9", type: "SaveImage", title: "保存图像", pos: [1600, 150], group: "输出",
      links: [{ name: "images", node: "8", slot: 0 }], field_ids: ["9::filename_prefix"], has_editable: true },
    { id: "10", type: "LoraLoader", title: "LoRA 加载器", pos: [800, 500], group: "",
      links: [{ name: "model", node: "4", slot: 0 }], field_ids: [], has_editable: false },
    { id: "11", type: "EmptyLatentImage", title: "空 Latent 图像", pos: [1200, 500], group: "",
      links: [], field_ids: ["11::batch_size"], has_editable: true },
  ],
  groups: [
    { id: "g0", title: "文本编码", color: "#3f789e", node_ids: ["4", "5", "6"] },
    { id: "g1", title: "采样", color: "#a1309b", node_ids: ["7"] },
    { id: "g2", title: "输出", color: "#3f789e", node_ids: ["8", "9"] },
  ],
};

const WORKFLOW = { id: "0a1b2c3d4e5f60718293", name: "高级页夹具工作流", node_count: 8, fields: FIELDS, graph: GRAPH };
const EMPTY_WORKFLOW = { id: "empty-workflow", name: "空工作流", node_count: 0, fields: [], graph: { nodes: [], groups: [] } };

const NODE_COUNT = GRAPH.nodes.length;   // 8
const GROUP_COUNT = 4;                   // 3 个命名组 + 未分组
const EDITABLE_COUNT = FIELDS.length;    // 7

/* ------------------------------------------------------------------ 假依赖 */

const HARNESS = String.raw`
(function () {
  var fixture = window.__FIXTURE__;
  var legacy = window.__LEGACY__ === true;   // 旧版 renderField：不认第 4 个参数
  var empty = window.__EMPTY__ === true;
  var lang = new URLSearchParams(location.search).get("lang") || "zh";

  var NAMES = {
    en: {
      "工作流": "Workflow", "高级": "Advanced", "暂无工作流": "No workflows",
      "搜索节点名、类型或编号": "Search node name, type or id",
      "未分组": "Ungrouped", "全部展开": "Expand all", "全部收起": "Collapse all",
      "无可调参数": "No editable parameters", "个节点": "nodes", "个可调参数": "editable parameters",
      "已修改": "Modified", "来自 {name}": "From {name}", "被 {name} 使用": "Used by {name}",
      "没有匹配的节点": "No matching nodes",
      "模型": "Model", "文本": "Text", "种子": "Seed", "采样步数": "Steps",
      "文件名前缀": "Filename prefix", "批量数量": "Batch size",
    },
  };

  function t(text, params) {
    var table = NAMES[lang] || {};
    var value = Object.prototype.hasOwnProperty.call(table, text) ? table[text] : text;
    if (params) {
      value = value.replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
      });
    }
    return value;
  }

  var state = {
    workflow: empty ? fixture.empty : fixture.workflow,
    values: {},
    fieldControls: new Map(),
  };
  var fields = state.workflow.fields || [];
  fields.forEach(function (field) { state.values[field.id] = field.value; });

  var calls = [];
  function updateFieldValue(field, value) {
    state.values[field.id] = value;
    calls.push([field.id, value]);
  }

  function renderField(field, index, compact, controls) {
    var wrapper = document.createElement("div");
    wrapper.className = compact ? "field compact-field" : "field";
    wrapper.dataset.input = field.input;
    var row = document.createElement("span");
    row.className = "field-label-row";
    var label = document.createElement("span");
    label.className = "field-label";
    label.textContent = t(field.label);
    row.append(label);
    wrapper.append(row);
    var control;
    if (field.kind === "select") {
      control = document.createElement("select");
      (field.options || []).forEach(function (value) {
        var option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        control.append(option);
      });
      control.value = state.values[field.id] == null ? "" : String(state.values[field.id]);
      control.addEventListener("change", function () { updateFieldValue(field, control.value); });
    } else {
      control = document.createElement("input");
      control.type = field.kind === "number" ? "number" : "text";
      control.value = state.values[field.id] == null ? "" : String(state.values[field.id]);
      control.id = "field-" + index;   // 生成页的控件 id 就是 field-<下标>
      control.addEventListener("input", function () {
        updateFieldValue(field, field.kind === "number" ? Number(control.value) : control.value);
      });
    }
    wrapper.append(control);
    if (legacy) state.fieldControls.set(field.id, control);
    else if (controls && typeof controls.set === "function") controls.set(field.id, control);
    else state.fieldControls.set(field.id, control);
    return wrapper;
  }

  // 生成页先渲染（app.js 就是这个顺序），高级页随后挂载。
  var gen = document.getElementById("genFields");
  fields.forEach(function (field, index) { gen.append(renderField(field, index, false, state.fieldControls)); });

  window.__state = state;
  window.__calls = calls;
  window.MobileAdvanced.mount({
    t: t,
    state: state,
    renderField: renderField,
    updateFieldValue: updateFieldValue,
    view: document.getElementById("view-advanced"),
    storage: window.localStorage,
  });
  window.__ready = true;
})();
`;

function harnessHtml() {
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<link rel="stylesheet" href="/mobile/assets/styles.css">\n' +
    '<title>Advanced page harness</title>\n</head>\n<body>\n' +
    '<div id="app" class="app-shell">\n<main class="main-content" id="mainContent">\n' +
    '<section id="view-generate" class="view" data-view="generate"><div id="genFields" class="fields-list"></div></section>\n' +
    '<section id="view-advanced" class="view active" data-view="advanced"></section>\n' +
    '</main>\n</div>\n' +
    '<script>window.__FIXTURE__ = ' + JSON.stringify({ workflow: WORKFLOW, empty: EMPTY_WORKFLOW }) + ';' +
    'window.__LEGACY__ = /legacy=1/.test(location.search);' +
    'window.__EMPTY__ = /empty=1/.test(location.search);<\/script>\n' +
    '<script src="/mobile/assets/advanced.js"><\/script>\n' +
    '<script>' + HARNESS + '<\/script>\n</body>\n</html>\n';
}

/* ------------------------------------------------------------------ 服务器 */

function startServer() {
  const files = new Map();
  const put = (url, file, contentType) => files.set(url, { contentType, body: fs.readFileSync(path.join(ROOT, file)) });
  put("/mobile/assets/advanced.js", "mobile/advanced.js", "text/javascript; charset=utf-8");
  put("/mobile/assets/advanced.css", "mobile/advanced.css", "text/css; charset=utf-8");
  put("/mobile/assets/styles.css", "mobile/styles.css", "text/css; charset=utf-8");
  const missing = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://advanced.test").pathname;
    const send = (status, contentType, body) => {
      response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
      response.end(body);
    };
    if (files.has(pathname)) {
      const file = files.get(pathname);
      return send(200, file.contentType, file.body);
    }
    if (pathname === "/harness") return send(200, "text/html; charset=utf-8", harnessHtml());
    if (pathname === "/favicon.ico") { response.writeHead(204); return response.end(); }
    missing.push(pathname);
    return send(404, "text/plain; charset=utf-8", "Unknown fixture route");
  });
  server.missing = missing;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: "http://127.0.0.1:" + server.address().port }));
  });
}

/* -------------------------------------------------------------------- 环境 */

let browser = null;
let server = null;
let base = "";
const consoleErrors = [];

test.before(async () => {
  const { chromium } = resolvePlaywright();
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const started = await startServer();
  server = started.server;
  base = started.base;
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function openHarness(options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width || 390, height: options.height || 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: options.lang === "en" ? "en-US" : "zh-CN",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String((error && error.message) || error)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    consoleErrors.push(text);
    errors.push("console: " + text);
  });
  const params = [];
  if (options.lang && options.lang !== "zh") params.push("lang=" + options.lang);
  if (options.legacy) params.push("legacy=1");
  if (options.empty) params.push("empty=1");
  await page.goto(base + "/harness" + (params.length ? "?" + params.join("&") : ""), { waitUntil: "load" });
  await page.waitForFunction("window.__ready === true");
  // 模块自己挂的样式表加载完再开始断言
  await page.waitForFunction(() => {
    const link = document.getElementById("mtr-advanced-styles");
    return Boolean(link && link.sheet) && Boolean(document.getElementById("advancedList"));
  });
  if (!options.empty) {
    await page.waitForFunction(() => {
      const node = document.querySelector(".advanced-node");
      return Boolean(node) && getComputedStyle(node).borderRadius === "12px";
    });
  }
  return { context, page, errors };
}

const nodeCards = (page) => page.locator("#advancedList .advanced-node");
const groupCards = (page) => page.locator("#advancedList .advanced-group");

function expectNoErrors(errors) {
  assert.deepEqual(errors, [], "页面不应有 pageerror / console error：\n" + errors.join("\n"));
}

/* -------------------------------------------------------------------- 用例 */

test("页面结构：控件、样式、组与节点数量、状态行都正确", async () => {
  const { context, page, errors } = await openHarness();
  try {
    assert.equal(await nodeCards(page).count(), NODE_COUNT, "节点卡片数量");
    assert.equal(await groupCards(page).count(), GROUP_COUNT, "组数量（含未分组）");
    assert.equal(await page.locator("#advancedList .advanced-group-title").last().textContent(), "未分组");
    assert.equal(await page.locator("#advancedStatus").textContent(), NODE_COUNT + " 个节点 · " + EDITABLE_COUNT + " 个可调参数");
    assert.equal(await page.locator("#advancedExpandButton").getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#advancedSearch").getAttribute("placeholder"), "搜索节点名、类型或编号");
    // 模块自己注入样式表并生效，不依赖 index.html
    assert.equal(await page.evaluate(() => {
      const link = document.getElementById("mtr-advanced-styles");
      return Boolean(link && link.getAttribute("href").indexOf("/mobile/assets/advanced.css") === 0);
    }), true, "mount() 应自己挂样式表");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".advanced-node")).contentVisibility), "auto");
    // 节点顺序照搬服务端给的画布阅读顺序
    assert.deepEqual(await nodeCards(page).evaluateAll((nodes) => nodes.map((node) => node.dataset.nodeId)),
      ["4", "5", "6", "7", "8", "9", "10", "11"]);
    // 没有可调参数的节点展开后显示灰字提示
    await page.locator('[data-node-id="8"] .advanced-node-toggle').click();
    assert.equal(await page.locator('[data-node-id="8"] .advanced-node-empty').textContent(), "无可调参数");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("组可以折叠，折叠状态写进 localStorage", async () => {
  const { context, page, errors } = await openHarness();
  try {
    const group = page.locator('.advanced-group[data-group-id="g0"]');
    assert.equal(await group.evaluate((node) => node.open), true, "默认展开");
    await group.locator("summary").click();
    assert.equal(await group.evaluate((node) => node.open), false, "点 summary 收起");
    // details 的 toggle 事件是异步派发的，等它把状态写进 localStorage
    await page.waitForFunction((id) => {
      const stored = JSON.parse(localStorage.getItem("comfy-mobile-remote.advancedGroups") || "{}");
      return Boolean(stored[id]) && stored[id].g0 === false;
    }, WORKFLOW.id);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("comfy-mobile-remote.advancedGroups") || "{}"));
    assert.equal(stored[WORKFLOW.id].g0, false, "折叠状态要落 localStorage");

    await page.reload({ waitUntil: "load" });
    await page.waitForFunction("window.__ready === true");
    await page.waitForFunction(() => Boolean(document.querySelector("#advancedList .advanced-node")));
    assert.equal(await page.locator('.advanced-group[data-group-id="g0"]').evaluate((node) => node.open), false, "刷新后仍收起");
    assert.equal(await page.locator('.advanced-group[data-group-id="g1"]').evaluate((node) => node.open), true, "其它组不受影响");

    // 全部展开 / 收起
    await page.locator("#advancedExpandButton").click();
    assert.equal(await page.locator("#advancedExpandButton").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#advancedExpandButton").getAttribute("aria-label"), "全部收起");
    assert.deepEqual(await groupCards(page).evaluateAll((nodes) => nodes.map((node) => node.open)), [true, true, true, true], "全部展开");
    assert.deepEqual(await page.locator("#advancedList .advanced-node-toggle").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-expanded"))),
      ["true", "true", "true", "true", "true", "true", "true", "true"]);
    await page.locator("#advancedExpandButton").click();
    assert.equal(await page.locator("#advancedExpandButton").getAttribute("aria-pressed"), "false");
    assert.deepEqual(await groupCards(page).evaluateAll((nodes) => nodes.map((node) => node.open)), [false, false, false, false], "全部收起");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("编辑控件回调 updateFieldValue，并同步生成页控件与已修改星标", async () => {
  const { context, page, errors } = await openHarness();
  try {
    const card = page.locator('[data-node-id="7"]');
    assert.equal(await card.locator(".advanced-node-modified").count(), 0, "未改过时不显示星标");
    await card.locator(".advanced-node-toggle").click();
    assert.equal(await card.locator(".advanced-node-toggle").getAttribute("aria-expanded"), "true");
    assert.equal(await card.locator(".advanced-node-type").textContent(), "KSampler");

    const steps = page.locator('[data-node-id="7"] [data-field-id="7::steps"] input');
    assert.equal(await steps.count(), 1, "展开后应出现该字段的控件");
    assert.equal(await steps.inputValue(), "20", "控件初值来自 state.values");

    await steps.fill("33");
    assert.deepEqual(await page.evaluate(() => [window.__state.values["7::steps"], window.__calls.slice(-1)[0]]), [33, ["7::steps", 33]]);
    assert.equal(await page.evaluate((index) => document.getElementById("field-" + index).value, STEP_INDEX), "33", "生成页控件要同步");
    assert.equal(await card.locator(".advanced-node-modified").count(), 1, "改过之后显示已修改星标");

    await steps.fill("20");
    assert.equal(await card.locator(".advanced-node-modified").count(), 0, "改回默认值后星标消失");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("生成页改完再切回高级页，控件按 state.values 整块重渲染", async () => {
  const { context, page, errors } = await openHarness();
  try {
    await page.locator('[data-node-id="7"] .advanced-node-toggle').click();
    await page.evaluate((index) => {
      const control = document.getElementById("field-" + index);
      control.value = "48";
      control.dispatchEvent(new Event("input", { bubbles: true }));
    }, STEP_INDEX);
    assert.equal(await page.evaluate(() => window.__state.values["7::steps"]), 48);
    await page.evaluate(() => window.MobileAdvanced.show());
    assert.equal(await page.locator('[data-node-id="7"] [data-field-id="7::steps"] input').inputValue(), "48");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("点入边芯片：清空搜索、展开目标组与节点、加 is-flash 并滚到视野内", async () => {
  const { context, page, errors } = await openHarness();
  try {
    // 先把目标组收起来，再看跳转能不能把它展开
    await page.locator('.advanced-group[data-group-id="g0"] summary').click();
    assert.equal(await page.locator('.advanced-group[data-group-id="g0"]').evaluate((node) => node.open), false);

    // 搜到只剩下 KSampler，此时目标节点 5 是被过滤掉的
    await page.locator("#advancedSearch").fill("K采样器");
    assert.equal(await nodeCards(page).count(), 1);
    assert.equal(await page.locator('[data-node-id="5"]').count(), 0);

    const chip = page.locator('[data-node-id="7"] .advanced-chip[data-jump="5"]');
    assert.equal(await chip.textContent(), "来自 CLIP文本编码丨正向");
    await chip.click();

    assert.equal(await page.locator("#advancedSearch").inputValue(), "", "跳转前要清空搜索");
    assert.equal(await page.locator('.advanced-group[data-group-id="g0"]').evaluate((node) => node.open), true, "目标组要展开");
    const target = page.locator('[data-node-id="5"]');
    assert.equal(await target.locator(".advanced-node-toggle").getAttribute("aria-expanded"), "true", "目标节点要展开");
    assert.equal(await target.evaluate((node) => node.classList.contains("is-flash")), true, "目标节点要有 is-flash");

    // is-flash 只亮 1.2 秒
    await page.waitForFunction(() => !document.querySelector('.advanced-node[data-node-id="5"]').classList.contains("is-flash"),
      null, { timeout: 5000, polling: 100 });
    assert.equal(await target.evaluate((node) => node.classList.contains("is-flash")), false, "1.2 秒后自动褪色");

    // 出边芯片 + 滚动到视野内
    await page.evaluate(() => window.MobileAdvanced.openNode("7"));
    await page.waitForFunction(() => {
      const card = document.querySelector('.advanced-node[data-node-id="7"]');
      const box = card.getBoundingClientRect();
      const view = document.getElementById("mainContent").getBoundingClientRect();
      return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
    }, null, { timeout: 5000 });
    assert.equal(await page.locator('[data-node-id="7"] .advanced-chip[data-jump="8"]').textContent(), "被 VAE 解码 使用");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("搜索：子串 / 子序列都能命中并高亮，无命中显示空提示", async () => {
  const { context, page, errors } = await openHarness();
  try {
    await page.locator("#advancedSearch").fill("文本编码");
    assert.equal(await nodeCards(page).count(), 2, "标题命中两个 CLIP 节点");
    assert.deepEqual(await nodeCards(page).evaluateAll((nodes) => nodes.map((node) => node.dataset.nodeId)), ["5", "6"]);
    assert.equal(await page.locator("#advancedList mark").count() > 0, true, "命中文字要 <mark> 高亮");
    assert.equal(await page.locator("#advancedList mark").first().textContent(), "文本编码");
    assert.equal(await page.locator('[data-node-id="5"] .advanced-node-toggle').getAttribute("aria-expanded"), "true", "命中时自动展开");
    assert.equal(await page.locator('.advanced-group[data-group-id="g1"]').count(), 0, "没有命中的组不显示");

    // 子序列：clpt 只能命中 CLIPTextEncode
    await page.locator("#advancedSearch").fill("clpt");
    assert.deepEqual(await nodeCards(page).evaluateAll((nodes) => nodes.map((node) => node.dataset.nodeId)), ["5", "6"]);
    assert.equal(await page.locator("#advancedList mark").count() >= 2, true, "子序列也要逐字高亮");

    // 类型 / #编号 也能搜
    await page.locator("#advancedSearch").fill("#9");
    assert.deepEqual(await nodeCards(page).evaluateAll((nodes) => nodes.map((node) => node.dataset.nodeId)), ["9"]);
    await page.locator("#advancedSearch").fill("SaveImage");
    assert.deepEqual(await nodeCards(page).evaluateAll((nodes) => nodes.map((node) => node.dataset.nodeId)), ["9"]);

    // 无命中
    await page.locator("#advancedSearch").fill("zzzz");
    assert.equal(await nodeCards(page).count(), 0);
    assert.equal(await page.locator("#advancedList .advanced-nomatch").textContent(), "没有匹配的节点");

    await page.locator("#advancedSearch").fill("");
    assert.equal(await nodeCards(page).count(), NODE_COUNT);
    assert.equal(await page.locator("#advancedList .advanced-nomatch").count(), 0);
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("旧版 renderField（不认第 4 个参数）也能用，且不抢生成页的控件表", async () => {
  const { context, page, errors } = await openHarness({ legacy: true });
  try {
    assert.equal(await nodeCards(page).count(), NODE_COUNT);
    await page.locator('[data-node-id="7"] .advanced-node-toggle').click();
    await page.locator('[data-node-id="7"] [data-field-id="7::steps"] input').fill("35");
    assert.equal(await page.evaluate(() => window.__state.values["7::steps"]), 35, "旧版 renderField 下也要能改值");
    assert.equal(await page.evaluate((index) => window.__state.fieldControls.get("7::steps") === document.getElementById("field-" + index), STEP_INDEX),
      true, "state.fieldControls 必须仍指向生成页控件");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("空工作流显示空状态", async () => {
  const { context, page, errors } = await openHarness({ empty: true });
  try {
    assert.equal(await nodeCards(page).count(), 0);
    assert.equal(await page.locator("#advancedEmpty").isVisible(), true);
    assert.equal(await page.locator("#advancedEmpty h3").textContent(), "暂无工作流");
    assert.equal(await page.locator("#advancedStatus").textContent(), "");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("320px 窄屏没有横向溢出（中文 + 英文、全部展开）", async () => {
  for (const options of [{ width: 320, height: 640 }, { width: 320, height: 640, lang: "en" }]) {
    const { context, page, errors } = await openHarness(options);
    try {
      await page.evaluate(() => window.MobileAdvanced.toggleAll());
      await page.locator("#advancedSearch").fill("文本编码");
      await page.locator("#advancedSearch").fill("");
      const report = await page.evaluate(() => {
        // content-visibility 会跳过屏幕外的卡片，这里临时关掉，保证每张卡片都被量到。
        document.querySelectorAll(".advanced-node").forEach((node) => { node.style.contentVisibility = "visible"; });
        const list = document.getElementById("advancedList");
        const width = document.documentElement.clientWidth;
        const offenders = [];
        for (const element of list.querySelectorAll("*")) {
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.right > width + 1 || rect.left < -1) {
            offenders.push({ cls: String(element.className).slice(0, 40), left: Math.round(rect.left), right: Math.round(rect.right) });
          }
        }
        return {
          viewport: width,
          docScrollWidth: document.documentElement.scrollWidth,
          listScrollWidth: list.scrollWidth,
          listClientWidth: list.clientWidth,
          offenders: offenders.slice(0, 10),
        };
      });
      assert.equal(report.docScrollWidth <= report.viewport + 1, true, "文档不应横向滚动：" + JSON.stringify(report));
      assert.equal(report.listScrollWidth <= report.listClientWidth + 1, true, "列表不应横向溢出：" + JSON.stringify(report));
      assert.deepEqual(report.offenders, [], "不该有元素超出视口：" + JSON.stringify(report.offenders));
      await expectNoErrors(errors);
    } finally {
      await context.close();
    }
  }
});

test("四种尺寸/语言截图（含跳转高亮态）", { timeout: 180000 }, async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const shots = [];

  const zh = await openHarness({ width: 390, height: 844 });
  try {
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-default.png") });
    await zh.page.locator('[data-node-id="7"] .advanced-node-toggle').click();
    await zh.page.locator('[data-node-id="4"] .advanced-node-toggle').click();
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-expanded.png") });
    await zh.page.evaluate(() => window.MobileAdvanced.openNode("5"));
    await zh.page.waitForFunction(() => document.querySelector('.advanced-node[data-node-id="5"]').classList.contains("is-flash"));
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-jump-flash.png") });
    await zh.page.locator("#advancedSearch").fill("编码");
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-search.png") });
    expectNoErrors(zh.errors);
  } finally {
    await zh.context.close();
  }
  shots.push("advanced-390x844-zh-default.png", "advanced-390x844-zh-expanded.png", "advanced-390x844-zh-jump-flash.png", "advanced-390x844-zh-search.png");

  const en = await openHarness({ width: 390, height: 844, lang: "en" });
  try {
    await en.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-en-default.png") });
    await en.page.locator('[data-node-id="7"] .advanced-node-toggle').click();
    await en.page.evaluate(() => window.MobileAdvanced.openNode("5"));
    await en.page.waitForFunction(() => document.querySelector('.advanced-node[data-node-id="5"]').classList.contains("is-flash"));
    await en.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-en-jump-flash.png") });
    expectNoErrors(en.errors);
  } finally {
    await en.context.close();
  }
  shots.push("advanced-390x844-en-default.png", "advanced-390x844-en-jump-flash.png");

  const narrow = await openHarness({ width: 320, height: 640 });
  try {
    await narrow.page.evaluate(() => window.MobileAdvanced.toggleAll());
    await narrow.page.evaluate(() => { document.getElementById("mainContent").scrollTop = 0; });
    await narrow.page.screenshot({ path: path.join(SHOT_DIR, "advanced-320x640-zh-all-open.png") });
    expectNoErrors(narrow.errors);
  } finally {
    await narrow.context.close();
  }
  shots.push("advanced-320x640-zh-all-open.png");

  const narrowOpen = await openHarness({ width: 320, height: 640 });
  try {
    await narrowOpen.page.locator('[data-node-id="7"] .advanced-node-toggle').click();
    await narrowOpen.page.evaluate(() => { document.getElementById("mainContent").scrollTop = 0; });
    await narrowOpen.page.screenshot({ path: path.join(SHOT_DIR, "advanced-320x640-zh-expanded.png") });
    expectNoErrors(narrowOpen.errors);
  } finally {
    await narrowOpen.context.close();
  }
  shots.push("advanced-320x640-zh-expanded.png");

  const narrowEn = await openHarness({ width: 320, height: 640, lang: "en" });
  try {
    await narrowEn.page.locator("#advancedSearch").fill("encode");
    await narrowEn.page.locator("#advancedSearch").press("End");
    await narrowEn.page.screenshot({ path: path.join(SHOT_DIR, "advanced-320x640-en-search.png") });
    expectNoErrors(narrowEn.errors);
  } finally {
    await narrowEn.context.close();
  }
  shots.push("advanced-320x640-en-search.png");

  for (const name of shots) {
    const file = path.join(SHOT_DIR, name);
    assert.equal(fs.existsSync(file), true, "缺少截图 " + file);
    assert.equal(fs.statSync(file).size > 2000, true, "截图太小，可能是空白页：" + file);
  }
  console.log("截图目录：" + SHOT_DIR + "\n" + shots.map((name) => " - " + path.join(SHOT_DIR, name)).join("\n"));
});

test("全程没有 pageerror，也没有请求漏配的夹具路由", async () => {
  assert.deepEqual(server.missing, [], "夹具服务器收到未知请求：" + server.missing.join(", "));
  assert.deepEqual(consoleErrors, [], "浏览器控制台不应报错：\n" + consoleErrors.join("\n"));
});
