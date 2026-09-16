(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const i18n = () => globalThis.MobileI18n;
  // 界面文案统一走这个入口：词典没到或没翻到就原样显示中文原文。
  const t = (text, params) => {
    const api = i18n();
    return api ? api.t(text, params) : text;
  };

  // 关闭大图后短暂屏蔽底部导航：关闭按钮正压在「设置」标签正上方，
  // 若画面尚未落帧，用户的第二下点击会穿透到导航并误切页面。
  const GALLERY_CLOSE_GUARD_MS = 450;
  // 队列/历史首屏只拉最近这么多条，翻历史时再用 offset 分段往更早的补（省流量）。
  // 「加载更多」每次也是这么多：loadMoreJobsOnce 拿它当 limit 并把游标推进这么多。
  // 取 60 是为了它是 12 的倍数：每页拉的是「批次」，而网格卡片是「图片」，
  // 出图张数固定时每页卡片数 = 批数 × 每批张数，能被 2/3/4 整除才不会在翻页
  // 边界上留半截行（50 就不是，3 列/4 列下会剩 2 张）。
  const JOBS_PAGE = 60;
  // 上滑松手后底部 dock 落回原位要 160ms（见 styles.css 的 .nav-dock）。
  // 果冻的「压扁」和上滑换色的起点都得对齐这一刻：落地那下才算数。
  const DOCK_LANDING_MS = 160;
  const state = {
    online: false,
    status: null,
    workflows: [],
    workflow: null,
    values: {},
    jobs: [],
    totalJobs: 0,
    jobsFirstPage: [],
    jobsOlderPages: [],
    jobsLoadedCount: 0,
    jobsPageOffset: 0,
    jobsHasMore: false,
    jobsMoreLoading: false,
    activeJob: null,
    currentJobId: "",
    progress: new window.MobileProgressStore(),
    optimisticJobs: new Map(),
    websocket: null,
    reconnectDelay: 1000,
    reconnectTimer: 0,
    previewUrl: "",
    dialogJob: null,
    workflowLoadToken: 0,
    fieldControls: new Map(),
    advancedControls: new Map(),
    galleryItems: [],
    galleryIndex: 0,
    galleryJobId: "",
    galleryLoadToken: 0,
    galleryCloseGuardUntil: 0,
    jobDialogToken: 0,
    gallerySeenUrls: new Set(),
    favoritesOnly: false,
    jobsMode: null,
    flatGallery: [],
    galleryTouchStart: null,
    historyReady: false,
    historySeenKeys: new Set(),
    historyRenderSignature: "",
    historyCards: new Map(),
    nodeTitles: new Map(),
    presetCatalog: [],
    presetRules: {},
    presetEnabled: false,
    presetState: { slots: {}, custom: {}, freeText: "", extraText: "", catalog: {} },
    presetCatalogKeyPresent: false,
    lastCatalogBaseline: null,
    effectiveRulesCache: null,
    presetField: null,
    presetTextarea: null,
    presetPanel: null,
    presetEditing: null,
    randomGenerate: false,
    repeatCount: 1,
    multiModel: false,
    fixedSeed: false,
    multiModelList: [],
    modelField: null,
  };

  let hydratingSettings = 0;
  let submittingBatch = false;
  let applyingRemoteSettings = false;
  let catalogInvalidNotified = false;
  // MobileSettingsSync 构造时就会回调一次 onStatus，所以这个变量必须先声明，
  // 否则 renderSettingsSync 会在 TDZ 里赋值失败、整个页面起不来。
  let lastSettingsStatus = null;
  const phoneSettings = new window.MobileSettingsSync({ onStatus: renderSettingsSync });

  function renderSettingsSync(status) {
    lastSettingsStatus = status;
    const saved = status.savedAt ? new Date(status.savedAt) : null;
    const time = saved ? localeTime(saved) : "";
    const labels = { loading: t("读取设置"), pending: t("待同步"), saving: t("同步中"), offline: t("未同步"), conflict: t("设置冲突") };
    const label = status.state === "synced" ? (time ? t("{time}已同步", { time: time }) : t("尚未同步")) : (labels[status.state] || t("待同步"));
    // 同步状态只在设置页那一行显示，顶栏不再重复。
    setText("settingsSyncDetail", label);
    $("settingsSyncConflict")?.classList.toggle("hidden", status.state !== "conflict");
    if (status.catalogInvalid) {
      if (!catalogInvalidNotified) {
        catalogInvalidNotified = true;
        toast(t("电脑标签目录损坏，其它设置仍会同步"), "error");
      }
    } else catalogInvalidNotified = false;
    if (status.catalogRebased) applyCatalogFromSettings();
  }

  const clientId = (() => {
    const key = "comfy-mobile-remote.client-id";
    let value = "";
    try { value = localStorage.getItem(key) || ""; } catch { /* storage optional */ }
    if (!value) {
      value = globalThis.crypto?.randomUUID?.() || `mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try { localStorage.setItem(key, value); } catch { /* storage optional */ }
    }
    return value;
  })();

  const ICONS = {
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
    video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 13 5 3V8l-5 3"/><rect x="3" y="5" width="13" height="14" rx="2"/></svg>',
    audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-8 4-4 4 4M5 21h14"/></svg>',
  };

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let amount = bytes;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
  }

  // 日期时间交给 Intl：「今天 14:03」「Sep 15 14:03」这类写法各语言差别太大，
  // 用拼字符串的方式拼不出自然的日语和韩语。
  function localeTime(date) {
    const api = i18n();
    const options = { hour: "2-digit", minute: "2-digit" };
    return api ? api.formatTime(date, options) : date.toLocaleTimeString();
  }

  function localeDateTime(date) {
    const api = i18n();
    // 运行时没加载时退回中文写法，和 t() 的兜底保持一致。
    if (!api) return `${date.getMonth() + 1}月${date.getDate()}日 ${localeTime(date)}`;
    return `${api.formatDate(date, { month: "short", day: "numeric" })} ${localeTime(date)}`;
  }

  function formatTime(value) {
    const timestamp = Number(value || 0);
    if (!timestamp) return t("时间未知");
    const date = new Date(timestamp);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay ? t("今天 {time}", { time: localeTime(date) }) : localeDateTime(date);
  }

  function describeError(body, fallback = t("请求失败")) {
    if (!body) return fallback;
    // 后端已按请求语言返回；这里再过一层词典兜底，没翻到的仍是中文原文。
    if (typeof body.error === "string") return t(body.error);
    if (body.error?.message) return t(body.error.message);
    if (typeof body.details === "string") return t(body.details);
    if (body.details?.error?.message) return t(body.details.error.message);
    if (body.details?.error?.details) return t(body.details.error.details);
    return fallback;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) {
      throw new Error(describeError(body, `HTTP ${response.status}`));
    }
    return body;
  }

  function toast(message, type = "") {
    const item = document.createElement("div");
    item.className = `toast ${type}`.trim();
    // 提示里可能混着后端原文，统一再过一次词典。
    item.textContent = t(String(message || "")).replace(/[，。、；：！？,.!?;:…—·“”‘’"'（）()[\]《》【】]/g, "").trim();
    if (!item.textContent) return;
    $("toastRegion").append(item);
    window.setTimeout(() => {
      item.classList.add("is-leaving");
      window.setTimeout(() => item.remove(), 180);
    }, 1000);
  }

  function showView(target) {
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle("active", view.dataset.view === target);
    });
    document.querySelectorAll(".nav-button").forEach((button) => {
      const active = button.dataset.target === target;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    window.scrollTo({ top: 0, behavior: "auto" });
    // 高级页按 state.values 整块重渲染：生成页/草稿里的改动切过去就能看见。
    if (target === "advanced") advancedPage?.show();
    // 反向同步：高级页改过值，切回生成页时重绘控件（值取自草稿，改值时会存草稿）。
    if (target === "generate" && advancedEdited) {
      advancedEdited = false;
      if (state.workflow) renderWorkflow(state.workflow);
    }
    if (target === "history") loadJobs().catch(() => {});
  }

  // 「高级」页（按组/节点浏览并编辑参数）实现全部在 mobile/advanced.js 里，
  // 这里只注入依赖：它不认识 app.js 的内部变量，也不需要认识。
  let advancedPage = null;
  // 高级页改过值 → 切回生成页时按最新值重绘控件，避免两边显示不一致。
  let advancedEdited = false;
  function setupAdvancedPage() {
    if (advancedPage) return advancedPage;
    const api = globalThis.MobileAdvanced;
    if (!api || typeof api.mount !== "function") return null;
    try {
      advancedPage = api.mount({
        document,
        t,
        $,
        state,
        renderField,
        updateFieldValue,
        onAction: (nodeId, action, value) => {
          advancedEdited = true;
          pushDesktopAction(nodeId, action, value);
        },
        // 组操作（改名 / 改颜色）：组 id 是 g<序号>，和电脑端 workflow.groups 的下标一致。
        onGroupAction: (index, action, value) => {
          advancedEdited = true;
          pushDesktopAction("g" + String(index), action, value);
        },
        onEdit: (field, value) => {
          advancedEdited = true;
          // 「高级」页改的值必须送回电脑端：那边的自制节点要靠自己的回调重画面板，
          // 光改手机这份快照是改不动它的。
          if (field) pushDesktopCommand(field.node_id, field.input, value);
        },
        view: "view-advanced",
      });
    } catch (error) {
      console.warn("[Mobile Remote] advanced page failed to mount", error);
    }
    return advancedPage;
  }

  function uiVersion() {
    const src = document.querySelector('script[src*="app.js"]')?.src || "";
    const match = /[?&]v=([^&]+)/.exec(src);
    return match ? match[1] : t("未知");
  }

  function renderStatus(status) {
    state.status = status;
    state.online = Boolean(status?.online);
    setText("connectionLabel", state.online ? t("已连接") : t("离线"));
    setText("runningCount", status?.running ?? 0);
    setText("pendingCount", status?.pending ?? 0);

    const gpu = status?.gpu || {};
    const gpuName = gpu.name || t("GPU 状态未知");
    const memory = gpu.total ? `${formatBytes(gpu.used)} / ${formatBytes(gpu.total)}` : "";
    setText("settingsGpu", memory ? `${gpuName} · ${memory}` : gpuName);
    setText("pluginVersion", t("{value} · 界面 {value1}", { value: status?.version || "-", value1: uiVersion() }));
    setText("currentAddress", `${location.origin}/mobile`);
    setText("tailscaleAddress", status?.mobile_urls?.[0] || t("未检测到"));

    paintStopAllButton(stoppingAllJobs);
  }

  async function loadStatus() {
    try {
      const body = await requestJson(`/mobile/api/status?_=${Date.now()}`);
      renderStatus(body);
    } catch {
      state.online = false;
      setText("connectionLabel", t("连接失败"));
    }
  }

  function draftKey(workflowId) {
    return `comfy-mobile-remote.draft.${workflowId}`;
  }

  function saveDraft() {
    if (hydratingSettings || !state.workflow?.id) return;
    phoneSettings.setItem(draftKey(state.workflow.id), JSON.stringify(state.values));
    phoneSettings.setItem("comfy-mobile-remote.workflow", state.workflow.id);
  }

  function loadDraft(workflow, fields) {
    // 生成页字段只是精选参数；高级页还会编辑 graph.inputs 里的其它输入。
    // 先把整张图的可编辑输入放进默认表，再用同一份草稿覆盖，避免切页后丢值。
    const defaults = Object.fromEntries(fields.map((field) => [field.id, field.value]));
    const nodes = workflow && workflow.graph && Array.isArray(workflow.graph.nodes)
      ? workflow.graph.nodes
      : [];
    for (const node of nodes) {
      const nodeId = String(node && node.id !== undefined ? node.id : "");
      if (!nodeId || !Array.isArray(node && node.inputs)) continue;
      for (const input of node.inputs) {
        const name = String(input && input.name !== undefined ? input.name : "");
        if (!name || input.link) continue;
        const key = nodeId + "::" + name;
        if (!Object.hasOwn(defaults, key)) defaults[key] = input.value;
      }
    }
    try {
      const saved = JSON.parse(phoneSettings.getItem(draftKey(workflow.id)) || "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [key, value] of Object.entries(saved)) {
          // 只恢复当前工作流仍存在的键，避免旧工作流残留值污染新图。
          if (Object.hasOwn(defaults, key)) defaults[key] = value;
        }
      }
    } catch { /* Use workflow defaults if a cached draft is unreadable. */ }
    return defaults;
  }

  function inputLabel(field) {
    const row = document.createElement("span");
    row.className = "field-label-row";
    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = t(field.label);
    const node = document.createElement("span");
    node.className = "field-node";
    node.textContent = field.node_title;
    node.title = field.node_title;
    row.append(label, node);
    return row;
  }

  function updateFieldValue(field, value) {
    state.values[field.id] = value;
    saveDraft();
    if (field.input === "width" || field.input === "height") syncSizePresetSelection();
  }

  // ---- 手机 → 电脑端：把「高级」页的改动送回电脑端画布 --------------------
  // 手机端拿到的是电脑端同步过来的**快照**：改值只写进 state.values，电脑画布上的节点毫无变化
  // （自制节点的面板由电脑端自己画，开关不送回去就永远没反应）。所以这里把改动写成一条指令
  // 发给服务端排队，由电脑端 web/sync.js 在它自己的画布上照做，再把它那边的新状态同步回来。
  const DESKTOP_COMMAND_THROTTLE_MS = 1000;
  const desktopCommands = new Map();   // "节点::输入名" → 最后一次改动（同一格的中间值直接覆盖）
  let desktopCommandTimer = 0;

  // 只有服务端认得下的输入才值得发。graph 是服务端按当前 prompt 建的，和服务端
  // _desktop_command_from_payload 的校验同源：前端专有控件（种子模式那种）不在 prompt 里，
  // 发了也会被拒。拿不到 graph 就不拦，交给服务端判断。
  function desktopInputExists(nodeId, input) {
    const nodes = state.workflow?.graph?.nodes;
    if (!Array.isArray(nodes)) return true;
    const node = nodes.find((item) => String(item?.id) === String(nodeId));
    if (!node) return false;
    const inputs = Array.isArray(node.inputs) ? node.inputs : [];
    // 被连线接管的输入是插槽不是控件，送过去也会被服务端拒。
    return inputs.some((entry) => String(entry?.name) === String(input) && !entry.frontend && !entry.link);
  }

  function flushDesktopCommands() {
    desktopCommandTimer = 0;
    if (!desktopCommands.size) return;
    const queued = [...desktopCommands.values()];
    desktopCommands.clear();
    for (const command of queued) {
      requestJson("/mobile/api/desktop/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      }).then((body) => {
        // 电脑端会自己领取并应用，然后把它那边的新状态同步回来。
        console.debug("[Mobile Remote] desktop command queued", command.node_id, command.input, body?.pending ?? 0);
      }).catch((error) => {
        // 电脑端没开着、工作流没同步过、或走公网隧道被挡：静默处理，绝不打扰用户。
        console.debug("[Mobile Remote] desktop command skipped", command.node_id, command.input, error?.message || error);
      });
    }
  }

  // 高级页改一个值就调这里：同一 (节点, 输入) 1 秒内只发最后一次。
  function pushDesktopCommand(nodeId, input, value) {
    const workflowId = state.workflow?.id;
    const id = String(nodeId ?? "");
    const name = String(input ?? "");
    if (!workflowId || !id || !name) return;
    if (!desktopInputExists(id, name)) {
      console.debug("[Mobile Remote] desktop command skipped: 工作流里没有这个输入", id, name);
      return;
    }
    desktopCommands.set(id + "::" + name, { workflow_id: workflowId, node_id: id, input: name, value });
    if (desktopCommandTimer) return;
    desktopCommandTimer = window.setTimeout(flushDesktopCommands, DESKTOP_COMMAND_THROTTLE_MS);
  }

  // 参考项目节点菜单动作：与控件修改共用同一条可靠指令队列。
  function pushDesktopAction(nodeId, action, value = true) {
    const workflowId = state.workflow?.id;
    const id = String(nodeId ?? "");
    const name = "action";
    if (!workflowId || !id || !action) return;
    desktopCommands.set(id + "::" + action, { workflow_id: workflowId, node_id: id, input: name, action: String(action), value });
    if (desktopCommandTimer) return;
    desktopCommandTimer = window.setTimeout(flushDesktopCommands, DESKTOP_COMMAND_THROTTLE_MS);
  }

  function autoGrow(area) {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }

  function makeTextInput(field, index) {
    const isArea = field.kind === "textarea";
    const input = document.createElement(isArea ? "textarea" : "input");
    if (!isArea) input.type = field.kind === "search" ? "search" : "text";
    input.id = `field-${index}`;
    input.value = state.values[field.id] ?? "";
    input.autocomplete = "off";
    input.spellcheck = isArea;
    if (isArea) {
      input.rows = 1;
      input.addEventListener("input", () => {
        updateFieldValue(field, input.value);
        autoGrow(input);
      });
      window.requestAnimationFrame(() => autoGrow(input));
    } else {
      input.addEventListener("input", () => updateFieldValue(field, input.value));
    }

    if (field.kind === "search" && Array.isArray(field.options)) {
      const listId = `options-${index}`;
      input.setAttribute("list", listId);
      const datalist = document.createElement("datalist");
      datalist.id = listId;
      field.options.slice(0, 1200).forEach((option) => {
        const element = document.createElement("option");
        element.value = String(option);
        datalist.append(element);
      });
      const fragment = document.createDocumentFragment();
      fragment.append(input, datalist);
      return fragment;
    }
    return input;
  }

  function modelOptionList(field) {
    const current = String(state.values[field?.id] ?? "");
    const options = Array.isArray(field?.options) ? field.options.map(String) : [];
    if (current && !options.includes(current)) options.unshift(current);
    return options.filter(Boolean);
  }

  function selectedModelQueue() {
    const field = state.modelField;
    const current = field ? String(state.values[field.id] ?? "") : "";
    if (!state.multiModel || !field) return current ? [current] : [];
    const allowed = new Set(modelOptionList(field));
    const listed = state.multiModelList.map(String).filter((name) => allowed.has(name));
    if (listed.length) return listed;
    return current && allowed.has(current) ? [current] : [];
  }

  function persistModelTools() {
    if (hydratingSettings) return;
    phoneSettings.setItem("comfy-mobile-remote.multiModel", state.multiModel ? "1" : "0");
    phoneSettings.setItem("comfy-mobile-remote.fixedSeed", state.fixedSeed ? "1" : "0");
    let saved = {};
    try { saved = JSON.parse(phoneSettings.getItem("comfy-mobile-remote.multiModels") || "{}"); } catch { saved = {}; }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
    if (state.workflow?.id) saved[state.workflow.id] = selectedModelQueue();
    phoneSettings.setItem("comfy-mobile-remote.multiModels", JSON.stringify(saved));
  }

  function paintModelTools() {
    const multi = $("multiModelToggle");
    const seed = $("fixedSeedToggle");
    if (multi) multi.checked = state.multiModel;
    if (seed) {
      seed.checked = state.multiModel && state.fixedSeed;
      seed.disabled = !state.multiModel;
      seed.closest(".model-tool")?.classList.toggle("is-disabled", !state.multiModel);
    }
    const wrap = document.querySelector(".model-select-wrap");
    wrap?.classList.toggle("is-multi", state.multiModel);
    const picker = $("modelPickerButton");
    if (picker) {
      const names = selectedModelQueue();
      const first = names[0] || t("选择模型");
      picker.textContent = names.length > 1 ? t("{first} · {length}个", { first: first, length: names.length }) : first;
      picker.title = names.join("\n");
    }
    document.querySelector(".generate-fab")?.classList.toggle("multi-model", state.multiModel);
  }

  function setMultiModel(enabled) {
    state.multiModel = Boolean(enabled);
    if (state.multiModel) {
      state.repeatCount = 1;
      phoneSettings.setItem("comfy-mobile-remote.repeatCount", "1");
      if (!selectedModelQueue().length && state.modelField) {
        const current = String(state.values[state.modelField.id] ?? "");
        state.multiModelList = current ? [current] : [];
      }
    } else {
      const first = selectedModelQueue()[0];
      if (first && state.modelField) updateFieldValue(state.modelField, first);
    }
    persistModelTools();
    paintModelTools();
    paintGenerateButton();
  }

  function setFixedSeed(enabled) {
    state.fixedSeed = state.multiModel && Boolean(enabled);
    persistModelTools();
    paintModelTools();
  }

  function togglePickedModel(name) {
    const options = modelOptionList(state.modelField);
    const allowed = new Set(options);
    if (!allowed.has(name)) return;
    const selected = new Set(selectedModelQueue());
    if (selected.has(name)) {
      if (selected.size === 1) return;
      selected.delete(name);
    } else if (selected.size < 20) selected.add(name);
    state.multiModelList = options.filter((item) => selected.has(item));
    if (state.modelField) updateFieldValue(state.modelField, state.multiModelList[0]);
    persistModelTools();
    paintModelTools();
    renderModelPickerList();
  }

  function renderModelPickerList() {
    const list = $("modelPickerList");
    if (!list) return;
    const query = String($("modelPickerSearch")?.value || "").trim().toLowerCase();
    const selected = new Set(selectedModelQueue());
    list.replaceChildren();
    modelOptionList(state.modelField).forEach((name) => {
      if (query && !name.toLowerCase().includes(query)) return;
      const row = document.createElement("button");
      row.type = "button";
      row.className = `model-pick-item${selected.has(name) ? " is-on" : ""}`;
      row.setAttribute("aria-pressed", selected.has(name) ? "true" : "false");
      const mark = document.createElement("span");
      mark.className = "model-pick-check";
      mark.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "model-pick-name";
      label.textContent = name;
      label.title = name;
      row.append(mark, label);
      row.addEventListener("click", () => togglePickedModel(name));
      list.append(row);
    });
    const count = $("modelPickerCount");
    if (count) count.textContent = t("已选 {size} 个", { size: selected.size });
  }

  function openModelPicker() {
    if (!state.multiModel || !state.modelField) return;
    const search = $("modelPickerSearch");
    if (search) search.value = "";
    renderModelPickerList();
    $("modelPickerDialog")?.showModal();
  }

  function makeMiniToggle(id, caption, onChange) {
    const wrap = document.createElement("label");
    wrap.className = "model-tool";
    wrap.title = caption;
    const text = document.createElement("span");
    text.className = "model-mini-caption";
    text.textContent = caption;
    const toggle = document.createElement("span");
    toggle.className = "toggle preset-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.setAttribute("aria-label", caption);
    const visual = document.createElement("span");
    visual.setAttribute("aria-hidden", "true");
    input.addEventListener("change", () => onChange(input.checked));
    toggle.append(input, visual);
    wrap.append(text, toggle);
    return wrap;
  }

  function attachModelTools(wrapper, field) {
    if (wrapper.querySelector(".model-tools")) return;
    const tools = document.createElement("div");
    tools.className = "model-tools";
    tools.append(
      makeMiniToggle("multiModelToggle", t("多模型"), setMultiModel),
      makeMiniToggle("fixedSeedToggle", t("单次种子固定"), setFixedSeed),
    );
    const labelRow = wrapper.querySelector(".field-label-row");
    labelRow?.after(tools);
    paintModelTools();
  }

  function makeSelect(field, index) {
    const wrap = document.createElement("span");
    wrap.className = "select-wrap";
    const select = document.createElement("select");
    select.id = `field-${index}`;
    const current = String(state.values[field.id] ?? "");
    const options = Array.isArray(field.options) ? [...field.options] : [];
    if (!options.some((option) => String(option) === current)) options.unshift(current);
    options.forEach((option) => {
      const element = document.createElement("option");
      element.value = String(option);
      element.textContent = String(option);
      element.selected = String(option) === current;
      select.append(element);
    });
    select.addEventListener("change", () => {
      updateFieldValue(field, select.value);
      if (isModelField(field) && !state.multiModel) {
        state.multiModelList = select.value ? [select.value] : [];
        persistModelTools();
      }
    });
    wrap.append(select);
    if (isModelField(field)) {
      wrap.classList.add("model-select-wrap");
      const picker = document.createElement("button");
      picker.type = "button";
      picker.id = "modelPickerButton";
      picker.className = "model-picker-button";
      picker.addEventListener("click", openModelPicker);
      wrap.append(picker);
    }
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("viewBox", "0 0 24 24");
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = '<path d="m6 9 6 6 6-6"/>';
    wrap.append(chevron);
    return wrap;
  }

  function makeNumber(field, index) {
    const row = document.createElement("div");
    row.className = field.randomizable ? "random-row" : "number-row";
    const decrement = document.createElement("button");
    decrement.type = "button";
    decrement.className = "stepper-button";
    decrement.textContent = "−";
    decrement.setAttribute("aria-label", t("{label}减小", { label: field.label }));

    const input = document.createElement("input");
    input.type = "number";
    input.id = `field-${index}`;
    input.inputMode = field.step && Number(field.step) % 1 !== 0 ? "decimal" : "numeric";
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    input.step = field.step ?? (Number.isInteger(field.value) ? 1 : "any");

    const increment = document.createElement("button");
    increment.type = "button";
    increment.className = "stepper-button";
    increment.textContent = "+";
    increment.setAttribute("aria-label", t("{label}增大", { label: field.label }));

    let randomButton = null;
    const paint = () => {
      const random = state.values[field.id] === "__random__";
      input.disabled = random;
      input.value = random ? "" : state.values[field.id] ?? field.value;
      if (randomButton) {
        randomButton.classList.toggle("active", random);
        randomButton.textContent = t("随机");
      }
    };

    const move = (direction) => {
      const current = Number(input.value || field.value || 0);
      const step = Number(field.step ?? (Number.isInteger(field.value) ? 1 : 0.1));
      let next = current + direction * step;
      if (field.min !== undefined) next = Math.max(Number(field.min), next);
      if (field.max !== undefined) next = Math.min(Number(field.max), next);
      if (Number.isInteger(field.value)) next = Math.round(next);
      updateFieldValue(field, next);
      paint();
    };

    decrement.addEventListener("click", () => move(-1));
    increment.addEventListener("click", () => move(1));
    input.addEventListener("input", () => updateFieldValue(field, input.value));
    const group = document.createElement("div");
    group.className = "stepper-group";
    group.append(decrement, input, increment);
    row.append(group);

    if (field.randomizable) {
      randomButton = document.createElement("button");
      randomButton.type = "button";
      randomButton.className = "random-button";
      randomButton.addEventListener("click", () => {
        const random = state.values[field.id] === "__random__";
        updateFieldValue(field, random ? field.value : "__random__");
        paint();
      });
      row.append(randomButton);
    }
    paint();
    return row;
  }

  function makeCompactNumber(field, index) {
    const input = document.createElement("input");
    input.type = "number";
    input.id = `field-${index}`;
    input.inputMode = "numeric";
    input.value = state.values[field.id] ?? field.value;
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    input.step = field.step ?? 1;
    input.addEventListener("input", () => updateFieldValue(field, input.value));
    return input;
  }

  function makeSeedRow(field, index) {
    const row = document.createElement("div");
    row.className = "number-row";
    const input = document.createElement("input");
    input.type = "number";
    input.id = `field-${index}`;
    input.inputMode = "numeric";
    input.value = state.values[field.id] ?? field.value;
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    input.step = field.step ?? 1;
    input.addEventListener("input", () => updateFieldValue(field, input.value));

    let randomButton = null;
    const paint = () => {
      const random = state.values[field.id] === "__random__";
      input.disabled = random;
      input.value = random ? "" : state.values[field.id] ?? field.value;
      if (randomButton) {
        randomButton.classList.toggle("active", random);
        randomButton.textContent = t("随机");
      }
    };

    randomButton = document.createElement("button");
    randomButton.type = "button";
    randomButton.className = "random-button";
    randomButton.setAttribute("aria-label", t("{label}随机开关", { label: field.label }));
    randomButton.addEventListener("click", () => {
      const random = state.values[field.id] === "__random__";
      updateFieldValue(field, random ? field.value : "__random__");
      paint();
    });

    const randomGroup = document.createElement("div");
    randomGroup.className = "random-group";
    randomGroup.append(input, randomButton);
    row.append(randomGroup);
    paint();
    return row;
  }

  function makeToggle(field, index) {
    const row = document.createElement("div");
    row.className = "toggle-row";
    const value = document.createElement("span");
    value.className = "field-note";
    const label = document.createElement("label");
    label.className = "toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `field-${index}`;
    input.checked = Boolean(state.values[field.id]);
    const visual = document.createElement("span");
    visual.setAttribute("aria-hidden", "true");
    const paint = () => { value.textContent = input.checked ? t("已开启") : t("已关闭"); };
    input.addEventListener("change", () => {
      updateFieldValue(field, input.checked);
      paint();
    });
    paint();
    label.append(input, visual);
    row.append(value, label);
    return row;
  }

  function splitInputPath(value) {
    const normalized = String(value || "").replace(/\\/g, "/");
    const parts = normalized.split("/");
    const filename = parts.pop() || "";
    return { filename, subfolder: parts.join("/") };
  }

  function inputImageUrl(value) {
    const { filename, subfolder } = splitInputPath(value);
    if (!filename) return "";
    const query = new URLSearchParams({ filename, subfolder, type: "input" });
    return `/view?${query}`;
  }

  function makeImageInput(field, index) {
    const container = document.createElement("div");
    const row = document.createElement("div");
    row.className = "upload-row";
    const input = document.createElement("input");
    input.type = "text";
    input.id = `field-${index}`;
    input.value = state.values[field.id] ?? "";
    input.autocomplete = "off";
    input.addEventListener("input", () => {
      updateFieldValue(field, input.value);
      paintPreview();
    });

    const upload = document.createElement("label");
    upload.className = "upload-button";
    upload.innerHTML = `${ICONS.upload}<span>${t("上传")}</span>`;
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.setAttribute("aria-label", t("上传{label}", { label: field.label }));
    upload.append(file);

    const preview = document.createElement("img");
    preview.className = "image-field-preview hidden";
    preview.alt = t(field.label);
    const paintPreview = () => {
      const url = inputImageUrl(input.value);
      if (url) {
        preview.src = url;
        preview.classList.remove("hidden");
      } else {
        preview.removeAttribute("src");
        preview.classList.add("hidden");
      }
    };

    file.addEventListener("change", async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      upload.classList.add("busy");
      const form = new FormData();
      form.append("image", selected, selected.name);
      form.append("type", "input");
      form.append("subfolder", "mobile_remote");
      form.append("overwrite", "false");
      try {
        const response = await fetch("/upload/image", { method: "POST", body: form });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.name) throw new Error(describeError(body, t("图片上传失败")));
        const next = [body.subfolder, body.name].filter(Boolean).join("/");
        input.value = next;
        updateFieldValue(field, next);
        paintPreview();
        toast(t("图片已上传"), "success");
      } catch (error) {
        toast(error.message || t("图片上传失败"), "error");
      } finally {
        upload.classList.remove("busy");
        file.value = "";
      }
    });

    row.append(input, upload);
    container.append(row, preview);
    paintPreview();
    return container;
  }

  // controls：控件表，默认是生成页那份；高级页会传自己的一份（同一个字段两处控件互不覆盖）。
  function renderField(field, index, compact = false, controls = state.fieldControls) {
    const wrapper = document.createElement("div");
    wrapper.className = compact ? "field compact-field" : "field";
    wrapper.dataset.input = field.input;
    wrapper.append(inputLabel(field));

    let control;
    if (field.kind === "number") control = compact ? makeCompactNumber(field, index) : makeNumber(field, index);
    else if (field.kind === "toggle") control = makeToggle(field, index);
    else if (
      field.kind === "select"
      || (field.kind === "search" && Array.isArray(field.options) && field.options.length > 0)
    ) control = makeSelect(field, index);
    else if (field.kind === "image") control = makeImageInput(field, index);
    else control = makeTextInput(field, index);
    wrapper.append(control);
    controls.set(field.id, control);
    if (isPositiveField(field) && field.kind === "textarea") {
      attachPresetPanel(wrapper, field, control);
    }
    if (field === state.modelField) attachModelTools(wrapper, field);
    return wrapper;
  }

  const ADVANCED_INPUTS = new Set([
    "steps",
    "cfg",
    "denoise",
    "sampler_name",
    "scheduler",
  ]);

  function isNegativeField(field) {
    return ["negative", "negative_prompt"].includes(field.input)
      || field.label === "反向提示词";
  }

  function isPositiveField(field) {
    return field.label === "正向提示词"
      || ["positive", "positive_prompt"].includes(field.input);
  }

  const PRESET_STORAGE_KEY = "comfy-mobile-remote.preset";
  const PRESET_CATALOG_KEY = "comfy-mobile-remote.presetCatalog";
  function presetCatalogApi() {
    return globalThis.MobilePresetCatalog;
  }

  function mobilePresetEngineApi() {
    return globalThis.MobilePresetEngine;
  }

  // The shared preset engine captures the catalog, preset state and builtin rules
  // it is created with, so replacing any of them rebuilds the engine. The app-level
  // state.effectiveRulesCache stays the "rules are stale" flag: setting it to null
  // forces the engine to recompute on the next call.
  let presetEngineInstance = null;
  let presetEngineCategories = null;
  let presetEngineState = null;
  let presetEngineRules = null;

  function presetEngine() {
    if (presetEngineInstance === null
      || presetEngineCategories !== state.presetCatalog
      || presetEngineState !== state.presetState
      || presetEngineRules !== state.presetRules) {
      presetEngineCategories = state.presetCatalog;
      presetEngineState = state.presetState;
      presetEngineRules = state.presetRules;
      presetEngineInstance = mobilePresetEngineApi().create({
        categories: state.presetCatalog,
        state: state.presetState,
        rules: state.presetRules,
      });
      state.effectiveRulesCache = true;
    } else if (!state.effectiveRulesCache) {
      presetEngineInstance.invalidateRules();
      state.effectiveRulesCache = true;
    }
    return presetEngineInstance;
  }

  function clonePresetData(value, fallback) {
    if (value === undefined) return fallback;
    try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
  }

  function catalogFromValues(values) {
    return presetCatalogApi().fromValues(values);
  }

  function presetStateCatalog() {
    return presetEngine().presetStateCatalog();
  }

  function effectivePresetRules() {
    return presetEngine().effectiveRules();
  }

  function loadPresetState() {
    let parsed = {};
    let legacyPresetInvalid = false;
    try {
      const value = JSON.parse(phoneSettings.getItem(PRESET_STORAGE_KEY) || "{}");
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
      else legacyPresetInvalid = true;
    } catch { legacyPresetInvalid = true; }

    const sharedRaw = phoneSettings.getItem(PRESET_CATALOG_KEY);
    const keyPresent = sharedRaw !== null && sharedRaw !== undefined;
    state.presetCatalogKeyPresent = keyPresent;
    const catalog = keyPresent
      ? parseCatalog(sharedRaw)
      : catalogFromValues({ [PRESET_STORAGE_KEY]: JSON.stringify(parsed) });
    state.lastCatalogBaseline = clonePresetData(catalog, emptyCatalog());

    state.presetEnabled = Boolean(parsed.enabled);
    state.presetState = {
      slots: parsed.slots && typeof parsed.slots === "object" && !Array.isArray(parsed.slots)
        ? clonePresetData(parsed.slots, {}) : {},
      custom: catalog.custom,
      freeText: typeof parsed.freeText === "string" ? parsed.freeText : "",
      extraText: typeof parsed.extraText === "string" ? parsed.extraText : "",
      catalog,
    };
    if (!keyPresent && !legacyPresetInvalid && phoneSettings.known && !phoneSettings.serverCatalogInvalid) {
      // Creates the authoritative key exactly once; ordinary slot saves below
      // never rewrite it unless a catalog entry itself changed.
      savePresetState({ catalogChanged: true, migrateCatalog: true });
    }
  }

  function applyCatalogFromSettings() {
    if (submittingBatch || applyingRemoteSettings) return;
    const slots = clonePresetData(state.presetState.slots, {});
    const freeText = state.presetState.freeText;
    const extraText = state.presetState.extraText;
    const enabled = state.presetEnabled;
    hydratingSettings += 1;
    try {
      loadPresetState();
    } catch {
      return;
    } finally {
      hydratingSettings = Math.max(0, hydratingSettings - 1);
    }
    state.presetState.slots = slots;
    state.presetState.freeText = freeText;
    state.presetState.extraText = extraText;
    state.presetEnabled = enabled;
    state.presetState.custom = state.presetState.catalog?.custom || {};
    markPresetConflicts();
    if (state.presetEnabled) applyPresetPrompt();
    renderPresetPanel();
  }

  function snapshotSlotStates(slots) {
    const out = {};
    if (!slots || typeof slots !== "object" || Array.isArray(slots)) return out;
    for (const [key, value] of Object.entries(slots)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      out[key] = {
        value: value.value === undefined || value.value === null ? "" : String(value.value),
        locked: Boolean(value.locked),
        ignored: Boolean(value.ignored),
      };
    }
    return out;
  }

  function savePresetState({ catalogChanged = false, migrateCatalog = false } = {}) {
    if (hydratingSettings) return;
    try {
      const catalog = presetStateCatalog();
      phoneSettings.setItem(PRESET_STORAGE_KEY, JSON.stringify({
        enabled: state.presetEnabled,
        slots: snapshotSlotStates(state.presetState.slots),
        custom: clonePresetData(catalog.custom, {}),
        freeText: state.presetState.freeText,
        extraText: state.presetState.extraText,
        catalog: clonePresetData(catalog, emptyCatalog()),
      }));
      if (catalogChanged || migrateCatalog) {
        phoneSettings.setItem(PRESET_CATALOG_KEY, JSON.stringify(clonePresetData(catalog, emptyCatalog())));
        state.presetCatalogKeyPresent = true;
        state.lastCatalogBaseline = clonePresetData(catalog, emptyCatalog());
      }
    } catch { /* storage optional */ }
  }

  function savePresetCatalog() {
    if (hydratingSettings) return;
    const local = normalizeCatalog(state.presetState.catalog);
    const rawRemote = phoneSettings.getItem(PRESET_CATALOG_KEY);
    const remote = rawRemote === null ? emptyCatalog() : parseCatalog(rawRemote);
    const base = state.lastCatalogBaseline || remote;
    const merged = mergeCatalog(base, local, remote);
    state.presetState.catalog = merged;
    state.presetState.custom = merged.custom;
    state.effectiveRulesCache = null;
    try {
      phoneSettings.setItem(PRESET_CATALOG_KEY, JSON.stringify(clonePresetData(merged, emptyCatalog())));
    } catch { /* storage optional */ }
    state.presetCatalogKeyPresent = true;
    state.lastCatalogBaseline = clonePresetData(merged, emptyCatalog());
    // Keep the legacy snapshot in sync without causing another catalog write.
    savePresetState();
  }
  async function loadPresetCatalog() {
    loadPresetState();
    try {
      const response = await fetch("/mobile/assets/prompt-presets.json?v=202610125", { cache: "no-store" });
      if (!response.ok) throw new Error(t("标签目录读取失败"));
      const body = await response.json();
      state.presetCatalog = Array.isArray(body?.categories) ? body.categories : [];
      state.presetRules = body?.rules && typeof body.rules === "object" ? body.rules : {};
    } catch (error) {
      state.presetCatalog = [];
      state.presetRules = {};
      throw error;
    }
  }

  function findPresetCategory(categoryId) {
    return presetEngine().findCategory(categoryId);
  }

  function findPresetSlot(categoryId, slotId) {
    return presetEngine().findSlot(categoryId, slotId);
  }

  function slotStorageKey(categoryId, slotId) {
    return presetEngine().slotKey(categoryId, slotId);
  }

  function emptyCatalog() {
    return presetCatalogApi().empty();
  }

  function stringList(value) {
    return presetEngine().stringList(value);
  }

  function tagMap(value) {
    const out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [key, tags] of Object.entries(value)) {
      const list = stringList(tags);
      if (list.length) out[key] = list;
    }
    return out;
  }

  function mergeTagMaps(...maps) {
    const out = {};
    for (const map of maps) {
      for (const [key, tags] of Object.entries(tagMap(map))) {
        out[key] = stringList([...(out[key] || []), ...tags]);
      }
    }
    return out;
  }

  function normalizeCatalog(raw) {
    return presetCatalogApi().normalize(raw);
  }

  function mergeCatalog(base, local, remote) {
    return presetCatalogApi().merge(base, local, remote);
  }
  function parseCatalog(raw) {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Invalid catalog");
    }
    return normalizeCatalog(parsed);
  }

  function catalogTagSet(kind, categoryId, slotId) {
    return presetEngine().catalogTagSet(kind, categoryId, slotId);
  }

  function slotPool(categoryId, slot) {
    return presetEngine().slotPool(categoryId, slot);
  }

  function randomSlotPool(categoryId, slot) {
    return presetEngine().randomPool(categoryId, slot);
  }

  function getSlotState(categoryId, slotId, options = {}) {
    return presetEngine().slotState(categoryId, slotId, options);
  }

  function tagConflicts(tag, accepted) {
    return presetEngine().tagConflicts(tag, accepted);
  }

  function skippedCategoryIds(tags = null) {
    return presetEngine().skipped(tags);
  }

  function collectPresetConflicts() {
    return presetEngine().collectConflicts();
  }

  function markPresetConflicts() {
    return presetEngine().conflicts();
  }

  function presetTagStatus(categoryId, slotId, value) {
    return presetEngine().tagStatus(categoryId, slotId, value);
  }

  function selectedTagsExcept(categoryId, slotId) {
    return presetEngine().selectedTagsExcept(categoryId, slotId);
  }

  function canSelectPresetTag(categoryId, slotId, value) {
    const text = String(value || "").trim();
    if (!text) return true;
    if (presetTagStatus(categoryId, slotId, text) === "deleted") return true;
    if (catalogTagSet("skipped", categoryId, slotId).has(text)) return true;
    if (!tagConflicts(text, selectedTagsExcept(categoryId, slotId))) return true;
    toast(t("这个标签与已选标签互斥，请先取消冲突标签"), "error");
    return false;
  }
  function filterSlotValues(values) {
    return presetEngine().filterValues(values);
  }

  function randomizePresetSlots(categoryId = "", { persist = true } = {}) {
    presetEngine().randomize(categoryId);
    if (persist) {
      savePresetState();
      renderPresetPanel();
      applyPresetPrompt();
    }
  }

  function activeSlotValues(category) {
    return presetEngine().activeValues(category);
  }

  function composeCategoryPhrase(category, values = null) {
    return presetEngine().composePhrase(category, values);
  }

  function composePresetPrompt() {
    return presetEngine().compose();
  }

  function applyPresetPrompt() {
    if (!state.presetEnabled || !state.presetField) return;
    const text = composePresetPrompt();
    updateFieldValue(state.presetField, text);
    if (state.presetTextarea) {
      state.presetTextarea.value = text;
      autoGrow(state.presetTextarea);
    }
  }

  function setPresetEnabled(enabled) {
    if (enabled === state.presetEnabled) {
      applyPresetMode();
      return;
    }
    if (enabled) {
      const current = state.presetTextarea?.value ?? state.values[state.presetField?.id] ?? "";
      state.presetState.freeText = current;
    } else if (state.presetField && typeof state.presetState.freeText === "string") {
      updateFieldValue(state.presetField, state.presetState.freeText);
      if (state.presetTextarea) {
        state.presetTextarea.value = state.presetState.freeText;
        autoGrow(state.presetTextarea);
      }
    }
    state.presetEnabled = enabled;
    applyPresetMode();
    savePresetState();
  }

  function applyPresetMode() {
    const panel = state.presetPanel;
    const textarea = state.presetTextarea;
    const toggle = $("presetModeToggle");
    if (toggle) toggle.checked = state.presetEnabled;
    if (!panel || !textarea) return;
    textarea.classList.toggle("hidden", state.presetEnabled);
    panel.classList.toggle("hidden", !state.presetEnabled);
    if (state.presetEnabled) {
      renderPresetPanel();
      applyPresetPrompt();
    } else {
      autoGrow(textarea);
    }
  }

  // 文本单独一层：按钮自己的匿名内容盒会被居中，省略号只在真正的块级文本框上生效。
  function textSpan(className, text) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
  }

  function renderPresetPanel() {
    const panel = state.presetPanel;
    if (!panel) return;
    let rows = panel.querySelector("#presetRows");
    if (rows) rows.classList.add("preset-rows");
    if (!rows) {
      panel.replaceChildren();
      const bar = document.createElement("div");
      bar.className = "preset-panel-bar";
      const hint = document.createElement("span");
      hint.textContent = t("点分类名随机，点标签修改");
      const randomButton = document.createElement("button");
      randomButton.type = "button";
      randomButton.className = "preset-random-button";
      randomButton.textContent = t("随机");
      randomButton.addEventListener("click", () => randomizePresetSlots());
      bar.append(hint, randomButton);

      const customWrap = document.createElement("details");
      customWrap.className = "advanced-section preset-custom";
      const summary = document.createElement("summary");
      const customLabel = document.createElement("span");
      customLabel.textContent = t("自定义");
      const customHint = document.createElement("span");
      customHint.className = "preset-custom-hint";
      customHint.textContent = t("此处输入文字会注入在提示词最后");
      summary.append(customLabel, customHint);
      summary.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>');
      const customInput = document.createElement("textarea");
      customInput.id = "presetCustomText";
      customInput.rows = 2;
      customInput.placeholder = t("额外要加进提示词的文字");
      customInput.value = state.presetState.extraText || "";
      customInput.addEventListener("input", () => {
        state.presetState.extraText = customInput.value;
        savePresetState();
        applyPresetPrompt();
        autoGrow(customInput);
      });
      customWrap.addEventListener("toggle", () => {
        if (customWrap.open) autoGrow(customInput);
      });
      customWrap.append(summary, customInput);

      rows = document.createElement("div");
      rows.id = "presetRows";
      rows.className = "preset-rows";
      panel.append(bar, rows, customWrap);
    }

     rows.replaceChildren();
    const skipped = skippedCategoryIds();
    const conflicts = markPresetConflicts();
    state.presetCatalog.forEach((category) => {
      const row = document.createElement("div");
      row.className = "preset-row";
      if (skipped.has(category.id)) row.classList.add("is-skipped");
      const label = document.createElement("button");
      label.type = "button";
      label.className = "preset-row-label";
      label.append(textSpan("preset-row-label-text", category.label));
      label.setAttribute("aria-label", t("随机{label}", { label: category.label }));
      label.addEventListener("click", () => randomizePresetSlots(category.id));
      const divider = document.createElement("span");
      divider.className = "preset-row-divider";
      divider.setAttribute("aria-hidden", "true");
      const values = document.createElement("div");
      values.className = "preset-row-values";
      (category.slots || []).forEach((slot, index) => {
        if (index > 0) {
          const sep = document.createElement("span");
          sep.className = "preset-chip-sep";
          sep.textContent = t("、");
          values.append(sep);
        }
        const current = getSlotState(category.id, slot.id);
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "preset-chip";
        const val = current.value || t("未选");
        const status = presetTagStatus(category.id, slot.id, current.value);
        const conflict = conflicts.has(slotStorageKey(category.id, slot.id));
        if (val.length <= 2) chip.classList.add("no-ellipsis");
        if (status === "deleted") chip.classList.add("deleted");
        if (status === "free") chip.classList.add("free");
        if (conflict) chip.classList.add("conflict");
        if ((category.slots || []).length >= 3) chip.classList.add("tight");
        if (current.locked) chip.classList.add("locked");
        if (current.ignored) chip.classList.add("ignored");
        chip.append(textSpan("preset-chip-text", status === "deleted" ? t("{val}（已删除）", { val: val }) : val));
        chip.title = [
          status === "deleted" ? t("当前标签已从目录删除，但仍保留在提示词中") : "",
          status === "free" ? t("自由标签") : "",
          conflict ? t("与其他已选标签互斥，请编辑其中一个") : "",
        ].filter(Boolean).join(t("；"));
        const chipLabel = [
          t("编辑{category}{slot}", { category: category.label, slot: slot.label }),
          status === "deleted" ? t("，已删除") : "",
          conflict ? t("，存在互斥") : "",
        ].join("");
        chip.setAttribute("aria-label", chipLabel);
        chip.addEventListener("click", () => openPresetTagEditor(category.id, slot.id));
        values.append(chip);
      });
      row.append(label, divider, values);
      rows.append(row);
    });
  }

  function openPresetTagEditor(categoryId, slotId) {
    const category = findPresetCategory(categoryId);
    const slot = findPresetSlot(categoryId, slotId);
    const dialog = $("presetTagDialog");
    if (!category || !slot || !dialog) return;
    state.presetEditing = { categoryId, slotId };
    const current = getSlotState(categoryId, slotId);
    setText("presetTagEyebrow", category.label);
    setText("presetTagTitle", slot.label);
    $("presetTagInput").value = current.value || "";
    paintPresetEditorFlags();
    renderPresetPool();
    if (!dialog.open) dialog.showModal();
  }

  function paintPresetEditorFlags() {
    if (!state.presetEditing) return;
    const current = getSlotState(state.presetEditing.categoryId, state.presetEditing.slotId);
    $("presetLockButton").classList.toggle("active", current.locked);
    $("presetIgnoreButton").classList.toggle("active", current.ignored);
    $("presetLockButton").textContent = current.locked ? t("已锁定") : t("锁定");
    $("presetIgnoreButton").textContent = current.ignored ? t("已忽略") : t("忽略");
  }

  function renderPresetPool() {
    const box = $("presetTagPool");
    if (!box || !state.presetEditing) return;
    const { categoryId, slotId } = state.presetEditing;
    const slot = findPresetSlot(categoryId, slotId);
    if (!slot) return;
    const current = getSlotState(categoryId, slotId);
    const key = slotStorageKey(categoryId, slotId);
    const custom = new Set(presetStateCatalog().custom[key] || []);
    const items = slotPool(categoryId, slot);
    if (current.value && !items.includes(current.value)) items.unshift(current.value);
    box.replaceChildren();
    items.forEach((item) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "preset-pool-chip";
      const status = presetTagStatus(categoryId, slotId, item);
      if (item === current.value) chip.classList.add("active");
      if (status === "deleted") chip.classList.add("deleted");
      chip.append(textSpan("preset-pool-chip-text", status === "deleted" ? t("{item}（已删除）", { item: item }) : item));
      chip.title = status === "deleted" ? t("已删除，仅用于恢复当前提示词") : t("选择此标签");
      chip.addEventListener("click", () => {
        if (!canSelectPresetTag(categoryId, slotId, item)) return;
        $("presetTagInput").value = item;
        current.value = item;
        current.conflict = false;
        savePresetState();
        renderPresetPool();
        renderPresetPanel();
        applyPresetPrompt();
      });
      if (custom.has(item) && status !== "deleted") {
        const remove = document.createElement("span");
        remove.className = "preset-pool-remove";
        remove.textContent = "×";
        remove.title = t("删除自定义标签");
          remove.addEventListener("click", (event) => {
            event.stopPropagation();
            removePresetCustomTag(categoryId, slotId, item);
            renderPresetPool();
            renderPresetPanel();
          });
        chip.append(remove);
      }
      box.append(chip);
    });
  }

  function removePresetCustomTag(categoryId, slotId, item) {
    const key = slotStorageKey(categoryId, slotId);
    const catalog = presetStateCatalog();
    catalog.removedCustom[key] = stringList([...(catalog.removedCustom[key] || []), String(item)]);
    state.presetState.custom = catalog.custom;
    savePresetCatalog();
  }
  function addPresetToPool() {
    if (!state.presetEditing) return;
    const text = String($("presetTagInput").value || "").trim();
    if (!text) return;
    const { categoryId, slotId } = state.presetEditing;
    if (!canSelectPresetTag(categoryId, slotId, text)) return;
    const key = slotStorageKey(categoryId, slotId);
    const catalog = presetStateCatalog();
    const list = catalog.custom[key] || [];
    const added = !list.includes(text);
    if (added) catalog.custom[key] = [...list, text];
    const wasRemoved = Boolean(catalog.removedCustom[key]?.includes(text));
    if (wasRemoved) {
      catalog.removedCustom[key] = catalog.removedCustom[key].filter((tag) => tag !== text);
      if (!catalog.removedCustom[key].length) delete catalog.removedCustom[key];
    }
    state.presetState.custom = catalog.custom;
    getSlotState(categoryId, slotId).value = text;
    if (added || wasRemoved) savePresetCatalog();
    else savePresetState();
    renderPresetPool();
    renderPresetPanel();
    applyPresetPrompt();
    toast(added ? t("已加入备选") : t("已选择标签"));
  }

  function savePresetTagEditor() {
    if (!state.presetEditing) return;
    const { categoryId, slotId } = state.presetEditing;
    const text = String($("presetTagInput").value || "").trim();
    if (text && !canSelectPresetTag(categoryId, slotId, text)) return;
    const current = getSlotState(categoryId, slotId);
    current.value = text;
    current.conflict = false;
    markPresetConflicts();
    savePresetState();
    renderPresetPanel();
    applyPresetPrompt();
    $("presetTagDialog").close();
  }

  function attachPresetPanel(wrapper, field, textarea) {
    if (!state.presetCatalog.length) return;
    state.presetField = field;
    state.presetTextarea = textarea;
    const labelRow = wrapper.querySelector(".field-label-row");
    if (labelRow && !wrapper.querySelector(".preset-toggle-wrap")) {
      const switchLabel = document.createElement("label");
      switchLabel.className = "toggle preset-toggle";
      switchLabel.title = t("标签预设");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = "presetModeToggle";
      input.checked = state.presetEnabled;
      input.setAttribute("aria-label", t("标签预设"));
      const visual = document.createElement("span");
      visual.setAttribute("aria-hidden", "true");
      input.addEventListener("change", () => setPresetEnabled(input.checked));
      switchLabel.append(input, visual);
      const wrap = document.createElement("span");
      wrap.className = "preset-toggle-wrap";
      const caption = document.createElement("span");
      caption.className = "preset-toggle-caption";
      caption.textContent = t("标签模式");
      wrap.append(caption, switchLabel);
      const node = labelRow.querySelector(".field-node");
      if (node) labelRow.insertBefore(wrap, node);
      else labelRow.append(wrap);
    }
    const panel = document.createElement("div");
    panel.className = "preset-panel hidden";
    panel.id = "presetPanel";
    wrapper.append(panel);
    state.presetPanel = panel;
    applyPresetMode();
  }

  function isSizeField(field) {
    return field.input === "width" || field.input === "height";
  }

  function syncSizePresetSelection() {
    const select = $("sizePresetSelect");
    if (!select || !state.workflow) return;
    const fields = state.workflow.fields || [];
    const width = fields.find((field) => field.input === "width");
    const height = fields.find((field) => field.input === "height");
    if (!width || !height) {
      select.value = "";
      return;
    }
    const value = `${Number(state.values[width.id])}x${Number(state.values[height.id])}`;
    select.value = Array.from(select.options).some((option) => option.value === value) ? value : "";
  }

  function applySizePreset(value) {
    const match = /^(\d+)x(\d+)$/.exec(value);
    if (!match || !state.workflow) return;
    const [width, height] = match.slice(1).map(Number);
    for (const field of state.workflow.fields || []) {
      const next = field.input === "width" ? width : field.input === "height" ? height : null;
      if (next === null) continue;
      state.values[field.id] = next;
      const control = state.fieldControls.get(field.id);
      if (control && "value" in control) control.value = String(next);
    }
    saveDraft();
    syncSizePresetSelection();
  }

  function isModelField(field) {
    return ["ckpt_name", "model_name", "unet_name"].includes(field.input);
  }

  function renderWorkflow(workflow) {
    state.workflow = workflow;
    const fields = workflow.fields || [];
    state.values = loadDraft(workflow, fields);
    state.fieldControls = new Map();
    state.nodeTitles = new Map(Object.entries(workflow.node_titles || {}));

    const negative = fields.filter(isNegativeField);
    const size = fields.filter(isSizeField);
    const batch = fields.find((field) => field.input === "batch_size") || null;
    const seed = fields.find((field) => field.input === "seed" || field.input === "noise_seed") || null;
    const model = fields.filter(isModelField);
    state.modelField = model[0] || null;
    if (state.modelField && state.workflow?.id) {
      let saved = {};
      try { saved = JSON.parse(phoneSettings.getItem("comfy-mobile-remote.multiModels") || "{}"); } catch { saved = {}; }
      const listed = Array.isArray(saved[state.workflow.id]) ? saved[state.workflow.id].map(String) : [];
      const allowed = new Set(modelOptionList(state.modelField));
      state.multiModelList = listed.filter((name) => allowed.has(name));
      const current = String(state.values[state.modelField.id] ?? "");
      if (!state.multiModelList.length && current) state.multiModelList = [current];
    } else {
      state.multiModelList = [];
    }
    // 手机端只把提示词、负向提示词、图像尺寸、模型选择留在外面，
    // 其余所有参数（包括 steps/cfg/denoise/seed 和节点带来的新参数）一律进"高级参数"。
    const advancedBase = fields.filter((field) => (
      !isNegativeField(field)
      && !isSizeField(field)
      && field !== batch
      && !["batch_size", "seed", "noise_seed"].includes(field.input) // 固定行只显示每类一个控件，不能重复进普通列表
      && !isModelField(field)
      && field.group !== "basic"   // 服务端标为 basic 的（提示词/模型/尺寸）必须留在外面
    ));
    const trio = advancedBase.filter((field) => ["steps", "cfg", "denoise"].includes(field.input));
    const advanced = advancedBase.filter((field) => !trio.includes(field));
    const basic = fields.filter((field) => (
      !isNegativeField(field)
      && !isSizeField(field)
      && field !== batch
      && !["batch_size", "seed", "noise_seed"].includes(field.input)
      && !isModelField(field)
      && !advancedBase.includes(field)
    ));
    const fieldIndex = (field) => fields.indexOf(field);

    $("basicFields").replaceChildren(...basic.map((field) => renderField(field, fieldIndex(field))));
    $("negativeFields").replaceChildren(...negative.map((field) => renderField(field, fieldIndex(field))));
    $("sizeFields").replaceChildren(...size.map((field) => renderField(field, fieldIndex(field), true)));

    const advancedNodes = [];
    const advancedContent = document.querySelector("#advancedSection .advanced-content");
    if (batch || seed) {
      const pairRow = document.createElement("div");
      pairRow.className = `pair-row${batch && seed ? "" : " single"}`;
      [{ field: batch, build: makeNumber }, { field: seed, build: makeSeedRow }].filter(({ field }) => field).forEach(({ field, build }) => {
        const cell = document.createElement("div");
        cell.className = "field pair-cell";
        const control = build(field, fieldIndex(field));
        cell.append(inputLabel(field), control);
        state.fieldControls.set(field.id, control);
        pairRow.append(cell);
      });
      if (advancedContent) {
        advancedContent.querySelectorAll(":scope > .pair-row").forEach((node) => node.remove());
        // 固定顺序第 1 位：批量数量 + 种子
        advancedContent.prepend(pairRow);
      } else {
        advancedNodes.push(pairRow);
      }
    }
    if (trio.length) {
      const trioRow = document.createElement("div");
      trioRow.className = "trio-row";
      trio.forEach((field) => trioRow.append(renderField(field, fieldIndex(field), true)));
      // 固定顺序第 2 位：采样步数 / CFG / 重绘幅度，排在「选择工作流」之前
      // 统一放进 advancedNodes，最后一次性重建，避免先插入又被 replaceChildren 清掉。
      advancedNodes.push(trioRow);
    }
    // 固定顺序第 3 位是「选择工作流」（静态元素），之后依次是采样器、调度器，再是其余
    const advancedRank = (field) => (field.input === "sampler_name" ? 0 : field.input === "scheduler" ? 1 : 2);
    const orderedAdvanced = advanced.slice().sort((left, right) => advancedRank(left) - advancedRank(right));
    advancedNodes.push(...orderedAdvanced.map((field) => renderField(field, fieldIndex(field))));
    if (!state.workflowPickerEl) {
      state.workflowPickerEl = document.getElementById("workflowPickerField");
    }
    if (state.workflowPickerEl) {
      // 高级参数固定顺序：
      // ① 批量数量+种子  ② 采样步数/CFG/重绘幅度  ③ 选择工作流  ④ 采样器  ⑤ 调度器  ⑥ 其余
      // 前两组已经放入 advancedNodes，所以只数数组里的 lead，保证工作流选择器排在它们后面
      const lead = advancedNodes.filter((node) => {
        const cls = node?.classList;
        return Boolean(cls && (cls.contains("pair-row") || cls.contains("trio-row")));
      }).length;
      advancedNodes.splice(lead, 0, state.workflowPickerEl);
    }
    $("advancedFields").replaceChildren(...advancedNodes);
    $("modelFields").replaceChildren(...model.map((field) => renderField(field, fieldIndex(field))));

    $("negativeSection").classList.toggle("hidden", negative.length === 0);
    $("modelFields").classList.toggle("hidden", model.length === 0);
    $("sizeSection").classList.toggle("hidden", size.length === 0);
    $("primaryFields").classList.add("hidden");
    $("advancedSection").classList.remove("hidden");
    setText("advancedCount", advanced.length + trio.length + 1 + (batch ? 1 : 0) + (seed ? 1 : 0));
    setText("workflowMeta", t("{node_count} 个节点 · {length} 个可调参数", { node_count: workflow.node_count, length: fields.length }));
    syncSizePresetSelection();
    paintModelTools();
    $("generationForm").classList.remove("hidden");
    $("workflowEmpty").classList.add("hidden");
  }

  async function loadWorkflow(workflowId, remember = false) {
    if (!workflowId) {
      state.workflow = null;
      $("generationForm").classList.add("hidden");
      return;
    }
    const token = ++state.workflowLoadToken;
    setText("workflowMeta", t("正在读取参数"));
    try {
      const body = await requestJson(`/mobile/api/workflows/${encodeURIComponent(workflowId)}?_=${Date.now()}`);
      if (token !== state.workflowLoadToken) return;
      hydratingSettings += 1;
      try {
        state.presetField = null;
        state.presetTextarea = null;
        state.presetPanel = null;
        renderWorkflow(body.workflow);
        advancedPage?.refresh();
      } finally {
        hydratingSettings -= 1;
      }
      if (remember) phoneSettings.setItem("comfy-mobile-remote.workflow", workflowId);
    } catch (error) {
      if (token !== state.workflowLoadToken) return;
      state.workflow = null;
      $("generationForm").classList.add("hidden");
      setText("workflowMeta", t(error.message));
      toast(error.message, "error");
    }
  }

  async function loadWorkflows(force = false) {
    const body = await requestJson(`/mobile/api/workflows?_=${Date.now()}`);
    state.workflows = body.workflows || [];
    const select = $("workflowSelect");
    const previous = force ? phoneSettings.getItem("comfy-mobile-remote.workflow") : (select.value || phoneSettings.getItem("comfy-mobile-remote.workflow"));
    select.replaceChildren();

    if (state.workflows.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t("暂无工作流");
      select.append(option);
      $("workflowEmpty").classList.remove("hidden");
      $("generationForm").classList.add("hidden");
      setText("workflowMeta", "");
      state.workflow = null;
      return;
    }

    // 常驻的（电脑端导入过）电脑端全关也能用，单独归一组，别和"打开中"混在一起
    const appendGroup = (label, items) => {
      if (!items.length) return;
      const group = document.createElement("optgroup");
      group.label = label;
      items.forEach((workflow) => {
        const option = document.createElement("option");
        option.value = workflow.id;
        option.textContent = workflow.name;
        group.append(option);
      });
      select.append(group);
    };
    appendGroup(t("常驻 · 电脑端不开也能用"), state.workflows.filter((workflow) => workflow.pinned));
    appendGroup(t("电脑端打开中"), state.workflows.filter((workflow) => !workflow.pinned));
    const selected = state.workflows.some((workflow) => workflow.id === previous)
      ? previous
      : state.workflows[0].id;
    select.value = selected;
    await loadWorkflow(selected);
  }

  function mediaUrl(item, compact = false) {
    if (!item?.filename) return "";
    const jobId = String(item.jobId || item.job_id || "");
    const useFavorite = item.source === "favorite" || (item.favorite && jobId);
    if (compact) {
      const query = new URLSearchParams({ filename: item.filename });
      if (useFavorite) query.set("job_id", jobId);
      else {
        query.set("subfolder", item.subfolder || "");
        query.set("type", item.type || "output");
      }
      return `/mobile/api/preview?${query}`;
    }
    if (useFavorite) {
      const query = new URLSearchParams({ job_id: jobId, filename: item.filename });
      return `/mobile/api/favorites/file?${query}`;
    }
    const query = new URLSearchParams({
      filename: item.filename,
      subfolder: item.subfolder || "",
      type: item.type || "output",
    });
    return `/view?${query}`;
  }

  function mediaKind(item) {
    const filename = String(item?.filename || "").toLowerCase();
    const type = String(item?.mediaType || item?.format || "").toLowerCase();
    if (/\.gif$/.test(filename)) return "image";
    if (type.includes("video") || /\.(mp4|webm|mov|mkv)$/.test(filename)) return "video";
    if (type.includes("audio") || /\.(mp3|wav|flac|m4a|ogg)$/.test(filename)) return "audio";
    if (item?.content !== undefined || type.includes("text")) return "text";
    if (item?.filename) return "image";
    return "none";
  }

  function mediaKey(item) {
    return `${item?.jobId || item?.job_id || ""}|${item?.filename || ""}|${item?.subfolder || ""}`;
  }

  function settleHistoryMedia(media) {
    if (!media) return;
    const image = media.querySelector("img");
    const video = media.querySelector("video");
    const done = (el) => {
      el?.classList.add("is-loaded");
      media.classList.remove("is-loading", "is-error");
    };
    const fail = (el) => {
      el?.classList.add("is-error");
      media.classList.remove("is-loading");
      media.classList.add("is-error");
    };
    if (image) {
      if (image.complete) {
        if (image.naturalWidth > 0) done(image);
        else fail(image);
        return;
      }
      if (media.dataset.loadWatch === "1") return;
      media.dataset.loadWatch = "1";
      image.addEventListener("load", () => done(image), { once: true });
      image.addEventListener("error", () => fail(image), { once: true });
      image.decode?.().then(() => { if (image.naturalWidth > 0) done(image); }).catch(() => {});
      return;
    }
    if (video) {
      if (video.readyState >= 2) {
        done(video);
        return;
      }
      if (media.dataset.loadWatch === "1") return;
      media.dataset.loadWatch = "1";
      video.addEventListener("loadeddata", () => done(video), { once: true });
      video.addEventListener("error", () => fail(video), { once: true });
      return;
    }
    media.classList.remove("is-loading");
  }

  function historyEntryKey(job, item) {
    return `${job?.id || item?.jobId || item?.job_id || ""}|${item?.filename || ""}|${item?.subfolder || ""}|${item?.type || "output"}`;
  }

  function createMedia(item, compact = false) {
    const kind = mediaKind(item);
    if (kind === "image") {
      const image = document.createElement("img");
      image.src = mediaUrl(item, compact);
      image.alt = compact ? "" : t("生成结果");
      image.loading = compact ? "lazy" : "eager";
      image.decoding = "async";
      if (compact) image.fetchPriority = "low";
      return image;
    }
    if (kind === "video") {
      const video = document.createElement("video");
      video.src = mediaUrl(item);
      video.muted = compact;
      video.loop = compact;
      video.autoplay = false;
      video.preload = compact ? "none" : "metadata";
      video.playsInline = true;
      if (!compact) video.controls = true;
      return video;
    }
    if (kind === "audio") {
      if (compact) {
        const wrapper = document.createElement("span");
        wrapper.innerHTML = ICONS.audio;
        return wrapper;
      }
      const audio = document.createElement("audio");
      audio.src = mediaUrl(item);
      audio.controls = true;
      return audio;
    }
    if (kind === "text") {
      const pre = document.createElement("pre");
      pre.textContent = String(item.content || "");
      return pre;
    }
    const fallback = document.createElement("span");
    fallback.innerHTML = ICONS.image;
    return fallback;
  }

  const STATUS_LABELS = {
    pending: t("排队中"),
    in_progress: t("运行中"),
    completed: t("已完成"),
    failed: t("失败"),
    cancelled: t("已停止"),
  };

  function jobStatusLabel(status) {
    return STATUS_LABELS[status] || status || t("未知");
  }

  // 顶栏「停止全部」：清空排队任务并中断正在执行的那一个。
  // 请求没回来之前按钮一直禁用，连点只会发一次。
  let stoppingAllJobs = false;

  function paintStopAllButton(busy) {
    const button = $("stopAllButton");
    if (!button) return;
    const activeCount = Number(state.status?.running || 0) + Number(state.status?.pending || 0);
    button.classList.toggle("hidden", activeCount === 0);
    button.disabled = Boolean(busy);
    button.setAttribute("aria-busy", String(Boolean(busy)));
    button.setAttribute("aria-label", t("停止全部"));
    button.title = t("停止全部");
  }

  async function stopAllJobs() {
    if (stoppingAllJobs) return;
    stoppingAllJobs = true;
    paintStopAllButton(true);
    try {
      await requestJson("/mobile/api/jobs/stop-all", { method: "POST" });
      toast(t("所有任务已停止"), "success");
      // 服务器已经不认这些任务了，乐观条目留着只会在顶栏显示幽灵任务。
      state.optimisticJobs.clear();
      await Promise.all([loadStatus(), loadJobs(true), loadProgress(true)]);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      stoppingAllJobs = false;
      paintStopAllButton(false);
    }
  }

  // 顶栏的「当前任务/进度环」要的就绪列表：运行中的排最前，其次是排队中的。
  function visibleQueueJobs() {
    const activeId = state.progress.activeId;
    const jobs = state.jobs.filter((job) =>
      ["pending", "in_progress"].includes(job.status) && !state.progress.finished.has(String(job.id))
    ).map((job) => String(job.id) === activeId ? { ...job, status: "in_progress" } : job);
    jobs.reverse();
    if (activeId && !jobs.some((job) => String(job.id) === activeId)) {
      jobs.unshift(state.progress.activeJob || { id: activeId, status: "in_progress" });
    }
    return jobs;
  }

  function progressDisplay(job) {
    const progress = job.status === "in_progress" ? state.progress.get(job.id) : null;
    const percent = progress?.percent ?? null;
    const label = job.status === "pending" ? t("等待执行")
      : progress?.displayId && progress.displayId !== "sampling" ? nodeDisplayName(progress.displayId)
      : t("正在处理");
    return { percent, text: percent == null ? "—" : `${Math.round(percent)}%`, label };
  }

  function jobGallery(job) {
    const gallery = Array.isArray(job.gallery)
      ? job.gallery.filter((item) => mediaKind(item) === "image")
      : [];
    if (gallery.length > 0) return gallery;
    return mediaKind(job.preview_output) === "image" ? [job.preview_output] : [];
  }

  function snapshotPreset() {
    const prompt = state.presetEnabled
      ? composePresetPrompt()
      : String(state.presetField ? (state.values[state.presetField.id] ?? "") : "");
    return {
      enabled: Boolean(state.presetEnabled),
      slots: snapshotSlotStates(state.presetState.slots),
      custom: clonePresetData(state.presetState.custom, {}),
      catalog: clonePresetData(normalizeCatalog(state.presetState.catalog), emptyCatalog()),
      extraText: state.presetState.extraText || "",
      prompt,
    };
  }

  function paintPresetFromSnapshot(preset) {
    if (!preset || typeof preset !== "object") return;
    if (preset.slots) state.presetState.slots = clonePresetData(preset.slots, {}) || state.presetState.slots;
    markPresetConflicts();
    renderPresetPanel();
    if (state.presetEnabled) applyPresetPrompt();
  }

  async function copyText(value) {
    const text = String(value || "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* clipboard optional */ }
  }

  function goToGenerate() {
    const jobDialog = $("jobDialog");
    if (jobDialog?.open) jobDialog.close();
    if ($("galleryDialog")?.open) closeGalleryViewer();
    showView("generate");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function galleryJobRecord() {
    const jobId = currentGalleryJobId();
    if (!jobId) throw new Error(t("找不到这张图的任务"));
    if (state.dialogJob?.id === jobId) return state.dialogJob;
    const body = await requestJson(`/mobile/api/jobs/${encodeURIComponent(jobId)}?_=${Date.now()}`);
    state.dialogJob = body.job;
    return body.job;
  }

  function setGalleryCopyMenu(open) {
    const menu = $("galleryCopyMenu");
    const button = $("copyGalleryButton");
    if (!menu || !button) return;
    menu.hidden = !open;
    menu.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function setPresetFreeText(prompt) {
    state.presetEnabled = false;
    state.presetState.freeText = prompt;
    const field = state.presetField || (state.workflow?.fields || []).find(isPositiveField);
    if (field) updateFieldValue(field, prompt);
    if (state.presetTextarea) {
      state.presetTextarea.value = prompt;
      autoGrow(state.presetTextarea);
    }
    applyPresetMode();
  }

  function restorePresetSnapshot(preset, prompt) {
    const before = JSON.stringify(normalizeCatalog(state.presetState.catalog));
    const currentCatalog = normalizeCatalog(state.presetState.catalog);
    const snapshotCatalog = normalizeCatalog(preset.catalog);
    const snapshotCustom = mergeTagMaps(snapshotCatalog.custom, preset.custom);
    const restoredCustom = mergeTagMaps(currentCatalog.custom, snapshotCustom);
    state.presetState.slots = clonePresetData(preset.slots, {}) || {};
    state.presetState.catalog = normalizeCatalog({
      ...currentCatalog,
      // History restores its custom vocabulary but never replaces global rule
      // management (removed/skipped/mutex/singletons/skipCategories).
      custom: restoredCustom,
    });
    state.presetState.custom = state.presetState.catalog.custom;
    if (typeof preset.extraText === "string") state.presetState.extraText = preset.extraText;
    state.presetEnabled = true;
    markPresetConflicts();
    const changedCatalog = before !== JSON.stringify(normalizeCatalog(state.presetState.catalog));
    if (changedCatalog) savePresetCatalog();
    applyPresetMode();

    const rebuilt = composePresetPrompt();
    if (prompt && rebuilt !== prompt) {
      setPresetFreeText(prompt);
      savePresetState();
      toast(t("历史目录已变化，已按原始提示词恢复"), "success");
      return false;
    }
    savePresetState();
    const extra = $("presetCustomText");
    if (extra) {
      extra.value = state.presetState.extraText || "";
      autoGrow(extra);
    }
    return true;
  }

  function restorePromptFromJob() {
    const job = state.dialogJob;
    const prompt = String(job?.positive_prompt || "").trim();
    const preset = job?.preset;
    if (preset && preset.enabled) {
      restorePresetSnapshot(preset, prompt);
    } else {
      setPresetFreeText(prompt);
      savePresetState();
    }
    copyText(prompt);
    goToGenerate();
    toast(t("已还原提示词"));
  }

  function restoreSeedFromJob() {
    const seed = String(state.dialogJob?.seed || "").trim();
    if (!seed) return;
    const field = (state.workflow?.fields || []).find((itemField) => itemField.input === "seed" || itemField.input === "noise_seed");
    if (field) {
      const numeric = Number(seed);
      const value = Number.isFinite(numeric) ? numeric : seed;
      updateFieldValue(field, value);
      const control = state.fieldControls.get(field.id);
      const input = control?.querySelector?.("input");
      if (input) {
        input.disabled = false;
        input.value = String(value);
      }
      control?.querySelector?.(".random-button")?.classList.remove("active");
    }
    const advanced = $("advancedSection");
    if (advanced) advanced.open = true;
    copyText(seed);
    goToGenerate();
    toast(t("已还原种子"));
  }

  function galleryAbsUrl(url) {
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return String(url || "");
    }
  }

  function galleryUrlCached(url) {
    if (!url) return false;
    if (state.gallerySeenUrls.has(galleryAbsUrl(url))) return true;
    const probe = new Image();
    probe.src = url;
    return probe.complete && probe.naturalWidth > 0;
  }

  function renderGalleryItem({ keepPainted = false } = {}) {
    const total = state.galleryItems.length;
    if (!total) return;
    state.galleryIndex = Math.max(0, Math.min(total - 1, state.galleryIndex));
    const item = state.galleryItems[state.galleryIndex];
    if (item?.jobId) state.galleryJobId = item.jobId;
    const image = $("galleryImage");
    const stage = $("galleryStage");
    const url = mediaUrl(item);
    const abs = galleryAbsUrl(url);
    const token = ++state.galleryLoadToken;
    const cached = galleryUrlCached(url);
    stage?.classList.remove("is-error");
    if (!cached) {
      stage?.classList.add("is-loading");
      image.classList.remove("is-ready");
      if (!keepPainted) image.removeAttribute("src");
    } else {
      stage?.classList.remove("is-loading");
    }
    const finish = (ok) => {
      if (token !== state.galleryLoadToken) return;
      stage?.classList.remove("is-loading");
      if (ok) {
        image.classList.add("is-ready");
        state.gallerySeenUrls.add(abs);
      } else stage?.classList.add("is-error");
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    if (image.src !== abs) image.src = url;
    image.alt = t("生成结果，第 {value} 张，共 {total} 张", { value: state.galleryIndex + 1, total: total });
    if (image.complete && image.naturalWidth > 0) finish(true);
    const zoom = state.galleryZoom;
    if (zoom) {
      if (!keepPainted) {
        zoom.scale = 1;
        zoom.x = 0;
        zoom.y = 0;
        image.style.transform = "";
      } else if (zoom.scale > 1.001) {
        // Cached page turns can repaint the image without repainting the
        // transform. Re-apply the persisted zoom so state and pixels agree.
        image.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
      } else {
        zoom.scale = 1;
        zoom.x = 0;
        zoom.y = 0;
        image.style.transform = "";
      }
    }
    setText("galleryCounter", `${state.galleryIndex + 1}/${total}`);
    const modelName = String(item?.job?.model_name || item?.model_name || "").trim().split(/[/\\]/).pop() || "";
    const modelLabel = $("galleryModelName");
    if (modelLabel) {
      modelLabel.textContent = modelName;
      modelLabel.title = modelName;
      modelLabel.hidden = !modelName;
    }
    $("galleryPreviousButton").disabled = total <= 1 || state.galleryIndex === 0;
    $("galleryNextButton").disabled = total <= 1 || state.galleryIndex === total - 1;
    syncFavoriteButton();
    [state.galleryIndex - 1, state.galleryIndex + 1].forEach((neighborIndex) => {
      const neighbor = state.galleryItems[neighborIndex];
      if (neighbor) {
        const probe = new Image();
        probe.src = mediaUrl(neighbor);
      }
    });
  }

  const favoriteToggleInFlight = new Set();

  function favoriteItemKey(item, jobId = "") {
    const id = String(item?.jobId || item?.job_id || jobId || "");
    return `${id}|${item?.filename || ""}|${item?.subfolder || ""}|${item?.type || "output"}`;
  }

  function updateFavoriteState(jobId, filename, subfolder, type, favorite) {
    const matches = (item, ownerJobId = jobId) => String(item?.jobId || item?.job_id || ownerJobId) === String(ownerJobId)
      && item?.filename === filename
      && (item?.subfolder || "") === (subfolder || "")
      && (item?.type || "output") === (type || "output");
    for (const list of [state.galleryItems, state.flatGallery]) {
      if (Array.isArray(list)) list.forEach((item) => { if (matches(item)) item.favorite = favorite; });
    }
    if (Array.isArray(state.jobs)) state.jobs.forEach((job) => {
      const ownerJobId = String(job?.id || job?.jobId || job?.job_id || "");
      if (matches(job, ownerJobId)) job.favorite = favorite;
      if (Array.isArray(job?.gallery)) job.gallery.forEach((item) => { if (matches(item, ownerJobId)) item.favorite = favorite; });
      if (matches(job?.preview_output, ownerJobId)) job.preview_output.favorite = favorite;
    });
  }

  function currentGalleryJobId() {
    const item = state.galleryItems[state.galleryIndex];
    return String(item?.jobId || item?.job_id || state.galleryJobId || "");
  }

  function isCurrentFavorite() {
    const item = state.galleryItems[state.galleryIndex];
    return Boolean(item?.favorite);
  }

  function syncFavoriteButton() {
    const button = $("favoriteGalleryButton");
    if (!button) return;
    const active = isCurrentFavorite();
    const item = state.galleryItems[state.galleryIndex];
    const key = favoriteItemKey(item, currentGalleryJobId());
    button.disabled = favoriteToggleInFlight.has(key);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute("aria-label", active ? t("取消收藏") : t("收藏这张图"));
    button.title = active ? t("取消收藏") : t("收藏");
  }

  async function toggleCurrentGalleryFavorite() {
    const item = state.galleryItems[state.galleryIndex];
    const jobId = currentGalleryJobId();
    if (!item?.filename || !jobId) {
      toast(t("这张图不能收藏"), "error");
      return;
    }
    const previous = Boolean(item.favorite);
    const subfolder = item.subfolder || "";
    const type = item.type || "output";
    const key = favoriteItemKey(item, jobId);
    if (favoriteToggleInFlight.has(key)) return;
    favoriteToggleInFlight.add(key);
    updateFavoriteState(jobId, item.filename, subfolder, type, !previous);
    syncFavoriteButton();
    if (state.favoritesOnly && !item.favorite) renderHistory();
    try {
      const body = await requestJson("/mobile/api/favorites/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          filename: item.filename,
          subfolder,
          type,
        }),
      });
      updateFavoriteState(jobId, item.filename, subfolder, type, Boolean(body.favorite));
      syncFavoriteButton();
      if (state.favoritesOnly) renderHistory();
      toast(body.favorite ? t("已收藏") : t("已取消收藏"));
    } catch (error) {
      updateFavoriteState(jobId, item.filename, subfolder, type, previous);
      syncFavoriteButton();
      if (state.favoritesOnly) renderHistory();
      toast(error.message || t("收藏失败"), "error");
    } finally {
      favoriteToggleInFlight.delete(key);
      syncFavoriteButton();
    }
  }

  async function deleteCurrentGalleryImage() {
    const item = state.galleryItems[state.galleryIndex];
    const jobId = currentGalleryJobId();
    if (!item?.filename || !jobId) {
      toast(t("无法删除这张图"), "error");
      return;
    }
    if (!window.confirm(t("删除这张图？删除后无法恢复。"))) return;
    try {
      await requestJson("/mobile/api/outputs/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          filename: item.filename,
          subfolder: item.subfolder || "",
          type: item.type || "output",
        }),
      });
      state.galleryItems.splice(state.galleryIndex, 1);
      if (state.galleryItems.length === 0) {
        closeGalleryViewer();
      } else {
        if (state.galleryIndex >= state.galleryItems.length) {
          state.galleryIndex = state.galleryItems.length - 1;
        }
        renderGalleryItem();
      }
      toast(t("已删除"));
      await loadJobs();
    } catch (error) {
      toast(error.message || t("删除失败"), "error");
    }
  }

  let galleryAnimating = false;

  function moveGallery(direction) {
    const total = state.galleryItems.length;
    if (total <= 1 || galleryAnimating || state.galleryDragActive) return;
    const next = Math.max(0, Math.min(total - 1, state.galleryIndex + direction));
    if (next === state.galleryIndex) return;
    const image = $("galleryImage");
    const stage = $("galleryStage");
    const gap = 18;
    const offRight = `translateX(calc(100% + ${gap}px))`;
    const offLeft = `translateX(calc(-100% - ${gap}px))`;
    const ghost = document.createElement("img");
    ghost.src = image.src;
    ghost.alt = "";
    ghost.className = "gallery-ghost";
    ghost.draggable = false;
    stage.append(ghost);
    galleryAnimating = true;
    image.style.transition = "none";
    image.style.transform = direction < 0 ? offLeft : offRight;
    state.galleryIndex = next;
    renderGalleryItem({ keepPainted: galleryUrlCached(mediaUrl(state.galleryItems[next])) });
    maybeLoadMoreForGallery();
    const finish = () => {
      ghost.remove();
      image.style.transform = "";
      image.style.transition = "";
      const zoom = state.galleryZoom;
      if (zoom) {
        zoom.scale = 1;
        zoom.x = 0;
        zoom.y = 0;
      }
      galleryAnimating = false;
    };
    const preload = new Promise((resolve) => {
      const probe = new Image();
      probe.onload = probe.onerror = resolve;
      probe.src = image.src;
      setTimeout(resolve, 400);
    });
    preload.then(() => {
      const anim = { duration: 260, easing: "cubic-bezier(0.3, 0.75, 0.3, 1)" };
      const ghostAnim = ghost.animate(
        [{ transform: "translateX(0)" }, { transform: direction < 0 ? offRight : offLeft }],
        anim,
      );
      const mainAnim = image.animate(
        [{ transform: direction < 0 ? offLeft : offRight }, { transform: "translateX(0)" }],
        anim,
      );
      mainAnim.onfinish = finish;
      ghostAnim.onfinish = finish;
    });
  }

  async function downloadHistoryImage(item) {
    const url = mediaUrl(item);
    const name = String(item?.filename || "image.png");
    if (!url) return;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("download failed");
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 2000);
      toast(t("已开始下载"));
    } catch {
      toast(t("下载失败"), "error");
    }
  }

  function closeGalleryViewer() {
    const gallery = $("galleryDialog");
    if (!gallery?.open || gallery.classList.contains("is-closing")) return;
    state.galleryLoadToken += 1;
    state.galleryCloseGuardUntil = performance.now() + GALLERY_CLOSE_GUARD_MS;
    gallery.classList.add("is-closing");
    const image = $("galleryImage");
    if (image) {
      image.onload = null;
      image.onerror = null;
    }
    // 关键：本帧只做上面这个 display:none（0.2ms），浏览器下一帧就能把网格画出来。
    // dialog.close() 会触发整页样式重算，历史网格越大越慢（手机上几十毫秒），
    // 若放在这里会把"大图消失"这一帧一起拖住，体感就是点了半天才关；
    // 因此用两层 rAF 把它推到隐藏画面真正落屏之后再执行。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // 这两帧之间若又打开了新的预览（openGallery 会移除 is-closing），就放弃本次收尾，
      // 否则会把刚打开的新图关掉。
      if (!gallery.classList.contains("is-closing")) return;
      if (gallery.open) gallery.close();
      gallery.classList.remove("is-closing");
      if (image) {
        image.removeAttribute("src");
        image.classList.remove("is-ready");
        image.style.transform = "";
      }
      $("galleryStage")?.querySelectorAll(".gallery-ghost").forEach((node) => node.remove());
      if (state.galleryZoom) {
        state.galleryZoom.scale = 1;
        state.galleryZoom.x = 0;
        state.galleryZoom.y = 0;
      }
      // 这一帧隐藏已经落屏，守卫从此刻再续一小段：
      // 手机渲染慢时画面回网格可能滞后，靠它兜住用户的"第二下"。
      const until = performance.now() + GALLERY_CLOSE_GUARD_MS;
      if (state.galleryCloseGuardUntil < until) state.galleryCloseGuardUntil = until;
    }));
  }

  // 大图查看器的序列跟着网格走：轮询进来的新图（插在最前）和翻出来的更早页
  // （接在最后）都会进序列，当前这张按 key 重新定位 —— 画面不跳，
  // 计数和「还能不能往后翻」立刻跟着更新，不用退出去重进。
  function syncGallerySequence() {
    const dialog = $("galleryDialog");
    // 拖动中换序列会让手指底下的分页错位；松手后自然会再同步一次。
    if (!dialog?.open || state.galleryDragActive) return;
    const items = state.flatGallery;
    if (!Array.isArray(items) || items.length === 0 || items === state.galleryItems) return;
    const key = state.galleryItems[state.galleryIndex]?.key;
    const found = key ? items.findIndex((item) => item.key === key) : -1;
    state.galleryItems = items;
    state.galleryIndex = found >= 0 ? found : Math.min(state.galleryIndex, items.length - 1);
    renderGalleryItem({ keepPainted: true });
  }

  // 翻到倒数第二张就该预备下一段了：拉回来的更早页会直接进序列（见上），
  // 所以能一路翻到底，不用退出去重进。判断条件和「加载更早的」按钮同源。
  function maybeLoadMoreForGallery() {
    if (!state.galleryItems.length) return;
    if (state.galleryItems.length - state.galleryIndex > 2) return;
    if (!historyHasMore()) return;
    loadMoreJobs().catch(() => {});
  }

  function openGallery(items, index, jobId = "") {
    if (!Array.isArray(items) || items.length === 0) return;
    const gallery = $("galleryDialog");
    gallery?.classList.remove("is-closing");
    state.galleryItems = items;
    state.galleryIndex = index;
    state.galleryJobId = jobId || "";
    renderGalleryItem();
    gallery.showModal();
    maybeLoadMoreForGallery();
  }

  function collectHistoryEntries() {
    const done = state.jobs.filter((job) => !["pending", "in_progress"].includes(job.status));
    const jobs = state.favoritesOnly ? done : done.filter((job) => !job.favorite_extra);
    const entries = [];
    jobs.forEach((job) => {
      const gallery = jobGallery(job);
      if (gallery.length === 0) return;
      gallery.forEach((item, index) => {
        if (state.favoritesOnly && !item?.favorite) return;
        const key = historyEntryKey(job, item);
        entries.push({
          ...item,
          key,
          jobId: job.id,
          batchIndex: index,
          batchLen: gallery.length,
          job,
          positivePrompt: job.positive_prompt || "",
          seed: job.seed || "",
          preset: job.preset || null,
        });
      });
    });
    return { jobs, entries };
  }

  function historyOverlayText(entry) {
    const batch = entry.batchLen > 1 ? `${entry.batchIndex + 1}/${entry.batchLen} · ` : "";
    return `${batch}${formatTime(entry.job.create_time)}`;
  }

  function updateHistoryCard(card, entry, flatIndex, total) {
    card._historyEntry = entry;
    card.dataset.historyKey = entry.key;
    const mediaButton = card.querySelector(".history-media-button");
    mediaButton?.setAttribute("aria-label", t("查看大图，第 {value} 张，共 {total} 张", { value: flatIndex + 1, total: total }));
    const title = card.querySelector(".history-title-button");
    const name = entry.job.model_name || entry.job.workflow_name || t("电脑端任务");
    if (title && title.textContent !== name) {
      title.textContent = name;
      title.setAttribute("aria-label", t("查看{name}的生成参数", { name: name }));
    }
    const meta = card.querySelector(".history-overlay-meta");
    const metaText = historyOverlayText(entry);
    if (meta && meta.textContent !== metaText) meta.textContent = metaText;
  }

  function buildHistoryCard(entry) {
    const card = document.createElement("article");
    card.className = "history-card";
    card.dataset.historyKey = entry.key;
    card._historyEntry = entry;

    const mediaButton = document.createElement("button");
    mediaButton.type = "button";
    mediaButton.className = "history-media-button";
    const media = document.createElement("span");
    media.className = "history-media is-loading";
    media.append(createMedia(entry, true));
    settleHistoryMedia(media);
    mediaButton.append(media);
    let holdTimer = 0;
    let held = false;
    mediaButton.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      held = false;
      window.clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        held = true;
        downloadHistoryImage(card._historyEntry);
      }, 520);
    });
    const clearHold = () => {
      window.clearTimeout(holdTimer);
      holdTimer = 0;
    };
    mediaButton.addEventListener("pointerup", clearHold);
    mediaButton.addEventListener("pointercancel", clearHold);
    mediaButton.addEventListener("pointerleave", clearHold);
    mediaButton.addEventListener("click", (event) => {
      if (held) {
        event.preventDefault();
        event.stopPropagation();
        held = false;
        return;
      }
      const key = card.dataset.historyKey;
      const index = state.flatGallery.findIndex((item) => item.key === key);
      if (index < 0) return;
      openGallery(state.flatGallery, index, state.flatGallery[index].jobId);
    });

    const overlay = document.createElement("div");
    overlay.className = "history-overlay";
    const title = document.createElement("button");
    title.type = "button";
    title.className = "history-title-button";
    const meta = document.createElement("span");
    meta.className = "history-overlay-meta";
    overlay.append(title, meta);
    overlay.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const jobId = card._historyEntry?.jobId;
      if (jobId) openJob(jobId);
    });
    card.append(mediaButton, overlay);
    card.addEventListener("animationend", () => card.classList.remove("is-new"));
    return card;
  }

  function renderHistory() {
    const { jobs, entries } = collectHistoryEntries();
    const signature = `${state.favoritesOnly ? 1 : 0}|${entries.map((entry) => `${entry.key}:${entry.favorite ? 1 : 0}:${entry.batchIndex}/${entry.batchLen}`).join("|")}`;
    state.flatGallery = entries;
    const imageTotal = entries.length;
    const batchCount = new Set(entries.map((entry) => entry.jobId)).size;
    setText(
      "historyTotal",
      imageTotal > 0
        ? t("{batchCount} 个批次 · {imageTotal} 张", { batchCount: batchCount, imageTotal: imageTotal })
        : (state.favoritesOnly ? t("暂无收藏") : t("{length} 条记录", { length: jobs.length, n: jobs.length })),
    );
    $("historyEmpty").classList.toggle("hidden", entries.length !== 0);
    paintHistoryMore();

    const grid = $("historyGrid");
    if (signature === state.historyRenderSignature && grid.childElementCount === entries.length) {
      entries.forEach((entry, index) => {
        const card = grid.children[index];
        if (card) card._historyEntry = entry;
      });
      grid.querySelectorAll(".history-media.is-loading").forEach(settleHistoryMedia);
      return;
    }
    // 走到这里说明条目真的变了（新图进来了／更早的页翻出来了），
    // 大图序列顺手跟上；上面那条快速返回不用管，序列本来就是最新的。
    syncGallerySequence();

    const wanted = new Set(entries.map((entry) => entry.key));
    const hadCards = state.historyCards.size > 0;
    entries.forEach((entry, index) => {
      let card = state.historyCards.get(entry.key);
      if (!card) {
        card = buildHistoryCard(entry);
        state.historyCards.set(entry.key, card);
        if (hadCards) card.classList.add("is-new");
      }
      updateHistoryCard(card, entry, index, entries.length);
      if (grid.children[index] !== card) grid.insertBefore(card, grid.children[index] || null);
    });
    [...grid.children].forEach((card) => {
      const key = card.dataset.historyKey;
      if (!wanted.has(key)) card.remove();
    });
    const liveKeys = new Set();
    state.jobs.forEach((job) => {
      jobGallery(job).forEach((item) => liveKeys.add(historyEntryKey(job, item)));
    });
    for (const key of [...state.historyCards.keys()]) {
      if (!liveKeys.has(key)) state.historyCards.delete(key);
    }

    state.historySeenKeys = wanted;
    state.historyReady = true;
    state.historyRenderSignature = signature;
    grid.querySelectorAll(".history-media.is-loading").forEach(settleHistoryMedia);
  }

  function nodeDisplayName(nodeId) {
    return state.nodeTitles?.get(String(nodeId)) || t("节点 {nodeId}", { nodeId: nodeId });
  }

  function setProgressRing(value) {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    const ring = $("progressBar");
    const wrapper = $("progressRing");
    ring.style.strokeDashoffset = String(113.1 * (1 - percent / 100));
    if (value == null) wrapper.removeAttribute("aria-valuenow");
    else wrapper.setAttribute("aria-valuenow", String(Math.round(percent)));
  }

  function updateActiveJob() {
    const jobs = visibleQueueJobs();
    const active = jobs.find((job) => String(job.id) === state.progress.activeId)
      || jobs.find((job) => job.status === "in_progress")
      || jobs.find((job) => job.status === "pending") || null;
    state.activeJob = active;
    const beacon = $("connectionBeacon");
    if (beacon) beacon.className = `status-beacon ${!state.online ? "is-offline" : active?.status === "in_progress" ? "is-running" : active ? "is-pending" : "is-idle"}`;

    if (!active) {
      setText("activeJobName", "Comfy Remote");
      setProgressRing(null);
      setText("progressValue", "—");
      setText("progressLabel", t("空闲"));
      $("livePreview").classList.add("hidden");
      return;
    }

    setText("activeJobName", active.workflow_name || t("电脑端任务"));
    const display = progressDisplay(active);
    setProgressRing(display.percent);
    setText("progressValue", display.text);
    setText("progressLabel", display.label);
  }

  function byCreateTimeDesc(left, right) {
    return (Number(right?.create_time) || 0) - (Number(left?.create_time) || 0);
  }

  // state.jobs 的拼装：第一页在前、已翻出来的更早页在后，按 id 去重（第一页优先），
  // 再补上还没落到服务器列表里的乐观任务，最后整体按 create_time 倒序。
  function mergeJobPages() {
    const seen = new Set();
    const merged = [];
    const take = (job) => {
      const id = job == null ? "" : String(job.id ?? "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      merged.push(job);
    };
    state.jobsFirstPage.forEach(take);
    state.jobsOlderPages.forEach(take);
    state.jobsLoadedCount = merged.length;
    for (const [id, job] of state.optimisticJobs) {
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(job);
    }
    merged.sort(byCreateTimeDesc);
    state.jobs = merged;
  }

  function applyJobPages() {
    mergeJobPages();
    renderHistory();
    updateActiveJob();
  }

  // 翻到更早的分页结果同样要保留接口给的字段形状，这里只做拼接，不加工条目内容。
  function appendOlderJobs(incoming) {
    const known = new Set();
    state.jobsFirstPage.forEach((job) => known.add(String(job.id)));
    state.jobsOlderPages.forEach((job) => known.add(String(job.id)));
    const added = [];
    incoming.forEach((job) => {
      const id = job == null ? "" : String(job.id ?? "");
      if (!id || known.has(id)) return;
      known.add(id);
      added.push(job);
    });
    state.jobsOlderPages = state.jobsOlderPages.concat(added);
    return added.length;
  }

  // 「加载更早的」按钮就挂在 #historyGrid 后面，只在还能往回翻时出现。
  function historyMoreButton() {
    const existing = $("historyMoreButton");
    if (existing) return existing;
    const grid = $("historyGrid");
    if (!grid) return null;
    const button = document.createElement("button");
    button.id = "historyMoreButton";
    button.type = "button";
    button.className = "secondary-button full hidden";
    button.textContent = t("加载更早的");
    button.addEventListener("click", () => {
      loadMoreJobs().catch(() => {});
    });
    grid.insertAdjacentElement("afterend", button);
    return button;
  }

  // 还能往更早翻吗？按钮的显隐、滑到底自动加载、大图翻页补档，
  // 三处共用同一条判断，免得一边以为还能翻、另一边空拉。
  function historyHasMore() {
    return state.jobsHasMore && state.jobsPageOffset < state.totalJobs;
  }

  function paintHistoryMore() {
    const button = historyMoreButton();
    if (!button) return;
    const busy = state.jobsMoreLoading;
    // has_more 说的是「offset=0 时后面还有」，全部翻完之后轮询仍会带 true，
    // 所以再要求「已加载条数还没追上 total」，否则按钮会在翻完后又冒出来。
    // 用「窗口游标」判断，而不是已加载条数：首屏会额外带回全部收藏任务
    // （favorite_extra），已加载条数会虚高，拿它判断会让按钮提前消失、剩下的更早记录翻不到。
    const hasHistory = state.flatGallery.length > 0;
    const hasMore = historyHasMore();
    const visible = busy || hasHistory;
    button.classList.toggle("hidden", !visible);
    const disabled = busy || !hasMore;
    if (button.disabled !== disabled) button.disabled = disabled;
    button.setAttribute("aria-busy", String(busy));
    const label = busy ? t("加载中…") : hasMore ? t("加载更早的") : t("已经到底了");
    if (button.textContent !== label) button.textContent = label;
  }

  let jobsLoadSequence = 0;
  async function loadJobsOnce() {
    const sequence = ++jobsLoadSequence;
    const favoritesOnly = Boolean(state.favoritesOnly);
    // A mode switch starts a fresh server window; old pages belong to the
    // previous filter and must not affect the new offset.
    if (state.jobsMode !== favoritesOnly) {
      state.jobsMode = favoritesOnly;
      state.jobsFirstPage = [];
      state.jobsOlderPages = [];
      state.jobsPageOffset = 0;
      state.jobsHasMore = false;
    }
    const body = await requestJson(`/mobile/api/jobs?limit=${JOBS_PAGE}&summary=1&favorites=${favoritesOnly ? 1 : 0}&_=${Date.now()}`);
    // Do not let a response for the previous filter repaint the new mode.
    if (sequence !== jobsLoadSequence || favoritesOnly !== Boolean(state.favoritesOnly)) return;
    const incoming = Array.isArray(body.jobs) ? body.jobs : [];
    const incomingIds = new Set(incoming.map((job) => String(job.id)));
    for (const [id, job] of state.optimisticJobs) {
      if (incomingIds.has(id) || Date.now() - job.create_time > 30000) state.optimisticJobs.delete(id);
    }
    // 轮询只覆盖第一页，已经翻出来的更早页（state.jobsOlderPages）原样留着。
    state.jobsFirstPage = incoming;
    state.totalJobs = Math.max(Number(body.total) || 0, incoming.length);
    state.jobsHasMore = Boolean(body.has_more);
    // 翻页游标只往前：刷新第一页不能把它退回去，否则会把翻过的旧页再拉一遍。
    state.jobsPageOffset = Math.max(state.jobsPageOffset, JOBS_PAGE);
    applyJobPages();
  }

  const jobsRefresh = new window.MobileSingleFlight(loadJobsOnce);
  function loadJobs(urgent = false) {
    return jobsRefresh.run(urgent);
  }

  async function loadMoreJobsOnce() {
    const favoritesOnly = Boolean(state.favoritesOnly);
    // offset 用「已消费的服务器列表窗口位置」，而不是 state.jobs.length：
    // 运行中/排队中的任务和收藏置顶每一页都会被塞回来，去重后的条数可能大于窗口位置，
    // 拿它当 offset 会把夹在窗口中间的那几条永久跳过。
    const offset = state.jobsPageOffset;
    const body = await requestJson(`/mobile/api/jobs?limit=${JOBS_PAGE}&offset=${offset}&summary=1&favorites=${favoritesOnly ? 1 : 0}&_=${Date.now()}`);
    // A filter change invalidates this page request as well; leave its offset
    // untouched so the next first-page request can establish a clean window.
    if (favoritesOnly !== Boolean(state.favoritesOnly) || state.jobsMode !== favoritesOnly) return;
    const incoming = Array.isArray(body.jobs) ? body.jobs : [];
    appendOlderJobs(incoming);
    state.jobsPageOffset = offset + JOBS_PAGE;
    state.jobsHasMore = Boolean(body.has_more);
    const total = Number(body.total);
    if (Number.isFinite(total) && total > 0) state.totalJobs = total;
    applyJobPages();
  }

  const jobsMoreRefresh = new window.MobileSingleFlight(loadMoreJobsOnce);
  async function loadMoreJobs() {
    if (state.jobsMoreLoading) return;
    state.jobsMoreLoading = true;
    paintHistoryMore();
    try {
      await jobsMoreRefresh.run(true);
    } catch (error) {
      toast(error.message || t("更早的记录读取失败"), "error");
    } finally {
      state.jobsMoreLoading = false;
      paintHistoryMore();
    }
  }

  async function loadProgressOnce() {
    const revision = state.progress.revision;
    let body;
    try {
      body = await requestJson(`/mobile/api/progress?_=${Date.now()}`);
    } catch {
      return;
    }
    if (revision !== state.progress.revision) return;
    const previousId = state.progress.activeId;
    if (state.progress.applySnapshot(body, revision)) {
      updateActiveJob();
      if (previousId !== state.progress.activeId) loadJobs(true).catch(() => {});
    }
  }

  const progressRefresh = new window.MobileSingleFlight(loadProgressOnce);
  function loadProgress(urgent = false) {
    return progressRefresh.run(urgent);
  }

  function promptValue(prompt, inputNames) {
    if (!prompt || typeof prompt !== "object") return undefined;
    for (const inputName of inputNames) {
      for (const node of Object.values(prompt)) {
        const value = node?.inputs?.[inputName];
        if (value !== undefined && value !== null && value !== "" && !Array.isArray(value)) return value;
      }
    }
    return undefined;
  }

  function detailValue(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    if (typeof value === "boolean") return value ? t("开启") : t("关闭");
    return String(value);
  }

  function jobDetailRows(job) {
    const prompt = job?.workflow?.prompt || {};
    const gallery = jobGallery(job);
    const width = promptValue(prompt, ["width"]);
    const height = promptValue(prompt, ["height"]);
    const size = width !== undefined && height !== undefined ? `${width} × ${height}` : "";
    const rows = [
      [t("工作流"), job.workflow_name || t("电脑端任务")],
      [t("模型"), detailValue(promptValue(prompt, ["unet_name", "ckpt_name", "model_name"]))],
      ["VAE", detailValue(promptValue(prompt, ["vae_name"]))],
      [t("采样器"), detailValue(promptValue(prompt, ["sampler_name"]))],
      [t("调度器"), detailValue(promptValue(prompt, ["scheduler"]))],
      [t("尺寸"), size],
      [t("采样步数"), detailValue(promptValue(prompt, ["steps"]))],
      ["CFG", detailValue(promptValue(prompt, ["cfg"]))],
      [t("重绘幅度"), detailValue(promptValue(prompt, ["denoise"]))],
      [t("批量数量"), detailValue(promptValue(prompt, ["batch_size"]))],
      [t("输出图片"), gallery.length ? t("{length} 张", { length: gallery.length, n: gallery.length }) : detailValue(job.outputs_count)],
      [t("提交时间"), formatTime(job.create_time)],
      [t("任务编号"), job.id],
    ].filter(([, value]) => value !== "");
    if (job.execution_error?.exception_message) rows.push([t("错误"), job.execution_error.exception_message]);
    return rows;
  }

  function paintJobDialog(job) {
    state.dialogJob = job;
    setText("dialogTitle", job.workflow_name || t("任务详情"));
    setText("dialogStatus", jobStatusLabel(job.status));
    $("dialogStatus").className = `status-chip ${job.status || ""}`;
    const elements = jobDetailRows(job).map(([term, description]) => {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = term;
      dd.textContent = description;
      row.append(dt, dd);
      return row;
    });
    $("dialogMeta").replaceChildren(...elements);
    const prompt = String(job.positive_prompt || "").trim();
    const seed = String(job.seed || "").trim();
    setText("jobPromptText", prompt || "—");
    setText("jobSeedText", seed || "—");
    $("jobPromptRow")?.classList.remove("is-expanded");
    $("copyJobPrompt").disabled = !prompt;
    $("copyJobSeed").disabled = !seed;
    $("retryJobButton").disabled = Boolean(job.persisted) || ["pending", "in_progress"].includes(job.status);
  }

  async function openJob(jobId) {
    const token = ++state.jobDialogToken;
    const preview = state.jobs.find((job) => String(job.id) === String(jobId)) || {
      id: jobId,
      status: "completed",
      workflow_name: t("任务详情"),
    };
    const dialog = $("jobDialog");
    paintJobDialog(preview);
    dialog.classList.add("is-loading");
    $("copyJobPrompt").disabled = true;
    $("copyJobSeed").disabled = true;
    $("retryJobButton").disabled = true;
    if (!dialog.open) dialog.showModal();
    try {
      const body = await requestJson(`/mobile/api/jobs/${encodeURIComponent(jobId)}?_=${Date.now()}`);
      if (token !== state.jobDialogToken) return;
      paintJobDialog(body.job);
      dialog.classList.remove("is-loading");
    } catch (error) {
      if (token !== state.jobDialogToken) return;
      dialog.classList.remove("is-loading");
      toast(error.message, "error");
    }
  }

  async function retryDialogJob() {
    if (!state.dialogJob?.id) return;
    const button = $("retryJobButton");
    button.disabled = true;
    try {
      const body = await requestJson(`/mobile/api/jobs/${encodeURIComponent(state.dialogJob.id)}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId }),
      });
      state.currentJobId = body.prompt_id;
      $("jobDialog").close();
      toast(t("已重新加入队列"), "success");
      showView("generate");
      await Promise.all([loadStatus(), loadJobs()]);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  let modeTipTimer = 0;
  function showModeTip(isRandom) {
    const bubble = $("modeTipBubble");
    if (!bubble) return;
    window.clearTimeout(modeTipTimer);
    bubble.classList.toggle("is-random", isRandom);
    bubble.innerHTML = `<span class="mode-tip-title">${isRandom ? t("随机生成模式") : t("普通生成模式")}</span>`;
    bubble.hidden = false;
    window.requestAnimationFrame(() => {
      bubble.classList.add("is-visible");
    });
    modeTipTimer = window.setTimeout(() => {
      bubble.classList.remove("is-visible");
      window.setTimeout(() => {
        if (!bubble.classList.contains("is-visible")) bubble.hidden = true;
      }, 150);
    }, 600);
  }

  function paintGenerateButton() {
    const button = $("generateButton");
    if (!button) return;
    const random = state.randomGenerate;
    if (state.multiModel) state.repeatCount = 1;
    const repeats = Math.max(1, Math.min(10, Number(state.repeatCount) || 1));
    state.repeatCount = repeats;
    button.classList.toggle("random-mode", random);
    button.classList.toggle("multi-model", state.multiModel);
    button.classList.toggle("has-repeat", repeats > 1);
    const label = state.multiModel
      ? (random ? t("按模型顺序随机生成") : t("按模型顺序加入队列"))
      : (random ? (repeats > 1 ? t("连发 {repeats} 次随机生成", { repeats: repeats }) : t("随机生成")) : (repeats > 1 ? t("连发 {repeats} 次", { repeats: repeats }) : t("加入队列")));
    button.setAttribute("aria-label", label);
    button.title = state.multiModel
      ? t("{label}（上滑切换随机；多模型下不能改次数）", { label: label })
      : (random ? t("随机生成（上滑切回普通生成）") : t("加入队列（上滑切换随机生成）"));
    const svg = button.querySelector("svg");
    if (svg) {
      svg.innerHTML = random
        ? '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'
        : '<path d="m5 3 14 9-14 9V3Z"/>';
      svg.style.marginLeft = random ? "0" : "3px";
    }
    const centerNum = $("repeatCenterNum");
    if (centerNum) {
      centerNum.textContent = String(repeats);
    }
    button.classList.toggle("is-submitting", submittingBatch);
    if (!submittingBatch) button.disabled = false;
  }

  let modeSwitching = false;

  // 上滑切模式：配色立刻开始淡入淡出（交给 .fab-random-layer 那条过渡），
  // 图标同时淡出缩小，换完图标再弹回来，整颗按钮跟着轻压一下。
  // 配色和图标是叠在一起跑的两条动作，不是"换完再变色"。
  function toggleRandomGenerate() {
    if (modeSwitching) return;
    const button = $("generateButton");
    const next = !state.randomGenerate;
    state.randomGenerate = next;
    try {
      phoneSettings.setItem("comfy-mobile-remote.randomGenerate", next ? "1" : "0");
    } catch { /* storage optional */ }
    if (!button) {
      paintGenerateButton();
      showModeTip(next);
      return;
    }
    modeSwitching = true;
    button.classList.toggle("random-mode", next);
    button.classList.add("is-mode-switching");
    showModeTip(next);
    window.setTimeout(() => {
      paintGenerateButton();                 // 换图标与文案（配色类已是目标值，不会跳）
      button.classList.remove("is-mode-switching");
      window.setTimeout(() => {
        modeSwitching = false;
      }, 420);
    }, 150);
  }

  function bindGenerateSwipe() {
    const button = $("generateButton");
    const dock = button?.closest(".nav-dock");
    if (!button || !dock) return;
    try {
      state.randomGenerate = phoneSettings.getItem("comfy-mobile-remote.randomGenerate") === "1";
      const stored = Number(phoneSettings.getItem("comfy-mobile-remote.repeatCount"));
      if (Number.isFinite(stored)) state.repeatCount = Math.max(1, Math.min(10, stored));
    } catch { /* storage optional */ }
    const ruler = $("repeatRuler");
    const bubble = $("repeatBubble");
    const bubbleNum = $("repeatBubbleNum");
    const STEP = 24;
    if (ruler && ruler.childElementCount === 0) {
      for (let index = 1; index <= 10; index += 1) {
        const tick = document.createElement("span");
        tick.className = "repeat-tick";
        tick.dataset.value = String(index);
        tick.textContent = String(index);
        ruler.append(tick);
      }
    }
    paintGenerateButton();
    let startX = 0;
    let startY = 0;
    let lockX = 0;
    let armed = false;
    let skipClick = false;
    let axis = "";
    let liveRepeat = 5;
    let startRepeat = 5;
    const VERTICAL = 36;
    const LOCK = 14;

    const stripX = (value, extra = 0) => {
      const width = button.clientWidth || 70;
      return width / 2 - (value - 0.5) * STEP + extra;
    };

    const showBubble = () => {
      if (!bubble) return;
      bubble.hidden = false;
      window.requestAnimationFrame(() => bubble.classList.add("is-visible"));
    };

    const paintRuler = (value, extra = 0) => {
      const clamped = Math.max(1, Math.min(10, value));
      liveRepeat = Math.round(clamped);
      if (bubbleNum) bubbleNum.textContent = String(liveRepeat);
      if (ruler) {
        ruler.style.transform = `translate3d(${stripX(clamped, extra)}px,0,0)`;
        ruler.querySelectorAll(".repeat-tick").forEach((tick) => {
          const n = Number(tick.dataset.value);
          const dist = Math.abs(n - clamped);
          tick.classList.toggle("is-active", n === liveRepeat);
          const scale = Math.max(0.72, 1.36 - dist * 0.48);
          const opacity = Math.max(0, 1 - Math.pow(dist / 1.55, 1.4));
          tick.style.transform = `scale(${scale.toFixed(2)})`;
          tick.style.opacity = opacity.toFixed(2);
        });
      }
    };

    const closeRuler = () => {
      button.classList.remove("is-ruler");
      dock.classList.remove("is-ruler");
      if (bubble) {
        bubble.classList.remove("is-visible");
        window.setTimeout(() => {
          if (!button.classList.contains("is-ruler") && bubble) bubble.hidden = true;
        }, 150);
      }
      if (ruler) {
        ruler.hidden = true;
        ruler.style.transform = "";
      }
    };

    const beginHorizontal = (clientX) => {
      skipClick = true;
      lockX = clientX;
      startRepeat = Math.max(1, Math.min(10, Number(state.repeatCount) || 1));
      liveRepeat = startRepeat;
      button.classList.add("is-ruler");
      dock.classList.add("is-ruler");
      if (ruler) ruler.hidden = false;
      showBubble();
      paintRuler(startRepeat);
    };

    const handleMove = (clientX, clientY, event) => {
      if (!armed) return;
      const dx = clientX - startX;
      const dy = startY - clientY;
      if (!axis) {
        if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
        axis = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
        if (axis === "h") {
          if (state.multiModel) {
            axis = "blocked";
            skipClick = true;
            toast(t("多模型开启时不能改次数"));
            return;
          }
          beginHorizontal(clientX);
        }
      }
      if (axis === "h" && event) event.preventDefault();
      if (axis === "v") {
        if (dy > 6) dock.style.transform = `translateY(${Math.max(-22, -dy * 0.32)}px)`;
        if (dy >= VERTICAL) skipClick = true;
        return;
      }
      if (axis === "h") {
        const shift = clientX - lockX;
        paintRuler(Math.max(1, Math.min(10, startRepeat - shift / STEP)));
      }
    };

    // 按下反馈走 JS 类名，不靠 :active —— 按下时 dock 会被加上 is-swiping，
    // 而 .nav-dock.is-swiping .generate-fab:active{transform:none} 会把它整条否掉。
    // 松手后的「果冻落地」：过冲拉长 → 被压扁 → 幅度递减地晃两下收住。
    // 用 WAAPI 而不是 CSS 关键帧：svg 上的 animation 属性已经被入场动画占着，
    // 改写它会把入场动画顺带重启一遍；WAAPI 既能避开特指度之争，也能从
    // "当前实际大小"起步（早点松手时不会跳变）。
    // WAAPI 的 options.easing 是"整条动画"的时间函数，它会把所有关键帧偏移一起拉伸：
    // 实测 offset 0.26 的压扁峰 53ms 就撞到了，而动画名义上还要跑 820ms，后半段全在空转。
    // 想按真实毫秒摆关键帧，就得把 easing 写在每一帧上 —— 这时的语义和 CSS 的
    // animation-timing-function 一样，管的是"它到下一帧"那一段。
    // 两种曲线按真实受力来分，而不是一律 ease-out：
    // EASE_POP  快起慢收 —— 弹簧释放/被弹回来的那一段，到达极值那一刻速度正好归零；
    // EASE_FALL 慢起快收 —— 越过极值之后就是自由落体，越落越快，砸到地面时速度最大。
    // 一律 ease-out 的话，砸下去那一下反而是"快到头了在减速"，看着就不像掉下来的。
    const EASE_POP = "cubic-bezier(0.16, 0.84, 0.44, 1)";
    const EASE_FALL = "cubic-bezier(0.5, 0, 0.9, 0.6)";
    // 压扁必须正好落在 dock 砸到最下方的那一刻（DOCK_LANDING_MS）。
    // 早了像悬在半空就被压扁，晚了像落地之后才塌下去 —— 两头都不像掉下来。
    const JELLY_MS = 820;
    const LAND = DOCK_LANDING_MS / JELLY_MS;
    // 里面的图标/数字：幅度大，负责"看得见的果冻"
    const JELLY = [
      { transform: "scale(1.01, 1.15)", offset: 0.07, easing: EASE_FALL },  // 57ms：弹到最高点，同时被拉长
      { transform: "scale(1.15, 0.85)", offset: LAND, easing: EASE_POP },   // 160ms：砸到最下方，正好压得最扁
      { transform: "scale(0.95, 1.06)", offset: 0.42, easing: EASE_FALL },  // 344ms：被弹回去
      { transform: "scale(1.04, 0.975)", offset: 0.64, easing: EASE_POP },
      { transform: "scale(0.995, 1.005)", offset: 0.85, easing: EASE_POP },
      { transform: "scale(1)", offset: 1 },
    ];
    // 底座整颗按钮：同相位、幅度小一半，跟着一起颤，读起来才像一整块果冻
    const JELLY_BODY = [
      { transform: "scale(1.005, 1.06)", offset: 0.07, easing: EASE_FALL },
      { transform: "scale(1.065, 0.94)", offset: LAND, easing: EASE_POP },
      { transform: "scale(0.98, 1.025)", offset: 0.42, easing: EASE_FALL },
      { transform: "scale(1.018, 0.99)", offset: 0.64, easing: EASE_POP },
      { transform: "scale(0.998, 1.002)", offset: 0.85, easing: EASE_POP },
      { transform: "scale(1)", offset: 1 },
    ];
    // 左右滑动改连发数量时用的"干脆"版：一下就弹到位、不拖尾，不带压扁的回弹。
    const SNAP = [
      { transform: "scale(1.055)", offset: 0.34 },
      { transform: "scale(1)", offset: 1 },
    ];
    const SNAP_BODY = [
      { transform: "scale(1.03)", offset: 0.34 },
      { transform: "scale(1)", offset: 1 },
    ];
    const RELEASE_MOTIONS = {
      // 果冻的 easing 已经写在每一帧上，这里必须是 linear —— 否则整条时间轴会被再拉一次。
      // startEasing 单独给第一段（当前大小 → 0.07 的极值）：它是动态起点，不在帧数组里。
      jelly: { body: JELLY_BODY, content: JELLY, duration: JELLY_MS, easing: "linear", startEasing: EASE_POP },
      snap: { body: SNAP_BODY, content: SNAP, duration: 230, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    };
    let jellyAnimations = [];
    const stopJelly = () => {
      for (const animation of jellyAnimations) {
        try { animation.cancel(); } catch { /* 已经结束 */ }
      }
      jellyAnimations = [];
    };
    const playRelease = (kind = "jelly") => {
      if (typeof button.animate !== "function") return;
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      stopJelly();
      const motion = RELEASE_MOTIONS[kind] || RELEASE_MOTIONS.jelly;
      const targets = [
        [button, motion.body],
        [button.querySelector("svg"), motion.content],
        [$("repeatCenterNum"), motion.content],
      ];
      for (const [el, frames] of targets) {
        if (!el) continue;
        const computed = window.getComputedStyle(el).transform;
        const matrix = new DOMMatrixReadOnly(computed === "none" ? "" : computed);
        const start = `scale(${Math.hypot(matrix.a, matrix.b).toFixed(4)}, ${Math.hypot(matrix.c, matrix.d).toFixed(4)})`;
        const opening = motion.startEasing
          ? { transform: start, easing: motion.startEasing }
          : { transform: start };
        jellyAnimations.push(el.animate(
          [opening, ...frames],
          { duration: motion.duration, easing: motion.easing },
        ));
      }
    };
    const pressDown = () => {
      stopJelly();                        // 上一次还在晃就先掐掉，别盖住这次的按下反馈
      button.classList.add("is-pressing");
    };
    // 松手动画按手势分开：左右滑是"改数量"，要干脆；上下滑/直接点才是果冻。
    const pressUp = (kind = "jelly") => {
      if (!button.classList.contains("is-pressing")) return;
      button.classList.remove("is-pressing");
      playRelease(kind);
    };

    button.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      armed = true;
      skipClick = false;
      axis = "";
      dock.classList.add("is-swiping");
      pressDown();
      try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    });
    button.addEventListener("pointermove", (event) => {
      handleMove(event.clientX, event.clientY, event);
    });
    button.addEventListener("touchmove", (event) => {
      const touch = event.touches[0];
      if (!touch) return;
      handleMove(touch.clientX, touch.clientY, event);
    }, { passive: false });
    const endHold = (event) => {
      // axis 此刻还留着本次手势的判定结果：左右滑（改连发数量）用干脆版
      pressUp(axis === "h" ? "snap" : "jelly");
      if (!armed) return;
      armed = false;
      dock.classList.remove("is-swiping");
      dock.style.transform = "";
      if (axis === "h") {
        event.preventDefault();
        state.repeatCount = liveRepeat;
        try {
          phoneSettings.setItem("comfy-mobile-remote.repeatCount", String(state.repeatCount));
        } catch { /* storage optional */ }
        closeRuler();
        paintGenerateButton();
        axis = "";
        return;
      }
      closeRuler();
      if (axis === "blocked") {
        axis = "";
        return;
      }
      if (skipClick) {
        event.preventDefault();
        // 配色和图标等按钮砸到底再开始换：dock 落地那一刻正是压得最扁的时候，
        // 两件事叠在一起才读得出「砸变了」。立刻换的话，视觉上跟落地没有任何关系。
        window.setTimeout(toggleRandomGenerate, DOCK_LANDING_MS);
      }
      axis = "";
    };
    button.addEventListener("pointerup", endHold);
    button.addEventListener("pointercancel", endHold);
    button.addEventListener("pointerleave", () => pressUp());
    button.addEventListener("lostpointercapture", () => pressUp());
    button.addEventListener("click", (event) => {
      if (!skipClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      skipClick = false;
    }, true);
  }

  function presetSubmissionHasConflicts() {
    return state.presetEnabled && markPresetConflicts().size > 0;
  }

  async function submitGeneration(event) {
    event.preventDefault();
    if (!state.workflow?.id || submittingBatch || applyingRemoteSettings) return;
    if (!state.randomGenerate && presetSubmissionHasConflicts()) {
      toast(t("存在互斥标签，请先修改冲突项"), "error");
      renderPresetPanel();
      return;
    }
    const models = selectedModelQueue();
    if (!models.length) {
      toast(t("请选择模型"), "error");
      return;
    }
    const times = state.multiModel ? models.length : Math.max(1, Math.min(10, Number(state.repeatCount) || 1));
    const workflowId = state.workflow.id;
    const seedFields = (state.workflow.fields || []).filter((field) => field.input === "seed" || field.input === "noise_seed");
    const sharedSeeds = {};
    if (state.multiModel && state.fixedSeed) {
      for (const field of seedFields) {
        const current = state.values[field.id];
        sharedSeeds[field.id] = current === "__random__" || current === "" || current == null
          ? Math.floor(Math.random() * 0x100000000)
          : current;
      }
    }
    const button = $("generateButton");
    submittingBatch = true;
    phoneSettings.beginBatch();
    button.disabled = true;
    button.classList.remove("is-pressing");
    button.classList.add("is-submitting");
    button.setAttribute("aria-busy", "true");
    $("workflowSelect").disabled = true;
    const hidden = button.querySelector(".visually-hidden");
    if (hidden) hidden.textContent = t("正在提交");
    let submitted = 0;
    const originalValues = clonePresetData(state.values, {});
    const originalPreset = clonePresetData(state.presetState, { slots: {}, custom: {}, freeText: "", extraText: "", catalog: emptyCatalog() });
    const payloads = [];
    try {
      const wasHydrating = hydratingSettings;
      hydratingSettings += 1;
      try {
        for (let index = 0; index < times; index += 1) {
          if (state.randomGenerate) randomizePresetSlots("", { persist: false });
          if (presetSubmissionHasConflicts()) throw new Error(t("存在互斥标签，请先修改冲突项"));
          if (state.presetEnabled) applyPresetPrompt();
          const values = { ...state.values };
          if (state.multiModel && state.modelField) values[state.modelField.id] = models[index];
          Object.assign(values, sharedSeeds);
          payloads.push({
            workflow_id: workflowId,
            client_id: clientId,
            values,
            preset: snapshotPreset(),
          });
        }
      } finally {
        hydratingSettings = wasHydrating;
      }
      saveDraft();
      savePresetState();
      for (const payload of payloads) {
        if (state.randomGenerate) {
          paintPresetFromSnapshot(payload.preset);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        const body = await requestJson("/mobile/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        submitted += 1;
        const promptId = String(body.prompt_id);
        state.currentJobId = promptId;
        const optimistic = {
          id: promptId,
          status: "pending",
          priority: body.number ?? 0,
          create_time: Date.now(),
          workflow_id: workflowId,
          workflow_name: String(body.workflow_name || t("手机工作流")),
          model_name: state.modelField ? String(payload.values[state.modelField.id] ?? "") : "",
          positive_prompt: state.presetField ? String(payload.values[state.presetField.id] ?? "") : "",
          outputs_count: 0,
          previewable_outputs_count: 0,
          gallery: [],
        };
        state.optimisticJobs.set(promptId, optimistic);
        if (!state.jobs.some((job) => String(job.id) === promptId)) state.jobs.unshift(optimistic);
        updateActiveJob();
      }
      toast(submitted > 1 ? t("已加入 {submitted} 个任务", { submitted, n: submitted }) : t("任务已加入队列"), "success");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      if (submitted === 0) {
        state.values = originalValues;
        state.presetState = originalPreset;
        state.presetState.custom = state.presetState.catalog?.custom || state.presetState.custom || {};
        markPresetConflicts();
        if (state.presetEnabled) applyPresetPrompt();
      }
      toast(submitted ? t("已加入 {submitted} 个，后续失败", { submitted: submitted }) : (error.message || t("提交失败")), "error");
    } finally {
      phoneSettings.endBatch();
      submittingBatch = false;
      button.disabled = false;
      button.classList.remove("is-submitting");
      button.classList.remove("is-pressing");
      // 图标回来时轻轻弹一下：显式加类，不再依赖选择器变化被动重启
      button.classList.remove("is-icon-in");
      void button.offsetWidth;
      button.classList.add("is-icon-in");
      window.setTimeout(() => button.classList.remove("is-icon-in"), 460);
      button.setAttribute("aria-busy", "false");
      $("workflowSelect").disabled = false;
      if (hidden) hidden.textContent = t("加入队列");
      // 队列/历史/状态的刷新放到解锁之后再跑：/mobile/api/jobs 在条数多时要好几秒，
      // 让「提交中」的锁一直挂在那儿不值当。任务已经入队，刷新只是补界面，
      // 而且乐观条目在提交循环里已经先渲染出来了，失败也不影响任务本身。
      void Promise.all([loadStatus(), loadJobs(true), loadProgress(true)]).catch(() => {});
    }
  }

  function handleSocketEvent(message) {
    const type = message?.type;
    const data = message?.data || {};
    const promptId = data.prompt_id ? String(data.prompt_id) : "";
    if (type === "status") {
      window.setTimeout(() => loadStatus().catch(() => {}), 80);
      window.setTimeout(() => loadJobs().catch(() => {}), 140);
      window.setTimeout(() => loadProgress().catch(() => {}), 180);
      return;
    }
    if (type === "execution_start" && promptId) {
      state.progress.begin(promptId);
      state.progress.set(promptId, { percent: 0, value: 0, max: 0, label: t("开始执行") });
      loadJobs().catch(() => {});
    } else if (type === "executing" && promptId && data.node) {
      if (state.progress.executing(data)) {
        state.progress.set(promptId, {
          label: nodeDisplayName(data.display_node || data.node),
          displayId: String(data.display_node || data.node),
        });
        updateActiveJob();
      }
    } else if (type === "progress" && promptId) {
      const max = Number(data.max);
      const value = Number(data.value);
      if (Number.isFinite(max) && Number.isFinite(value) && max > 0) {
        state.progress.set(promptId, {
          value,
          max,
          label: data.node ? nodeDisplayName(data.node) : t("正在采样"),
          nodeId: data.node ? String(data.node) : "",
        });
        updateActiveJob();
      }
    } else if (type === "progress_state" && promptId) {
      if (state.progress.acceptProgressState(data)) {
        updateActiveJob();
      }
    } else if (["execution_success", "execution_error", "execution_interrupted"].includes(type)) {
      if (type === "execution_success") toast(t("生成完成"), "success");
      if (type === "execution_error") toast(data.exception_message || t("生成失败"), "error");
      if (type === "execution_interrupted") toast(t("任务已停止"));
      state.progress.delete(promptId);
      window.setTimeout(() => Promise.all([loadStatus(), loadJobs(true), loadProgress(true)]).catch(() => {}), 250);
      window.setTimeout(() => loadJobs(true).catch(() => {}), 900);
    }
  }

  function handleBinaryPreview(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return;
    const view = new DataView(buffer);
    const eventType = view.getUint32(0);
    let mime = "image/png";
    let imageOffset = 8;

    if (eventType === 1) {
      const imageType = view.getUint32(4);
      mime = imageType === 1 ? "image/jpeg" : "image/png";
    } else if (eventType === 4) {
      const metadataLength = view.getUint32(4);
      imageOffset = 8 + metadataLength;
      if (imageOffset >= buffer.byteLength) return;
      try {
        const metadataBytes = new Uint8Array(buffer, 8, metadataLength);
        const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
        mime = metadata.image_type || mime;
      } catch {
        // The image payload is still usable when optional metadata is malformed.
      }
    } else {
      return;
    }

    const blob = new Blob([buffer.slice(imageOffset)], { type: mime });
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(blob);
    const preview = $("livePreview");
    preview.src = state.previewUrl;
    preview.classList.remove("hidden");
  }

  function connectWebSocket() {
    window.clearTimeout(state.reconnectTimer);
    if (state.websocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.websocket.readyState)) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws?clientId=${encodeURIComponent(clientId)}`);
    socket.binaryType = "arraybuffer";
    state.websocket = socket;
    socket.addEventListener("open", () => {
      state.reconnectDelay = 1000;
      const beacon = $("connectionBeacon");
      if (beacon) beacon.className = "status-beacon is-idle";
      socket.send(JSON.stringify({ type: "feature_flags", data: {} }));
      loadProgress(true).catch(() => {});
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try { handleSocketEvent(JSON.parse(event.data)); } catch { /* Ignore malformed extension events. */ }
      } else {
        handleBinaryPreview(event.data);
      }
    });
    socket.addEventListener("close", () => {
      if (state.websocket === socket) state.websocket = null;
      const beacon = $("connectionBeacon");
      if (beacon) beacon.className = "status-beacon is-offline";
      state.reconnectTimer = window.setTimeout(connectWebSocket, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 1.7, 15000);
    });
    socket.addEventListener("error", () => socket.close());
  }

  // 启动与重新联网时把状态、队列、进度、工作流列表一起拉一遍。
  async function refreshAll() {
    const tasks = [loadStatus(), loadJobs(), loadProgress()];
    if (!submittingBatch && !applyingRemoteSettings) tasks.push(loadWorkflows(false));
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) toast(failed.reason?.message || t("刷新失败"), "error");
  }

  // 语言菜单：手机端放在设置页右上角，选中后整页文案原地刷新，不重新加载页面。
  function setupLanguageMenu() {
    const button = $("languageButton");
    const menu = $("languageMenu");
    const api = i18n();
    if (!button || !menu || !api) return;
    const close = () => {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    };
    const paint = () => {
      menu.replaceChildren();
      for (const item of api.locales) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "language-option";
        option.setAttribute("role", "menuitemradio");
        option.setAttribute("aria-checked", String(item.id === api.locale));
        option.textContent = item.label;
        option.addEventListener("click", async (event) => {
          event.stopPropagation();
          close();
          if (item.id === api.locale) return;
          await api.set(item.id);
          paint();
        });
        menu.append(option);
      }
    };
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.hidden) {
        paint();
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
      } else close();
    });
    menu.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", close);
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    paint();
  }

  // 语言变了只需重画「由脚本生成」的部分，静态标记由运行时统一处理。
  function applyLocaleChange() {
    if (lastSettingsStatus) renderSettingsSync(lastSettingsStatus);
    paintModelTools();
    paintGenerateButton();
    paintHistoryMore();
    renderHistory();
    renderPresetPanel();
    if (state.workflow) renderWorkflow(state.workflow);
  }

  function bindEvents() {
    setupLanguageMenu();
    i18n()?.onChange?.(() => applyLocaleChange());
    const content = document.querySelector(".main-content");
    const topbar = document.querySelector(".topbar");
    content?.addEventListener("scroll", () => {
      topbar?.classList.toggle("is-scrolled", content.scrollTop > 12);
    }, { passive: true });
    document.querySelectorAll(".nav-button").forEach((button) => {
      button.addEventListener("click", (event) => {
        // 大图刚关闭的瞬间，画面可能还没落帧，而关闭按钮正压在导航上方；
        // 此时落到导航上的点击是"第二下"误触，直接吞掉，不切页面。
        if (performance.now() < state.galleryCloseGuardUntil) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        showView(button.dataset.target);
      });
    });
    $("workflowSelect").addEventListener("change", (event) => loadWorkflow(event.target.value, true));
    $("sizePresetSelect").addEventListener("change", (event) => applySizePreset(event.target.value));
    $("closeModelPickerButton")?.addEventListener("click", () => $("modelPickerDialog")?.close());
    $("modelPickerDoneButton")?.addEventListener("click", () => $("modelPickerDialog")?.close());
    $("modelPickerSearch")?.addEventListener("input", renderModelPickerList);
    $("generationForm").addEventListener("submit", submitGeneration);
    bindGenerateSwipe();
    $("stopAllButton")?.addEventListener("click", () => { void stopAllJobs(); });
    $("closeDialogButton").addEventListener("click", () => $("jobDialog").close());
    $("retryJobButton").addEventListener("click", retryDialogJob);
    $("jobDialog").addEventListener("click", (event) => {
      if (event.target === $("jobDialog")) $("jobDialog").close();
    });

    const gallery = $("galleryDialog");
    // 关闭按钮：手指一抬就关，不等 click 事件。
    // 部分手机的浏览器（如开启"强制缩放"）会重新引入数百毫秒的点击延迟，
    // 只监听 click 会让用户觉得"点了没反应"，于是再补一下。
    let closeTapStart = null;
    const closeGalleryButton = $("closeGalleryButton");
    closeGalleryButton.addEventListener("pointerdown", (event) => {
      closeTapStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    closeGalleryButton.addEventListener("pointercancel", () => { closeTapStart = null; });
    closeGalleryButton.addEventListener("pointerup", (event) => {
      const start = closeTapStart;
      closeTapStart = null;
      if (!start || start.id !== event.pointerId) return;
      // 手指移动超过 12px 视为滑动，不当作点击
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;
      closeGalleryViewer();
    });
    // 键盘回车/空格等仍走 click；重复调用会被 closeGalleryViewer 自身的判断挡掉
    closeGalleryButton.addEventListener("click", () => closeGalleryViewer());
    $("deleteGalleryButton").addEventListener("click", deleteCurrentGalleryImage);
    $("closePresetTagButton").addEventListener("click", () => $("presetTagDialog").close());
    $("presetTagSaveButton").addEventListener("click", savePresetTagEditor);
    $("presetAddPoolButton").addEventListener("click", addPresetToPool);
    $("presetLockButton").addEventListener("click", () => {
      if (!state.presetEditing) return;
      const current = getSlotState(state.presetEditing.categoryId, state.presetEditing.slotId);
      if (!current.locked && current.value && !canSelectPresetTag(state.presetEditing.categoryId, state.presetEditing.slotId, current.value)) return;
      current.locked = !current.locked;
      markPresetConflicts();
      savePresetState();
      paintPresetEditorFlags();
      renderPresetPanel();
    });
    $("presetIgnoreButton").addEventListener("click", () => {
      if (!state.presetEditing) return;
      const current = getSlotState(state.presetEditing.categoryId, state.presetEditing.slotId);
      current.ignored = !current.ignored;
      markPresetConflicts();
      savePresetState();
      paintPresetEditorFlags();
      renderPresetPanel();
      applyPresetPrompt();
    });
    $("presetTagDialog").addEventListener("close", () => { state.presetEditing = null; });
    $("favoriteGalleryButton").addEventListener("click", toggleCurrentGalleryFavorite);
    $("copyGalleryButton").addEventListener("click", (event) => {
      event.stopPropagation();
      setGalleryCopyMenu($("galleryCopyMenu")?.hidden !== false);
    });
    $("galleryCopyMenu").addEventListener("click", (event) => event.stopPropagation());
    $("copyGalleryPrompt").addEventListener("click", async () => {
      setGalleryCopyMenu(false);
      try {
        await galleryJobRecord();
        restorePromptFromJob();
      } catch (error) {
        toast(error.message || t("无法复制提示词"), "error");
      }
    });
    $("copyGallerySeed").addEventListener("click", async () => {
      setGalleryCopyMenu(false);
      try {
        await galleryJobRecord();
        restoreSeedFromJob();
      } catch (error) {
        toast(error.message || t("无法复制种子"), "error");
      }
    });
    $("galleryDialog").addEventListener("click", () => setGalleryCopyMenu(false));
    $("galleryDialog").addEventListener("close", () => setGalleryCopyMenu(false));
    $("copyJobPrompt").addEventListener("click", restorePromptFromJob);
    $("copyJobSeed").addEventListener("click", restoreSeedFromJob);
    $("jobPromptText").addEventListener("click", (event) => {
      event.stopPropagation();
      if (!$("copyJobPrompt").disabled) $("jobPromptRow").classList.toggle("is-expanded");
    });
    $("jobDialog").addEventListener("click", (event) => {
      if (!event.target.closest("#jobPromptText")) $("jobPromptRow")?.classList.remove("is-expanded");
    });
    $("jobDialog").addEventListener("close", () => {
      state.jobDialogToken += 1;
      $("jobDialog").classList.remove("is-loading");
      $("jobPromptRow")?.classList.remove("is-expanded");
    });
    $("galleryPreviousButton").addEventListener("click", () => moveGallery(-1));
    $("galleryNextButton").addEventListener("click", () => moveGallery(1));
    gallery.addEventListener("click", (event) => {
      if (event.target === gallery) closeGalleryViewer();
    });
    const galleryStage = $("galleryStage");
    const galleryImage = $("galleryImage");
    const galleryZoom = state.galleryZoom || (state.galleryZoom = { scale: 1, x: 0, y: 0 });
    let galleryPinch = null;
    let galleryPan = null;
    let galleryLastTap = 0;
    let galleryLastTapX = 0;
    let galleryLastTapY = 0;
    let galleryMultiTouch = false;
    let galleryDrag = null;

    const applyGalleryZoom = () => {
      if (galleryZoom.scale <= 1.001) {
        galleryZoom.scale = 1;
        galleryZoom.x = 0;
        galleryZoom.y = 0;
        galleryImage.style.transform = "";
        return;
      }
      const maxX = galleryStage.clientWidth * (galleryZoom.scale - 1) / 2;
      const maxY = galleryStage.clientHeight * (galleryZoom.scale - 1) / 2;
      galleryZoom.x = Math.max(-maxX, Math.min(maxX, galleryZoom.x));
      galleryZoom.y = Math.max(-maxY, Math.min(maxY, galleryZoom.y));
      galleryImage.style.transform = `translate(${galleryZoom.x}px, ${galleryZoom.y}px) scale(${galleryZoom.scale})`;
    };

    const galleryZoomTo = (scale, px, py) => {
      galleryZoom.scale = scale;
      galleryZoom.x = px * (1 - scale);
      galleryZoom.y = py * (1 - scale);
      galleryImage.style.transition = "transform 200ms ease-out";
      applyGalleryZoom();
      setTimeout(() => { galleryImage.style.transition = ""; }, 220);
    };

    const galleryResetZoom = () => {
      galleryZoom.scale = 1;
      galleryZoom.x = 0;
      galleryZoom.y = 0;
      galleryImage.style.transition = "transform 200ms ease-out";
      galleryImage.style.transform = "";
      setTimeout(() => { galleryImage.style.transition = ""; }, 220);
    };

    const galleryGap = 18;

    const gallerySetX = (el, x) => {
      el.style.transform = x === 0 ? "" : `translateX(${x}px)`;
    };

    // 翻页时相邻两张图会作为图层滑进来。新生成的图还没下载完，
    // 浏览器会先画已解码的那部分（常见是上面一小条或半张），
    // 松手后又立刻被"加载中"盖住，看起来就是闪一下半张图。
    // 所以图层加载完成前一律不显示，加载好了再露出来。
    const galleryMakeGhost = (src) => {
      const ghost = document.createElement("img");
      ghost.alt = "";
      ghost.className = "gallery-ghost is-pending";
      ghost.draggable = false;
      const reveal = () => ghost.classList.remove("is-pending");
      ghost.addEventListener("load", reveal, { once: true });
      galleryStage.append(ghost);
      ghost.src = src;
      // 命中缓存时 load 可能已经错过，直接按当前状态补齐。
      if (ghost.complete && ghost.naturalWidth > 0) reveal();
      return ghost;
    };

    const galleryStartDrag = (touch) => {
      const width = galleryStage.clientWidth;
      const index = state.galleryIndex;
      const items = state.galleryItems;
      const layers = [];
      if (index > 0) layers.push({ el: galleryMakeGhost(mediaUrl(items[index - 1])), item: index - 1, base: -(width + galleryGap) });
      layers.push({ el: galleryImage, item: index, base: 0 });
      if (index < items.length - 1) layers.push({ el: galleryMakeGhost(mediaUrl(items[index + 1])), item: index + 1, base: width + galleryGap });
      layers.forEach((layer) => {
        layer.el.style.transition = "none";
        gallerySetX(layer.el, layer.base);
      });
      $("galleryStage")?.classList.remove("is-loading");
      galleryDrag = {
        startX: touch.clientX,
        startY: touch.clientY,
        width,
        index,
        hasPrev: index > 0,
        hasNext: index < items.length - 1,
        layers,
        applied: 0,
        decided: false,
        horizontal: true,
        samples: [{ t: performance.now(), x: touch.clientX }],
      };
      state.galleryDragActive = true;
    };

    const galleryCancelDrag = (drag) => {
      drag.layers.forEach((layer) => {
        if (layer.el !== galleryImage) layer.el.remove();
        gallerySetX(layer.el, layer.base);
      });
      galleryImage.style.transform = "";
      state.galleryDragActive = false;
    };

    const galleryTrackDrag = (touch) => {
      const drag = galleryDrag;
      if (!drag) return;
      const raw = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;
      if (!drag.decided) {
        if (Math.abs(raw) < 8 && Math.abs(dy) < 8) return;
        drag.decided = true;
        drag.horizontal = Math.abs(raw) >= Math.abs(dy);
        if (!drag.horizontal) {
          galleryCancelDrag(drag);
          galleryDrag = null;
          return;
        }
      }
      if (!drag.horizontal) return;
      const hasNeighbor = raw > 0 ? drag.hasPrev : drag.hasNext;
      drag.applied = hasNeighbor ? raw : raw * 0.3;
      drag.layers.forEach((layer) => gallerySetX(layer.el, layer.base + drag.applied));
      drag.samples.push({ t: performance.now(), x: touch.clientX });
      if (drag.samples.length > 6) drag.samples.shift();
    };

    const gallerySettleDrag = () => {
      const drag = galleryDrag;
      galleryDrag = null;
      if (!drag) return;
      if (galleryZoom.scale > 1 || !drag.layers.length) {
        drag.layers.forEach((layer) => {
          if (layer.el !== galleryImage) layer.el.remove();
        });
        state.galleryDragActive = false;
        return;
      }
      let vx = 0;
      const now = performance.now();
      const samples = drag.samples.filter((sample) => now - sample.t <= 120);
      if (samples.length >= 2) {
        const dt = samples[samples.length - 1].t - samples[0].t;
        if (dt > 0) vx = (samples[samples.length - 1].x - samples[0].x) / dt;
      }
      let target = drag.index;
      if (vx < -0.5 && drag.hasNext) target = drag.index + 1;
      else if (vx > 0.5 && drag.hasPrev) target = drag.index - 1;
      else if (drag.applied <= -drag.width / 2 && drag.hasNext) target = drag.index + 1;
      else if (drag.applied >= drag.width / 2 && drag.hasPrev) target = drag.index - 1;
      const changed = target !== drag.index;
      const animations = [];
      drag.layers.forEach((layer) => {
        const from = layer.base + drag.applied;
        const to = (layer.item - target) * (drag.width + galleryGap);
        if (Math.abs(to - from) < 1) {
          gallerySetX(layer.el, to);
          return;
        }
        const anim = layer.el.animate(
          [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
          { duration: 240, easing: "cubic-bezier(0.22, 0.7, 0.3, 1)" },
        );
        animations.push(anim.finished.catch(() => {}));
      });
      Promise.all(animations).then(() => {
        if (changed) {
          const incoming = drag.layers.find((layer) => layer.item === target);
          const nextUrl = mediaUrl(state.galleryItems[target]);
          const ready = galleryUrlCached(nextUrl) || Boolean(incoming?.el?.complete && incoming.el.naturalWidth > 0);
          state.galleryIndex = target;
          galleryImage.style.transform = "";
          if (ready) {
            galleryImage.src = incoming?.el?.currentSrc || incoming?.el?.src || nextUrl;
            galleryImage.classList.add("is-ready");
            renderGalleryItem({ keepPainted: true });
          } else {
            galleryImage.classList.remove("is-ready");
            galleryImage.removeAttribute("src");
            renderGalleryItem({ keepPainted: false });
          }
        } else {
          galleryImage.style.transform = "";
        }
        drag.layers.forEach((layer) => {
          if (layer.el !== galleryImage) layer.el.remove();
        });
        state.galleryDragActive = false;
        if (changed) maybeLoadMoreForGallery();
      });
    };

    galleryStage.addEventListener("touchstart", (event) => {
      if (event.target.closest("button")) return;
      galleryImage.style.transition = "";
      if (event.touches.length === 2) {
        galleryMultiTouch = true;
        if (galleryDrag) {
          galleryCancelDrag(galleryDrag);
          galleryDrag = null;
        }
        const [a, b] = event.touches;
        galleryPinch = {
          dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
          scale: galleryZoom.scale,
          cx: (a.clientX + b.clientX) / 2,
          cy: (a.clientY + b.clientY) / 2,
          x: galleryZoom.x,
          y: galleryZoom.y,
        };
        galleryPan = null;
        state.galleryTouchStart = null;
        event.preventDefault();
      } else if (event.touches.length === 1) {
        galleryMultiTouch = false;
        const touch = event.touches[0];
        if (galleryZoom.scale > 1) {
          galleryPan = { x: touch.clientX, y: touch.clientY };
          event.preventDefault();
        } else if (!state.galleryDragActive && !galleryAnimating) {
          galleryStartDrag(touch);
        }
        state.galleryTouchStart = { x: touch.clientX, y: touch.clientY };
      }
    }, { passive: false });

    galleryStage.addEventListener("touchmove", (event) => {
      if (galleryPinch && event.touches.length === 2) {
        const [a, b] = event.touches;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        galleryZoom.scale = Math.max(1, Math.min(6, galleryPinch.scale * (dist / galleryPinch.dist)));
        galleryZoom.x = galleryPinch.x + (a.clientX + b.clientX) / 2 - galleryPinch.cx;
        galleryZoom.y = galleryPinch.y + (a.clientY + b.clientY) / 2 - galleryPinch.cy;
        applyGalleryZoom();
        event.preventDefault();
      } else if (galleryPan && event.touches.length === 1) {
        const touch = event.touches[0];
        galleryZoom.x += touch.clientX - galleryPan.x;
        galleryZoom.y += touch.clientY - galleryPan.y;
        galleryPan = { x: touch.clientX, y: touch.clientY };
        applyGalleryZoom();
        event.preventDefault();
      } else if (galleryDrag && event.touches.length === 1) {
        galleryTrackDrag(event.touches[0]);
        event.preventDefault();
      }
    }, { passive: false });

    galleryStage.addEventListener("touchend", (event) => {
      if (event.touches.length < 2) galleryPinch = null;
      if (event.touches.length === 0) galleryPan = null;
      if (galleryZoom.scale <= 1.001) {
        galleryZoom.scale = 1;
        galleryZoom.x = 0;
        galleryZoom.y = 0;
        galleryImage.style.transform = "";
      }
      const start = state.galleryTouchStart;
      const touch = event.changedTouches[0];
      state.galleryTouchStart = null;
      if (!touch) {
        if (event.touches.length === 0) gallerySettleDrag();
        return;
      }
      if (event.touches.length === 0 && !galleryMultiTouch && start) {
        const deltaY = touch.clientY - start.y;
        const now = performance.now();
        if (Math.hypot(touch.clientX - start.x, deltaY) < 24) {
          if (now - galleryLastTap < 320 && Math.hypot(touch.clientX - galleryLastTapX, touch.clientY - galleryLastTapY) < 40) {
            galleryLastTap = 0;
            if (galleryZoom.scale > 1) galleryResetZoom();
            else {
              const rect = galleryStage.getBoundingClientRect();
              galleryZoomTo(3, touch.clientX - (rect.left + rect.width / 2), touch.clientY - (rect.top + rect.height / 2));
            }
          } else {
            galleryLastTap = now;
            galleryLastTapX = touch.clientX;
            galleryLastTapY = touch.clientY;
          }
        }
      }
      if (event.touches.length === 0) {
        gallerySettleDrag();
        galleryMultiTouch = false;
      }
    }, { passive: false });
    gallery.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveGallery(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveGallery(1);
      }
    });

    window.addEventListener("online", () => refreshAll());
    window.addEventListener("offline", () => {
      state.online = false;
      setText("connectionLabel", t("网络断开"));
    });

    const grid = $("historyGrid");
    // 滑到底自动加载更早的记录：直接盯着「加载更早的」那颗按钮 ——
    // 不管滚动的是 .main-content 还是 window，它露出来就说明到底了。
    // 按钮留在原地当兜底：自动加载失败或者被节流时还能手动点。
    const moreButton = historyMoreButton();
    if (moreButton && typeof IntersectionObserver === "function") {
      new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (state.jobsMoreLoading || !historyHasMore()) return;
        loadMoreJobs().catch(() => {});
      }, { rootMargin: "200px 0px" }).observe(moreButton);
    }
    const layoutButton = $("historyLayoutButton");
    const favoritesButton = $("historyFavoritesButton");
    try {
      state.favoritesOnly = phoneSettings.getItem("comfy-mobile-remote.favoritesOnly") === "1";
    } catch { /* storage optional */ }
    const applyFavoritesOnly = () => {
      favoritesButton.classList.toggle("active", state.favoritesOnly);
      favoritesButton.setAttribute("aria-pressed", state.favoritesOnly ? "true" : "false");
      favoritesButton.setAttribute("aria-label", state.favoritesOnly ? t("显示全部照片") : t("只看收藏"));
      favoritesButton.title = state.favoritesOnly ? t("显示全部照片") : t("只看收藏");
      renderHistory();
    };
    favoritesButton.addEventListener("click", () => {
      state.favoritesOnly = !state.favoritesOnly;
      try {
        phoneSettings.setItem("comfy-mobile-remote.favoritesOnly", state.favoritesOnly ? "1" : "0");
      } catch { /* storage optional */ }
      applyFavoritesOnly();
      // Fetch the filtered first page immediately; waiting for the 8s
      // fallback poll makes opening 收藏 look broken.
      loadJobs(true).catch(() => {});
    });
    applyFavoritesOnly();
    const applyHistoryCols = (cols) => {
      grid.classList.remove("cols-3", "cols-4");
      if (cols !== 2) grid.classList.add(`cols-${cols}`);
      layoutButton.title = t("切换列数（当前 {cols} 列）", { cols: cols });
      layoutButton.setAttribute("aria-label", t("切换列数，当前 {cols} 列", { cols: cols }));
    };
    let initialHistoryCols = Number(phoneSettings.getItem("comfy-mobile-remote.historyCols")) || 2;
    state.historyCols = [2, 3, 4].includes(initialHistoryCols) ? initialHistoryCols : 2;
    applyHistoryCols(state.historyCols);
    layoutButton.addEventListener("click", () => {
      state.historyCols = state.historyCols >= 4 ? 2 : state.historyCols + 1;
      phoneSettings.setItem("comfy-mobile-remote.historyCols", String(state.historyCols));
      applyHistoryCols(state.historyCols);
    });

    document.addEventListener("gesturestart", (event) => event.preventDefault());
    document.addEventListener("gesturechange", (event) => event.preventDefault());
  }

  function applyPhonePreferences() {
    state.randomGenerate = phoneSettings.getItem("comfy-mobile-remote.randomGenerate") === "1";
    state.multiModel = phoneSettings.getItem("comfy-mobile-remote.multiModel") === "1";
    state.fixedSeed = phoneSettings.getItem("comfy-mobile-remote.fixedSeed") === "1";
    const repeat = Number(phoneSettings.getItem("comfy-mobile-remote.repeatCount") || 1);
    state.repeatCount = state.multiModel ? 1 : (Number.isInteger(repeat) ? Math.max(1, Math.min(10, repeat)) : 1);
    paintModelTools();
    paintGenerateButton();
    const previousFavoritesOnly = state.favoritesOnly;
    state.favoritesOnly = phoneSettings.getItem("comfy-mobile-remote.favoritesOnly") === "1";
    const favoriteButton = $("historyFavoritesButton");
    favoriteButton.classList.toggle("active", state.favoritesOnly);
    favoriteButton.setAttribute("aria-pressed", String(state.favoritesOnly));
    favoriteButton.setAttribute("aria-label", state.favoritesOnly ? t("显示全部照片") : t("只看收藏"));
    favoriteButton.title = state.favoritesOnly ? t("显示全部照片") : t("只看收藏");
    const cols = Number(phoneSettings.getItem("comfy-mobile-remote.historyCols") || 2);
    state.historyCols = [2, 3, 4].includes(cols) ? cols : 2;
    const grid = $("historyGrid");
    grid.classList.toggle("cols-3", state.historyCols === 3);
    grid.classList.toggle("cols-4", state.historyCols === 4);
    const layoutButton = $("historyLayoutButton");
    layoutButton.title = t("切换列数（当前 {historyCols} 列）", { historyCols: state.historyCols });
    layoutButton.setAttribute("aria-label", t("切换列数，当前 {historyCols} 列", { historyCols: state.historyCols }));
    renderHistory();
    if (previousFavoritesOnly !== state.favoritesOnly) loadJobs(true).catch(() => {});
  }

  async function applySharedSettings() {
    applyingRemoteSettings = true;
    try {
      loadPresetState();
      applyPhonePreferences();
      $("workflowSelect").value = "";
      await loadWorkflows(true);
    } finally {
      applyingRemoteSettings = false;
      const button = $("generateButton");
      if (button && !submittingBatch) button.disabled = false;
    }
  }

  let settingsRefreshPromise = null;
  async function refreshSharedSettings() {
    if (settingsRefreshPromise) return settingsRefreshPromise;
    if (submittingBatch || applyingRemoteSettings || phoneSettings.dirty) return;
    settingsRefreshPromise = (async () => {
      try {
        if (await phoneSettings.refresh()) await applySharedSettings();
      } finally { settingsRefreshPromise = null; }
    })();
    return settingsRefreshPromise;
  }

  async function chooseSettingsVersion(choice) {
    if (submittingBatch || applyingRemoteSettings) return;
    const buttons = [$("useComputerSettingsButton"), $("keepPhoneSettingsButton")];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await phoneSettings.resolveConflict(choice);
      await applySharedSettings();
    } catch (error) {
      toast(error.message || t("设置读取失败，请稍后重试"), "error");
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function start() {
    try {
      // 词典没到位就先渲染的话，用户会先看到一闪而过的中文原文。
      await globalThis.MobileI18nReady?.catch?.(() => {});
      await phoneSettings.init();
      try {
        await loadPresetCatalog();
      } catch (error) {
        state.presetEnabled = false;
        toast(error.message || t("标签目录读取失败"), "error");
      }
      bindEvents();
      setupAdvancedPage();
      applyPhonePreferences();
      connectWebSocket();
      await refreshAll();
      $("useComputerSettingsButton").addEventListener("click", () => chooseSettingsVersion("server"));
      $("keepPhoneSettingsButton").addEventListener("click", () => chooseSettingsVersion("local"));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        refreshSharedSettings().catch(() => {});
        // 原来靠顶栏的「刷新」按钮手动重读电脑端打开中的工作流列表；按钮已删除，
        // 改成回到页面就自动重读。
        if (!submittingBatch && !applyingRemoteSettings) loadWorkflows(false).catch(() => {});
      });
      window.setInterval(() => loadStatus().catch(() => {}), 5000);
      // 队列/历史列表：websocket 事件会即时触发刷新，这里只做兜底轮询，
      // 所以放慢到 8 秒——这个接口在任务多时要几百毫秒到几秒，太勤会把服务器占满。
      window.setInterval(() => loadJobs().catch(() => {}), 8000);
      window.setInterval(() => loadProgress().catch(() => {}), 1000);
    } catch (error) {
      toast(error.message || t("页面启动失败"), "error");
    } finally {
      const button = $("generateButton");
      if (button && !submittingBatch) button.disabled = false;
    }
  }

  start();
})();
