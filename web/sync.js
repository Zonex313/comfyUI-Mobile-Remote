import { t } from "./i18n.js?v=202610121";
import { app } from "../../scripts/app.js";

const LOG_PREFIX = "[Mobile Remote]";
const syncRuntime = globalThis.__MTR_SYNC_RUNTIME || (globalThis.__MTR_SYNC_RUNTIME = { started: false });
let lastFingerprint = "";
let lastWorkflowSource = "";
let lastWorkflowSaved = null;
let syncing = false;
let timer = 0;
// 手机端指令只对「它自己那个工作流」有效。记下上次成功同步的工作流编号，以及当时电脑端
// 开着哪一个"身份"：身份对不上就说明用户换了工作流/另存了，节点编号会被另一个图复用，
// 这时候照旧应用等于去改别人的节点。
let lastWorkflowId = "";
let lastWorkflowKey = "";
let pollingCommands = false;

function fastHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
}

function activeWorkflowInfo(workflow) {
  // ComfyUI's workflow store exposes isTemporary for the never-saved draft.
  // isModified/isDirty only describes edits after a real file was opened and
  // must not prevent syncing a saved workflow after it changes.
  const candidate = [
    app.extensionManager?.workflow?.activeWorkflow,
    app.workflowManager?.activeWorkflow,
    app.extensionManager?.workflow?.currentWorkflow,
  ].find(Boolean) || null;

  let source = candidate?.path || candidate?.filename || candidate?.id || "";
  let name = candidate?.name || candidate?.displayName || candidate?.filename || "";
  let saved = null;
  if (candidate) {
    if (typeof candidate.isTemporary === "boolean") saved = !candidate.isTemporary;
    else if (typeof candidate.isSaved === "boolean") saved = candidate.isSaved;
    else saved = true;
  }

  source = String(source || workflow?.path || workflow?.filename || workflow?.id || "current-workflow");
  name = String(name || source.split(/[\\/]/).pop() || t("当前工作流"));
  name = name.replace(/\.json$/i, "").replace(/\s*[-|]\s*ComfyUI.*$/i, "").trim();
  const hasFileSource = Boolean(candidate?.path || candidate?.filename || workflow?.path || workflow?.filename);
  return { source, name: name || t("当前工作流"), saved, hasFileSource };
}

// A real path is authoritative. Names such as Untitled.json are valid saved
// filenames; only the frontend's explicit temporary marker rejects a draft.
function isSavedWorkflow(info) {
  const source = String(info?.source || "").trim();
  if (!source || source === "current-workflow") return false;
  if (info?.saved === false) return false;
  return info?.saved === true || info?.hasFileSource === true;
}

let lastSources = [];

