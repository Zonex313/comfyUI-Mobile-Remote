/* Real reference React panel inside the phone host. Isolated HTTP fixtures verify
 * shared phone drafts, immutable source identity, retained presentation controls,
 * original job submission, transactional reset, and zero desktop commands. */
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

function startFixture({ originallyBypassed = false, sourceSeedMode = "fixed", repeatCount = 1, nativeWorkflow = NATIVE_WORKFLOW, objectInfo = OBJECT_INFO } = {}) {
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
    // 生成页需要有和面板同一格参数的字段，才能验证"高级改完回生成页看得见"。
    [`/mobile/api/workflows/${WORKFLOW_ID}`]: { ok: true, workflow: {
      id: WORKFLOW_ID, name: "夹具工作流", snapshot: "a".repeat(64), native_workflow: nativeWorkflow,
      fields: [{ id: "2::seed", node_id: "2", input: "seed", label: "种子", kind: "number", value: 12345 }, {id:"1::ckpt_name",node_id:"1",input:"ckpt_name",label:"模型",kind:"select",value:"sd_xl_base_1.0.safetensors",options:["sd_xl_base_1.0.safetensors"]}],
      node_titles: { "1": "Checkpoint 加载器", "2": "K 采样器" },
      graph: { nodes: [], groups: [] },
    } },
    [`/mobile/api/panel/workflow/${WORKFLOW_ID}`]: { ok: true, id: WORKFLOW_ID, name: "夹具工作流", workflow: nativeWorkflow },
    "/api/object_info": objectInfo,
  };
  api['/mobile/api/workflows/' + WORKFLOW_ID].workflow.native_workflow = structuredClone(nativeWorkflow);
  if (originallyBypassed) api['/mobile/api/workflows/' + WORKFLOW_ID].workflow.native_workflow.nodes[0].mode = 4;
  const detail = api['/mobile/api/workflows/' + WORKFLOW_ID].workflow;
  detail.native_workflow.nodes[1].widgets_values[1] = sourceSeedMode;
  detail.graph.nodes = [{id:'2',inputs:[{name:'seed',value:12345,type:'INT'},{name:'control_after_generate',value:sourceSeedMode,type:'COMBO',frontend:true}]}];
  api['/mobile/api/settings'].values['comfy-mobile-remote.repeatCount'] = String(repeatCount);
  const posted = [], submissions = [];
  const controls = { failRefresh: false, refreshes: 0, missingSnapshot: false, throttlePanel: false };
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
    if (request.method === 'POST' && pathname === '/mobile/api/settings') {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const data = JSON.parse(raw), settings = api[pathname];
        for (const [key,value] of Object.entries(data.changes || {})) {
          if (value === null) delete settings.values[key]; else settings.values[key] = value;
        }
        settings.revision++;
        response.writeHead(200, {'Content-Type':'application/json'});
        response.end(JSON.stringify(settings));
      });
      return;
    }
    if (request.method === 'POST' && pathname === '/mobile/api/jobs') {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const data = JSON.parse(raw);
        submissions.push(data);
        const nextSeeds = {};
        for (const [key,mode] of Object.entries(data.seed_modes || {})) {
          if (mode === 'increment' || mode === 'decrement') nextSeeds[key] = Math.max(0,Number(data.values[key]) + (mode === 'increment' ? 1 : -1));
        }
        response.writeHead(200, {'Content-Type':'application/json'});
        response.end(JSON.stringify({ok:true,prompt_id:'fixture-job-'+submissions.length,next_seed_values:nextSeeds}));
      });
      return;
    }
    if (request.method === 'POST' && pathname.endsWith('/refresh')) {
      controls.refreshes++;
      response.writeHead(controls.failRefresh ? 409 : 200, {'Content-Type':'application/json'});
      if (controls.failRefresh) return response.end(JSON.stringify({ok:false,error:'同步失败，手机副本未改变。'}));
      const detail = api['/mobile/api/workflows/' + WORKFLOW_ID].workflow;
      detail.snapshot = 'b'.repeat(64);
      detail.native_workflow = structuredClone(nativeWorkflow);
      detail.native_workflow.nodes[1].widgets_values[0] = 999;
      detail.fields[0].value = 999;
      response.end(JSON.stringify({ok:true,snapshot:detail.snapshot}));
      return;
    }
    if (controls.missingSnapshot && pathname === '/mobile/api/workflows/' + WORKFLOW_ID && new URL(request.url,'http://fixture').searchParams.get('snapshot') === 'a'.repeat(64)) {
      response.writeHead(404, {'Content-Type':'application/json'});
      return response.end(JSON.stringify({ok:false,error:'手机工作流副本已丢失，请在设置中重新同步。'}));
    }
    // 面板资源可以按需限速：进度条只在下载还没结束时才观察得到。
    if (controls.throttlePanel && pathname === '/mobile/assets/panel.js') {
      const body = files.get(pathname)[1];
      const step = Math.max(1, Math.ceil(body.length / 8));
      let sent = 0;
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "Content-Length": String(body.length) });
      const pump = () => {
        if (response.writableEnded) return;
        if (sent >= body.length) return response.end();
        const next = Math.min(body.length, sent + step);
        response.write(body.subarray(sent, next));
        sent = next;
        setTimeout(pump, 60);
      };
      return pump();
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
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/mobile`, posted, submissions, controls });
    });
  });
}

async function stopFixture(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test("高级页手机独立草稿：参数互通、禁用结构编辑、不会回写电脑", { timeout: 120000 }, async () => {
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

    // 2) 修改面板种子只更新手机副本，不发送电脑指令。
    const seedRow = frame.locator("#widget-row-2-0");
    const field = seedRow.locator("input").first();
    await field.click();
    await field.fill("777");
    await field.press("Tab");
    assert.equal(posted.length, 0, "修改手机草稿不得发送桌面指令");
    // 3) 两边参数互通（出图仍走手机原来的路径）：
    //    面板改的值要写进手机草稿，回生成页点「生成」用的就是它。
    await page.click(".nav-button[data-target=generate]");
    await page.waitForTimeout(500);
    const generateValues = await page.evaluate(() => Array.from(document.querySelectorAll("#view-generate input"))
      .map((input) => String(input.value)));
    assert.equal(generateValues.includes("777"), true,
      "面板里改的种子值要出现在生成页的控件里：" + JSON.stringify(generateValues));
    await page.click(".nav-button[data-target=advanced]");
    await frame.locator("#node-list-shell").waitFor({ timeout: 30000 });
    await page.waitForTimeout(600);

    // Basic controls share the same phone draft; no forged postMessage needed.
    await page.click('.nav-button[data-target=generate]');
    await page.locator('#advancedSection').evaluate(el => { el.open = true; });
    const basicSeed = page.locator('#view-generate input[type=number]:visible').first();
    await basicSeed.fill('4242');
    await basicSeed.press('Tab');
    await page.click('.nav-button[data-target=advanced]');
    await field.waitFor();
    assert.equal(await field.inputValue(), '4242');
    assert.equal(posted.length, 0);
    await frame.locator('#node-header-2 button').last().click();
    const menu = frame.locator('.fixed.z-\\[1000\\]').last();
    const menuText = await frame.locator('body').innerText();
    assert.doesNotMatch(menuText, /Duplicate|Delete|复制节点|删除节点|新增节点|Add node|Add group/);
    await page.click('.nav-button[data-target=settings]');
    await page.click('#workflowHelpButton');
    assert.equal(await page.locator('#workflowHelpDialog').evaluate(el=>el.open), true);
    assert.match(await page.locator('#workflowHelpDialog').innerText(), /不会改变电脑画布/);
    assert.equal(await page.locator('#confirmWorkflowResetButton').isVisible(), false);
    await page.click('#closeWorkflowHelpButton');

    assert.deepEqual(errors, [], "面板不应抛出未捕获异常");
    assert.deepEqual(failed.filter((item) => item.includes("/mobile/assets/panel.js")), [], "panel.js 必须加载成功");
    await context.close();
  } finally {
    await stopFixture(server);
    await browser.close();
  }
});

test('phone copy survives reload, submits bypass settings, and resets transactionally', {timeout:120000}, async () => {
  const {chromium} = resolvePlaywright();
  const browser = await chromium.launch({executablePath:chromePath(),headless:true});
  const {server,url,posted,submissions,controls} = await startFixture({originallyBypassed:true});
  try {
    const context = await browser.newContext({locale:'en-US',viewport:{width:390,height:844}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.click('.nav-button[data-target=advanced]');
    const frame = page.frameLocator('.panel-frame');
    await frame.locator('#node-header-1').waitFor();
    const nodeMenu = async () => frame.locator('#node-header-1 button').last().click();
    await nodeMenu();
    await frame.getByRole('button',{name:/^(Engage|启用)$/}).click();
    const field = frame.locator('#widget-row-2-0 input').first();
    await field.fill('8181');
    // Generation must flush a still-focused advanced input.
    await page.click('.nav-button[data-target=generate]');
    const jobRequest = page.waitForRequest(r=>r.method()==='POST' && r.url().endsWith('/mobile/api/jobs'));
    await page.click('#generateButton');
    const payload = (await jobRequest).postDataJSON();
    await page.waitForFunction(()=>document.querySelector('#generateButton').disabled===false);
    assert.equal(payload.snapshot,'a'.repeat(64));
    assert.deepEqual(payload.node_modes,{'1':0});
    assert.equal(Number(payload.values['2::seed']),8181);
    assert.deepEqual(payload.widget_values,{},'Named scalar edits do not impose raw custom widget layout validation');
    await page.reload();
    await page.click('.nav-button[data-target=advanced]');
    await field.waitFor();
    assert.equal(await field.inputValue(),'8181','Draft survives reload');
    await nodeMenu();
    await frame.getByRole('button',{name:/^(Bypass|绕过)$/}).click();
    await nodeMenu();
    await frame.getByRole('button',{name:/^(Hide|隐藏)$/}).click();
    await frame.locator('#node-card-1').waitFor({state:'hidden'});
    await frame.locator('#workflow-menu-container button').click();
    const options = await frame.locator('#workflow-options-dropdown').innerText();
    assert.doesNotMatch(options,/Add node|Duplicate|Delete|Subgraph|新增|删除|复制/);
    await frame.getByRole('button',{name:/^(Hide . Show|隐藏 . 显示)$/}).click();
    await frame.getByRole('button',{name:/Show all hidden nodes|显示所有隐藏节点/}).click();
    await frame.getByRole('button',{name:/^(Cancel|取消)$/}).click();
    await frame.locator('#node-header-1').waitFor();
    await page.click('.nav-button[data-target=settings]');
    controls.failRefresh = true;
    await page.click('#resetWorkflowButton');
    await page.click('#confirmWorkflowResetButton');
    await page.waitForFunction(()=>document.querySelector('#confirmWorkflowResetButton')?.disabled === false);
    assert.equal(controls.refreshes,1);
    assert.equal(await page.locator('#workflowHelpDialog').evaluate(el=>el.open),true);
    await page.click('#closeWorkflowHelpButton');
    await page.click('.nav-button[data-target=advanced]');
    assert.equal(await field.inputValue(),'8181','Failed refresh preserves the copy');
    await nodeMenu();
    await frame.getByRole('button',{name:/^(Engage|启用)$/}).waitFor();
    await page.click('.nav-button[data-target=settings]');
    controls.failRefresh = false;
    controls.missingSnapshot = true;
    const missingResponse = page.waitForResponse(r=>r.status()===404 && r.url().includes('/mobile/api/workflows/'));
    await page.reload();
    await missingResponse;
    await page.click('.nav-button[data-target=settings]');
    await page.click('#resetWorkflowButton');
    await page.click('#confirmWorkflowResetButton');
    await page.waitForFunction(()=>!document.querySelector('#workflowHelpDialog')?.open);
    await page.click('.nav-button[data-target=advanced]');
    await field.waitFor();
    assert.equal(await field.inputValue(),'999');
    await nodeMenu();
    await frame.getByRole('button',{name:/^(Bypass|绕过)$/}).waitFor();
    await page.click('.nav-button[data-target=generate]');
    const resetJob = page.waitForRequest(r=>r.method()==='POST' && r.url().endsWith('/mobile/api/jobs'));
    await page.click('#generateButton');
    const resetPayload = (await resetJob).postDataJSON();
    await page.waitForFunction(()=>document.querySelector('#generateButton').disabled===false);
    assert.equal(resetPayload.snapshot,'b'.repeat(64));
    assert.deepEqual(resetPayload.node_modes,{});
    assert.equal(Number(resetPayload.values['2::seed']),999);
    assert.deepEqual(posted,[],'No desktop commands in any action');
    assert.deepEqual(errors,[]);
    assert.equal(submissions.length,2);
    await context.close();
  } finally { await stopFixture(server); await browser.close(); }
});

test('source seed mode agrees across pages and decrement batches stay at zero', {timeout:60000}, async () => {
  const {chromium} = resolvePlaywright();
  const browser = await chromium.launch({executablePath:chromePath(),headless:true});
  const {server,url,submissions} = await startFixture({sourceSeedMode:'randomize',repeatCount:2});
  try {
    const page = await browser.newPage({locale:'en-US',viewport:{width:390,height:844}});
    await page.goto(url);
    await page.locator('#advancedSection').evaluate(el=>{el.open=true;});
    const base = page.locator('#view-generate input[type=number]').first();
    assert.equal(await base.isDisabled(),true,'Source random mode is reflected in basic controls');
    await page.locator('#advancedSection .random-button').click();
    await base.fill('0');
    await page.click('.nav-button[data-target=advanced]');
    const frame = page.frameLocator('.panel-frame');
    const seedRow = frame.locator('#widget-row-2-0');
    await seedRow.waitFor();
    assert.match(await seedRow.innerText(),/fixed/);
    await seedRow.getByRole('combobox').click();
    await frame.getByRole('option',{name:'decrement',exact:true}).click();
    await page.click('.nav-button[data-target=generate]');
    const accepted = page.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/mobile/api/jobs'));
    await page.click('#generateButton');
    await accepted;
    await page.waitForFunction(()=>document.querySelector('#generateButton').disabled===false);
    assert.equal(submissions.length,2);
    for(const payload of submissions) {
      assert.equal(payload.seed_modes['2::seed'],'decrement');
      assert.equal(Number(payload.values['2::seed']),0);
    }
    for (const viewport of [{width:320,height:640},{width:1440,height:900}]) {
      await page.setViewportSize(viewport);
      await page.click('.nav-button[data-target=settings]');
      await page.click('#workflowHelpButton');
      const dialog = page.locator('#workflowHelpDialog');
      assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      await page.screenshot({path:path.join(ROOT,'tests','screenshots','panel','help-'+viewport.width+'.png')});
      await page.click('#closeWorkflowHelpButton');
    }
  } finally {await stopFixture(server);await browser.close();}
});

function relationFixture(resultCount = 6) {
  const nativeWorkflow = structuredClone(NATIVE_WORKFLOW);
  const objectInfo = structuredClone(OBJECT_INFO);
  objectInfo.KSampler.input.required.notes = ['STRING', {multiline:true}];
  nativeWorkflow.nodes[1].widgets_values.push(Array.from({length:14},(_,i)=>'Long parameter line '+i).join('\n'));
  objectInfo.RelationSource = {name:'RelationSource',display_name:'Source',input:{required:{text:['STRING',{multiline:true}]}},output:['CONDITIONING'],output_name:['CONDITIONING'],category:'fixture'};
  objectInfo.RelationResult = {name:'RelationResult',display_name:'Result',input:{required:{samples:['LATENT'],strength:['FLOAT',{default:1}]}},output:[],output_name:[],category:'fixture'};
  for (const id of [3,4]) nativeWorkflow.nodes.push({id,type:'RelationSource',title:'Source '+id,pos:[1000,(id-3)*220],size:[240,160],flags:{},order:id,mode:0,properties:{},inputs:[],outputs:[{name:'CONDITIONING',type:'CONDITIONING',links:[id-1]}],widgets_values:['Source text '+id]});
  nativeWorkflow.nodes[1].inputs[1].link=2;
  nativeWorkflow.nodes[1].inputs[2].link=3;
  nativeWorkflow.links.push([2,3,0,2,1,'CONDITIONING'],[3,4,0,2,2,'CONDITIONING']);
  for (let id=5;id<5+resultCount;id++) {
    nativeWorkflow.nodes.push({id,type:'RelationResult',title:'Result '+id,pos:[1600,(id-5)*180],size:[260,150],flags:{},order:id,mode:0,properties:{},inputs:[{name:'samples',type:'LATENT',link:id-1}],outputs:[],widgets_values:[1]});
    nativeWorkflow.nodes[1].outputs[0].links.push(id-1);
    nativeWorkflow.links.push([id-1,2,0,id,0,'LATENT']);
  }
  objectInfo.RelationLongResult=structuredClone(objectInfo.RelationResult);
  objectInfo.RelationLongResult.name='RelationLongResult';
  for(let index=0;index<14;index++)objectInfo.RelationLongResult.input.required['extra_'+index]=['FLOAT',{default:.5}];
  nativeWorkflow.nodes.at(-1).type='RelationLongResult';
  nativeWorkflow.nodes.at(-1).widgets_values.push(...Array(14).fill(.5));
  nativeWorkflow.groups.push({id:2,title:'Sources',bounding:[980,-20,300,500],color:'#366454'},{id:3,title:'Results',bounding:[1580,-20,340,Math.max(1180,resultCount*180+40)],color:'#67547e'});
  nativeWorkflow.last_node_id=4+resultCount;nativeWorkflow.last_link_id=3+resultCount;
  return {nativeWorkflow,objectInfo};
}

async function focusPanelNode(frame,id,offset=0) {
  await frame.locator('#node-card-'+id).evaluate((card,offset)=>{
    const scroll=card.closest('[data-node-list]');
    scroll.scrollTo({top:scroll.scrollTop+card.getBoundingClientRect().top-scroll.getBoundingClientRect().top+offset,behavior:'instant'});
  },offset);
  await frame.locator('[data-phone-focus-id="'+id+'"]').waitFor({state:'attached',timeout:10000});
}

test('connection previews stay fixed, reveal grouped folded targets and interrupt safely', {timeout:120000}, async()=>{
  const {chromium}=resolvePlaywright();
  const browser=await chromium.launch({executablePath:chromePath(),headless:true});
  const fixture=await startFixture(relationFixture());
  const shotDir=process.env.PANEL_SHOT_DIR||path.join(ROOT,'tests/screenshots/panel');
  try {
    const context=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844},hasTouch:true});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(fixture.url);
    await page.click('.nav-button[data-target=advanced]');
    const frame=page.frameLocator('#view-advanced .panel-frame');
    await frame.locator('#node-card-10').waitFor();
    await focusPanelNode(frame,2);
    const input=frame.locator('[data-phone-side=input]');
    assert.deepEqual(await input.evaluateAll(nodes=>nodes.map(n=>n.dataset.phoneRelation)),['1','3','4']);
    assert.equal(await frame.locator('[data-phone-more]').count(),0,'no neighbour is folded behind a counter');
    const markers=await frame.locator('#node-card-2 button[id^="connection-button-"]').evaluateAll(nodes=>nodes.map(node=>({size:Math.round(node.getBoundingClientRect().width),text:node.textContent.trim()})));
    assert.ok(markers.length>=5,'the fixture exposes the connected slots');
    assert.ok(markers.every(marker=>marker.size<=20),'connection buttons are quartered: '+JSON.stringify(markers));
    assert.ok(markers.every(marker=>!/[←→]/.test(marker.text)),'connection buttons no longer draw a direction arrow: '+JSON.stringify(markers));
    assert.deepEqual(await frame.locator('[data-phone-side=output]').evaluateAll(nodes=>nodes.map(n=>n.dataset.phoneRelation)),['5','6','7','8','9','10'],'every downstream neighbour is listed on the rail');
    await frame.locator('.phone-relation-wires path').nth(4).waitFor({state:'attached'});
    await page.waitForTimeout(180);
    // A tab is flush with the edge, so 100% of its own width is exactly off screen.
    const entering=await input.first().evaluate(el=>{const s=getComputedStyle(el);return {name:s.animationName,duration:s.animationDuration};});
    assert.match(entering.name,/phone-relation-enter-left/,'the left tab slides in from off screen');
    assert.equal(entering.duration,'0.18s');
    assert.match(await frame.locator('[data-phone-side=output]').first().evaluate(el=>getComputedStyle(el).animationName),/phone-relation-enter-right/,'the right tab slides in from off screen on the same beat');
    const before=await input.first().boundingBox();
    await frame.locator('#node-list-container').evaluate(scroll=>{scroll.scrollTop+=190;});
    await page.waitForTimeout(200);
    const after=await input.first().boundingBox();
    assert.ok(Math.abs(after.y-before.y)<2,'side entrance does not travel with long node content: '+JSON.stringify({before,after,geometry:await frame.locator('.phone-relations-layer').evaluate(el=>({rect:el.getBoundingClientRect().toJSON(),focus:el.dataset.phoneFocusId,scroll:document.getElementById('node-list-container').scrollTop}))}));
    assert.equal(await frame.locator('.phone-relations-layer').getAttribute('data-phone-focus-id'),'2');
    await fs.promises.mkdir(shotDir,{recursive:true});
    await page.screenshot({path:path.join(shotDir,'panel-relations-390.png')});
    // A port that scrolls away takes its wire with it: leaving the screen reads
    // as a continuing connection, parking against the edge reads as detached.
    // Push the first input port a known distance above the scrollport so the
    // focused card still fills the view and the geometry is deterministic.
    await frame.locator('#node-list-container').evaluate(scroll=>{
      const port=document.getElementById('connection-button-2-input-0');
      scroll.scrollTop+=(port.getBoundingClientRect().top-scroll.getBoundingClientRect().top)+120;
    });
    await page.waitForTimeout(240);
    assert.equal(await frame.locator('.phone-relations-layer').getAttribute('data-phone-focus-id'),'2');
    const wireEnds=await frame.locator('.phone-relation-wires path').evaluateAll(paths=>paths.map(path=>Number(path.getAttribute('d').trim().split(/[ ,]+/).at(-1))));
    assert.ok(wireEnds.length>=5,'the focused card still draws its wires: '+JSON.stringify(wireEnds));
    assert.ok(wireEnds.some(end=>end<0),'a wire follows its port off screen instead of parking on the edge: '+JSON.stringify(wireEnds));
    assert.ok(wireEnds.every(end=>end!==14),'no wire is clamped to the viewport edge');
    await page.screenshot({path:path.join(shotDir,'panel-relations-offscreen-390.png')});
    for (const width of [320,430,1280]) {
      await page.setViewportSize({width,height:844});
      await focusPanelNode(frame,2,180);
      await page.waitForTimeout(100);
      if (width <= 720) {
        const viewport = await page.locator('#view-advanced .panel-frame').boundingBox();
        assert.ok(Math.abs(viewport.x) < 1 && Math.abs(viewport.width - width) < 1, 'phone previews reach the screen edge, without a second outer gutter');
      }
      const boxes=await frame.locator('#node-list-container').evaluate(scroll=>{
        const card=document.getElementById('node-card-2').getBoundingClientRect();
        const box=scroll.getBoundingClientRect();
        return {overflow:scroll.scrollWidth-scroll.clientWidth,edge:{left:box.left,right:box.right},card:{left:card.left,right:card.right},previews:[...document.querySelectorAll('[data-phone-relation]')].map(n=>{const r=n.getBoundingClientRect();return {side:n.dataset.phoneSide,left:r.left,right:r.right};})};
      });
      await page.screenshot({path:path.join(shotDir,'panel-relations-'+width+'.png')});
      assert.ok(boxes.overflow<=1,'no horizontal document overflow at '+width+': '+JSON.stringify(boxes));
      for (const box of boxes.previews) {
        assert.ok(box.side==='input'?box.right<=boxes.card.left+2:box.left>=boxes.card.right-2,'preview does not cover real controls at '+width);
        assert.ok(box.side==='input'?box.left<=boxes.edge.left+1:box.right>=boxes.edge.right-1,'entry reads as cut off by the viewport edge at '+width+': '+JSON.stringify(boxes));
      }
      assert.equal(await frame.locator('.phone-connection-port-row').evaluateAll(rows=>rows.some(row=>row.getBoundingClientRect().width>row.parentElement.getBoundingClientRect().width+1)),false,'port labels stay inside their original input/output columns at '+width);
      await page.screenshot({path:path.join(shotDir,'panel-relations-'+width+'.png')});
    }
    await page.setViewportSize({width:390,height:844});
    await frame.locator('#node-title-container-5 button').first().evaluate(button=>button.click());
    await frame.locator('#node-card-wrapper-5[data-phone-expanded=false]').waitFor({state:'attached'});
    await frame.locator('#group-header-3 button').first().evaluate(button=>button.click());
    await frame.locator('#node-card-5').waitFor({state:'detached'});
    await focusPanelNode(frame,2);
    await frame.locator('#node-list-container').evaluate(scroll=>{
      window.__foldedArrival=false;
      window.__arrivalObserver=new MutationObserver(()=>{
        if(scroll.dataset.phoneTravelling==='output'&&document.getElementById('node-card-wrapper-5')?.dataset.phoneExpanded==='false')window.__foldedArrival=true;
      });
      window.__arrivalObserver.observe(scroll,{subtree:true,childList:true,attributes:true});
    });
    await frame.locator('[data-phone-side=output][data-phone-relation="5"]').click();
    await frame.locator('[data-phone-focus-id="5"]').waitFor({state:'attached'});
    assert.equal(await frame.locator('#node-card-wrapper-5').getAttribute('data-phone-expanded'),'true');
    assert.equal(await frame.locator('body').evaluate(()=>{window.__arrivalObserver.disconnect();return window.__foldedArrival;}),true,'target is revealed folded before arrival completes');
    assert.ok(await frame.locator('#group-header-3').count(),'destination remains in its original group');
    const savedScroll=await frame.locator('#node-list-container').evaluate(s=>s.scrollTop);
    await frame.locator('#node-list-container').evaluate(s=>{s.scrollTop+=35;});
    assert.ok(await frame.locator('#node-list-container').evaluate(s=>s.scrollTop)>savedScroll,'normal vertical scrolling resumes');
    await focusPanelNode(frame,2);
    await frame.locator('#node-title-container-10 button').first().evaluate(button=>button.click());
    await frame.locator('#node-card-wrapper-10[data-phone-expanded=false]').waitFor({state:'attached'});
    await frame.locator('[data-phone-side=output][data-phone-relation="10"]').click();
    await frame.locator('[data-phone-focus-id="10"]').waitFor({state:'attached'});
    const lastOffset=await frame.locator('#node-card-10').evaluate(card=>card.getBoundingClientRect().top-card.closest('[data-node-list]').getBoundingClientRect().top);
    assert.ok(Math.abs(lastOffset)<30,'last folded long node stays aligned after expansion: '+lastOffset);
    await focusPanelNode(frame,2);
    await frame.locator('[data-phone-side=input][data-phone-relation="3"]').click();
    await frame.locator('[data-phone-side=input]').first().dispatchEvent('wheel',{deltaY:80});
    await frame.locator('#node-list-container').evaluate(s=>{s.scrollTop+=60;});
    await page.waitForTimeout(1100);
    assert.equal(await frame.locator('#node-list-container').getAttribute('data-phone-travelling'),null);
    assert.equal(await frame.locator('#node-list-inner').evaluate(el=>getComputedStyle(el).transform),'none');
    await focusPanelNode(frame,2);
    // The original port button and side entrance share the same navigation path.
    await frame.locator('#connection-button-2-input-0').click();
    await frame.locator('[data-phone-focus-id="1"]').waitFor({state:'attached'});
    assert.equal(fixture.posted.length,0,'relation navigation never writes to desktop');
    assert.deepEqual(errors,[]);
    await context.close();
  } finally {await browser.close();await stopFixture(fixture.server);}
});


test('relation focus recovers after search, honors visibility and avoids bookmarks', {timeout:120000}, async()=>{
  const {chromium}=resolvePlaywright();
  const browser=await chromium.launch({executablePath:chromePath(),headless:true});
  const fixture=await startFixture(relationFixture());
  try {
    const context=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844},reducedMotion:'reduce'});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(fixture.url);await page.click('.nav-button[data-target=advanced]');
    const frame=page.frameLocator('#view-advanced .panel-frame');
    await frame.locator('#node-card-2').waitFor();
    await focusPanelNode(frame,2);
    const options=frame.getByRole('button',{name:'工作流选项'});
    await options.click();await frame.getByRole('button',{name:'搜索',exact:true}).click();
    const search=frame.locator('.node-search-bar input');
    await search.fill('no-node-matches-this-query');
    await frame.locator('#node-list-inner').waitFor({state:'detached'});
    assert.equal(await frame.locator('[data-phone-relation]').count(),0);
    await search.fill('KSampler');await search.evaluate(el=>el.blur());
    await focusPanelNode(frame,2);
    await frame.locator('[data-phone-side=input][data-phone-relation="1"]').waitFor();
    await frame.locator('body').evaluate(()=>{
      window.__travelAnimations=0;const original=Element.prototype.animate;
      Element.prototype.animate=function(...args){window.__travelAnimations++;return original.apply(this,args);};
    });
    await frame.locator('[data-phone-side=input][data-phone-relation="1"]').click();
    await frame.locator('[data-phone-focus-id="1"]').waitFor({state:'attached'});
    assert.equal(await frame.locator('body').evaluate(()=>window.__travelAnimations),0,'reduced motion skips horizontal animation');
    assert.equal(await frame.locator('[data-phone-node-key]').count(),10,'explicit connection jump clears the search filter');
    const foreignAccepted=await frame.locator('body').evaluate(()=>!window.dispatchEvent(new CustomEvent('phone-connection-jump',{cancelable:true,detail:{itemKey:'foreign-scope/node:2',nodeId:2,direction:'output'}})));
    assert.equal(foreignAccepted,false,'unknown scope is not accepted by the phone transition');
    await focusPanelNode(frame,2);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await options.click();await frame.getByRole('button',{name:'隐藏 / 显示',exact:true}).click();
    await frame.locator('body').evaluate(()=>window.dispatchEvent(new CustomEvent('phone-connection-jump',{cancelable:true,detail:{itemKey:document.getElementById('node-card-wrapper-3').dataset.phoneNodeKey,nodeId:3,direction:'input'}})));
    await frame.getByRole('button',{name:'隐藏连接按钮',exact:true}).click();
    await frame.locator('[data-phone-relation]').first().waitFor({state:'detached'});
    await frame.getByRole('button',{name:'显示连接按钮',exact:true}).click();
    await frame.getByRole('button',{name:'取消',exact:true}).click();
    await focusPanelNode(frame,2);
    await frame.locator('[data-phone-relation]').first().waitFor();
    await frame.locator('#node-header-2 button').last().click();
    await frame.getByRole('button',{name:'添加书签',exact:true}).click();
    const bar=frame.locator('[data-phone-bookmark-bar]');await bar.waitFor();
    await bar.evaluate(el=>{el.style.top='180px';el.style.left='0px';el.style.right='auto';});
    await page.waitForTimeout(150);
    const collision=await bar.evaluate(bar=>{
      const b=bar.getBoundingClientRect();
      return [...document.querySelectorAll('[data-phone-relation],[data-phone-more]')].some(el=>{
        const r=el.getBoundingClientRect();return r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top;
      });
    });
    assert.equal(collision,false,'side relations yield space to the retained bookmark bar');
    assert.ok(await bar.locator('button').count(),'bookmark controls remain present');
    await options.click();await frame.getByRole('button',{name:'全部折叠',exact:true}).click();
    await frame.locator('[data-phone-relation]').first().waitFor({state:'detached'});
    assert.equal(fixture.posted.length,0);
    assert.deepEqual(errors,[]);
    await context.close();
  } finally {await browser.close();await stopFixture(fixture.server);}
});

for (const count of [14, 120]) {
  test('crowded rails fit all ' + count + ' neighbours without an overflow menu', {timeout:120000}, async()=>{
    const {chromium}=resolvePlaywright();
    const browser=await chromium.launch({executablePath:chromePath(),headless:true});
    const fixture=await startFixture(relationFixture(count));
    const shotDir=process.env.PANEL_SHOT_DIR||path.join(ROOT,'tests/screenshots/panel');
    try {
      const context=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:count===14?844:640}});
      const page=await context.newPage();const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(fixture.url);await page.click('.nav-button[data-target=advanced]');
      const frame=page.frameLocator('#view-advanced .panel-frame');
      await frame.locator('#node-card-'+(count+4)).waitFor();
      await focusPanelNode(frame,2);
      const previews=frame.locator('[data-phone-side=output]');
      await previews.nth(count-1).waitFor();
      assert.equal(await previews.count(),count,'all downstream neighbours are listed');
      assert.equal(await frame.locator('[data-phone-more]').count(),0,'nothing is hidden behind a counter');
      await frame.locator('.phone-relation-wires path').nth(count+2).waitFor({state:'attached'});
      await page.waitForTimeout(220);
      const rail=await frame.locator('.phone-relations-layer').evaluate(layer=>{
        const box=layer.getBoundingClientRect();
        return {top:box.top,bottom:box.bottom,rows:[...layer.querySelectorAll('[data-phone-side=output]')].map(n=>{
          const r=n.getBoundingClientRect(),s=getComputedStyle(n);
          return {top:r.top,bottom:r.bottom,height:r.height,outerBorder:s.borderRightWidth,color:s.backgroundColor};
        })};
      });
      for (let index=1;index<rail.rows.length;index++) assert.ok(rail.rows[index].top>=rail.rows[index-1].bottom-0.5,'rows never overlap');
      assert.ok(rail.rows[0].top>=rail.top && rail.rows.at(-1).bottom<=rail.bottom+1,'all entries stay above the reserved bottom controls');
      assert.ok(rail.rows.every(row=>row.height>0 && row.outerBorder==='0px'),'every neighbour has a visible sliver with its outer border cut off');
      const tallest=Math.max(...rail.rows.map(row=>row.height));
      assert.ok(tallest<(count===14?50:5),'dense rows shrink to fit the shorter viewport: '+tallest);
      if(count===120)assert.ok(rail.rows.every(row=>row.color==='rgb(236, 72, 153)'),'squeezed bars retain the LATENT port colour');
      await fs.promises.mkdir(shotDir,{recursive:true});
      await page.screenshot({path:path.join(shotDir,'panel-relations-crowded-'+count+'.png')});
      await previews.nth(count-1).click();
      // The tabs slide out with the list, not after it lands, and only exist for
      // the length of that slide — so watch from the click rather than sampling
      // once after a fixed wait.
      const target=String(count+4);
      const leavingTabs=frame.locator('[data-phone-tab-leaving]');
      let leavingNames=null;
      let leftWhileMoving=false;
      // 连线属于当前焦点卡片的位置，过渡期间画出来就是留在旧位置上的那一段。
      let wiresGoneWhileMoving=false;
      for(let attempt=0;attempt<160&&!leavingNames;attempt++){
        const state=await frame.locator('.phone-relations-layer').evaluate((layer,expected)=>{
          const scroll=document.getElementById('node-list-container');
          return {
            moving:Boolean(scroll&&scroll.dataset.phoneTravelling),
            focus:layer.dataset.phoneFocusId,
            wires:layer.querySelectorAll('.phone-relation-wires').length,
            names:[...layer.querySelectorAll('[data-phone-tab-leaving]')].map(node=>({side:node.className.includes('is-input')?'input':'output',name:getComputedStyle(node).animationName})),
          };
        },target);
        if(state.moving&&state.wires===0)wiresGoneWhileMoving=true;
        if(state.names.length){
          leavingNames=state.names;
          leftWhileMoving=state.moving&&state.focus!==target;
          if(leftWhileMoving)await page.screenshot({path:path.join(shotDir,'panel-relations-handover-'+count+'.png')});
        }
        if(!leavingNames)await page.waitForTimeout(12);
      }
      assert.ok(leavingNames,'the outgoing tabs are kept long enough to slide out');
      assert.ok(leavingNames.every(entry=>entry.name==='phone-relation-leave-'+(entry.side==='input'?'left':'right')),'each outgoing tab slides out of its own side: '+JSON.stringify(leavingNames.slice(0,4)));
      assert.ok(leftWhileMoving,'the tabs leave while the list is still moving, not once it has landed');
      assert.ok(wiresGoneWhileMoving,'no wires are left hanging at the old position while the list moves');
      await frame.locator('[data-phone-focus-id="'+target+'"]').waitFor({state:'attached'});
      await frame.locator('.phone-relation-wires path').first().waitFor({state:'attached',timeout:5000});
      assert.ok(await frame.locator('.phone-relation-wires path').count()>0,'the wires come back once the new card has been measured');
      await frame.locator('[data-phone-focus-id="'+(count+4)+'"]').waitFor({state:'attached'});
      await leavingTabs.first().waitFor({state:'detached',timeout:3000});
      assert.equal(fixture.posted.length,0);
      assert.deepEqual(errors,[]);
      await context.close();
    } finally {await browser.close();await stopFixture(fixture.server);}
  });
}

test('a side that empties out slides its tabs away exactly once', {timeout:120000}, async()=>{
  const {chromium}=resolvePlaywright();
  const browser=await chromium.launch({executablePath:chromePath(),headless:true});
  const fixture=await startFixture(relationFixture());
  try {
    const context=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844}});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(fixture.url);await page.click('.nav-button[data-target=advanced]');
    const frame=page.frameLocator('#view-advanced .panel-frame');
    await frame.locator('#node-card-10').waitFor();
    await focusPanelNode(frame,2);
    await frame.locator('[data-phone-side=input][data-phone-relation="1"]').waitFor();
    await frame.locator('body').evaluate(()=>{
      window.__railAnimations=[];
      document.addEventListener('animationstart',event=>{
        const el=event.target;
        if(typeof el.className!=='string'||!el.className.includes('phone-relation-preview'))return;
        window.__railAnimations.push({name:event.animationName,rel:el.dataset.phoneRelation||'ghost',side:el.dataset.phoneSide||'ghost'});
      },true);
    });
    // Node 1 has no inputs, so the entire left rail empties on this hop.
    await frame.locator('[data-phone-side=input][data-phone-relation="1"]').click();
    await frame.locator('[data-phone-focus-id="1"]').waitFor({state:'attached'});
    await page.waitForTimeout(700);
    const animations=await frame.locator('body').evaluate(()=>window.__railAnimations);
    const leftLeaves=animations.filter(entry=>entry.name==='phone-relation-leave-left');
    assert.equal(leftLeaves.length,3,'each outgoing left tab slides out exactly once: '+JSON.stringify(animations));
    assert.ok(leftLeaves.every(entry=>entry.rel!=='ghost'),'the outgoing tabs are not replayed as ghosts: '+JSON.stringify(animations));
    assert.equal(fixture.posted.length,0);
    assert.deepEqual(errors,[]);
    await context.close();
  } finally {await browser.close();await stopFixture(fixture.server);}
});

test('the first visit to the advanced page shows real download progress', {timeout:120000}, async()=>{
  const {chromium}=resolvePlaywright();
  const browser=await chromium.launch({executablePath:chromePath(),headless:true});
  const fixture=await startFixture();
  fixture.controls.throttlePanel=true;
  try {
    const context=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844}});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(fixture.url);
    await page.click('.nav-button[data-target=advanced]');
    const overlay=page.locator('#panelLoading');
    await overlay.waitFor({state:'visible'});
    // 真实字节数：进度要出现中间值，而不是 0 直接跳 100。
    let partial=0;
    for(let attempt=0;attempt<160&&!partial;attempt++){
      const state=await overlay.evaluate(el=>({
        measured:el.classList.contains('is-measured'),
        percent:document.getElementById('panelLoadingPercent').textContent,
      }));
      const value=Number(String(state.percent).replace('%',''));
      if(state.measured&&value>0&&value<100)partial=value;
      else await page.waitForTimeout(20);
    }
    assert.ok(partial>0,'the bar reports intermediate progress: '+partial);
    assert.equal(await page.locator('#panelLoadingLabel').textContent(),'正在加载高级面板…');
    const frame=page.frameLocator('#view-advanced .panel-frame');
    await frame.locator('#node-card-2').waitFor({timeout:60000});
    await overlay.waitFor({state:'hidden',timeout:10000});
    assert.equal(fixture.posted.length,0);
    assert.deepEqual(errors,[]);
    await context.close();
  } finally {await browser.close();await stopFixture(fixture.server);}
});
