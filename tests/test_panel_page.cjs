/* 「高级」页 = 参考项目真实 React 面板：真浏览器加载真实手机页 + 真实 panel.js，
 * 校验三件事：
 *   1. 切到高级页后，参考项目的面板真的渲染出来（组头、节点卡、连线区）；
 *   2. 面板改一个控件值，会经本插件的指令通道回写电脑端（POST /mobile/api/desktop/commands）；
 *   3. 全程没有未捕获异常。
 * 面板数据来自 /mobile/api/panel/workflow/<id>（原生工作流）与 /api/object_info（节点定义）。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT_ASSETS = ["app.js", "settings-sync.js", "preset-catalog.js", "preset-engine.js", "progress-sync.js", "panel.js"];
const STYLE_ASSETS = ["styles.css", "panel.css"];
const WORKFLOW_ID = "0123456789abcdef0123";

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

/* 原生（canonical）工作流：参考项目的面板吃这个格式。 */
const NATIVE_WORKFLOW = {
  last_node_id: 2,
  last_link_id: 1,
  nodes: [
    {
      id: 1, type: "CheckpointLoaderSimple", pos: [0, 0], size: [300, 100],
      flags: {}, order: 0, mode: 0, properties: {},
      inputs: [],
      outputs: [{ name: "MODEL", type: "MODEL", links: [1], slot_index: 0 }],
      widgets_values: ["sd_xl_base_1.0.safetensors"],
    },
    {
      id: 2, type: "KSampler", pos: [400, 0], size: [320, 220],
      flags: {}, order: 1, mode: 0, properties: {},
      inputs: [
        { name: "model", type: "MODEL", link: 1 },
        { name: "positive", type: "CONDITIONING", link: null },
        { name: "negative", type: "CONDITIONING", link: null },
        { name: "latent_image", type: "LATENT", link: null },
      ],
      outputs: [{ name: "LATENT", type: "LATENT", links: [], slot_index: 0 }],
      widgets_values: [12345, "randomize", 20, 7, "euler", "normal", 1],
    },
  ],
  links: [[1, 1, 0, 2, 0, "MODEL"]],
  groups: [{ id: 1, title: "测试组", bounding: [-20, -20, 800, 300], color: "#3f789e" }],
  config: {}, extra: {}, version: 0.4,
};

const OBJECT_INFO = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["sd_xl_base_1.0.safetensors"], {}] } },
    output: ["MODEL", "CLIP", "VAE"], output_name: ["MODEL", "CLIP", "VAE"],
    name: "CheckpointLoaderSimple", display_name: "CheckpointLoaderSimple", category: "loaders",
  },
  KSampler: {
    input: {
      required: {
        model: ["MODEL"],
        seed: ["INT", { default: 0, min: 0, max: 18446744073709551615 }],
        steps: ["INT", { default: 20, min: 1, max: 10000 }],
        cfg: ["FLOAT", { default: 8, min: 0, max: 100 }],
        sampler_name: [["euler", "dpmpp_2m"], {}],
        scheduler: [["normal", "karras"], {}],
        denoise: ["FLOAT", { default: 1, min: 0, max: 1 }],
      },
    },
    output: ["LATENT"], output_name: ["LATENT"],
    name: "KSampler", display_name: "KSampler", category: "sampling",
  },
};

