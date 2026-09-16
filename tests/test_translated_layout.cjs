/* 多语言按钮排版回归：英/日/韩译文比中文长，按钮不允许被文字撑破。
 * 真浏览器 + 全内存夹具，只读源码资源，绝不访问真实历史/收藏/设置。
 * 运行：node --test tests/test_translated_layout.cjs
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { createFixture } = require("./helpers/layout-fixture.cjs");

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

/* 定高芯片、图标按钮、省略号标题本来就用省略号收尾，不算溢出。 */
const ELLIPSIS_CONTROLS = [
  "preset-chip", "preset-row-label", "history-title-button", "history-media-button",
  "mtr-chip", "mtr-row-label", "icon-button", "generate-fab", "gallery-nav",
  "stepper-button", "preset-pool-chip", "mtr-pool-chip", "nav-badge",
];

/* 只量「文字」本身：绝对定位的角标（例如队列数量气泡）不算文字溢出。 */
const OFFENDERS = `(() => {
  const ignore = ${JSON.stringify(ELLIPSIS_CONTROLS)};
  const out = [];
  const textRects = (el) => {
    const rects = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const parent = node.parentElement;
      const style = parent ? getComputedStyle(parent) : null;
      if (style && (style.position === "absolute" || style.position === "fixed")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...range.getClientRects());
    }
    return rects;
  };
  const nodes = document.querySelectorAll("button, a.secondary-button, label.upload-button, .mobile-remote-button");
  for (const el of nodes) {
    if (!el.getClientRects().length) continue;
    const cls = String(el.className || "");
    if (ignore.some((name) => cls.includes(name))) continue;
    const text = (el.textContent || "").trim();
    if (!text) continue;
    const box = el.getBoundingClientRect();
    const left = box.left + el.clientLeft;
    const top = box.top + el.clientTop;
    const right = left + el.clientWidth;
    const bottom = top + el.clientHeight;
    const outside = textRects(el).filter((rect) => rect.width > 0 && rect.height > 0 &&
      (rect.right > right + 1 || rect.left < left - 1 || rect.bottom > bottom + 1 || rect.top < top - 1));
    if (!outside.length) continue;
    out.push({ cls: cls.slice(0, 44), text: text.slice(0, 26),
      overflowRight: Math.round(Math.max(...outside.map((rect) => rect.right)) - right),
      overflowBottom: Math.round(Math.max(...outside.map((rect) => rect.bottom)) - bottom),
      overflowLeft: Math.round(left - Math.min(...outside.map((rect) => rect.left))) });
  }
  return out;
})()`;

