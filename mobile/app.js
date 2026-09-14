(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  // 关闭大图后短暂屏蔽底部导航：关闭按钮正压在「设置」标签正上方，
  // 若画面尚未落帧，用户的第二下点击会穿透到导航并误切页面。
  const GALLERY_CLOSE_GUARD_MS = 450;
  const state = {
    online: false,
    status: null,
    workflows: [],
    workflow: null,
    values: {},
    jobs: [],
    totalJobs: 0,
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
    galleryItems: [],
    galleryIndex: 0,
    galleryJobId: "",
    galleryLoadToken: 0,
    galleryCloseGuardUntil: 0,
    jobDialogToken: 0,
    gallerySeenUrls: new Set(),
    favoritesOnly: false,
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
  const phoneSettings = new window.MobileSettingsSync({ onStatus: renderSettingsSync });

  function renderSettingsSync(status) {
    const saved = status.savedAt ? new Date(status.savedAt) : null;
    const time = saved ? `${String(saved.getHours()).padStart(2, "0")}：${String(saved.getMinutes()).padStart(2, "0")}` : "";
    const labels = { loading: "读取设置", pending: "待同步", saving: "同步中", offline: "未同步", conflict: "设置冲突" };
    const label = status.state === "synced" ? (time ? `${time}已同步` : "尚未同步") : (labels[status.state] || "待同步");
    const element = $("settingsSyncLabel");
    if (element) {
      element.textContent = label;
      element.dataset.state = status.state;
      element.title = status.error || (time ? `最近保存于 ${time}；新修改满一分钟后合并上传` : "新修改满一分钟后合并上传");
    }
    setText("settingsSyncDetail", label);
    $("settingsSyncConflict")?.classList.toggle("hidden", status.state !== "conflict");
    if (status.catalogInvalid) {
      if (element) element.title = "电脑上的标签目录损坏，其它设置仍会同步；未上传的标签改动会留在本机";
      if (!catalogInvalidNotified) {
        catalogInvalidNotified = true;
        toast("电脑标签目录损坏，其它设置仍会同步", "error");
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
    queue: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-8 4-4 4 4M5 21h14"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
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

  function formatTime(value) {
    const timestamp = Number(value || 0);
    if (!timestamp) return "时间未知";
    const date = new Date(timestamp);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return sameDay ? `今天 ${time}` : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }

  function describeError(body, fallback = "请求失败") {
    if (!body) return fallback;
    if (typeof body.error === "string") return body.error;
    if (body.error?.message) return body.error.message;
    if (typeof body.details === "string") return body.details;
    if (body.details?.error?.message) return body.details.error.message;
    if (body.details?.error?.details) return body.details.error.details;
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
    item.textContent = String(message || "").replace(/[，。、；：！？,.!?;:…—·“”‘’"'（）()[\]《》【】]/g, "").trim();
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
    if (target === "queue" || target === "history") loadJobs().catch(() => {});
  }

  function uiVersion() {
    const src = document.querySelector('script[src*="app.js"]')?.src || "";
    const match = /[?&]v=([^&]+)/.exec(src);
    return match ? match[1] : "未知";
  }

  function renderStatus(status) {
    state.status = status;
    state.online = Boolean(status?.online);
    setText("connectionLabel", state.online ? "已连接" : "离线");
    setText("runningCount", status?.running ?? 0);
    setText("pendingCount", status?.pending ?? 0);

    const gpu = status?.gpu || {};
    const gpuName = gpu.name || "GPU 状态未知";
    const memory = gpu.total ? `${formatBytes(gpu.used)} / ${formatBytes(gpu.total)}` : "";
    setText("settingsGpu", memory ? `${gpuName} · ${memory}` : gpuName);
    setText("pluginVersion", `${status?.version || "-"} · 界面 ${uiVersion()}`);
    setText("currentAddress", `${location.origin}/mobile`);
    setText("tailscaleAddress", status?.mobile_urls?.[0] || "未检测到");

    const activeCount = Number(status?.running || 0) + Number(status?.pending || 0);
    const badge = $("queueBadge");
    badge.textContent = activeCount > 99 ? "99+" : String(activeCount);
    badge.classList.toggle("hidden", activeCount === 0);
  }

  async function loadStatus() {
    try {
      const body = await requestJson(`/mobile/api/status?_=${Date.now()}`);
      renderStatus(body);
    } catch {
      state.online = false;
      setText("connectionLabel", "连接失败");
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
    const defaults = Object.fromEntries(fields.map((field) => [field.id, field.value]));
    try {
      const saved = JSON.parse(phoneSettings.getItem(draftKey(workflow.id)) || "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const field of fields) {
          if (Object.hasOwn(saved, field.id)) defaults[field.id] = saved[field.id];
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
    label.textContent = field.label;
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
      const first = names[0] || "选择模型";
      picker.textContent = names.length > 1 ? `${first} · ${names.length}个` : first;
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
    if (count) count.textContent = `已选 ${selected.size} 个`;
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
      makeMiniToggle("multiModelToggle", "多模型", setMultiModel),
      makeMiniToggle("fixedSeedToggle", "单次种子固定", setFixedSeed),
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
    decrement.setAttribute("aria-label", `${field.label}减小`);

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
    increment.setAttribute("aria-label", `${field.label}增大`);

    let randomButton = null;
    const paint = () => {
      const random = state.values[field.id] === "__random__";
      input.disabled = random;
      input.value = random ? "" : state.values[field.id] ?? field.value;
      if (randomButton) {
        randomButton.classList.toggle("active", random);
        randomButton.textContent = "随机";
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
        randomButton.textContent = "随机";
      }
    };

    randomButton = document.createElement("button");
    randomButton.type = "button";
    randomButton.className = "random-button";
    randomButton.setAttribute("aria-label", `${field.label}随机开关`);
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
    const paint = () => { value.textContent = input.checked ? "已开启" : "已关闭"; };
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
    upload.innerHTML = `${ICONS.upload}<span>上传</span>`;
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.setAttribute("aria-label", `上传${field.label}`);
    upload.append(file);

    const preview = document.createElement("img");
    preview.className = "image-field-preview hidden";
    preview.alt = field.label;
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
        if (!response.ok || !body.name) throw new Error(describeError(body, "图片上传失败"));
        const next = [body.subfolder, body.name].filter(Boolean).join("/");
        input.value = next;
        updateFieldValue(field, next);
        paintPreview();
        toast("图片已上传", "success");
      } catch (error) {
        toast(error.message || "图片上传失败", "error");
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

  function renderField(field, index, compact = false) {
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
    state.fieldControls.set(field.id, control);
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
      const response = await fetch("/mobile/assets/prompt-presets.json?v=202609221", { cache: "no-store" });
      if (!response.ok) throw new Error("标签目录读取失败");
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
    toast("这个标签与已选标签互斥，请先取消冲突标签", "error");
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
      hint.textContent = "点分类名随机，点标签修改";
      const randomButton = document.createElement("button");
      randomButton.type = "button";
      randomButton.className = "preset-random-button";
      randomButton.textContent = "随机";
      randomButton.addEventListener("click", () => randomizePresetSlots());
      bar.append(hint, randomButton);

      const customWrap = document.createElement("details");
      customWrap.className = "advanced-section preset-custom";
      const summary = document.createElement("summary");
      const customLabel = document.createElement("span");
      customLabel.textContent = "自定义";
      const customHint = document.createElement("span");
      customHint.className = "preset-custom-hint";
      customHint.textContent = "此处输入文字会注入在提示词最后";
      summary.append(customLabel, customHint);
      summary.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>');
      const customInput = document.createElement("textarea");
      customInput.id = "presetCustomText";
      customInput.rows = 2;
      customInput.placeholder = "额外要加进提示词的文字";
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
      label.textContent = category.label;
      label.setAttribute("aria-label", `随机${category.label}`);
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
          sep.textContent = "、";
          values.append(sep);
        }
        const current = getSlotState(category.id, slot.id);
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "preset-chip";
        const val = current.value || "未选";
        const status = presetTagStatus(category.id, slot.id, current.value);
        const conflict = conflicts.has(slotStorageKey(category.id, slot.id));
        if (val.length <= 2) chip.classList.add("no-ellipsis");
        if (status === "deleted") chip.classList.add("deleted");
        if (status === "free") chip.classList.add("free");
        if (conflict) chip.classList.add("conflict");
        if ((category.slots || []).length >= 3) chip.classList.add("tight");
        if (current.locked) chip.classList.add("locked");
        if (current.ignored) chip.classList.add("ignored");
        chip.textContent = status === "deleted" ? `${val}（已删除）` : val;
        chip.title = [
          status === "deleted" ? "当前标签已从目录删除，但仍保留在提示词中" : "",
          status === "free" ? "自由标签" : "",
          conflict ? "与其他已选标签互斥，请编辑其中一个" : "",
        ].filter(Boolean).join("；");
        chip.setAttribute("aria-label", `编辑${category.label}${slot.label}${status === "deleted" ? "，已删除" : ""}${conflict ? "，存在互斥" : ""}`);
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
    $("presetLockButton").textContent = current.locked ? "已锁定" : "锁定";
    $("presetIgnoreButton").textContent = current.ignored ? "已忽略" : "忽略";
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
      chip.textContent = status === "deleted" ? `${item}（已删除）` : item;
      chip.title = status === "deleted" ? "已删除，仅用于恢复当前提示词" : "选择此标签";
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
        remove.title = "删除自定义标签";
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
    toast(added ? "已加入备选" : "已选择标签");
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
      switchLabel.title = "标签预设";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = "presetModeToggle";
      input.checked = state.presetEnabled;
      input.setAttribute("aria-label", "标签预设");
      const visual = document.createElement("span");
      visual.setAttribute("aria-hidden", "true");
      input.addEventListener("change", () => setPresetEnabled(input.checked));
      switchLabel.append(input, visual);
      const wrap = document.createElement("span");
      wrap.className = "preset-toggle-wrap";
      const caption = document.createElement("span");
      caption.className = "preset-toggle-caption";
      caption.textContent = "标签模式";
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
      && field !== seed            // batch/seed 由固定的「批量数量+种子」行渲染，不能再进普通列表
      && !isModelField(field)
      && field.group !== "basic"   // 服务端标为 basic 的（提示词/模型/尺寸）必须留在外面
    ));
    const trio = advancedBase.filter((field) => ["steps", "cfg", "denoise"].includes(field.input));
    const advanced = advancedBase.filter((field) => !trio.includes(field));
    const basic = fields.filter((field) => (
      !isNegativeField(field)
      && !isSizeField(field)
      && field !== batch
      && field !== seed
      && !isModelField(field)
      && !advancedBase.includes(field)
    ));
    const fieldIndex = (field) => fields.indexOf(field);

    $("basicFields").replaceChildren(...basic.map((field) => renderField(field, fieldIndex(field))));
    $("negativeFields").replaceChildren(...negative.map((field) => renderField(field, fieldIndex(field))));
    $("sizeFields").replaceChildren(...size.map((field) => renderField(field, fieldIndex(field), true)));

    const advancedNodes = [];
    const advancedContent = document.querySelector("#advancedSection .advanced-content");
    if (batch && seed) {
      const pairRow = document.createElement("div");
      pairRow.className = "pair-row";
      [{ field: batch, build: makeNumber }, { field: seed, build: makeSeedRow }].forEach(({ field, build }) => {
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
    } else {
      [batch, seed].filter(Boolean).forEach((field) => {
        advancedNodes.push(renderField(field, fieldIndex(field)));
      });
    }
    if (trio.length) {
      const trioRow = document.createElement("div");
      trioRow.className = "trio-row";
      trio.forEach((field) => trioRow.append(renderField(field, fieldIndex(field), true)));
      // 固定顺序第 2 位：采样步数 / CFG / 重绘幅度，排在「选择工作流」之前
      const pickerForTrio = advancedContent?.querySelector("#workflowPickerField");
      if (advancedContent && pickerForTrio) pickerForTrio.before(trioRow);
      else advancedNodes.push(trioRow);
    }
    // 固定顺序第 3 位是「选择工作流」（静态元素），之后依次是采样器、调度器，再是其余
    const advancedRank = (field) => (field.input === "sampler_name" ? 0 : field.input === "scheduler" ? 1 : 2);
    const orderedAdvanced = advanced.slice().sort((left, right) => advancedRank(left) - advancedRank(right));
    advancedNodes.push(...orderedAdvanced.map((field) => renderField(field, fieldIndex(field))));
    if (!state.workflowPickerEl) {
      state.workflowPickerEl = document.getElementById("workflowPickerField");
    }
    if (state.workflowPickerEl) {
      const schedulerIdx = advanced.findIndex((field) => field.input === "scheduler");
      const insertAt = schedulerIdx === -1 ? advancedNodes.length : (trio.length ? 1 : 0) + schedulerIdx + 1;
      advancedNodes.splice(insertAt, 0, state.workflowPickerEl);
    }
    $("advancedFields").replaceChildren(...advancedNodes);
    $("modelFields").replaceChildren(...model.map((field) => renderField(field, fieldIndex(field))));

    $("negativeSection").classList.toggle("hidden", negative.length === 0);
    $("modelFields").classList.toggle("hidden", model.length === 0);
    $("sizeSection").classList.toggle("hidden", size.length === 0);
    $("primaryFields").classList.add("hidden");
    $("advancedSection").classList.remove("hidden");
    setText("advancedCount", advanced.length + trio.length + 1 + (batch ? 1 : 0) + (seed ? 1 : 0));
    setText("workflowMeta", `${workflow.node_count} 个节点 · ${fields.length} 个可调参数`);
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
    setText("workflowMeta", "正在读取参数");
    try {
      const body = await requestJson(`/mobile/api/workflows/${encodeURIComponent(workflowId)}?_=${Date.now()}`);
      if (token !== state.workflowLoadToken) return;
      hydratingSettings += 1;
      try {
        state.presetField = null;
        state.presetTextarea = null;
        state.presetPanel = null;
        renderWorkflow(body.workflow);
      } finally {
        hydratingSettings -= 1;
      }
      if (remember) phoneSettings.setItem("comfy-mobile-remote.workflow", workflowId);
    } catch (error) {
      if (token !== state.workflowLoadToken) return;
      state.workflow = null;
      $("generationForm").classList.add("hidden");
      setText("workflowMeta", error.message);
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
      option.textContent = "暂无工作流";
      select.append(option);
      $("workflowEmpty").classList.remove("hidden");
      $("generationForm").classList.add("hidden");
      setText("workflowMeta", "");
      state.workflow = null;
      return;
    }

    state.workflows.forEach((workflow) => {
      const option = document.createElement("option");
      option.value = workflow.id;
      option.textContent = workflow.name;
      select.append(option);
    });
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
    if (type.includes("video") || /\.(mp4|webm|mov|mkv|gif)$/.test(filename)) return "video";
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
      image.alt = compact ? "" : "生成结果";
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
    pending: "排队中",
    in_progress: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已停止",
  };

  function jobStatusLabel(status) {
    return STATUS_LABELS[status] || status || "未知";
  }

  async function cancelJob(jobId) {
    try {
      await requestJson(`/mobile/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
      toast("任务已停止", "success");
      state.progress.delete(jobId);
      await Promise.all([loadStatus(), loadJobs()]);
    } catch (error) {
      toast(error.message, "error");
    }
  }

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
    const label = job.status === "pending" ? "等待执行"
      : progress?.displayId && progress.displayId !== "sampling" ? nodeDisplayName(progress.displayId)
      : "正在处理";
    return { percent, text: percent == null ? "—" : `${Math.round(percent)}%`, label };
  }

  function paintQueueProgress(card, jobId) {
    const display = progressDisplay({ id: jobId, status: "in_progress" });
    const fill = card.querySelector(".job-progress-fill");
    const label = card.querySelector(".job-progress-label");
    const percent = card.querySelector(".job-progress-percent");
    const bar = card.querySelector(".job-progress-bar");
    if (!fill) return;
    fill.style.width = `${display.percent ?? 0}%`;
    if (label) label.textContent = display.label;
    if (percent) percent.textContent = display.text;
    if (bar) {
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", display.label);
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      if (display.percent == null) bar.removeAttribute("aria-valuenow");
      else bar.setAttribute("aria-valuenow", String(Math.round(display.percent)));
    }
  }

  function updateQueueCard(card, job) {
    card.dataset.jobId = String(job.id);
    card.className = `job-card is-${job.status}`;
    const thumb = card.querySelector(".job-thumb");
    const title = card.querySelector(".job-copy strong");
    const time = card.querySelector(".job-copy > span");
    const status = card.querySelector(".job-status");
    if (thumb) thumb.innerHTML = job.status === "in_progress" ? ICONS.image : ICONS.queue;
    if (title) title.textContent = job.workflow_name || "电脑端任务";
    if (time) time.textContent = formatTime(job.create_time);
    if (status) {
      status.className = `job-status ${job.status}`;
      status.textContent = jobStatusLabel(job.status);
    }
    let progressWrap = card.querySelector(".job-progress-wrap");
    if (job.status === "in_progress") {
      if (!progressWrap) {
        progressWrap = document.createElement("div");
        progressWrap.className = "job-progress-wrap";
        progressWrap.innerHTML = '<div class="job-progress-bar"><div class="job-progress-fill"></div></div><div class="job-progress-meta"><span class="job-progress-label">正在执行</span><span class="job-progress-percent">0%</span></div>';
        card.querySelector(".job-copy")?.append(progressWrap);
      }
      paintQueueProgress(card, job.id);
    } else {
      progressWrap?.remove();
    }
  }

  function buildQueueCard(job) {
    const card = document.createElement("article");
    const thumb = document.createElement("div");
    thumb.className = "job-thumb";
    const copy = document.createElement("div");
    copy.className = "job-copy";
    const title = document.createElement("strong");
    const time = document.createElement("span");
    copy.append(title, time);
    const actions = document.createElement("div");
    actions.className = "job-actions";
    const status = document.createElement("span");
    status.className = "job-status";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "icon-button";
    cancel.setAttribute("aria-label", "停止任务");
    cancel.title = "停止任务";
    cancel.innerHTML = ICONS.stop;
    cancel.addEventListener("click", () => cancelJob(job.id));
    actions.append(status, cancel);
    card.append(thumb, copy, actions);
    updateQueueCard(card, job);
    return card;
  }

  function renderQueue() {
    const jobs = visibleQueueJobs();
    setText("queueTotal", `${jobs.length} 个任务`);
    $("queueEmpty").classList.toggle("hidden", jobs.length !== 0);
    const list = $("queueList");
    const current = new Map([...list.querySelectorAll(".job-card")].map((card) => [card.dataset.jobId, card]));
    const wanted = new Set();
    jobs.forEach((job, index) => {
      const id = String(job.id);
      wanted.add(id);
      const card = current.get(id) || buildQueueCard(job);
      if (current.has(id)) updateQueueCard(card, job);
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    });
    current.forEach((card, id) => { if (!wanted.has(id)) card.remove(); });
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
    if (!jobId) throw new Error("找不到这张图的任务");
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
      toast("历史目录已变化，已按原始提示词恢复", "success");
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
    toast("已还原提示词");
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
    toast("已还原种子");
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
    image.alt = `生成结果，第 ${state.galleryIndex + 1} 张，共 ${total} 张`;
    if (image.complete && image.naturalWidth > 0) finish(true);
    const zoom = state.galleryZoom;
    if (zoom && !keepPainted) {
      zoom.scale = 1;
      zoom.x = 0;
      zoom.y = 0;
      image.style.transform = "";
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
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute("aria-label", active ? "取消收藏" : "收藏这张图");
    button.title = active ? "取消收藏" : "收藏";
  }

  async function toggleCurrentGalleryFavorite() {
    const item = state.galleryItems[state.galleryIndex];
    const jobId = currentGalleryJobId();
    if (!item?.filename || !jobId) {
      toast("这张图不能收藏", "error");
      return;
    }
    const previous = Boolean(item.favorite);
    item.favorite = !previous;
    syncFavoriteButton();
    if (state.favoritesOnly && !item.favorite) renderHistory();
    try {
      const body = await requestJson("/mobile/api/favorites/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          filename: item.filename,
          subfolder: item.subfolder || "",
          type: item.type || "output",
        }),
      });
      item.favorite = Boolean(body.favorite);
      syncFavoriteButton();
      if (state.favoritesOnly) renderHistory();
      toast(body.favorite ? "已收藏" : "已取消收藏");
    } catch (error) {
      item.favorite = previous;
      syncFavoriteButton();
      if (state.favoritesOnly) renderHistory();
      toast(error.message || "收藏失败", "error");
    }
  }

  async function deleteCurrentGalleryImage() {
    const item = state.galleryItems[state.galleryIndex];
    const jobId = currentGalleryJobId();
    if (!item?.filename || !jobId) {
      toast("无法删除这张图", "error");
      return;
    }
    if (!window.confirm("删除这张图？删除后无法恢复。")) return;
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
      toast("已删除");
      await loadJobs();
    } catch (error) {
      toast(error.message || "删除失败", "error");
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
    const finish = () => {
      ghost.remove();
      image.style.transform = "";
      image.style.transition = "";
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
      toast("已开始下载");
    } catch {
      toast("下载失败", "error");
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

  function openGallery(items, index, jobId = "") {
    if (!Array.isArray(items) || items.length === 0) return;
    const gallery = $("galleryDialog");
    gallery?.classList.remove("is-closing");
    state.galleryItems = items;
    state.galleryIndex = index;
    state.galleryJobId = jobId || "";
    renderGalleryItem();
    gallery.showModal();
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
    mediaButton?.setAttribute("aria-label", `查看大图，第 ${flatIndex + 1} 张，共 ${total} 张`);
    const title = card.querySelector(".history-title-button");
    const name = entry.job.model_name || entry.job.workflow_name || "电脑端任务";
    if (title && title.textContent !== name) {
      title.textContent = name;
      title.setAttribute("aria-label", `查看${name}的生成参数`);
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
        ? `${batchCount} 个批次 · ${imageTotal} 张`
        : (state.favoritesOnly ? "暂无收藏" : `${jobs.length} 条记录`),
    );
    $("historyEmpty").classList.toggle("hidden", entries.length !== 0);

    const grid = $("historyGrid");
    if (signature === state.historyRenderSignature && grid.childElementCount === entries.length) {
      entries.forEach((entry, index) => {
        const card = grid.children[index];
        if (card) card._historyEntry = entry;
      });
      grid.querySelectorAll(".history-media.is-loading").forEach(settleHistoryMedia);
      return;
    }

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
    return state.nodeTitles?.get(String(nodeId)) || `节点 ${nodeId}`;
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
      setText("progressLabel", "空闲");
      $("livePreview").classList.add("hidden");
      return;
    }

    setText("activeJobName", active.workflow_name || "电脑端任务");
    const display = progressDisplay(active);
    setProgressRing(display.percent);
    setText("progressValue", display.text);
    setText("progressLabel", display.label);
  }

  let jobsLoadSequence = 0;
  async function loadJobsOnce() {
    const sequence = ++jobsLoadSequence;
    const body = await requestJson(`/mobile/api/jobs?limit=500&summary=1&_=${Date.now()}`);
    if (sequence !== jobsLoadSequence) return;
    const incoming = body.jobs || [];
    const incomingIds = new Set(incoming.map((job) => String(job.id)));
    for (const [id, job] of state.optimisticJobs) {
      if (incomingIds.has(id) || Date.now() - job.create_time > 30000) state.optimisticJobs.delete(id);
      else incoming.unshift(job);
    }
    state.jobs = incoming;
    state.totalJobs = body.total || state.jobs.length;
    renderQueue();
    renderHistory();
    updateActiveJob();
  }

  const jobsRefresh = new window.MobileSingleFlight(loadJobsOnce);
  function loadJobs(urgent = false) {
    return jobsRefresh.run(urgent);
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
      renderQueue();
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
    if (typeof value === "boolean") return value ? "开启" : "关闭";
    return String(value);
  }

  function jobDetailRows(job) {
    const prompt = job?.workflow?.prompt || {};
    const gallery = jobGallery(job);
    const width = promptValue(prompt, ["width"]);
    const height = promptValue(prompt, ["height"]);
    const size = width !== undefined && height !== undefined ? `${width} × ${height}` : "";
    const rows = [
      ["工作流", job.workflow_name || "电脑端任务"],
      ["模型", detailValue(promptValue(prompt, ["unet_name", "ckpt_name", "model_name"]))],
      ["VAE", detailValue(promptValue(prompt, ["vae_name"]))],
      ["采样器", detailValue(promptValue(prompt, ["sampler_name"]))],
      ["调度器", detailValue(promptValue(prompt, ["scheduler"]))],
      ["尺寸", size],
      ["采样步数", detailValue(promptValue(prompt, ["steps"]))],
      ["CFG", detailValue(promptValue(prompt, ["cfg"]))],
      ["重绘幅度", detailValue(promptValue(prompt, ["denoise"]))],
      ["批量数量", detailValue(promptValue(prompt, ["batch_size"]))],
      ["输出图片", gallery.length ? `${gallery.length} 张` : detailValue(job.outputs_count)],
      ["提交时间", formatTime(job.create_time)],
      ["任务编号", job.id],
    ].filter(([, value]) => value !== "");
    if (job.execution_error?.exception_message) rows.push(["错误", job.execution_error.exception_message]);
    return rows;
  }

  function paintJobDialog(job) {
    state.dialogJob = job;
    setText("dialogTitle", job.workflow_name || "任务详情");
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
      workflow_name: "任务详情",
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
      toast("已重新加入队列", "success");
      showView("queue");
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
    bubble.innerHTML = `<span class="mode-tip-title">${isRandom ? "随机生成模式" : "普通生成模式"}</span>`;
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
      ? (random ? "按模型顺序随机生成" : "按模型顺序加入队列")
      : (random ? (repeats > 1 ? `连发 ${repeats} 次随机生成` : "随机生成") : (repeats > 1 ? `连发 ${repeats} 次` : "加入队列"));
    button.setAttribute("aria-label", label);
    button.title = state.multiModel
      ? `${label}（上滑切换随机；多模型下不能改次数）`
      : (random ? "随机生成（上滑切回普通生成）" : "加入队列（上滑切换随机生成）");
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
    if (!submittingBatch) button.disabled = false;
  }

  function toggleRandomGenerate() {
    state.randomGenerate = !state.randomGenerate;
    try {
      phoneSettings.setItem("comfy-mobile-remote.randomGenerate", state.randomGenerate ? "1" : "0");
    } catch { /* storage optional */ }
    paintGenerateButton();
    showModeTip(state.randomGenerate);
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
            toast("多模型开启时不能改次数");
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

    button.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      armed = true;
      skipClick = false;
      axis = "";
      dock.classList.add("is-swiping");
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
        toggleRandomGenerate();
      }
      axis = "";
    };
    button.addEventListener("pointerup", endHold);
    button.addEventListener("pointercancel", endHold);
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
      toast("存在互斥标签，请先修改冲突项", "error");
      renderPresetPanel();
      return;
    }
    const models = selectedModelQueue();
    if (!models.length) {
      toast("请选择模型", "error");
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
    $("workflowSelect").disabled = true;
    const hidden = button.querySelector(".visually-hidden");
    if (hidden) hidden.textContent = "正在提交";
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
          if (presetSubmissionHasConflicts()) throw new Error("存在互斥标签，请先修改冲突项");
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
          workflow_name: String(body.workflow_name || "手机工作流"),
          outputs_count: 0,
          previewable_outputs_count: 0,
          gallery: [],
        };
        state.optimisticJobs.set(promptId, optimistic);
        if (!state.jobs.some((job) => String(job.id) === promptId)) state.jobs.unshift(optimistic);
        renderQueue();
        updateActiveJob();
      }
      toast(submitted > 1 ? `已加入 ${submitted} 个任务` : "任务已加入队列", "success");
      await Promise.all([loadStatus(), loadJobs(true), loadProgress(true)]);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      if (submitted === 0) {
        state.values = originalValues;
        state.presetState = originalPreset;
        state.presetState.custom = state.presetState.catalog?.custom || state.presetState.custom || {};
        markPresetConflicts();
        if (state.presetEnabled) applyPresetPrompt();
      }
      toast(submitted ? `已加入 ${submitted} 个，后续失败` : (error.message || "提交失败"), "error");
    } finally {
      phoneSettings.endBatch();
      submittingBatch = false;
      button.disabled = false;
      $("workflowSelect").disabled = false;
      if (hidden) hidden.textContent = "加入队列";
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
      state.progress.set(promptId, { percent: 0, value: 0, max: 0, label: "开始执行" });
      loadJobs().catch(() => {});
    } else if (type === "executing" && promptId && data.node) {
      if (state.progress.executing(data)) {
        state.progress.set(promptId, {
          label: nodeDisplayName(data.display_node || data.node),
          displayId: String(data.display_node || data.node),
        });
        updateActiveJob();
        const card = [...document.querySelectorAll(".job-card")].find((item) => item.dataset.jobId === promptId);
        if (card) paintQueueProgress(card, promptId);
      }
    } else if (type === "progress" && promptId) {
      const max = Number(data.max);
      const value = Number(data.value);
      if (Number.isFinite(max) && Number.isFinite(value) && max > 0) {
        state.progress.set(promptId, {
          value,
          max,
          label: data.node ? nodeDisplayName(data.node) : "正在采样",
          nodeId: data.node ? String(data.node) : "",
        });
        updateActiveJob();
        const card = [...document.querySelectorAll(".job-card")].find((item) => item.dataset.jobId === promptId);
        if (card) paintQueueProgress(card, promptId);
      }
    } else if (type === "progress_state" && promptId) {
      if (state.progress.acceptProgressState(data)) {
        updateActiveJob();
        const card = [...document.querySelectorAll(".job-card")].find((item) => item.dataset.jobId === promptId);
        if (card) paintQueueProgress(card, promptId);
      }
    } else if (["execution_success", "execution_error", "execution_interrupted"].includes(type)) {
      if (type === "execution_success") toast("生成完成", "success");
      if (type === "execution_error") toast(data.exception_message || "生成失败", "error");
      if (type === "execution_interrupted") toast("任务已停止");
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

  async function refreshAll(showMessage = false) {
    const button = $("refreshButton");
    button.disabled = true;
    button.classList.add("is-refreshing");
    const tasks = [loadStatus(), loadJobs(), loadProgress()];
    if (!submittingBatch && !applyingRemoteSettings) tasks.push(loadWorkflows(false));
    const results = await Promise.allSettled(tasks);
    button.disabled = false;
    button.classList.remove("is-refreshing");
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      toast(failed.reason?.message || "刷新失败", "error");
    } else if (showMessage) {
      toast("已刷新", "success");
    }
  }

  function bindEvents() {
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
    $("refreshButton").addEventListener("click", async () => {
      await refreshSharedSettings().catch(() => {});
      await refreshAll(true);
    });
    $("reloadWorkflowsButton").addEventListener("click", async () => {
      if (submittingBatch || applyingRemoteSettings) return;
      try {
        await loadWorkflows(true);
        toast("工作流已更新", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    });
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
        toast(error.message || "无法复制提示词", "error");
      }
    });
    $("copyGallerySeed").addEventListener("click", async () => {
      setGalleryCopyMenu(false);
      try {
        await galleryJobRecord();
        restoreSeedFromJob();
      } catch (error) {
        toast(error.message || "无法复制种子", "error");
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

    const galleryMakeGhost = (src) => {
      const ghost = document.createElement("img");
      ghost.src = src;
      ghost.alt = "";
      ghost.className = "gallery-ghost";
      ghost.draggable = false;
      galleryStage.append(ghost);
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

    window.addEventListener("online", () => refreshAll(false));
    window.addEventListener("offline", () => {
      state.online = false;
      setText("connectionLabel", "网络断开");
    });

    const grid = $("historyGrid");
    const layoutButton = $("historyLayoutButton");
    const favoritesButton = $("historyFavoritesButton");
    try {
      state.favoritesOnly = phoneSettings.getItem("comfy-mobile-remote.favoritesOnly") === "1";
    } catch { /* storage optional */ }
    const applyFavoritesOnly = () => {
      favoritesButton.classList.toggle("active", state.favoritesOnly);
      favoritesButton.setAttribute("aria-pressed", state.favoritesOnly ? "true" : "false");
      favoritesButton.setAttribute("aria-label", state.favoritesOnly ? "显示全部照片" : "只看收藏");
      favoritesButton.title = state.favoritesOnly ? "显示全部照片" : "只看收藏";
      renderHistory();
    };
    favoritesButton.addEventListener("click", () => {
      state.favoritesOnly = !state.favoritesOnly;
      try {
        phoneSettings.setItem("comfy-mobile-remote.favoritesOnly", state.favoritesOnly ? "1" : "0");
      } catch { /* storage optional */ }
      applyFavoritesOnly();
    });
    applyFavoritesOnly();
    const applyHistoryCols = (cols) => {
      grid.classList.remove("cols-3", "cols-4");
      if (cols !== 2) grid.classList.add(`cols-${cols}`);
      layoutButton.title = `切换列数（当前 ${cols} 列）`;
      layoutButton.setAttribute("aria-label", `切换列数，当前 ${cols} 列`);
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
    state.favoritesOnly = phoneSettings.getItem("comfy-mobile-remote.favoritesOnly") === "1";
    const favoriteButton = $("historyFavoritesButton");
    favoriteButton.classList.toggle("active", state.favoritesOnly);
    favoriteButton.setAttribute("aria-pressed", String(state.favoritesOnly));
    favoriteButton.setAttribute("aria-label", state.favoritesOnly ? "显示全部照片" : "只看收藏");
    favoriteButton.title = state.favoritesOnly ? "显示全部照片" : "只看收藏";
    const cols = Number(phoneSettings.getItem("comfy-mobile-remote.historyCols") || 2);
    state.historyCols = [2, 3, 4].includes(cols) ? cols : 2;
    const grid = $("historyGrid");
    grid.classList.toggle("cols-3", state.historyCols === 3);
    grid.classList.toggle("cols-4", state.historyCols === 4);
    const layoutButton = $("historyLayoutButton");
    layoutButton.title = `切换列数（当前 ${state.historyCols} 列）`;
    layoutButton.setAttribute("aria-label", `切换列数，当前 ${state.historyCols} 列`);
    renderHistory();
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
      toast(error.message || "设置读取失败，请稍后重试", "error");
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function start() {
    try {
      await phoneSettings.init();
      try {
        await loadPresetCatalog();
      } catch (error) {
        state.presetEnabled = false;
        toast(error.message || "标签目录读取失败", "error");
      }
      bindEvents();
      applyPhonePreferences();
      connectWebSocket();
      await refreshAll(false);
      $("useComputerSettingsButton").addEventListener("click", () => chooseSettingsVersion("server"));
      $("keepPhoneSettingsButton").addEventListener("click", () => chooseSettingsVersion("local"));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshSharedSettings().catch(() => {});
      });
      window.setInterval(() => loadStatus().catch(() => {}), 5000);
      window.setInterval(() => loadJobs().catch(() => {}), 4000);
      window.setInterval(() => loadProgress().catch(() => {}), 1000);
    } catch (error) {
      toast(error.message || "页面启动失败", "error");
    } finally {
      const button = $("generateButton");
      if (button && !submittingBatch) button.disabled = false;
    }
  }

  start();
})();
