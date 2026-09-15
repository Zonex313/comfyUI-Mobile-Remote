import { app } from "../../scripts/app.js";

const LOG_PREFIX = "[Mobile Remote]";
let lastFingerprint = "";
let syncing = false;
let timer = 0;

function fastHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
}

function activeWorkflowInfo(workflow) {
  const candidates = [
    app.extensionManager?.workflow?.activeWorkflow,
    app.workflowManager?.activeWorkflow,
    app.extensionManager?.workflow?.currentWorkflow,
  ].filter(Boolean);

  let source = "";
  let name = "";
  for (const candidate of candidates) {
    source = source || candidate.path || candidate.filename || candidate.id || "";
    name = name || candidate.name || candidate.displayName || candidate.filename || "";
  }

  source = String(source || workflow?.id || "current-workflow");
  name = String(name || source.split(/[\\/]/).pop() || "当前工作流");
  name = name.replace(/\.json$/i, "").replace(/\s*[-|]\s*ComfyUI.*$/i, "").trim();
  return { source, name: name || "当前工作流" };
}

// 只有「已保存到磁盘」的工作流才同步给手机：
// 未保存的（新版前端叫 Unsaved Workflow）不进手机列表，避免刷出一堆同名条目。
function isSavedWorkflow(info) {
  const name = String(info?.name || "").trim();
  const source = String(info?.source || "").trim();
  if (!name || /unsaved|untitled|未保存|未命名/i.test(name)) return false;
  if (!source || source === "current-workflow" || /unsaved|untitled/i.test(source)) return false;
  return true;
}

let lastSources = [];

// 电脑端当前打开着的所有工作流（不只前台那一个，后台标签页也算）
function openWorkflowSources() {
  const store = app.extensionManager?.workflow || app.workflowManager;
  // 注意：store.workflows 是整个工作流库（几百个），openWorkflows 才是打开着的标签页
  const list = store?.openWorkflows || store?.openedWorkflows || store?.workflows || [];
  const sources = [];
  for (const item of Array.isArray(list) ? list : []) {
    const source = item?.path || item?.filename || item?.id || "";
    if (source) sources.push(String(source));
  }
  return sources;
}

// 告诉服务端"电脑端开着哪些工作流"：手机端列表只显示这些，全关掉就是空列表。
async function markOpen(sources = null) {
  const payload = Array.isArray(sources) ? sources : openWorkflowSources();
  lastSources = payload;
  try {
    await fetch("/mobile/api/workflows/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ sources: payload }),
    });
  } catch { /* 心跳失败不影响本地使用 */ }
}

async function syncCurrentWorkflow(force = false) {
  if (syncing || !app?.graph || typeof app.graphToPrompt !== "function") return;

  let graphFingerprint = "";
  let serializedWorkflow = null;
  try {
    serializedWorkflow = app.graph.serialize();
    graphFingerprint = fastHash(JSON.stringify(serializedWorkflow));
  } catch {
    graphFingerprint = `${Date.now()}`;
  }
  if (!force && graphFingerprint === lastFingerprint) {
    await markOpen(lastSources); // 图没变也要发心跳，否则"打开集合"会超时失效
    return;
  }

  // 已明确标记为未保存的工作流，不必先做昂贵的 graphToPrompt。
  const quickInfo = activeWorkflowInfo(serializedWorkflow);
  if (quickInfo.source !== "current-workflow" && !isSavedWorkflow(quickInfo)) {
    await markOpen();
    return;
  }

  syncing = true;
  try {
    const converted = await app.graphToPrompt();
    const prompt = converted?.output;
    const workflow = converted?.workflow || app.graph.serialize();
    if (!prompt || typeof prompt !== "object" || Object.keys(prompt).length === 0) return;

    const info = activeWorkflowInfo(workflow);
    if (!isSavedWorkflow(info)) {
      await markOpen(); // 未保存的不进列表，但其它打开的标签页要照常上报
      return;
    }
    const response = await fetch("/mobile/api/workflows/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        name: info.name,
        source: info.source,
        prompt,
        workflow,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    lastFingerprint = graphFingerprint;
    await markOpen();
    console.info(`${LOG_PREFIX} synced “${body.workflow.name}” for /mobile`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} workflow sync skipped`, error);
  } finally {
    syncing = false;
  }
}

function scheduleSync(delay = 1200, force = true) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => syncCurrentWorkflow(force), delay);
}

app.registerExtension({
  name: "ComfyUI.MobileRemote.AutoSync",

  async setup() {
    scheduleSync(2500, true);
    window.setInterval(() => {
      if (document.visibilityState === "visible") syncCurrentWorkflow(false);
    }, 15000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleSync(800, false);
    });
    // 关掉页面 = 关掉工作流，立刻从手机列表里撤掉
    window.addEventListener("beforeunload", () => {
      try {
        fetch("/mobile/api/workflows/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sources: [] }),
          keepalive: true,
        });
      } catch { /* 忽略 */ }
    });
  },

  async afterConfigureGraph() {
    scheduleSync(1500, true);
  },
});