function startServer() {
  const fixture = createFixture();
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const result = fixture.respond(request.url, request.method, body);
      response.writeHead(result.status, { "Content-Type": result.contentType, "Cache-Control": "no-store" });
      response.end(result.body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function stopServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

const LOCALES = [["zh-CN", "中文"], ["en-US", "英文"], ["ja-JP", "日文"], ["ko-KR", "韩文"]];
const DESKTOP_WIDTHS = [280, 320, 420];
const PHONE_SIZES = [[320, 640], [390, 844]];

const tag = (where, rows) => rows.map((row) => ({ ...row, where }));

const report = (rows) => {
  const seen = new Set();
  const lines = [];
  for (const row of rows) {
    const line = typeof row === "string" ? row
      : `${row.where}  ${row.cls} "${row.text}" 右溢 ${row.overflowRight}px / 下溢 ${row.overflowBottom}px / 左溢 ${row.overflowLeft}px`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join("\n");
};

test("手机端四种语言的按钮都不被译文撑破", { timeout: 600000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const { server, base } = await startServer();
  const failures = [];
  try {
    for (const [locale] of LOCALES) {
      for (const [width, height] of PHONE_SIZES) {
        const where = `[${locale} ${width}px]`;
        const context = await browser.newContext({ locale, viewport: { width, height } });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(`${where} 页面异常：${error.message}`));
        await page.goto(`${base}/mobile`);
        await page.waitForFunction(() => document.querySelector("#pluginVersion")?.textContent?.includes("0.3.0"), null, { timeout: 30000 });
        await page.waitForFunction(() => !document.querySelector("#generationForm")?.classList.contains("hidden"), null, { timeout: 30000 });
        const offenders = await page.evaluate(OFFENDERS);
        await page.evaluate(() => {
          document.querySelector("#advancedSection")?.setAttribute("open", "");
          document.querySelector("#negativeSection")?.setAttribute("open", "");
          document.querySelector("#presetModeToggle")?.click();
        });
        await page.waitForTimeout(200);
        offenders.push(...await page.evaluate(OFFENDERS));
        for (const view of ["queue", "history", "settings", "generate"]) {
          await page.click(`.nav-button[data-target=${view}]`);
          await page.waitForTimeout(150);
          offenders.push(...tag(`${where} ${view}`, await page.evaluate(OFFENDERS)));
        }
        // 「加载更早的 / 已经到底了」平时是 hidden，这里单独掀开量一次。
        await page.evaluate(() => document.querySelector("#historyMoreButton")?.classList.remove("hidden"));
        await page.click(".nav-button[data-target=history]");
        await page.waitForTimeout(120);
        offenders.push(...await page.evaluate(OFFENDERS));
        for (const dialogId of ["jobDialog", "galleryDialog", "presetTagDialog", "modelPickerDialog"]) {
          await page.evaluate((id) => { const dialog = document.getElementById(id); if (dialog && !dialog.open) dialog.showModal(); }, dialogId);
          await page.waitForTimeout(120);
          offenders.push(...tag(`${where} ${dialogId}`, await page.evaluate(OFFENDERS)));
          await page.evaluate((id) => document.getElementById(id)?.close(), dialogId);
        }
        failures.push(...tag(where, offenders), ...errors);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await stopServer(server);
  }
  assert.equal(failures.length, 0, `手机端按钮被文字撑破：\n${report(failures)}`);
});

test("电脑端四种语言的按钮都不被译文撑破，复制成功不再挤图标按钮", { timeout: 600000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const { server, base } = await startServer();
  const failures = [];
  try {
    for (const [locale] of LOCALES) {
      for (const width of DESKTOP_WIDTHS) {
        const where = `[${locale} ${width}px]`;
        const context = await browser.newContext({ locale, viewport: { width: 1100, height: 900 } });
        await context.addInitScript(() => {
          try { navigator.clipboard.writeText = async () => {}; } catch { /* 只读就算了 */ }
          document.execCommand = () => true;
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => failures.push(`${where} 页面异常：${error.message}`));
        await page.goto(`${base}/desktop`);
        await page.evaluate((size) => document.querySelector("#fixture").style.setProperty("--panel-width", `${size}px`), width);
        await page.waitForFunction(() => {
          const button = document.querySelector(".mobile-remote-url-actions button");
          return button && !button.disabled;
        }, null, { timeout: 30000 });
        const offenders = await page.evaluate(OFFENDERS);
        // 复制成功态：完整译文进反馈行，图标按钮不被文字撑高。
        await page.evaluate(() => document.querySelector(".mobile-remote-url-actions button")?.click());
        await page.waitForTimeout(250);
        const copied = await page.evaluate(() => ({
          feedback: document.querySelector(".mobile-remote-cloud .mobile-remote-feedback")?.textContent?.trim() || "",
          feedbackHidden: Boolean(document.querySelector(".mobile-remote-cloud .mobile-remote-feedback")?.hidden),
          caption: document.querySelector(".mobile-remote-url-actions .mobile-remote-button-label")?.textContent?.trim() || "",
          copied: document.querySelector(".mobile-remote-url-actions button")?.classList.contains("is-copied") || false,
          height: (() => { const el = document.querySelector(".mobile-remote-url-actions button"); return el ? Math.round(el.getBoundingClientRect().height) : 0; })(),
        }));
        offenders.push(...await page.evaluate(OFFENDERS));
        if (!copied.copied) failures.push(`${where} 复制按钮未进入成功态`);
        if (copied.feedbackHidden || !copied.feedback) failures.push(`${where} 复制成功提示没有显示在反馈行`);
        if (copied.caption !== "") failures.push(`${where} 成功文案仍塞在图标按钮里：「${copied.caption}」`);
        if (copied.height > 33) failures.push(`${where} 复制按钮被文字撑高到 ${copied.height}px`);
        await page.evaluate(() => document.querySelectorAll(".mobile-remote-header-actions > .mobile-remote-button")[0]?.click());
        await page.waitForTimeout(350);
        offenders.push(...tag(`${where} 标签管理`, await page.evaluate(OFFENDERS)));
        await page.evaluate(() => document.querySelectorAll(".mobile-remote-header-actions > .mobile-remote-button")[0]?.click());
        await page.waitForTimeout(200);
        await page.evaluate(() => document.querySelectorAll(".mobile-remote-action-row .mobile-remote-button")[1]?.click());
        await page.waitForTimeout(450);
        offenders.push(...tag(`${where} 导入工作流`, await page.evaluate(OFFENDERS)));
        const overflow = await page.evaluate(() => { const panel = document.querySelector("#fixture"); return panel.scrollWidth - panel.clientWidth; });
        if (overflow > 1) failures.push(`${where} 面板横向溢出 ${overflow}px`);
        failures.push(...tag(where, offenders));
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await stopServer(server);
  }
  assert.equal(failures.length, 0, `电脑端按钮被文字撑破：\n${report(failures)}`);
});
