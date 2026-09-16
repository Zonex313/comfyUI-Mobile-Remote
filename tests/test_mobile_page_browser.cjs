/* 手机端页面冒烟测试：真浏览器加载 index.html + 全部脚本，
 * 校验「能起来」「跟随系统语言」「能手动切换语言」三件事。
 * 启动期的 TDZ / 空引用之类的错误会在这里直接被 pageerror 抓住。
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

const API = {
  "/mobile/api/status": { ok: true, online: true, running: 0, pending: 0,
    gpu: { name: "test-gpu", total: 1024, free: 512, used: 512 },
    tailscale_ips: [], mobile_urls: [], version: "0.3.0" },
  "/mobile/api/settings": { ok: true, revision: 1, saved_at: 1700000000000, exists: true, values: {} },
  "/mobile/api/jobs": { ok: true, jobs: [], total: 0, has_more: false },
  "/mobile/api/workflows": { ok: true, workflows: [] },
  "/mobile/api/progress": { ok: true, active_job: null, nodes: {} },
};

function readAsset(name) {
  if (name === "i18n.js") return [ "text/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, "web", "i18n.js")) ];
  if (name === "styles.css") return [ "text/css; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", "styles.css")) ];
  return [ "text/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", name)) ];
}

function startFixture() {
  const files = new Map();
  for (const name of [...SCRIPT_ASSETS, "i18n.js", "styles.css"]) files.set(`/mobile/assets/${name}`, readAsset(name));
  files.set("/mobile", [ "text/html; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", "index.html")) ]);
  for (const lang of ["en", "ja", "ko"]) {
    const file = path.join(ROOT, "i18n", `${lang}.json`);
    files.set(`/mobile/api/i18n/${lang}`, [ "application/json; charset=utf-8", fs.readFileSync(file) ]);
  }
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const file = files.get(pathname);
    if (file) { response.writeHead(200, { "Content-Type": file[0], "Cache-Control": "no-store" }); return response.end(file[1]); }
    if (Object.prototype.hasOwnProperty.call(API, pathname)) {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return response.end(JSON.stringify(API[pathname]));
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/mobile` });
    });
  });
}

async function stopFixture(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

const navLabels = (page) => page.$$eval(".nav-button > span", (nodes) => nodes.map((node) => node.textContent.trim()));

test("手机端页面跟系统语言启动，并能手动切换语言", { timeout: 90000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const { server, url } = await startFixture();
  try {
    // 系统语言是中文：页面应当以中文启动。
    const zh = await browser.newContext({ locale: "zh-CN" });
    const page = await zh.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("#pluginVersion")?.textContent?.includes("0.3.0"), null, { timeout: 20000 });
    assert.deepEqual(await navLabels(page), ["生成", "高级", "历史", "设置"]);
    assert.equal(await page.evaluate(() => document.documentElement.lang), "zh-CN");
    assert.match(await page.textContent("#currentAddress"), /^http:\/\//);

    // 右上角语言按钮：菜单四项，选中后整页原地切换，不刷新页面。
    await page.click(".nav-button[data-target=settings]");
    await page.click("#languageButton");
    assert.deepEqual(await page.$$eval(".language-option", (nodes) => nodes.map((node) => node.textContent)),
      ["中文", "English", "日本語", "한국어"]);
    await page.click(".language-option:nth-child(2)");
    await page.waitForFunction(() => document.documentElement.lang === "en", null, { timeout: 10000 });
    assert.deepEqual(await navLabels(page), ["Generate", "Advanced", "History", "Settings"]);
    assert.equal(await page.evaluate(() => localStorage.getItem("comfy-mobile-remote.ui-locale")), "en");
    assert.deepEqual(errors, [], "页面不应抛出未捕获异常");
    await zh.close();

    // 系统语言是日语：不点任何按钮也应当是日文。
    const ja = await browser.newContext({ locale: "ja-JP" });
    const jaPage = await ja.newPage();
    const jaErrors = [];
    jaPage.on("pageerror", (error) => jaErrors.push(error.message));
    await jaPage.goto(url);
    await jaPage.waitForFunction(() => document.querySelector("#pluginVersion")?.textContent?.includes("0.3.0"), null, { timeout: 20000 });
    assert.equal(await jaPage.evaluate(() => document.documentElement.lang), "ja");
    assert.deepEqual(await navLabels(jaPage), ["生成", "詳細", "履歴", "設定"]);
    assert.deepEqual(jaErrors, [], "日文页面不应抛出未捕获异常");
    await ja.close();
  } finally {
    await browser.close();
    await stopFixture(server);
  }
});
