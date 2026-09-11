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

async function syncCurrentWorkflow(force = false) {
  if (syncing || !app?.graph || typeof app.graphToPrompt !== "function") return;

  let graphFingerprint = "";
  try {
    graphFingerprint = fastHash(JSON.stringify(app.graph.serialize()));
  } catch {
    graphFingerprint = `${Date.now()}`;
  }
  if (!force && graphFingerprint === lastFingerprint) return;

  syncing = true;
  try {
    const converted = await app.graphToPrompt();
    const prompt = converted?.output;
    const workflow = converted?.workflow || app.graph.serialize();
    if (!prompt || typeof prompt !== "object" || Object.keys(prompt).length === 0) return;

    const info = activeWorkflowInfo(workflow);
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
  },

  async afterConfigureGraph() {
    scheduleSync(1500, true);
  },
});