// 电脑端当前打开着的所有工作流（不只前台那一个，后台标签页也算）
function openWorkflowSources() {
  const store = app.extensionManager?.workflow || app.workflowManager;
  // 注意：store.workflows 是整个工作流库（几百个），openWorkflows 才是打开着的标签页
  const list = store?.openWorkflows || store?.openedWorkflows || [];
  const sources = [];
  for (const item of Array.isArray(list) ? list : []) {
    const source = item?.path || item?.filename || item?.id || "";
    if (source && item && item.isTemporary !== true && item.isSaved !== false) sources.push(String(source));
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
  // 身份也必须参与短路：另存或切换到同图工作流时不能沿用旧 source。
  const quickInfo = activeWorkflowInfo(serializedWorkflow);
  const quickKey = quickInfo.source + "|" + String(quickInfo.saved);
  const lastKey = lastWorkflowSource + "|" + String(lastWorkflowSaved);
  if (!force && graphFingerprint === lastFingerprint && quickKey === lastKey) {
    await markOpen(lastSources); // 图没变也要发心跳，否则"打开集合"会超时失效
    return;
  }

  // 已明确标记为未保存的工作流，不必先做昂贵的 graphToPrompt。
  if (!isSavedWorkflow(quickInfo)) {
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
    lastWorkflowSource = info.source;
    lastWorkflowSaved = info.saved;
    lastWorkflowId = String(body.workflow?.id || "");
    lastWorkflowKey = activeWorkflowKey();
    await markOpen();
    console.info(`${LOG_PREFIX} synced “${body.workflow.name}” for /mobile`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} workflow sync skipped`, error);
  } finally {
    syncing = false;
  }
}

// ---- 手机 → 电脑端：把手机上的改动落到本地画布上 ------------------------
// 手机端拿到的是**快照**（API prompt + 原生 workflow），在「高级」页改值只改得动它自己那份
// 数据，电脑画布上的节点毫无变化——自制节点的面板是电脑端自己画的，例如「标签模式」开关得靠
// 它自己的 widget.callback 去 setVisible(true) 才会展开随机标签区。所以手机端把改动写成指令
// 排进服务端待办，这里在本地画布上照做，做完立刻把新状态同步回手机。

// 电脑端“当前是哪个工作流”的身份。刻意不带 workflow 参数：同步成功时记下的就是这一份，
// 两边用同一套算法才比得准。
function activeWorkflowKey() {
  const info = activeWorkflowInfo(null);
  return info.source + "|" + String(info.saved);
}

function markCanvasDirty(node) {
  try { node.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
  try { app.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
  // 新版前端靠 graph 的版本号驱动重绘：不碰它，画布会停在旧画面上。
  try { node.graph?.incrementVersion?.(); } catch { /* 老版前端没有这个方法 */ }
}

// 在画布上照做一条指令。返回值说明处理结果：
// applied（真改了）/ unchanged（本来就是这个值）/ missing-node / missing-widget（找不到，作废）。
function applyDesktopCommand(command) {
  const graph = app?.graph;
  const nodeId = String(command?.node_id ?? "");
  const inputName = String(command?.input ?? "");
  if (!graph || !nodeId || !inputName) return "skip";

  let node = null;
  try { node = graph.getNodeById?.(Number(nodeId)) || null; } catch { node = null; }
  if (!node) {
    // 节点编号不一定是纯数字（UUID 之类），再按字符串逐个体比对一遍。
    const nodes = Array.isArray(graph._nodes) ? graph._nodes : Array.isArray(graph.nodes) ? graph.nodes : [];
    node = nodes.find((item) => String(item?.id) === nodeId) || null;
  }
  if (!node) {
    console.debug(LOG_PREFIX + " 手机端指令作废：画布上没有节点 #" + nodeId + "（" + inputName + "）");
    return "missing-node";
  }

  const widgets = Array.isArray(node.widgets) ? node.widgets : [];
  const widget = widgets.find((item) => item && String(item.name) === inputName) || null;
  if (!widget) {
    console.debug(LOG_PREFIX + " 手机端指令作废：节点 #" + nodeId + " 上没有「" + inputName + "」控件");
    return "missing-widget";
  }

  const previous = widget.value;
  if (previous === command.value) {
    // 值已经一样：前端自己也短路，不重复触发回调（有些节点的回调带副作用）。
    markCanvasDirty(node);
    return "unchanged";
  }

  // 顺序照抄 ComfyUI 前端 BaseWidget.setValue()：写值 → widget.callback → onWidgetChanged。
  widget.value = command.value;
  try {
    // 有些控件把值镜像到节点属性上（前端也会同步这一份）。
    if (widget.options?.property && typeof node.setProperty === "function"
      && node.properties && node.properties[widget.options.property] !== undefined) {
      node.setProperty(widget.options.property, command.value);
    }
  } catch { /* 属性镜像失败不影响控件本身 */ }
  try {
    widget.callback?.(widget.value, app.canvas, node, app.canvas?.graph_mouse, null);
  } catch (error) {
    console.warn(LOG_PREFIX + " 节点 #" + nodeId + " 的「" + inputName + "」控件回调报错", error);
  }
  try {
    node.onWidgetChanged?.(inputName, widget.value, previous, widget);
  } catch (error) {
    console.warn(LOG_PREFIX + " 节点 #" + nodeId + " 的 onWidgetChanged 报错", error);
  }
  markCanvasDirty(node);
  console.info(LOG_PREFIX + " 已应用手机端改动：节点 #" + nodeId + "「" + inputName + "」= " + JSON.stringify(command.value));
  return "applied";
}

async function ackDesktopCommands(ids) {
  if (!ids.length) return;
  try {
    await fetch("/mobile/api/desktop/commands/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ ids }),
    });
  } catch (error) {
    // ack 失败不致命：指令会留在待办里，下一次轮询重放（同值重放是幂等的），只是多画一次。
    console.debug(LOG_PREFIX + " 指令 ack 失败，下次轮询会重放", error);
  }
}

// 领取并应用待办。约 1 秒一次，只在页面可见时跑：手机刚点的开关要马上见效，等不了
// 15 秒的重同步节奏；这里是几十字节的 GET，不影响原有同步的频率控制。
async function pollDesktopCommands() {
  if (pollingCommands || !lastWorkflowId) return;
  if (activeWorkflowKey() !== lastWorkflowKey) return; // 换过工作流：等下一次同步把身份对上再说
  pollingCommands = true;
  let changed = false;
  try {
    const url = "/mobile/api/desktop/commands?workflow_id=" + encodeURIComponent(lastWorkflowId);
    const response = await fetch(url, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) return;
    const commands = Array.isArray(body.commands) ? body.commands : [];
    if (!commands.length) return;
    const handled = [];
    for (const command of commands) {
      const outcome = applyDesktopCommand(command);
      // 找不到节点/控件的也要 ack：重试一万次也找不到，只会把日志刷爆。
      if (outcome !== "skip") handled.push(String(command.id));
      if (outcome === "applied") changed = true;
    }
    await ackDesktopCommands(handled);
    if (changed) {
      // 立刻强制同步一次（绕过指纹短路）：把电脑端的新状态推回手机，那边才看得到节点真的变了。
      await syncCurrentWorkflow(true);
      // 上面那次可能正好撞在别的同步里被挡掉，隔一会儿再兜一次。
      scheduleSync(1200, true);
    }
  } catch (error) {
    console.debug(LOG_PREFIX + " 领取手机端指令失败", error);
  } finally {
    pollingCommands = false;
  }
}

function scheduleSync(delay = 1200, force = true) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => syncCurrentWorkflow(force), delay);
}

app.registerExtension({
  name: "ComfyUI.MobileRemote.AutoSync",

  async setup() {
    if (syncRuntime.started) return;
    syncRuntime.started = true;
    scheduleSync(2500, true);
    window.setInterval(() => {
      if (document.visibilityState === "visible") syncCurrentWorkflow(false);
    }, 15000);
    // 手机端指令是「用户刚点了开关」这种即时操作，单独用 1 秒的小轮询领取；
    // 原来的重同步节奏（15 秒一次 + 图变了才发）一点不动。
    window.setInterval(() => {
      if (document.visibilityState === "visible") pollDesktopCommands();
    }, 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        scheduleSync(800, false);
        pollDesktopCommands();
      }
    });
    // 手工排查用：控制台里能直接 __MTR_SYNC_RUNTIME.pollDesktopCommands()。
    syncRuntime.pollDesktopCommands = pollDesktopCommands;
    syncRuntime.applyDesktopCommand = applyDesktopCommand;
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
