/* 「高级」页（节点/组控制）浏览器用例。
 * 真浏览器 + 全内存夹具：只读源码资源（advanced.js / advanced.css / styles.css），
 * 不碰真实历史/收藏/设置，也不修改任何已存在的文件。
 * 运行：node --test tests/test_advanced_page.cjs
 * 截图默认写到 tests/screenshots/advanced/（可用 ADVANCED_SHOT_DIR 覆盖）。
 *
 * 夹具要点：graph.nodes[].inputs 由本文件自己造（不依赖服务端已改完），
 * 覆盖 COMBO / INT / FLOAT / BOOLEAN / 多行 STRING / 单行 STRING / 被连线接管的输入 /
 * 前端专有控件 / 不认识类型 / fields 里没有的输入（标签模式、每次随机）。
 * 连线交互按参考项目 CueForge 的做法：连线画在输入行与卡片底部的输出区上，
 * 一个输出槽接多个节点时点按钮先弹就地菜单。夹具里因此有一个节点被两个节点连入
 * （8 号：7 与 4）、一个节点有两条出边（10 → 14 的 model / clip）、
 * 一个输出槽接两个节点（4 号槽 0 → 7.model 与 10.model）。
 * 另有一个只有旧 field_ids、没有 inputs 的旧数据工作流，验证向后兼容。
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

/* 生成页的「精选字段」表：还在，但高级页不再用它渲染（只有旧数据工作流才用它）。 */
const FIELDS = [
  { id: "4::ckpt_name", node_id: "4", input: "ckpt_name", label: "模型", kind: "select",
    value: "sd_xl_base_1.0.safetensors", options: ["sd_xl_base_1.0.safetensors", "sdxl_lightning_4step.safetensors"] },
  { id: "5::text", node_id: "5", input: "text", label: "文本", kind: "textarea", value: "a landscape" },
  { id: "6::text", node_id: "6", input: "text", label: "文本", kind: "textarea", value: "" },
  { id: "12::text", node_id: "12", input: "text", label: "文本", kind: "textarea", value: "1girl, solo" },
  { id: "7::seed", node_id: "7", input: "seed", label: "种子", kind: "number", value: 123456789 },
  { id: "7::steps", node_id: "7", input: "steps", label: "采样步数", kind: "number", value: 20, min: 1, max: 100, step: 1 },
  { id: "9::filename_prefix", node_id: "9", input: "filename_prefix", label: "文件名前缀", kind: "text", value: "ComfyUI" },
  { id: "11::batch_size", node_id: "11", input: "batch_size", label: "批量数量", kind: "number", value: 1, min: 1, max: 64, step: 1 },
];

const STEP_INDEX = FIELDS.findIndex((field) => field.id === "7::steps");
const SEED_CHAIN = ["fixed", "increment", "decrement", "randomize"];

