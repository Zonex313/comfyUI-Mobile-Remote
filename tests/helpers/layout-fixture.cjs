"use strict";

// Only source assets are read. All API responses and writes live in memory;
// this fixture never loads Python or touches the user's history/settings files.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const ROOT = path.resolve(__dirname, "../..");
const LONG_TAG = "ExtraordinarilyLongUnbrokenLandscapeDescriptionForLayoutTesting";
const catalog = { categories: [{ id: "scene", label: "Landscape and environment", slots: [
  { id: "subject", label: "Subject description", pool: ["mountains", "forest", LONG_TAG] },
  { id: "light", label: "Lighting", pool: ["daylight", "moonlight"] },
  { id: "style", label: "Style", pool: ["photographic", "watercolor"] },
] }], rules: { mutex: [["mountains", "forest"]], singletons: [], skipCategories: [] } };
const field = (input, label, kind, value, extra = {}) => ({ id: input, node_id: "1", input, label, kind, value, ...extra });
const workflow = { id: "0a1b2c3d4e5f60718293", name: "Landscape workflow for layout testing", node_count: 10, pinned: true,
  source: "workflows/Examples/landscape.json", library_path: "Examples/landscape.json", fields: [
    field("positive", "正向提示词", "textarea", "a landscape", { group: "basic" }),
    field("negative", "反向提示词", "textarea", ""),
    field("ckpt_name", "模型", "select", "landscape.safetensors", { group: "basic", options: ["landscape.safetensors", LONG_TAG + ".safetensors"] }),
    field("width", "宽度", "number", 1024, { min: 64, max: 4096, step: 64 }),
    field("height", "高度", "number", 1024, { min: 64, max: 4096, step: 64 }),
    field("batch_size", "批量数量", "number", 1, { min: 1, max: 64, step: 1 }),
    field("seed", "种子", "number", 123456789012345, { randomizable: true }),
    field("steps", "采样步数", "number", 20, { min: 1, max: 100, step: 1 }),
    field("cfg", "CFG", "number", 7),
    field("denoise", "重绘幅度", "number", 1, { min: 0, max: 1, step: 0.01 }),
    field("sampler_name", "采样器", "select", "euler", { options: ["euler", "dpmpp_2m"] }),
    field("image", "图像", "image", ""),
  ] };
const output = { filename: "layout.png", subfolder: "", type: "output", kind: "image" };
const output2 = { filename: "layout-2.png", subfolder: "", type: "output", kind: "image" };
// 10 个排队任务 = 连发 10 次之后的真实状态：历史页要能忽略未完成任务，
// 顶栏的「运行 / 排队」计数与「停止全部」按钮也靠它撑出真实数字。
const pendingJobs = Array.from({ length: 10 }, (_, index) => ({
  id: `layout-pending-${index}`,
  status: "pending",
  create_time: Date.now(),   // 刚入队：和真实排队任务一样是最新的时间戳
  workflow_name: workflow.name,
  model_name: index % 2 ? "landscape-v2.safetensors" : "landscape.safetensors",
  positive_prompt: `a landscape with mountains and a river, variation ${index}, highly detailed`,
}));
const jobs = [
  { id: "layout-completed", status: "completed", create_time: 1700000000000, workflow_name: workflow.name, workflow_id: workflow.id, gallery: [output, output2], preview_output: output, seed: 123, positive_prompt: "A landscape" },
  ...pendingJobs,
];
const EMPTY_CATALOG = { custom: {}, removed: {}, removedCustom: {}, skipped: {}, mutex: [], singletons: [], skipCategories: [] };

function desktopHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>html,body{margin:0;height:100%;background:#10121a;font:14px Arial,sans-serif}#fixture{width:var(--panel-width,100%);height:100vh}.pi::before{content:"◇";display:inline-block;width:1em}</style>
    </head><body><main id="fixture"></main><script type="module" src="/extensions/ComfyUI-Mobile-Remote/remote.js"></script></body></html>`;
}
const appStub = `export const app = {
  registerExtension(extension) { extension.setup(); },
  extensionManager: { registerSidebarTab(tab) { globalThis.__layoutTab = tab; tab.render(document.querySelector("#fixture")); } }
};`;

function createFixture() {
  const files = new Map();
  const put = (url, file, contentType) => files.set(url, { contentType, body: fs.readFileSync(path.join(ROOT, file)) });
  put("/mobile", "mobile/index.html", "text/html; charset=utf-8");
  for (const name of ["app.js", "settings-sync.js", "preset-catalog.js", "preset-engine.js", "progress-sync.js", "styles.css", "icon.svg"]) {
    put(`/mobile/assets/${name}`, `mobile/${name}`, name.endsWith("css") ? "text/css" : name.endsWith("svg") ? "image/svg+xml" : "text/javascript");
  }
  put("/mobile/assets/i18n.js", "web/i18n.js", "text/javascript");
  for (const name of ["remote.js", "remote.css", "tag-node.css", "i18n.js", "preset-manager.js", "preset-store.js", "workflow-import.js", "workflow-library.js"]) {
    put(`/extensions/ComfyUI-Mobile-Remote/${name}`, `web/${name}`, name.endsWith("css") ? "text/css" : "text/javascript");
  }
  for (const lang of ["en", "ja", "ko"]) put(`/mobile/api/i18n/${lang}`, `i18n/${lang}.json`, "application/json");
  const settings = { ok: true, revision: 1, exists: true, saved_at: 1700000000000, values: { "comfy-mobile-remote.presetCatalog": JSON.stringify(EMPTY_CATALOG) } };
  const requests = [];
  function respond(rawUrl, method = "GET", body = "") {
    const url = new URL(rawUrl, "http://layout.test");
    const pathname = url.pathname;
    requests.push({ method, pathname });
    const json = (value) => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (files.has(pathname)) return { status: 200, ...files.get(pathname) };
    if (pathname === "/desktop") return { status: 200, contentType: "text/html", body: desktopHtml() };
    if (pathname === "/scripts/app.js") return { status: 200, contentType: "text/javascript", body: appStub };
    if (pathname === "/mobile/assets/prompt-presets.json") return json(catalog);
    if (pathname === "/mobile/api/settings") {
      if (method === "POST") { Object.assign(settings.values, JSON.parse(body || "{}").changes || {}); settings.revision++; }
      return json(settings);
    }
    if (pathname === "/mobile/api/status") return json({ ok: true, online: true, running: 0, pending: 10, version: "0.3.0", gpu: { name: "Layout test GPU", total: 1024, free: 512, used: 512 }, tailscale_ips: [], mobile_urls: [] });
    if (pathname === "/mobile/api/update") return json({ ok: true, has_update: false });
    if (pathname === "/mobile/api/connections") return json({ ok: true, tunnel: { state: "connected", url: "https://layout.example/mobile", message: "", autostart: true, enabled: true, binary_present: true }, tailscale: { state: "unconfigured", urls: [], message: "" } });
    if (pathname === "/mobile/api/workflows") return json({ ok: true, workflows: [workflow] });
    if (pathname === `/mobile/api/workflows/${workflow.id}`) return json({ ok: true, workflow });
    if (pathname === "/mobile/api/jobs") return json({ ok: true, jobs, total: jobs.length, has_more: false });
    if (pathname === "/mobile/api/jobs/layout-completed") return json({ ok: true, job: jobs[0] });
    if (pathname === "/mobile/api/progress") return json({ ok: true, active_job: null, nodes: {} });
    if (pathname === "/userdata") return json([{ path: "Examples/landscape.json", size: 1024 }, { path: `Examples/${LONG_TAG}.json`, size: 512 }]);
    if (["/view", "/mobile/api/preview"].includes(pathname)) return { status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#6596ad"/></svg>' };
    return { status: 404, contentType: "text/plain", body: "Unknown fixture route" };
  }
  return { respond, requests };
}

// Optional, isolated preview for agent-browser. Never proxies to a real server.
if (require.main === module) {
  const fixture = createFixture();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const result = fixture.respond(req.url, req.method, body);
      res.writeHead(result.status, { "Content-Type": result.contentType, "Cache-Control": "no-store" });
      res.end(result.body);
    });
  });
  server.listen(0, "127.0.0.1", () => console.log(`Layout fixture: http://127.0.0.1:${server.address().port}`));
}
module.exports = { createFixture, LONG_TAG };
