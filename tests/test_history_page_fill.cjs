/* 历史首页的「一页」= 60 个能出卡的批次，而不是 60 条记录：
 * 取消/失败这类没有出图的记录在画廊里本来就没有卡片，不该占位
 * （60 条里有 2 条没图，顶部就会显示成 58，看起来像丢了两个任务）。
 * 这里用真浏览器跑一遍，盯住三件事：
 * 1) 卡片不够时按差额往后补，补满 60 个批次；
 * 2) 补的是差额（limit=2&offset=60），不会白拉一整页；
 * 3) 翻更早的记录时游标接着补完的位置走，也不在历史尽头空转。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT_ASSETS = ["app.js", "settings-sync.js", "preset-catalog.js", "preset-engine.js", "progress-sync.js"];

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

function readAsset(name) {
  if (name === "i18n.js") return ["text/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, "web", "i18n.js"))];
  if (name === "styles.css") return ["text/css; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", "styles.css"))];
  return ["text/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", name))];
}

function makeJob(index, withImage) {
  const gallery = withImage ? [{ filename: `page-${index}.png`, subfolder: "", type: "output" }] : [];
  return {
    id: `page-job-${index}`,
    status: withImage ? "completed" : "cancelled",
    create_time: 1700000000000 - index,
    workflow_name: "分页测试",
    outputs_count: gallery.length,
    gallery,
    preview_output: gallery[0] || null,
  };
}

// 首条记录的最新 2 条没有出图（真实现场：用户点了「停止全部」被取消的任务）。
function buildRecords({ fullFirstPage = false, total = 122 } = {}) {
  const records = [];
  for (let index = 0; index < 60 && index < total; index += 1) {
    records.push(makeJob(index, fullFirstPage || index >= 2));
  }
  for (let index = 60; index < total; index += 1) records.push(makeJob(index, true));
  return records;
}

function startFixture(records) {
  const files = new Map();
  for (const name of [...SCRIPT_ASSETS, "i18n.js", "styles.css"]) files.set(`/mobile/assets/${name}`, readAsset(name));
  files.set("/mobile", ["text/html; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", "index.html"))]);
  files.set("/mobile/assets/prompt-presets.json", ["application/json; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", "prompt-presets.json"))]);
  for (const lang of ["en", "ja", "ko"]) files.set(`/mobile/api/i18n/${lang}`, ["application/json; charset=utf-8", fs.readFileSync(path.join(ROOT, "i18n", `${lang}.json`))]);
  const jobsRequests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = url.pathname;
    const send = (contentType, body) => {
      response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      response.end(body);
    };
    const json = (value) => send("application/json", JSON.stringify(value));
    const file = files.get(pathname);
    if (file) return send(file[0], file[1]);
    if (pathname === "/mobile/api/i18n/zh") return json({});
    if (pathname === "/mobile/api/status") return json({ ok: true, online: true, running: 0, pending: 0, gpu: { name: "test-gpu", total: 1024, free: 512, used: 512 }, tailscale_ips: [], mobile_urls: [], version: "0.3.0" });
    if (pathname === "/mobile/api/settings") return json({ ok: true, revision: 1, saved_at: 1700000000000, exists: true, values: {} });
    if (pathname === "/mobile/api/workflows") return json({ ok: true, workflows: [] });
    if (pathname === "/mobile/api/progress") return json({ ok: true, active_job: null, nodes: {} });
    if (pathname === "/view") return send("image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#333"/></svg>');
    if (pathname === "/mobile/api/jobs") {
      const limit = Math.max(1, Number(url.searchParams.get("limit") || 60));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      jobsRequests.push({ limit, offset });
      return json({
        ok: true,
        jobs: records.slice(offset, offset + limit),
        total: records.length,
        has_more: offset + limit < records.length,
      });
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/mobile`, jobsRequests });
    });
  });
}

async function stopFixture(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function openHistory(browser, fixture) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.url);
  await page.waitForFunction(() => /个批次/.test(document.getElementById("historyTotal")?.textContent || ""), null, { timeout: 30000 });
  return { context, page, errors };
}

test("历史首页按能出卡的批次凑满一页：没出图的记录不占位", { timeout: 120000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const fixture = await startFixture(buildRecords());
  try {
    const { context, page, errors } = await openHistory(browser, fixture);
    assert.equal(await page.textContent("#historyTotal"), "60 个批次 · 60 张");
    assert.equal(await page.$$eval("#historyGrid > .history-card", (nodes) => nodes.length), 60);
    assert.deepEqual(fixture.jobsRequests.slice(0, 2), [{ limit: 60, offset: 0 }, { limit: 2, offset: 60 }]);
    assert.ok(!fixture.jobsRequests.some((item) => item.limit === 60 && item.offset === 60), "补页不该整页重拉");

    // 翻更早的记录：游标接着补完的 62 走，不会把已经显示过的两条再拉一遍。
    await page.click(".nav-button[data-target=history]");
    await page.click("#historyMoreButton");
    await page.waitForFunction(() => /120 个批次/.test(document.getElementById("historyTotal")?.textContent || ""), null, { timeout: 30000 });
    assert.ok(fixture.jobsRequests.some((item) => item.limit === 60 && item.offset === 62), "更早一页应当从 62 继续");
    assert.deepEqual(errors, [], "页面不应抛出未捕获异常");
    await context.close();
  } finally {
    await browser.close();
    await stopFixture(fixture.server);
  }
});

test("首页本来就够 60 个批次时不再补页", { timeout: 120000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const fixture = await startFixture(buildRecords({ fullFirstPage: true }));
  try {
    const { context, page, errors } = await openHistory(browser, fixture);
    assert.equal(await page.textContent("#historyTotal"), "60 个批次 · 60 张");
    assert.deepEqual(fixture.jobsRequests, [{ limit: 60, offset: 0 }]);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await stopFixture(fixture.server);
  }
});

test("历史尽头不会为了凑数空转", { timeout: 120000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const fixture = await startFixture(buildRecords({ total: 60 }));
  try {
    const { context, page, errors } = await openHistory(browser, fixture);
    // 没有更早的记录可补：显示真实条数，请求也只发这一次。
    assert.equal(await page.textContent("#historyTotal"), "58 个批次 · 58 张");
    assert.deepEqual(fixture.jobsRequests, [{ limit: 60, offset: 0 }]);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await stopFixture(fixture.server);
  }
});