/* 10 个节点：和画布一样，节点有几个输入就有几个 inputs 条目、顺序照抄。 */
const GRAPH = {
  nodes: [
    { id: "4", type: "CheckpointLoaderSimple", title: "Checkpoint 加载器", pos: [0, 0], group: "文本编码",
      links: [],
      inputs: [
        { name: "ckpt_name", value: "sd_xl_base_1.0.safetensors", type: "COMBO",
          options: ["sd_xl_base_1.0.safetensors", "sdxl_lightning_4step.safetensors"] },
      ],
      field_ids: ["4::ckpt_name"], has_editable: true },
    { id: "5", type: "CLIPTextEncode", title: "CLIP文本编码丨正向", pos: [400, 0], group: "文本编码",
      links: [{ name: "clip", node: "4", slot: 1 }],
      inputs: [
        { name: "clip", value: ["4", 1], type: "CLIP", link: { node: "4", slot: 1 } },
        { name: "text", value: "a landscape", type: "STRING", multiline: true },
      ],
      field_ids: ["5::text"], has_editable: true },
    { id: "6", type: "CLIPTextEncode", title: "CLIP文本编码丨反向", pos: [400, 300], group: "文本编码",
      links: [{ name: "clip", node: "4", slot: 2 }],
      inputs: [
        { name: "clip", value: ["4", 2], type: "CLIP", link: { node: "4", slot: 2 } },
        { name: "text", value: "", type: "STRING", multiline: true },
      ],
      field_ids: ["6::text"], has_editable: true },
    // 自制节点：标签模式 / 每次随机 被服务端的 NODE_HIDDEN_INPUTS 藏出 fields，
    // 高级页必须照样渲染（这是本次回归的主角）；mask 是前端不认识的类型。
    { id: "12", type: "MieTagEncode", title: "CLIP文本编码丨随机标签", pos: [400, 520], group: "文本编码",
      links: [{ name: "clip", node: "4", slot: 3 }],
      inputs: [
        { name: "clip", value: ["4", 3], type: "CLIP", link: { node: "4", slot: 3 } },
        { name: "text", value: "1girl, solo", type: "STRING", multiline: true },
        { name: "标签模式", value: "自定义", type: "COMBO", options: ["随机", "固定", "顺序"] },
        { name: "每次随机", value: true, type: "BOOLEAN" },
        { name: "mask", value: "", type: "MASK" },
      ],
      field_ids: ["12::text"], has_editable: true },
    { id: "7", type: "KSampler", title: "K采样器", pos: [800, 150], group: "采样",
      links: [{ name: "model", node: "4", slot: 0 }, { name: "positive", node: "5", slot: 0 }, { name: "negative", node: "6", slot: 0 }],
      inputs: [
        { name: "model", value: ["4", 0], type: "MODEL", link: { node: "4", slot: 0 } },
        { name: "positive", value: ["5", 0], type: "CONDITIONING", link: { node: "5", slot: 0 } },
        { name: "negative", value: ["6", 0], type: "CONDITIONING", link: { node: "6", slot: 0 } },
        { name: "seed", value: 123456789, type: "INT", min: 0, max: 1125899906842624, step: 1 },
        { name: "control_after_generate", value: "fixed", type: "COMBO", options: SEED_CHAIN, frontend: true },
        { name: "steps", value: 20, type: "INT", min: 1, max: 100, step: 1 },
        { name: "cfg", value: 7.5, type: "FLOAT", min: 0, max: 100, step: 0.1 },
        { name: "sampler_name", value: "euler", type: "COMBO", options: ["euler", "euler_ancestral", "dpmpp_2m"] },
        { name: "scheduler", value: "normal", type: "COMBO", options: ["normal", "karras", "beta"] },
        { name: "denoise", value: 1, type: "FLOAT", min: 0, max: 1, step: 0.01 },
      ],
      field_ids: ["7::seed", "7::steps"], has_editable: true },
    { id: "8", type: "VAEDecode", title: "VAE 解码", pos: [1200, 150], group: "输出",
      links: [{ name: "samples", node: "7", slot: 0 }],
      inputs: [
        { name: "samples", value: ["7", 0], type: "LATENT", link: { node: "7", slot: 0 } },
        { name: "vae", value: ["4", 2], type: "VAE", link: { node: "4", slot: 2 } },
      ],
      field_ids: [], has_editable: false },
    { id: "9", type: "SaveImage", title: "保存图像", pos: [1600, 150], group: "输出",
      links: [{ name: "images", node: "8", slot: 0 }],
      inputs: [
        { name: "images", value: ["8", 0], type: "IMAGE", link: { node: "8", slot: 0 } },
        { name: "filename_prefix", value: "ComfyUI", type: "STRING" },
      ],
      field_ids: ["9::filename_prefix"], has_editable: true },
    { id: "10", type: "LoraLoader", title: "LoRA 加载器", pos: [800, 500], group: "",
      links: [{ name: "model", node: "4", slot: 0 }],
      inputs: [
        { name: "model", value: ["4", 0], type: "MODEL", link: { node: "4", slot: 0 } },
        { name: "clip", value: ["4", 1], type: "CLIP", link: { node: "4", slot: 1 } },
        { name: "lora_name", value: "add_detail.safetensors", type: "COMBO", options: ["add_detail.safetensors", "none"] },
        { name: "strength_model", value: 0.8, type: "FLOAT", min: -10, max: 10, step: 0.01 },
        { name: "strength_clip", value: 0.8, type: "FLOAT", min: -10, max: 10, step: 0.01 },
      ],
      field_ids: [], has_editable: false },
    { id: "11", type: "EmptyLatentImage", title: "空 Latent 图像", pos: [1200, 500], group: "",
      links: [],
      inputs: [
        { name: "width", value: 1024, type: "INT", min: 16, max: 8192, step: 8 },
        { name: "height", value: 1024, type: "INT", min: 16, max: 8192, step: 8 },
        { name: "batch_size", value: 1, type: "INT", min: 1, max: 64, step: 1 },
      ],
      field_ids: ["11::batch_size"], has_editable: true },
    { id: "13", type: "Note", title: "备注", pos: [1600, 500], group: "",
      links: [], inputs: [], field_ids: [], has_editable: false },
    // 一个节点有两条出边（10 → 14 的 model / clip），而且 14 自己没有出边：
    // 输出区应当正好两条、各跳各的，14 的卡片上不该有输出区。
    { id: "14", type: "LoraLoaderModelOnly", title: "LoRA 支线采样", pos: [1600, 800], group: "",
      links: [{ name: "model", node: "10", slot: 0 }, { name: "clip", node: "10", slot: 1 }],
      inputs: [
        { name: "model", value: ["10", 0], type: "MODEL", link: { node: "10", slot: 0 } },
        { name: "clip", value: ["10", 1], type: "CLIP", link: { node: "10", slot: 1 } },
        { name: "strength", value: 1, type: "FLOAT", min: 0, max: 10, step: 0.01 },
      ],
      field_ids: [], has_editable: true },
  ],
  groups: [
    { id: "g0", title: "文本编码", color: "#3f789e", node_ids: ["4", "5", "6", "12"] },
    { id: "g1", title: "采样", color: "#a1309b", node_ids: ["7"] },
    { id: "g2", title: "输出", color: "#3f789e", node_ids: ["8", "9"] },
  ],
};

/* 旧数据：节点只有 field_ids，没有 inputs（还有一条指向不存在字段的脏 id）。 */
const LEGACY_GRAPH = {
  nodes: [
    { id: "4", type: "CheckpointLoaderSimple", title: "Checkpoint 加载器", pos: [0, 0], group: "文本编码",
      links: [], field_ids: ["4::ckpt_name"], has_editable: true },
    { id: "5", type: "CLIPTextEncode", title: "CLIP文本编码丨正向", pos: [400, 0], group: "文本编码",
      links: [{ name: "clip", node: "4", slot: 1 }], field_ids: ["5::text"], has_editable: true },
    { id: "7", type: "KSampler", title: "K采样器", pos: [800, 150], group: "采样",
      links: [{ name: "model", node: "4", slot: 0 }, { name: "positive", node: "5", slot: 0 }],
      field_ids: ["7::seed", "7::steps"], has_editable: true },
    { id: "8", type: "VAEDecode", title: "VAE 解码", pos: [1200, 150], group: "",
      links: [{ name: "samples", node: "7", slot: 0 }], field_ids: ["8::missing"], has_editable: false },
  ],
  groups: [
    { id: "g0", title: "文本编码", color: "#3f789e", node_ids: ["4", "5"] },
    { id: "g1", title: "采样", color: "#a1309b", node_ids: ["7"] },
  ],
};

