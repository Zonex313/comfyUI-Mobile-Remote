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

function startFixture({ originallyBypassed = false, sourceSeedMode = "fixed", repeatCount = 1 } = {}) {
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
      id: WORKFLOW_ID, name: "夹具工作流", snapshot: "a".repeat(64), native_workflow: NATIVE_WORKFLOW,
      fields: [{ id: "2::seed", node_id: "2", input: "seed", label: "种子", kind: "number", value: 12345 }, {id:"1::ckpt_name",node_id:"1",input:"ckpt_name",label:"模型",kind:"select",value:"sd_xl_base_1.0.safetensors",options:["sd_xl_base_1.0.safetensors"]}],
      node_titles: { "1": "Checkpoint 加载器", "2": "K 采样器" },
      graph: { nodes: [], groups: [] },
    } },
    [`/mobile/api/panel/workflow/${WORKFLOW_ID}`]: { ok: true, id: WORKFLOW_ID, name: "夹具工作流", workflow: NATIVE_WORKFLOW },
    "/api/object_info": OBJECT_INFO,
  };
  api['/mobile/api/workflows/' + WORKFLOW_ID].workflow.native_workflow = structuredClone(NATIVE_WORKFLOW);
  if (originallyBypassed) api['/mobile/api/workflows/' + WORKFLOW_ID].workflow.native_workflow.nodes[0].mode = 4;
  const detail = api['/mobile/api/workflows/' + WORKFLOW_ID].workflow;
  detail.native_workflow.nodes[1].widgets_values[1] = sourceSeedMode;
  detail.graph.nodes = [{id:'2',inputs:[{name:'seed',value:12345,type:'INT'},{name:'control_after_generate',value:sourceSeedMode,type:'COMBO',frontend:true}]}];
  api['/mobile/api/settings'].values['comfy-mobile-remote.repeatCount'] = String(repeatCount);
  const posted = [], submissions = [];
  const controls = { failRefresh: false, refreshes: 0, missingSnapshot: false };
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
      detail.native_workflow = structuredClone(NATIVE_WORKFLOW);
      detail.native_workflow.nodes[1].widgets_values[0] = 999;
      detail.fields[0].value = 999;
      response.end(JSON.stringify({ok:true,snapshot:detail.snapshot}));
      return;
    }
    if (controls.missingSnapshot && pathname === '/mobile/api/workflows/' + WORKFLOW_ID && new URL(request.url,'http://fixture').searchParams.get('snapshot') === 'a'.repeat(64)) {
      response.writeHead(404, {'Content-Type':'application/json'});
      return response.end(JSON.stringify({ok:false,error:'手机工作流副本已丢失，请在设置中重新同步。'}));
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
