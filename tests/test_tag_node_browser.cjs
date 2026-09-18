/* 电脑端「CLIP文本编码丨随机标签」节点：标签语言圆形按钮 + 浮层菜单。
 * 用假的 app / node 撑起节点本体，标签引擎与词典都是真实源码。
 * 用 node --test tests/test_tag_node_browser.cjs 运行。
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

const hasCjk = (text) => [...text].some((ch) => ch.codePointAt(0) >= 0x4e00 && ch.codePointAt(0) <= 0x9fff);

function pageHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <style>html,body{margin:0;background:#10121a;font:12px Arial,sans-serif}</style>
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
  put("/mobile/assets/i18n.js", "web/i18n.js", "text/javascript");
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

const buttonState = () => {
  const node = document.querySelector(".mtr-lang");
  const style = getComputedStyle(node);
  const icon = node.querySelector(".mtr-lang-icon");
  const code = node.querySelector(".mtr-lang-code");
  return {
    mode: node.dataset.mode,
    code: code.textContent,
    codeVisible: code.getBoundingClientRect().width > 0,
    iconVisible: icon.getBoundingClientRect().width > 0,
    radius: style.borderRadius,
    backgroundImage: style.backgroundImage,
    label: node.getAttribute("aria-label"),
    width: Math.round(node.getBoundingClientRect().width),
    height: Math.round(node.getBoundingClientRect().height),
  };
};

test("电脑端随机标签节点：圆形语言按钮 + 浮层菜单，能真的换提示词语言", { timeout: 120000 }, async () => {
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
          document.body.append(element);
          return { name, element };
        },
      };
      proto.onNodeCreated.call(node);
      globalThis.__node = node;
    });
    await page.waitForFunction(() => document.querySelectorAll(".mtr-row").length > 0, null, { timeout: 30000 });

    const layout = await page.evaluate(() => {
      const lang = document.querySelector(".mtr-lang").getBoundingClientRect();
      const random = document.querySelector(".mtr-random").getBoundingClientRect();
      return { langLeft: lang.left, randomLeft: random.left };
    });
    assert.ok(layout.langLeft < layout.randomLeft, "语言按钮必须排在「随机」左边：" + JSON.stringify(layout));

    const initial = await page.evaluate(buttonState);
    assert.equal(initial.mode, "auto", "默认应当是跟随系统语言：" + JSON.stringify(initial));
    assert.equal(initial.iconVisible, true, "跟随系统语言时应当显示图标");
    assert.equal(initial.codeVisible, false, "跟随系统语言时不该显示简码");
    assert.equal(initial.radius, "50%", "按钮应当是圆的：" + initial.radius);
    assert.equal(initial.backgroundImage, "none", "按钮不该有彩色渐变：" + initial.backgroundImage);
    assert.ok(Math.abs(initial.width - initial.height) <= 1, "圆形按钮宽高应当一致：" + JSON.stringify(initial));
    assert.ok(initial.label.includes("跟随"), "说明要写清当前状态：" + initial.label);

    const chinese = await page.evaluate(() => globalThis.__node.__mtrPanel.finalPrompt());
    assert.ok(hasCjk(chinese), "默认应当是中文提示词：" + JSON.stringify(chinese.slice(0, 50)));
    assert.ok(chinese.includes("my own words"), "节点文本框里自己的文字要原样保留");

    // 点开菜单
    await page.click(".mtr-lang");
    await page.waitForSelector(".mtr-lang-menu .mtr-lang-option", { timeout: 10000 });
    const menu = await page.$$eval(".mtr-lang-menu .mtr-lang-option", (nodes) => nodes.map((n) => ({
      locale: n.dataset.locale, checked: n.getAttribute("aria-checked"), text: n.textContent,
    })));
    assert.equal(menu.length, 5, "菜单应当是「跟随系统语言」+ 四种语言：" + JSON.stringify(menu));
    assert.equal(menu[0].locale, "", "第一项必须是跟随系统语言");
    assert.equal(menu[0].checked, "true", "当前选择要被标出：" + JSON.stringify(menu[0]));
    assert.deepEqual(menu.slice(1).map((item) => item.locale), ["zh", "en", "ja", "ko"], "语言顺序不对：" + JSON.stringify(menu));

    await page.click('.mtr-lang-menu .mtr-lang-option[data-locale="en"]');
    await page.waitForFunction(() => !document.querySelector(".mtr-lang-menu"), null, { timeout: 10000 });
    const afterEnglish = await page.evaluate(buttonState);
    assert.equal(afterEnglish.mode, "fixed", "选了语言之后应当不再跟随：" + JSON.stringify(afterEnglish));
    assert.equal(afterEnglish.code, "EN");
    assert.equal(afterEnglish.codeVisible, true, "选定语言后应当显示简码");
    assert.equal(afterEnglish.iconVisible, false, "选定语言后不该再显示图标");
    assert.equal(await page.evaluate(() => globalThis.__node.properties.mtrTagState.promptLocale), "en", "选择要存在节点上，跟着工作流保存");

    await page.waitForFunction(() => {
      const prompt = globalThis.__node.__mtrPanel.finalPrompt();
      return prompt && ![...prompt].some((ch) => ch.codePointAt(0) >= 0x4e00 && ch.codePointAt(0) <= 0x9fff);
    }, null, { timeout: 30000 });
    const english = await page.evaluate(() => globalThis.__node.__mtrPanel.finalPrompt());
    assert.ok(english.includes("my own words"), "英文标签后面仍然要接上自己的文字");
    assert.notEqual(english, chinese, "换成英文后提示词应当变了");

    // 回到「跟随系统语言」
    await page.click(".mtr-lang");
    await page.waitForSelector(".mtr-lang-menu .mtr-lang-option", { timeout: 10000 });
    await page.click('.mtr-lang-menu .mtr-lang-option[data-locale=""]');
    await page.waitForFunction(() => !document.querySelector(".mtr-lang-menu"), null, { timeout: 10000 });
    const backToAuto = await page.evaluate(buttonState);
    assert.equal(backToAuto.mode, "auto", "应当能选回「跟随系统语言」");
    assert.equal(backToAuto.iconVisible, true);
    assert.equal(await page.evaluate(() => globalThis.__node.properties.mtrTagState.promptLocale), "");
    await page.waitForFunction(() => {
      const prompt = globalThis.__node.__mtrPanel.finalPrompt();
      return prompt && [...prompt].some((ch) => ch.codePointAt(0) >= 0x4e00 && ch.codePointAt(0) <= 0x9fff);
    }, null, { timeout: 30000 });

    // Esc 关闭菜单
    await page.click(".mtr-lang");
    await page.waitForSelector(".mtr-lang-menu .mtr-lang-option", { timeout: 10000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".mtr-lang-menu"), null, { timeout: 10000 });

    assert.deepEqual(errors, [], "节点面板不应抛出未捕获异常");
    await context.close();
  } finally {
    await browser.close();
    await stopFixture(server);
  }
});