const WORKFLOW = { id: "0a1b2c3d4e5f60718293", name: "高级页夹具工作流", node_count: 10, fields: FIELDS, graph: GRAPH };
const LEGACY_WORKFLOW = { id: "legacy-workflow", name: "旧数据工作流", node_count: 4, fields: FIELDS, graph: LEGACY_GRAPH };
const EMPTY_WORKFLOW = { id: "empty-workflow", name: "空工作流", node_count: 0, fields: [], graph: { nodes: [], groups: [] } };

const NODE_COUNT = GRAPH.nodes.length;      // 11
const GROUP_COUNT = 4;                      // 3 个命名组 + 未分组
// 可编辑输入（去掉连线的和类型不认识的）：1+1+1+3+7+0+1+3+3+0+1 = 21
const EDITABLE_COUNT = 21;
const LEGACY_NODE_COUNT = LEGACY_GRAPH.nodes.length;   // 4
const LEGACY_EDITABLE_COUNT = 4;                        // 脏 id 8::missing 不算

/* ------------------------------------------------------------------ 假依赖 */

const HARNESS = String.raw`
(function () {
  var fixture = window.__FIXTURE__;
  var legacy = window.__LEGACY__ === true;   // 旧数据：节点只有 field_ids
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
      "已连接：来自 {name}": "Connected: from {name}",
      "← 输入来自": "← Input from", "→ 输出到": "→ Output to",
      "选择要跳转的节点": "Choose a node to jump to",
      "此类型暂不支持编辑": "This type is not editable yet",
      "输入值无效": "Invalid input value",
      "仅手机端设置": "Phone-only setting",
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

  var workflow = legacy ? fixture.legacy : (empty ? fixture.empty : fixture.workflow);
  var state = {
    workflow: workflow,
    values: {},
    fieldControls: new Map(),
  };
  var fields = workflow.fields || [];
  fields.forEach(function (field) { state.values[field.id] = field.value; });

  var calls = [];
  function updateFieldValue(field, value) {
    state.values[field.id] = value;
    calls.push({ id: field.id, value: value, node_id: field.node_id, input: field.input, kind: field.kind, initial: field.value });
  }

  // 生成页的控件（app.js 里那一套）：高级页不该再碰它，这里留着做对照。
  var renderFieldCalls = 0;
  function renderField(field, index, compact, controls) {
    renderFieldCalls += 1;
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
    if (controls && typeof controls.set === "function") controls.set(field.id, control);
    else state.fieldControls.set(field.id, control);
    return wrapper;
  }

  // 生成页先渲染（app.js 就是这个顺序），高级页随后挂载。
  var gen = document.getElementById("genFields");
  fields.forEach(function (field, index) { gen.append(renderField(field, index, false, state.fieldControls)); });

  window.__state = state;
  window.__calls = calls;
  window.__renderFieldCalls = function () { return renderFieldCalls; };
  renderFieldCalls = 0;   // 从挂载开始只统计高级页触发的 renderField 调用

  window.MobileAdvanced.mount({
    t: t,
    state: state,
    renderField: renderField,          // 注入仍然给，但高级页不该用它
    updateFieldValue: updateFieldValue,
    $: function (id) { return document.getElementById(id); },
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
    '<script>window.__FIXTURE__ = ' + JSON.stringify({ workflow: WORKFLOW, legacy: LEGACY_WORKFLOW, empty: EMPTY_WORKFLOW }) + ';' +
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
const inputRow = (page, nodeId, name) => page.locator('[data-node-id="' + nodeId + '"] .advanced-input[data-input-name="' + name + '"]');
const openNodeCard = (page, nodeId) => page.locator('[data-node-id="' + nodeId + '"] .advanced-node-toggle').click();

function expectNoErrors(errors) {
  assert.deepEqual(errors, [], "页面不应有 pageerror / console error：\n" + errors.join("\n"));
}

/* -------------------------------------------------------------------- 用例 */

test("页面结构：组与节点数量、状态行、样式、顺序都正确", async () => {
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
      ["4", "5", "6", "12", "7", "8", "9", "10", "11", "13", "14"]);
    // 一个输入都没有的节点展开后显示灰字提示，而不是白屏
    await openNodeCard(page, "13");
    assert.equal(await page.locator('[data-node-id="13"] .advanced-node-empty').textContent(), "无可调参数");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("控件映射：每个输入 1:1 一个控件，类型/选项/范围/只读都对", async () => {
  const { context, page, errors } = await openHarness();
  try {
    assert.equal(FIELDS.some((field) => field.id === "12::标签模式"), false, "夹具里标签模式确实不在 fields 里");
    await openNodeCard(page, "12");

    const rows = page.locator('[data-node-id="12"] .advanced-input');
    assert.equal(await rows.count(), 5, "节点有几个输入就几个控件（含连线与不支持的类型）");
    assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.inputName)),
      ["clip", "text", "标签模式", "每次随机", "mask"], "顺序照抄服务端 inputs");
    // 输入名不翻译（必须与画布/API 一致），右上角是类型小字
    assert.deepEqual(await rows.locator(".advanced-input-name").evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ["clip", "text", "标签模式", "每次随机", "mask"]);
    assert.deepEqual(await rows.locator(".advanced-input-type").evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ["CLIP", "STRING", "COMBO", "BOOLEAN", "MASK"]);
    // 被连线接管的输入：行内就是「← 对端节点标题 · 插槽号」方向按钮，没有可编辑控件
    const clip = inputRow(page, "12", "clip");
    const clipLink = clip.locator(".advanced-input-head .advanced-link.is-in");
    assert.equal(await clipLink.locator(".advanced-link-arrow").textContent(), "←");
    assert.equal(await clipLink.locator(".advanced-link-text").textContent(), "Checkpoint 加载器 · 3");
    assert.equal(await clipLink.getAttribute("data-jump"), "4", "按钮指向连线源节点");
    assert.equal(await clipLink.getAttribute("aria-label"), "已连接：来自 Checkpoint 加载器");
    assert.equal(await clip.locator("input, select, textarea").count(), 0, "连线输入不给可编辑控件");
    // 没被连线的输入行照旧是可编辑控件
    assert.equal(await inputRow(page, "12", "text").locator("textarea").count(), 1);
    assert.equal(await inputRow(page, "12", "mask").locator(".advanced-input-hint").count(), 1);
    // 多行 STRING → textarea rows=2
    const text = inputRow(page, "12", "text").locator("textarea");
    assert.equal(await text.count(), 1);
    assert.equal(await text.getAttribute("rows"), "2");
    assert.equal(await text.inputValue(), "1girl, solo");
    // COMBO（当前值不在候选里 → 补一项在最前）
    const mode = inputRow(page, "12", "标签模式").locator("select");
    assert.deepEqual(await mode.locator("option").evaluateAll((options) => options.map((option) => option.value)),
      ["自定义", "随机", "固定", "顺序"]);
    assert.equal(await mode.inputValue(), "自定义");
    // BOOLEAN → 复选框
    assert.equal(await inputRow(page, "12", "每次随机").locator('input[type="checkbox"]').isChecked(), true);
    // 不认识的类型 → 只读文本 + 灰字，不崩
    const mask = inputRow(page, "12", "mask");
    assert.equal(await mask.locator(".advanced-input-hint").textContent(), "此类型暂不支持编辑");
    assert.equal(await mask.locator("input, select, textarea").count(), 0);

    await openNodeCard(page, "7");
    // INT 带 min/max/step
    const steps = inputRow(page, "7", "steps").locator('input[type="number"]');
    assert.equal(await steps.getAttribute("min"), "1");
    assert.equal(await steps.getAttribute("max"), "100");
    assert.equal(await steps.getAttribute("step"), "1");
    assert.equal(await steps.inputValue(), "20");
    // FLOAT 也是数字输入，候选值、范围照抄
    const cfg = inputRow(page, "7", "cfg").locator('input[type="number"]');
    assert.equal(await cfg.inputValue(), "7.5");
    assert.equal(await cfg.getAttribute("step"), "0.1");
    assert.deepEqual(await inputRow(page, "7", "sampler_name").locator("option").evaluateAll((options) => options.map((option) => option.value)),
      ["euler", "euler_ancestral", "dpmpp_2m"]);
    // 前端专有控件：照 COMBO 渲染，旁边一句灰字
    const chain = inputRow(page, "7", "control_after_generate");
    assert.deepEqual(await chain.locator("option").evaluateAll((options) => options.map((option) => option.value)), SEED_CHAIN);
    assert.equal(await chain.locator(".advanced-input-note").textContent(), "仅手机端设置");
    assert.equal(await chain.getAttribute("data-input-frontend"), "1");

    // 单行 STRING → input[type=text]
    await openNodeCard(page, "9");
    const prefix = inputRow(page, "9", "filename_prefix").locator('input[type="text"]');
    assert.equal(await prefix.count(), 1);
    assert.equal(await prefix.inputValue(), "ComfyUI");

    // 高级页不再使用生成页的 renderField，也不占用 field-<下标> 的 id
    assert.equal(await page.evaluate(() => window.__renderFieldCalls()), 0, "高级页不该调用注入的 renderField");
    assert.equal(await page.locator('#advancedList [id^="field-"]').count(), 0, "高级页控件不该复用生成页的 id");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("改值：合成 field 写进 state.values，已修改星标按服务器初始值判定", async () => {
  const { context, page, errors } = await openHarness();
  try {
    await openNodeCard(page, "7");
    const card = page.locator('[data-node-id="7"]');
    assert.equal(await card.locator(".advanced-node-modified").count(), 0, "没改过时不显示星标");

    const steps = inputRow(page, "7", "steps").locator("input");
    await steps.fill("33");
    // 数字字段给 number，键是「节点::输入名」，回调收到合成 field
    assert.deepEqual(await page.evaluate(() => [window.__state.values["7::steps"], window.__calls.slice(-1)[0]]),
      [33, { id: "7::steps", node_id: "7", input: "steps", kind: "number", initial: 20, value: 33 }]);
    assert.equal(await card.locator(".advanced-node-modified").count(), 1, "改过之后显示已修改星标");
    assert.equal(await page.evaluate((index) => document.getElementById("field-" + index).value, STEP_INDEX), "20",
      "高级页不再去同步生成页控件");

    await steps.fill("20");
    assert.equal(await card.locator(".advanced-node-modified").count(), 0, "改回初始值后星标消失");

    // 空/非数字：不写进去，只提示，也不算已修改
    const warning = inputRow(page, "7", "steps").locator(".advanced-input-warning");
    await steps.fill("");
    assert.equal(await warning.isVisible(), true);
    assert.equal(await warning.textContent(), "输入值无效");
    assert.equal(await page.evaluate(() => window.__state.values["7::steps"]), 20, "非法值不许写进 state.values");
    assert.equal(await card.locator(".advanced-node-modified").count(), 0);
    await steps.fill("20");
    assert.equal(await warning.isVisible(), false, "值合法后提示消失");

    // COMBO / BOOLEAN / 前端专有控件同样按「节点::输入名」写回
    await openNodeCard(page, "12");
    const tagCard = page.locator('[data-node-id="12"]');
    await inputRow(page, "12", "标签模式").locator("select").selectOption("固定");
    assert.equal(await page.evaluate(() => window.__state.values["12::标签模式"]), "固定");
    await inputRow(page, "12", "每次随机").locator('input[type="checkbox"]').uncheck();
    assert.equal(await page.evaluate(() => window.__state.values["12::每次随机"]), false);
    assert.equal(await tagCard.locator(".advanced-node-modified").count(), 1, "节点里任一输入改过就亮星标");
    await inputRow(page, "7", "control_after_generate").locator("select").selectOption("randomize");
    assert.equal(await page.evaluate(() => window.__state.values["7::control_after_generate"]), "randomize");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("生成页改完再切回高级页，控件按 state.values 整块重渲染", async () => {
  const { context, page, errors } = await openHarness();
  try {
    await openNodeCard(page, "7");
    await page.evaluate((index) => {
      const control = document.getElementById("field-" + index);
      control.value = "48";
      control.dispatchEvent(new Event("input", { bubbles: true }));
    }, STEP_INDEX);
    assert.equal(await page.evaluate(() => window.__state.values["7::steps"]), 48);
    await page.evaluate(() => window.MobileAdvanced.show());
    assert.equal(await inputRow(page, "7", "steps").locator("input").inputValue(), "48");
    assert.equal(await page.locator('[data-node-id="7"] .advanced-node-modified').count(), 1,
      "和服务器给的初始值不同就该亮星标");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("syncValue / syncAll 只对齐控件显示，不整块重渲染", async () => {
  const { context, page, errors } = await openHarness();
  try {
    await openNodeCard(page, "7");
    await openNodeCard(page, "12");
    const steps = inputRow(page, "7", "steps").locator("input");
    await steps.evaluate((node) => { node.dataset.marker = "kept"; });

    await page.evaluate(() => { window.MobileAdvanced.syncValue("7::steps", 48); });
    assert.equal(await steps.inputValue(), "48");
    assert.equal(await steps.evaluate((node) => node.dataset.marker), "kept", "syncValue 不能整块重渲染");
    assert.equal(await page.evaluate(() => window.__state.values["7::steps"]), 20, "syncValue 只管显示，不改 state.values");
    // 控件不存在（没渲染 / 键不对）时静默返回
    assert.equal(await page.evaluate(() => { window.MobileAdvanced.syncValue("99::ghost", 1); return "ok"; }), "ok");
    assert.equal(await page.evaluate(() => { window.MobileAdvanced.syncValue("7::model", 1); return "ok"; }), "ok");

    // 生成页把值改了：syncValue 一处、syncAll 一处
    await page.evaluate(() => {
      window.__state.values["7::steps"] = 33;
      window.__state.values["12::标签模式"] = "顺序";
      window.__state.values["12::每次随机"] = false;
      window.MobileAdvanced.syncAll();
    });
    assert.equal(await steps.inputValue(), "33");
    assert.equal(await inputRow(page, "12", "标签模式").locator("select").inputValue(), "顺序");
    assert.equal(await inputRow(page, "12", "每次随机").locator('input[type="checkbox"]').isChecked(), false);
    assert.equal(await page.locator('[data-node-id="7"] .advanced-node-modified').count(), 1);
    assert.equal(await page.locator('[data-node-id="12"] .advanced-node-modified').count(), 1);

    // 回到初始值 → 星标消失，syncValue 也能给 select 补候选里没有的值
    await page.evaluate(() => {
      window.__state.values["7::steps"] = 20;
      window.__state.values["12::标签模式"] = "自定义";
      window.__state.values["12::每次随机"] = true;
      window.MobileAdvanced.syncValue("12::标签模式", "自定义");
      window.MobileAdvanced.syncAll();
    });
    assert.equal(await steps.inputValue(), "20");
    assert.equal(await page.locator('[data-node-id="7"] .advanced-node-modified').count(), 0, "对齐回初始值后星标消失");
    assert.equal(await page.locator('[data-node-id="12"] .advanced-node-modified').count(), 0);

    await page.evaluate(() => { window.MobileAdvanced.syncValue("12::标签模式", "候选外的新模式"); });
    const mode = inputRow(page, "12", "标签模式").locator("select");
    assert.equal(await mode.inputValue(), "候选外的新模式");
    assert.equal(await mode.locator('option[value="候选外的新模式"]').count(), 1, "候选里没有的值也要补一项");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("整块重渲染时保留正在编辑的控件焦点与光标", async () => {
  const { context, page, errors } = await openHarness();
  try {
    await openNodeCard(page, "12");
    const area = inputRow(page, "12", "text").locator("textarea");
    await area.focus();
    await area.evaluate((node) => node.setSelectionRange(2, 5));
    // 展开收起会整块重渲染
    await page.evaluate(() => window.MobileAdvanced.toggleAll());
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      const row = active && active.closest ? active.closest("[data-value-key]") : null;
      return {
        key: row ? row.dataset.valueKey : "",
        start: active ? active.selectionStart : null,
        end: active ? active.selectionEnd : null,
      };
    });
    assert.deepEqual(focused, { key: "12::text", start: 2, end: 5 }, "重渲染后焦点与光标都要还回来");

    // 在输入框里改值本身不触发重渲染（不打断打字）
    await area.evaluate((node) => { node.dataset.marker = "kept"; });
    await area.fill("a landscape");
    assert.equal(await area.evaluate((node) => node.dataset.marker), "kept", "改单个控件不能整块重渲染");
    assert.equal(await page.evaluate(() => window.__state.values["12::text"]), "a landscape");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("行内连接：输入行与输出区的方向按钮都能跳转、清搜索、展开并高亮", async () => {
  const { context, page, errors } = await openHarness();
  try {
    // 先把目标组收起来，再看跳转能不能把它展开
    await page.locator('.advanced-group[data-group-id="g0"] summary').click();
    assert.equal(await page.locator('.advanced-group[data-group-id="g0"]').evaluate((node) => node.open), false);

    // 搜到只剩下 KSampler，此时目标节点 5 是被过滤掉的
    await page.locator("#advancedSearch").fill("K采样器");
    assert.equal(await nodeCards(page).count(), 1);
    assert.equal(await page.locator('[data-node-id="5"]').count(), 0);

    // 输入行里的方向按钮：← 对端节点标题 · 插槽号
    const button = inputRow(page, "7", "positive").locator(".advanced-input-head .advanced-link.is-in");
    assert.equal(await button.locator(".advanced-link-text").textContent(), "CLIP文本编码丨正向 · 0");
    assert.equal(await button.getAttribute("data-jump"), "5");
    await button.click();

    assert.equal(await page.locator("#advancedSearch").inputValue(), "", "跳转前要清空搜索");
    assert.equal(await page.locator('.advanced-group[data-group-id="g0"]').evaluate((node) => node.open), true, "目标组要展开");
    const target = page.locator('[data-node-id="5"]');
    assert.equal(await target.locator(".advanced-node-toggle").getAttribute("aria-expanded"), "true", "目标节点要展开");
    assert.equal(await target.evaluate((node) => node.classList.contains("is-flash")), true, "目标节点要有 is-flash");

    // is-flash 只亮 1.2 秒
    await page.waitForFunction(() => !document.querySelector('.advanced-node[data-node-id="5"]').classList.contains("is-flash"),
      null, { timeout: 15000, polling: 100 });
    assert.equal(await target.evaluate((node) => node.classList.contains("is-flash")), false, "1.2 秒后自动褪色");

    // 被连线接管的输入行里没有可编辑控件；没被连线的输入行控件照旧
    assert.equal(await inputRow(page, "7", "model").locator("input, select, textarea").count(), 0);
    assert.equal(await inputRow(page, "7", "steps").locator('input[type="number"]').count(), 1);
    assert.equal(await inputRow(page, "7", "cfg").locator('input[type="number"]').inputValue(), "7.5");

    // 输入行按钮：点一下跳到连线源节点
    await page.evaluate(() => window.MobileAdvanced.openNode("7"));
    const inputLink = inputRow(page, "7", "model").locator(".advanced-input-head .advanced-link.is-in");
    assert.equal(await inputLink.locator(".advanced-link-text").textContent(), "Checkpoint 加载器 · 0");
    assert.equal(await inputLink.getAttribute("aria-label"), "已连接：来自 Checkpoint 加载器");
    await inputLink.click();
    assert.equal(await page.locator('.advanced-node[data-node-id="4"]').evaluate((node) => node.classList.contains("is-flash")), true,
      "输入行按钮要跳到连线源节点");

    // 输出区 + 滚动到视野内
    await page.evaluate(() => window.MobileAdvanced.openNode("7"));
    await page.waitForFunction(() => {
      const card = document.querySelector('.advanced-node[data-node-id="7"]');
      const box = card.getBoundingClientRect();
      const view = document.getElementById("mainContent").getBoundingClientRect();
      return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
    }, null, { timeout: 15000 });
    const outRow = page.locator('[data-node-id="7"] .advanced-node-outputs .advanced-link-row.is-out');
    assert.equal(await outRow.count(), 1);
    assert.equal(await outRow.locator(".advanced-link.is-out .advanced-link-text").textContent(), "VAE 解码 · samples");
    assert.equal(await outRow.locator(".advanced-link-count").count(), 0, "单个连接不标条数");
    await outRow.locator(".advanced-link").click();
    assert.equal(await page.locator('.advanced-node[data-node-id="8"]').evaluate((node) => node.classList.contains("is-flash")), true,
      "输出区的按钮要跳到对端节点");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("输出区：一个节点两条出边就是两条、各跳各的；无出边不显示这块", async () => {
  const { context, page, errors } = await openHarness();
  try {
    // 顶部图例：灰字说明方向按钮怎么读
    assert.deepEqual(await page.locator(".advanced-legend span").evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ["← 输入来自", "→ 输出到"]);

    // LoRA 加载器有两条出边（都指向 14 号），一条一个方向按钮
    await openNodeCard(page, "10");
    const rows = page.locator('[data-node-id="10"] .advanced-node-outputs .advanced-link-row.is-out');
    assert.equal(await rows.count(), 2, "两条出边就是两条");
    assert.deepEqual(await rows.locator(".advanced-link-text").evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ["LoRA 支线采样 · model", "LoRA 支线采样 · clip"], "每条写对端节点标题 · 对端输入名");
    assert.deepEqual(await rows.locator(".advanced-link").evaluateAll((nodes) => nodes.map((node) => node.dataset.input)),
      ["model", "clip"]);
    assert.equal(await page.locator('[data-node-id="10"] .advanced-node-outputs .advanced-link-count').count(), 0,
      "每个输出槽只接了一个节点，不标条数");

    // 单条连接：直接跳，不弹菜单
    await rows.first().locator(".advanced-link").click();
    assert.equal(await page.locator(".advanced-menu").count(), 0, "只有一条连接时不弹菜单");
    assert.equal(await page.locator('.advanced-node[data-node-id="14"] .advanced-node-toggle').getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator('.advanced-node[data-node-id="14"]').evaluate((node) => node.classList.contains("is-flash")), true);

    // 没有出边的节点不显示输出区
    await page.evaluate(() => window.MobileAdvanced.openNode("9"));
    assert.equal(await page.locator('[data-node-id="9"] .advanced-node-outputs').count(), 0, "保存图像没有出边");
    assert.equal(await page.locator('[data-node-id="14"] .advanced-node-outputs').count(), 0, "LoRA 支线采样没有出边");

    // 一个节点被两个节点连入：两行各自指向自己的源节点，行内没有可编辑控件
    await page.evaluate(() => window.MobileAdvanced.openNode("8"));
    const linked = page.locator('[data-node-id="8"] .advanced-input[data-input-linked="1"]');
    assert.equal(await linked.count(), 2);
    assert.deepEqual(await linked.locator(".advanced-link-text").evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ["K采样器 · 0", "Checkpoint 加载器 · 2"]);
    assert.deepEqual(await linked.locator(".advanced-link").evaluateAll((nodes) => nodes.map((node) => node.dataset.jump)),
      ["7", "4"]);
    assert.equal(await linked.locator("input, select, textarea").count(), 0);
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("多连接菜单：一个输出槽接了多个节点时先弹就地菜单，选谁跳谁", async () => {
  const { context, page, errors } = await openHarness();
  try {
    // 4 号节点的输出槽 0 同时接到 7.model 与 10.model
    const menuRow = () => page.locator('[data-node-id="4"] .advanced-node-outputs .advanced-link-row.is-out')
      .filter({ has: page.locator('[data-jump="7"][data-input="model"]') });
    assert.equal(await menuRow().count(), 1);
    assert.equal(await menuRow().locator(".advanced-link").getAttribute("data-multi"), "1");
    assert.equal(await menuRow().locator(".advanced-link-count").textContent(), "2", "多连接要标条数");
    await menuRow().locator(".advanced-link").click();

    const menu = page.locator(".advanced-menu");
    assert.equal(await menu.count(), 1, "多连接要先弹菜单");
    assert.equal(await menu.getAttribute("role"), "menu");
    assert.equal(await menu.locator(".advanced-menu-title").textContent(), "选择要跳转的节点");
    // 菜单项 = 对端节点标题 + 插槽名
    assert.deepEqual(await menu.locator(".advanced-menu-item").evaluateAll((items) => items.map((item) => item.dataset.jump)),
      ["7", "10"]);
    assert.deepEqual(await menu.locator(".advanced-menu-node").evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ["K采样器", "LoRA 加载器"]);
    assert.deepEqual(await menu.locator(".advanced-menu-slot").evaluateAll((nodes) => nodes.map((node) => node.textContent)),
      ["model", "model"]);
    // 就地浮层：落在视口里
    const box = await menu.boundingBox();
    const view = page.viewportSize();
    assert.equal(box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width + 1 && box.y + box.height <= view.height + 1,
      true, "菜单要在视口内：" + JSON.stringify(box));

    // 选「LoRA 加载器」→ 跳到 10 号并高亮，菜单关掉
    await menu.locator('.advanced-menu-item[data-jump="10"]').click();
    assert.equal(await page.locator(".advanced-menu").count(), 0, "选完要关掉菜单");
    assert.equal(await page.locator('.advanced-node[data-node-id="10"] .advanced-node-toggle').getAttribute("aria-expanded"), "true",
      "菜单项跳转也要展开目标节点");
    assert.equal(await page.locator('.advanced-node[data-node-id="10"]').evaluate((node) => node.classList.contains("is-flash")), true);

    // Esc 关菜单
    await menuRow().locator(".advanced-link").click();
    assert.equal(await page.locator(".advanced-menu").count(), 1);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".advanced-menu").count(), 0, "Esc 要关掉菜单");

    // 点空白处关菜单
    await menuRow().locator(".advanced-link").click();
    assert.equal(await page.locator(".advanced-menu").count(), 1);
    await page.mouse.click(4, 4);
    assert.equal(await page.locator(".advanced-menu").count(), 0, "点空白处要关掉菜单");

    // 重渲染（展开/收起）也会把菜单收掉，不留孤儿浮层
    await menuRow().locator(".advanced-link").click();
    assert.equal(await page.locator(".advanced-menu").count(), 1);
    await page.evaluate(() => window.MobileAdvanced.toggleAll());
    assert.equal(await page.locator(".advanced-menu").count(), 0, "重渲染要关掉菜单");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("组可以折叠，折叠状态写进 localStorage；全部展开/收起", async () => {
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
      ["true", "true", "true", "true", "true", "true", "true", "true", "true", "true", "true"]);
    await page.locator("#advancedExpandButton").click();
    assert.equal(await page.locator("#advancedExpandButton").getAttribute("aria-pressed"), "false");
    assert.deepEqual(await groupCards(page).evaluateAll((nodes) => nodes.map((node) => node.open)), [false, false, false, false], "全部收起");
    await expectNoErrors(errors);
  } finally {
    await context.close();
  }
});

test("搜索：子串 / 子序列都能命中并高亮，无命中显示空提示", async () => {
  const { context, page, errors } = await openHarness();
  try {
    await page.locator("#advancedSearch").fill("文本编码");
    assert.equal(await nodeCards(page).count(), 3, "标题命中三个编码节点");
    assert.deepEqual(await nodeCards(page).evaluateAll((nodes) => nodes.map((node) => node.dataset.nodeId)), ["5", "6", "12"]);
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

test("向后兼容：节点只有旧 field_ids（没有 inputs）也能用，不白屏", async () => {
  const { context, page, errors } = await openHarness({ legacy: true });
  try {
    assert.equal(await nodeCards(page).count(), LEGACY_NODE_COUNT);
    assert.equal(await groupCards(page).count(), 3, "文本编码 / 采样 / 未分组");
    assert.equal(await page.locator("#advancedStatus").textContent(),
      LEGACY_NODE_COUNT + " 个节点 · " + LEGACY_EDITABLE_COUNT + " 个可调参数");

    await openNodeCard(page, "7");
    const rows = page.locator('[data-node-id="7"] .advanced-input');
    assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.inputName)), ["seed", "steps"],
      "退化成 field_ids 里的输入名（就是 API 键名）");
    const steps = inputRow(page, "7", "steps").locator('input[type="number"]');
    assert.equal(await steps.getAttribute("min"), "1");
    assert.equal(await steps.inputValue(), "20");
    await steps.fill("35");
    assert.deepEqual(await page.evaluate(() => [window.__state.values["7::steps"], window.__calls.slice(-1)[0].id]), [35, "7::steps"]);
    assert.equal(await page.locator('[data-node-id="7"] .advanced-node-modified').count(), 1, "旧数据也要有已修改星标");
    // 旧 select 字段也能用
    await openNodeCard(page, "4");
    assert.deepEqual(await inputRow(page, "4", "ckpt_name").locator("option").evaluateAll((options) => options.map((option) => option.value)),
      ["sd_xl_base_1.0.safetensors", "sdxl_lightning_4step.safetensors"]);
    // 旧数据没有 inputs：连线名找不到对应的输入行时，单独列成只读连线行，控件行不受影响
    await openNodeCard(page, "5");
    const orphan = page.locator('[data-node-id="5"] .advanced-link-row.is-orphan .advanced-link');
    assert.equal(await orphan.count(), 1);
    assert.equal(await orphan.locator(".advanced-link-text").textContent(), "Checkpoint 加载器 · 1");
    assert.equal(await orphan.getAttribute("data-jump"), "4");
    assert.equal(await page.locator('[data-node-id="5"] .advanced-input[data-input-name]').count(), 1,
      "只读连线行不能挤进控件行");
    // 出边照样反推得出来（7 → 8 的 samples）
    assert.equal(await page.locator('[data-node-id="7"] .advanced-node-outputs .advanced-link-text').textContent(), "VAE 解码 · samples");
    // 生成页的控件表原封不动
    assert.equal(await page.evaluate((index) => window.__state.fieldControls.get("7::steps") === document.getElementById("field-" + index), STEP_INDEX),
      true, "state.fieldControls 必须仍指向生成页控件");
    // 指向不存在字段的脏 id：跳过、不崩
    await openNodeCard(page, "8");
    assert.equal(await page.locator('[data-node-id="8"] .advanced-node-empty').textContent(), "无可调参数");
    // 高级页仍然不碰 renderField
    assert.equal(await page.evaluate(() => window.__renderFieldCalls()), 0);
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

test("四种尺寸/语言截图（含跳转高亮与全控件演示）", { timeout: 180000 }, async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const shots = [];

  const zh = await openHarness({ width: 390, height: 844 });
  try {
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-default.png") });
    // 展开态：KSampler 的数字输入 + 前端专有控件（仅手机端设置）
    await openNodeCard(zh.page, "7");
    await zh.page.evaluate(() => document.querySelector('.advanced-node[data-node-id="7"]').scrollIntoView({ block: "center" }));
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-expanded.png") });
    // 全控件演示：连线芯片 / 多行文本 / 下拉 / 复选框 / 不支持的类型
    await openNodeCard(zh.page, "12");
    await zh.page.evaluate(() => {
      document.querySelector('.advanced-node[data-node-id="12"]').scrollIntoView({ block: "center" });
      document.getElementById("mainContent").scrollTop += 260;
    });
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-inputs.png") });
    await zh.page.evaluate(() => window.MobileAdvanced.openNode("5"));
    await zh.page.waitForFunction(() => document.querySelector('.advanced-node[data-node-id="5"]').classList.contains("is-flash"));
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-jump-flash.png") });
    // 行内连线：被连线的输入行 + 卡片底部「→ 输出到」区
    await zh.page.evaluate(() => window.MobileAdvanced.openNode("7"));
    await zh.page.evaluate(() => document.querySelector('.advanced-node[data-node-id="7"]').scrollIntoView({ block: "center" }));
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-links.png") });
    // 一个输出槽接了多个节点：点方向按钮先弹就地菜单
    await zh.page.evaluate(() => window.MobileAdvanced.openNode("4"));
    await zh.page.locator('[data-node-id="4"] .advanced-node-outputs .advanced-link-row.is-out')
      .filter({ has: zh.page.locator('[data-jump="7"][data-input="model"]') }).locator(".advanced-link").click();
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-menu.png") });
    await zh.page.keyboard.press("Escape");

    await zh.page.locator("#advancedSearch").fill("编码");
    await zh.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-zh-search.png") });
    expectNoErrors(zh.errors);
  } finally {
    await zh.context.close();
  }
  shots.push("advanced-390x844-zh-default.png", "advanced-390x844-zh-expanded.png", "advanced-390x844-zh-inputs.png",
    "advanced-390x844-zh-jump-flash.png", "advanced-390x844-zh-links.png", "advanced-390x844-zh-menu.png",
    "advanced-390x844-zh-search.png");

  const en = await openHarness({ width: 390, height: 844, lang: "en" });
  try {
    await en.page.screenshot({ path: path.join(SHOT_DIR, "advanced-390x844-en-default.png") });
    await openNodeCard(en.page, "7");
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
    await openNodeCard(narrowOpen.page, "7");
    await narrowOpen.page.evaluate(() => { document.getElementById("mainContent").scrollTop = 0; });
    await narrowOpen.page.screenshot({ path: path.join(SHOT_DIR, "advanced-320x640-zh-expanded.png") });
    // 320 窄屏：行内连线 + 输出区（重点看有没有被挤破）
    await narrowOpen.page.evaluate(() => document.querySelector('.advanced-node[data-node-id="7"]').scrollIntoView({ block: "center" }));
    await narrowOpen.page.waitForTimeout(200);
    await narrowOpen.page.screenshot({ path: path.join(SHOT_DIR, "advanced-320x640-zh-links.png") });
    expectNoErrors(narrowOpen.errors);
  } finally {
    await narrowOpen.context.close();
  }
  shots.push("advanced-320x640-zh-expanded.png", "advanced-320x640-zh-links.png");

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