function startFixture() {
  const files = new Map();
  for (const name of SCRIPT_ASSETS) {
    files.set(`/mobile/assets/${name}`, ["text/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", name))]);
  }
  for (const name of STYLE_ASSETS) {
    files.set(`/mobile/assets/${name}`, ["text/css; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", name))]);
  }
  files.set("/mobile/assets/panel.html", ["text/html; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", "panel.html"))]);
  files.set("/mobile/assets/i18n.js", ["text/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, "web", "i18n.js"))]);
  files.set("/mobile", ["text/html; charset=utf-8", fs.readFileSync(path.join(ROOT, "mobile", "index.html"))]);
  for (const lang of ["en", "ja", "ko"]) {
    files.set(`/mobile/api/i18n/${lang}`, ["application/json; charset=utf-8", fs.readFileSync(path.join(ROOT, "i18n", `${lang}.json`))]);
  }
  const api = {
    "/mobile/api/status": { ok: true, online: true, running: 0, pending: 0,
      gpu: { name: "test-gpu", total: 1024, free: 512, used: 512 }, tailscale_ips: [], mobile_urls: [], version: "0.3.0" },
    "/mobile/api/settings": { ok: true, revision: 1, saved_at: 1700000000000, exists: true, values: {} },
    "/mobile/api/jobs": { ok: true, jobs: [], total: 0, has_more: false },
    "/mobile/api/progress": { ok: true, active_job: null, nodes: {} },
    "/mobile/api/workflows": { ok: true, workflows: [
      { id: WORKFLOW_ID, name: "夹具工作流", source: "fixture.json", synced_at: 1, node_count: 2, field_count: 0, pinned: true },
    ] },
    [`/mobile/api/workflows/${WORKFLOW_ID}`]: { ok: true, workflow: {
      id: WORKFLOW_ID, name: "夹具工作流", fields: [], node_titles: { "1": "Checkpoint 加载器", "2": "K 采样器" },
      graph: { nodes: [], groups: [] },
    } },
    [`/mobile/api/panel/workflow/${WORKFLOW_ID}`]: { ok: true, id: WORKFLOW_ID, name: "夹具工作流", workflow: NATIVE_WORKFLOW },
    "/api/object_info": OBJECT_INFO,
  };
  const posted = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "POST" && pathname === "/mobile/api/desktop/commands") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        try { posted.push(JSON.parse(body)); } catch { posted.push({ raw: body }); }
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ ok: true, pending: posted.length }));
      });
      return;
    }
    const file = files.get(pathname);
    if (file) { response.writeHead(200, { "Content-Type": file[0], "Cache-Control": "no-store" }); return response.end(file[1]); }
    if (Object.prototype.hasOwnProperty.call(api, pathname)) {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return response.end(JSON.stringify(api[pathname]));
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/mobile`, posted });
    });
  });
}

async function stopFixture(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test("高级页跑参考项目的真实面板：渲染、连线、改值回写电脑端", { timeout: 120000 }, async () => {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const { server, url, posted } = await startFixture();
  const shotDir = process.env.PANEL_SHOT_DIR || path.join(ROOT, "tests", "screenshots", "panel");
  try {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const failed = [];
    page.on("requestfailed", (request) => failed.push(request.url()));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("#pluginVersion")?.textContent?.includes("0.3.0"), null, { timeout: 30000 });

    // 切到「高级」：面板按需加载（1.4MB），切过去才创建 iframe。
    await page.click(".nav-button[data-target=advanced]");
    await page.waitForSelector("#view-advanced .panel-frame", { timeout: 30000 });
    const frame = page.frameLocator("#view-advanced .panel-frame");
    await frame.locator("#node-list-shell").waitFor({ timeout: 60000 });

    // 1) 参考项目的面板结构真的在：组头、节点卡、左右连线箭头（都用它自己的 id）。
    assert.equal(await frame.locator("#group-header-1").count(), 1, "渲染出参考项目的组头");
    assert.match(await frame.locator("#group-header-1").textContent(), /测试组/);
    assert.equal(await frame.locator("#node-card-1").count(), 1, "渲染出参考项目的节点卡 #1");
    assert.equal(await frame.locator("#node-card-2").count(), 1, "渲染出参考项目的节点卡 #2");
    assert.equal(await frame.locator("#node-header-2").count(), 1, "节点卡有自己的标题栏");
    assert.equal(await frame.locator("#node-id-badge-2").count(), 1, "节点卡带编号角标");
    assert.equal(await frame.locator("#node-card-2 .node-connections").count() >= 1, true, "连线区在（参考项目的 node-connections）");
    // 「左边几个箭头、右边几个箭头」：输入侧 4 个（model/positive/negative/latent_image），
    // 输出侧 1 个；点箭头就是参考项目自己的跳转逻辑。
    const inputArrows = await frame.locator('#node-card-2 [id^="connection-button-2-input-"]').count();
    const outputArrows = await frame.locator('#node-card-1 [id^="connection-button-1-output-"]').count();
    assert.equal(inputArrows, 4, "输入侧 4 个箭头");
    assert.equal(outputArrows, 1, "输出侧 1 个箭头");
    // 控件行 id 也是参考项目那套：widget-row-<节点>-<下标>
    assert.equal(await frame.locator("#widget-row-2-0").count(), 1, "控件行按参考项目规则命名");
    assert.equal(await frame.locator("#widget-row-1-0").count(), 1, "模型加载器的控件行也在");
    // 面板的整站样式没有漏进手机页，手机页也没打进去：宿主 iframe 之外的 body 样式不变。
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgba(0, 0, 0, 0)", "手机页 body 不被面板样式改掉");

    // 背景必须无缝：面板的 iframe、iframe 的 html/body、以及面板外壳都不许画自己的底色，
    // 否则会在手机页上贴出一块"贴上去"的黑底（外壳那层是参考项目自家整页的 bg-slate-950/88）。
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.querySelector("#view-advanced .panel-frame")).backgroundColor),
      "rgba(0, 0, 0, 0)",
      "iframe 自身要透明",
    );
    const shell = await frame.locator("body").evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      html: getComputedStyle(document.documentElement).backgroundColor,
      wrapper: getComputedStyle(document.getElementById("node-list-wrapper")).backgroundColor,
      wrapperTop: getComputedStyle(document.getElementById("node-list-wrapper")).top,
    }));
    assert.equal(shell.body, "rgba(0, 0, 0, 0)", "面板 body 要透明");
    assert.equal(shell.html, "rgba(0, 0, 0, 0)", "面板 html 要透明");
    assert.equal(shell.wrapper, "rgba(0, 0, 0, 0)", "面板外壳那层深色底要去掉");
    assert.equal(shell.wrapperTop, "0px", "外壳不留为它自家顶栏预留的空隙");
    // 卡片本身是面板自己的设计，必须还在。
    assert.equal(await frame.locator('[id^="node-card-"]').count() >= 2, true, "卡片照旧渲染");

    await fs.promises.mkdir(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, "panel-390x844-zh.png") });

    // 2) 改面板里的种子值，应当回写成本插件的桌面指令。
    const seedRow = frame.locator("#widget-row-2-0");
    const field = seedRow.locator("input").first();
    await field.click();
    await field.fill("777");
    await field.press("Tab");
    // 面板改值 → 入口的差分桥 → POST 桌面指令（等它发出来）。
    for (let attempt = 0; attempt < 60 && posted.length === 0; attempt += 1) {
      await page.waitForTimeout(100);
    }
    assert.equal(posted.length > 0, true, "面板改值要发出桌面指令");
    const seedCommand = posted.find((item) => item && String(item.node_id) === "2");
    assert.ok(seedCommand, "指令里要带节点号：" + JSON.stringify(posted));
    assert.equal(seedCommand.workflow_id, WORKFLOW_ID);
    assert.equal(String(seedCommand.input), "seed");
    assert.equal(Number(seedCommand.value), 777);

    assert.deepEqual(errors, [], "面板不应抛出未捕获异常");
    assert.deepEqual(failed.filter((item) => item.includes("/mobile/assets/panel.js")), [], "panel.js 必须加载成功");
    await context.close();
  } finally {
    await stopFixture(server);
    await browser.close();
  }
});
