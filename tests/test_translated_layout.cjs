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
const { createFixture, LONG_TAG } = require("./helpers/layout-fixture.cjs");

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
  "stepper-button", "preset-pool-chip", "mtr-pool-chip",
];

/* 只量「文字」本身：绝对定位的角标不算文字溢出。 */
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
        // 连发 10 个任务后：FAB 上的连发数字必须是单行。
        const counters = await page.evaluate(() => {
          const fab = document.querySelector("#generateButton");
          if (fab && !fab.classList.contains("has-repeat")) {
            fab.classList.add("has-repeat");
            document.querySelector("#repeatCenterNum").textContent = "10";
          }
          const measure = (selector) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const range = document.createRange();
            range.selectNodeContents(el);
            const rects = [...range.getClientRects()];
            return { text: el.textContent.trim(), height: Math.round(el.getBoundingClientRect().height),
              lines: [...new Set(rects.map((rect) => Math.round(rect.top)))].length };
          };
          return { repeat: measure("#repeatCenterNum") };
        });
        if (!counters.repeat || counters.repeat.text !== "10" || counters.repeat.lines !== 1) {
          failures.push(`${where} 连发数字不是单行的「10」：${JSON.stringify(counters.repeat)}`);
        }
        const offenders = await page.evaluate(OFFENDERS);
        await page.evaluate(() => {
          document.querySelector("#advancedSection")?.setAttribute("open", "");
          document.querySelector("#negativeSection")?.setAttribute("open", "");
          document.querySelector("#presetModeToggle")?.click();
        });
        await page.waitForTimeout(200);
        offenders.push(...await page.evaluate(OFFENDERS));
        for (const view of ["advanced", "history", "settings", "generate"]) {
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
        // 右上角三个按钮：同高 28px、字号各小两号、图标与文字四方向居中。
        // 图标与文字是并排的，所以横向要看「左右留白相等」，纵向看各自是否居中。
        const header = await page.evaluate(() => {
          const rows = [];
          for (const button of document.querySelectorAll(".mobile-remote-header-actions button")) {
            const box = button.getBoundingClientRect();
            if (box.width < 1) continue;
            const contentLeft = box.left + button.clientLeft;
            const contentRight = contentLeft + button.clientWidth;
            const contentCenterY = box.top + button.clientTop + button.clientHeight / 2;
            const icon = button.querySelector(".mobile-remote-icon");
            const label = button.querySelector(".mobile-remote-button-label");
            const hasText = Boolean(label && label.textContent.trim());
            const first = icon || label;
            const last = hasText ? label : icon;
            rows.push({
              cls: String(button.className || ""),
              text: hasText ? label.textContent.trim() : "",
              width: Math.round(box.width),
              height: Math.round(box.height),
              fontSize: parseFloat(getComputedStyle(hasText ? label : button).fontSize),
              hasIcon: Boolean(icon),
              leftGap: first ? +(first.getBoundingClientRect().left - contentLeft).toFixed(2) : null,
              rightGap: last ? +(contentRight - last.getBoundingClientRect().right).toFixed(2) : null,
              centerX: +(box.left + box.width / 2).toFixed(2),
              iconDy: icon ? +(icon.getBoundingClientRect().top + icon.getBoundingClientRect().height / 2 - contentCenterY).toFixed(2) : null,
              labelDy: hasText ? +(label.getBoundingClientRect().top + label.getBoundingClientRect().height / 2 - contentCenterY).toFixed(2) : null,
              labelDx: hasText ? +(label.getBoundingClientRect().left + label.getBoundingClientRect().width / 2 - (contentLeft + contentRight) / 2).toFixed(2) : null,
              iconDx: icon ? +(icon.getBoundingClientRect().left + icon.getBoundingClientRect().width / 2 - (contentLeft + contentRight) / 2).toFixed(2) : null,
            });
          }
          return rows;
        });
        if (header.length < 3) failures.push(`${where} 右上角按钮数量不对：${header.length}`);
        for (const row of header) {
          const name = row.text || "图标按钮";
          if (row.height !== 28) failures.push(`${where} 右上角「${name}」高度不是 28px（${row.height}px）`);
          // 字号不同、字体墨迹也不同：这里只要求「盒子中心 ± 1.5px」，
          // 真正的视觉居中靠 CSS 里那 1px / 0.5px 的光学补偿。
          if (row.iconDy !== null && Math.abs(row.iconDy) > 1.5) {
            failures.push(`${where} 右上角「${name}」的图标纵向偏太多：dy=${row.iconDy}`);
          }
          if (row.labelDy !== null && Math.abs(row.labelDy) > 1.5) {
            failures.push(`${where} 右上角「${name}」的文字纵向偏太多：dy=${row.labelDy}`);
          }
          if (row.hasIcon && row.text) {
            if (Math.abs(row.leftGap - row.rightGap) > 0.5) {
              failures.push(`${where} 右上角「${name}」左右留白不等：左 ${row.leftGap} / 右 ${row.rightGap}`);
            }
          } else if (row.hasIcon && Math.abs(row.iconDx) > 0.5) {
            failures.push(`${where} 右上角图标按钮横向没居中：dx=${row.iconDx}`);
          } else if (!row.hasIcon && Math.abs(row.labelDx) > 0.5) {
            failures.push(`${where} 右上角「${name}」横向没居中：dx=${row.labelDx}`);
          }
          if (row.cls.includes("mobile-remote-icon-button") && row.width !== 28) {
            failures.push(`${where} 右上角图标按钮不是正方形（${row.width}x${row.height}）`);
          }
          if (row.cls.includes("mobile-remote-tags-entry") && row.fontSize !== 10) {
            failures.push(`${where} 右上角「${name}」字号不是 10px（${row.fontSize}px）`);
          }
          if (row.cls.includes("mobile-remote-update") && row.fontSize !== 11) {
            failures.push(`${where} 右上角「${name}」字号不是 11px（${row.fontSize}px）`);
          }
        }
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

/* 标签溢出时必须是「单侧裁切 + 省略号」：
 * inline-flex + 居中会让溢出部分两端同时被剪掉，省略号也不会出现。 */
const chipContract = (selectors) => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const out = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!el.getClientRects().length) continue;
      const text = (el.textContent || "").trim();
      if (!text) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let textNode = null;
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.trim()) { textNode = node; break; }
      }
      const host = textNode && textNode.parentElement ? textNode.parentElement : el;
      const style = getComputedStyle(host);
      const range = document.createRange();
      range.selectNodeContents(host);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      if (!rects.length) continue;
      const hostBox = host.getBoundingClientRect();
      const contentLeft = hostBox.left + host.clientLeft;
      const contentRight = contentLeft + host.clientWidth;
      const chipBox = el.getBoundingClientRect();
      out.push({
        selector,
        text: text.slice(0, 20),
        textHost: String(host.className || host.tagName),
        overflowing: Math.max(...rects.map((rect) => rect.right)) > contentRight + 1,
        oneSided: Math.min(...rects.map((rect) => rect.left)) - contentLeft <= 2,
        ellipsis: style.textOverflow === "ellipsis",
        centered: style.textAlign === "center",
        display: style.display,
        height: Math.round(chipBox.height),
      });
    }
  }
  return out;
})()`;

function checkChips(rows, where, failures, expectedHeight) {
  if (!rows.length) failures.push(`${where} 没有渲染出标签芯片`);
  for (const row of rows) {
    const name = `${where} ${row.selector} "${row.text}"（${row.textHost}）`;
    if (row.display !== "block") failures.push(`${name} 不是块级布局（${row.display}），省略号不会生效`);
    if (!row.ellipsis) failures.push(`${name} 没有设置省略号`);
    if (row.centered) failures.push(`${name} 居中排版：文字会被两端同时裁切`);
    if (row.height !== expectedHeight) failures.push(`${name} 高度不是固定的 ${expectedHeight}px（${row.height}px）`);
    if (row.overflowing && !row.oneSided) failures.push(`${name} 溢出时左侧也被裁切`);
  }
}

test("标签溢出时用省略号单侧裁切，高度保持各控件原有定高", { timeout: 300000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const { server, base } = await startServer();
  const failures = [];
  try {
    // 手机端：打开标签预设面板，量真实的分类名与标签芯片。
    const phone = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 } });
    const page = await phone.newPage();
    page.on("pageerror", (error) => failures.push(`手机端页面异常：${error.message}`));
    await page.goto(`${base}/mobile`);
    await page.waitForFunction(() => !document.querySelector("#generationForm")?.classList.contains("hidden"), null, { timeout: 30000 });
    await page.evaluate(() => document.querySelector("#presetModeToggle")?.click());
    await page.waitForTimeout(300);
    checkChips(await page.evaluate(chipContract([".preset-chip", ".preset-row-label"])), "手机端预设", failures, 18);
    // 标签编辑弹层里的「备选词库」也是标签芯片，一并检查
    await page.evaluate(() => document.querySelector(".preset-chip")?.click());
    await page.waitForTimeout(250);
    checkChips(await page.evaluate(chipContract([".preset-pool-chip"])), "手机端备选词库", failures, 32);
    await page.evaluate(() => document.getElementById("presetTagDialog")?.close());
    await phone.close();

    // 电脑端节点：注入真实 tag-node.css 与节点内部结构（不需要画布）。
    const desktop = await browser.newContext({ locale: "en-US", viewport: { width: 900, height: 600 } });
    const panel = await desktop.newPage();
    panel.on("pageerror", (error) => failures.push(`电脑端页面异常：${error.message}`));
    await panel.goto(`${base}/desktop`);
    await panel.evaluate(() => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/extensions/ComfyUI-Mobile-Remote/tag-node.css";
      document.head.append(link);
    });
    await panel.waitForTimeout(150);
    await panel.evaluate((longTag) => {
      const holder = document.createElement("div");
      holder.id = "mtr-holder";
      holder.style.cssText = "width:270px;padding:10px;background:#0a0d16";
      const panelNode = document.createElement("div");
      panelNode.className = "mtr-panel";
      const rows = document.createElement("div");
      rows.className = "mtr-rows";
      rows.style.cssText = "display:flex;flex-direction:column;grid-template-columns:none";
      for (const [labelName, chipValue] of [["Landscape and environment", "photographic"], ["Lighting conditions", longTag]]) {
        const row = document.createElement("div");
        row.className = "mtr-row";
        const label = document.createElement("button");
        label.className = "mtr-row-label";
        const labelText = document.createElement("span");
        labelText.className = "mtr-row-label-text";
        labelText.textContent = labelName;
        label.append(labelText);
        const values = document.createElement("div");
        values.className = "mtr-values";
        const chip = document.createElement("button");
        chip.className = "mtr-chip";
        const chipText = document.createElement("span");
        chipText.className = "mtr-chip-text";
        chipText.textContent = chipValue;
        chip.append(chipText);
        values.append(chip);
        row.append(label, values);
        rows.append(row);
      }
      panelNode.append(rows);
      holder.append(panelNode);
      document.body.append(holder);
    }, LONG_TAG);
    await panel.waitForTimeout(150);
    await panel.evaluate((longTag) => {
      const holder = document.getElementById("mtr-holder");
      // 节点弹层里的备选词库芯片
      const popup = document.createElement("div");
      popup.className = "mtr-popup";
      popup.style.cssText = "position:static;max-height:none";
      const head = document.createElement("div");
      head.className = "mtr-pool-head";
      head.textContent = "Tags";
      const pool = document.createElement("div");
      pool.className = "mtr-pool";
      for (const tag of ["daylight", longTag]) {
        const chip = document.createElement("button");
        chip.className = "mtr-pool-chip";
        const text = document.createElement("span");
        text.className = "mtr-pool-chip-text";
        text.textContent = tag;
        chip.append(text);
        pool.append(chip);
      }
      popup.append(head, pool);
      holder.append(popup);
    }, LONG_TAG);
    await panel.waitForTimeout(150);
    checkChips(await panel.evaluate(chipContract([".mtr-chip", ".mtr-row-label"])), "电脑端节点", failures, 18);
    checkChips(await panel.evaluate(chipContract([".mtr-pool-chip"])), "电脑端词库", failures, 20);
    await desktop.close();
  } finally {
    await browser.close();
    await stopServer(server);
  }
  assert.equal(failures.length, 0, `标签裁切方式不对：\n${failures.join("\n")}`);
});

/* 设置页长值：放得下就一行，放不下就整块换行占满整行，不许从中间硬切。 */
test("设置页长文本换行合理，电脑端语言菜单不越界", { timeout: 300000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const { server, base } = await startServer();
  const failures = [];
  try {
    const phone = await browser.newContext({ locale: "en-US", viewport: { width: 320, height: 700 } });
    const page = await phone.newPage();
    page.on("pageerror", (error) => failures.push(`手机端页面异常：${error.message}`));
    await page.goto(`${base}/mobile`);
    await page.waitForFunction(() => !document.querySelector("#generationForm")?.classList.contains("hidden"), null, { timeout: 30000 });
    await page.click(".nav-button[data-target=settings]");
    await page.waitForTimeout(200);
    // 逐字量：得到每一行的实际内容与断行处，才能判断「切在哪」是否合理。
    const measureValue = (text) => page.evaluate((value) => {
      const el = document.querySelector("#tailscaleAddress");
      el.textContent = value;
      const node = el.firstChild;
      const range = document.createRange();
      const chars = [];
      for (let index = 0; index < value.length; index += 1) {
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        chars.push({ char: value[index], top: Math.round(rect.top), left: rect.left, right: rect.right });
      }
      const box = el.getBoundingClientRect();
      const lines = [];
      for (const item of chars) {
        const line = lines.find((entry) => Math.abs(entry.top - item.top) < 3);
        if (line) { line.chars.push(item.char); line.left = Math.min(line.left, item.left); line.right = Math.max(line.right, item.right); }
        else lines.push({ top: item.top, chars: [item.char], left: item.left, right: item.right });
      }
      return { lines: lines.length,
        filled: lines.map((line) => Math.round(((line.right - line.left) / box.width) * 100)),
        breaks: lines.slice(0, -1).map((line) => line.chars[line.chars.length - 1]) };
    }, text);
    // 常见地址应当整行显示
    const typical = await measureValue("https://device.tailnet.ts.net:8188/mobile");
    if (typical.lines !== 1) failures.push(`常见地址被折成 ${typical.lines} 行（占比 ${typical.filled.join("/")}%）`);
    // 必须折行的超长地址：断点只能落在分隔符处，或者该行已经排满（≥70%）
    const long = await measureValue("https://workstation-01.verylongtailnetname.ts.net:8188/mobile/index.html?token=abcdef");
    const separators = new Set(["/", ".", ":", "-", "_", "?", "&", "=", "#", "~"]);
    const ugly = long.breaks
      .map((char, index) => ({ char, percent: long.filled[index] }))
      .filter((item) => !separators.has(item.char) && item.percent < 70);
    if (ugly.length) {
      failures.push(`超长地址从中间硬切：断点 ${ugly.map((item) => `"${item.char}"@${item.percent}%`).join(" ")}（各行占比 ${long.filled.join("/")}%）`);
    }
    await phone.close();

    // 电脑端语言菜单：往右展开，且始终落在侧栏内
    const desktop = await browser.newContext({ locale: "zh-CN", viewport: { width: 900, height: 700 } });
    const panel = await desktop.newPage();
    panel.on("pageerror", (error) => failures.push(`电脑端页面异常：${error.message}`));
    await panel.goto(`${base}/desktop`);
    for (const width of [230, 260, 280, 340]) {
      await panel.evaluate((size) => document.querySelector("#fixture").style.setProperty("--panel-width", `${size}px`), width);
      await panel.evaluate(() => {
        const button = document.querySelector(".mobile-remote-language-picker button");
        if (button.getAttribute("aria-expanded") !== "true") button.click();
      });
      await panel.waitForTimeout(150);
      const menu = await panel.evaluate(() => {
        const menu = document.querySelector(".mobile-remote-language-menu");
        const picker = document.querySelector(".mobile-remote-language-picker");
        const panel = document.querySelector("#fixture");
        const menuBox = menu.getBoundingClientRect();
        const pickerBox = picker.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        return { hidden: menu.hidden, rightOfButton: menuBox.left >= pickerBox.left - 1,
          insideLeft: menuBox.left >= panelBox.left - 1, insideRight: menuBox.right <= panelBox.right + 1,
          options: menu.querySelectorAll(".mobile-remote-language-option").length,
          width: Math.round(menuBox.width) };
      });
      if (menu.hidden || !menu.options) failures.push(`[${width}px] 语言菜单没有展开`);
      if (!menu.rightOfButton) failures.push(`[${width}px] 语言菜单弹到了按钮左侧`);
      if (!menu.insideLeft || !menu.insideRight) failures.push(`[${width}px] 语言菜单超出侧栏（宽 ${menu.width}px）`);
      await panel.evaluate(() => {
        const button = document.querySelector(".mobile-remote-language-picker button");
        if (button.getAttribute("aria-expanded") === "true") button.click();
      });
      await panel.waitForTimeout(80);
    }
    await desktop.close();
  } finally {
    await browser.close();
    await stopServer(server);
  }
  assert.equal(failures.length, 0, `设置页/语言菜单排版不对：\n${failures.join("\n")}`);
});

/* 大图翻页：相邻图片还在下载时不能显示，否则会先露出上面一小条/半张图。 */
test("大图翻页不会先露出半张没下载完的图", { timeout: 300000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const { server, base } = await startServer();
  const failures = [];
  try {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 390, height: 800 }, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(`页面异常：${error.message}`));
    // 第二张图卡住不返回：模拟"新生成的图还在下载"，这样才能稳定复现。
    let releaseSecond = () => {};
    const gate = new Promise((resolve) => { releaseSecond = resolve; });
    let gatedRequests = 0;
    await page.route("**/view?*", async (route) => {
      if (route.request().url().includes("layout-2.png")) {
        gatedRequests += 1;
        await gate;
      }
      await route.continue();
    });
    await page.goto(`${base}/mobile`);
    await page.waitForFunction(() => !document.querySelector("#generationForm")?.classList.contains("hidden"), null, { timeout: 30000 });
    await page.click(".nav-button[data-target=history]");
    await page.waitForSelector("#historyGrid .history-media-button", { timeout: 30000 });
    await page.click("#historyGrid .history-media-button");
    await page.waitForFunction(() => document.querySelector("#galleryDialog")?.open, null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector("#galleryImage")?.classList.contains("is-ready"), null, { timeout: 30000 });
    const pending = await page.evaluate(() => {
      const stage = document.querySelector("#galleryStage");
      const box = stage.getBoundingClientRect();
      const y = box.top + box.height / 2;
      const send = (type, x) => {
        const touch = new Touch({ identifier: 7, target: stage, clientX: x, clientY: y });
        stage.dispatchEvent(new TouchEvent(type, {
          touches: type === "touchend" ? [] : [touch],
          targetTouches: type === "touchend" ? [] : [touch],
          changedTouches: [touch], bubbles: true, cancelable: true,
        }));
      };
      send("touchstart", box.left + box.width - 20);
      // 拖动必须超过半个屏幕：合成出来的两次事件可能落在同一毫秒，
      // 速度会算成 0，只能靠距离判定翻页。
      send("touchmove", box.left + 20);
      const ghosts = [...stage.querySelectorAll("img.gallery-ghost")];
      const ghost = ghosts[ghosts.length - 1];
      if (!ghost) return { found: false };
      const rect = ghost.getBoundingClientRect();
      return {
        found: true,
        src: ghost.getAttribute("src") || "",
        complete: ghost.complete,
        opacity: getComputedStyle(ghost).opacity,
        exposed: Math.round(Math.min(rect.right, box.right) - Math.max(rect.left, box.left)),
      };
    });
    if (!pending.found) failures.push("滑动时没有生成相邻图片图层");
    else {
      if (!pending.src.includes("layout-2.png")) failures.push(`相邻图层取的不是下一张图：${pending.src}`);
      if (pending.complete) failures.push("第二张图没有被挂住，测试前提不成立");
      if (pending.exposed > 0 && pending.opacity !== "0") {
        failures.push(`图片还没下载完就已经露出来了：opacity=${pending.opacity}，露出 ${pending.exposed}px`);
      }
      if (pending.opacity !== "0") failures.push(`未加载完的图层没有隐藏：opacity=${pending.opacity}`);
    }
    if (gatedRequests === 0) failures.push("没有拦到第二张图的请求");
    releaseSecond();
    // 下载完成后图层要自己显示出来
    const revealed = await page.waitForFunction(() => {
      const stage = document.querySelector("#galleryStage");
      const ghosts = [...stage.querySelectorAll("img.gallery-ghost")];
      const ghost = ghosts[ghosts.length - 1];
      return Boolean(ghost) && ghost.complete && ghost.naturalWidth > 0 && getComputedStyle(ghost).opacity === "1";
    }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!revealed) failures.push("图片下载完了，图层却没有显示出来");
    // 松手翻到下一张，等它稳定显示
    await page.evaluate(() => {
      const stage = document.querySelector("#galleryStage");
      const box = stage.getBoundingClientRect();
      const y = box.top + box.height / 2;
      const touch = new Touch({ identifier: 7, target: stage, clientX: box.left + 20, clientY: y });
      stage.dispatchEvent(new TouchEvent("touchend", { touches: [], targetTouches: [], changedTouches: [touch], bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(700);
    const settled = await page.evaluate(() => {
      const image = document.querySelector("#galleryImage");
      return { ready: image.classList.contains("is-ready"), src: image.getAttribute("src") || "",
        counter: document.querySelector("#galleryCounter")?.textContent || "",
        ghosts: document.querySelectorAll("#galleryStage img.gallery-ghost").length };
    });
    if (!settled.src.includes("layout-2.png")) failures.push(`松手后没有翻到第二张：${settled.src}`);
    if (!settled.ready) failures.push("翻页后大图没有进入已显示状态");
    if (settled.ghosts !== 0) failures.push(`翻页后还残留 ${settled.ghosts} 个图层`);
    await context.close();
  } finally {
    await browser.close();
    await stopServer(server);
  }
  assert.equal(failures.length, 0, `大图翻页有问题：\n${failures.join("\n")}`);
});




