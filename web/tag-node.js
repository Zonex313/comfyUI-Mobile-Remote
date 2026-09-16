import { ready as i18nReady, t } from "./i18n.js?v=202610127";

// 词典到位后再注册界面，否则侧边栏标题会先渲染成中文原文。
await i18nReady;
import { app } from "../../scripts/app.js";

// 电脑端「CLIP文本编码丨随机标签」节点面板。
// 随机/组合逻辑与手机端共用同一份引擎（mobile/preset-engine.js + preset-catalog.js），
// 但节点自己的锁定/忽略状态保存在节点上（写进工作流），与手机端设置互相独立。

/* 文本单独一层：按钮自己的匿名内容盒会被居中，省略号要放在真正的块级文本框上。 */
function textSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

const NODE_TYPE = "MobileTagCLIPTextEncode";
const VERSION = "202610127";
const PANEL_HEIGHT = 202;

let libraryPromise = null;
let stylesReady = false;

function ensureStyles() {
  if (stylesReady || document.getElementById("mtr-tag-styles")) { stylesReady = true; return; }
  const link = document.createElement("link");
  link.id = "mtr-tag-styles";
  link.rel = "stylesheet";
  link.href = new URL("./tag-node.css", import.meta.url).href + "?v=" + VERSION;
  document.head.append(link);
  stylesReady = true;
}

async function loadLibrary() {
  if (libraryPromise) return libraryPromise;
  libraryPromise = (async () => {
    await Promise.all([
      import("/mobile/assets/preset-catalog.js?v=" + VERSION),
      import("/mobile/assets/preset-engine.js?v=" + VERSION),
    ]);
    const Catalog = globalThis.MobilePresetCatalog;
    const Engine = globalThis.MobilePresetEngine;
    if (!Catalog || !Engine) throw new Error(t("标签引擎加载失败"));
    const response = await fetch("/mobile/assets/prompt-presets.json?v=" + VERSION, { cache: "no-store" });
    if (!response.ok) throw new Error(t("标签词库读取失败"));
    const body = await response.json();
    const categories = Array.isArray(body?.categories) ? body.categories : [];
    const builtin = body?.rules && typeof body.rules === "object" ? body.rules : {};
    let editor = Catalog.empty();
    try {
      const settings = await fetch("/mobile/api/settings", { cache: "no-store" }).then((r) => r.json());
      if (settings && settings.values) editor = Catalog.fromValues(settings.values);
    } catch { /* 目录编辑器状态读不到就用基础词库 */ }
    return { Catalog, Engine, categories, builtin, editor };
  })();
  try { return await libraryPromise; }
  catch (error) { libraryPromise = null; throw error; }
}

function emptyState() {
  const state = { slots: {}, custom: {}, freeText: "", extraText: "" };
  Object.defineProperty(state, "catalog", { value: null, writable: true, configurable: true, enumerable: false });
  return state;
}

class TagPanel {
  constructor(node) {
    this.node = node;
    this.library = null;
    this.error = "";
    this.widget = null;
    this.visible = null;
    this.userExtra = 0;
    this.root = document.createElement("div");
    this.root.className = "mtr-panel";
    this.rows = document.createElement("div");
    this.rows.className = "mtr-rows";
    const bar = document.createElement("div");
    bar.className = "mtr-bar";
    const hint = document.createElement("span");
    hint.className = "mtr-hint";
    hint.textContent = t("点分类名随机，点标签修改");
    this.copyButton = document.createElement("button");
    this.copyButton.type = "button";
    this.copyButton.className = "mtr-copy";
    this.copyButton.textContent = t("复制");
    this.copyButton.title = t("复制当前完整提示词（随机标签 + 文本框里你自己输入的文字）");
    this.copyButton.addEventListener("click", () => this.copyPrompt());
    this.randomButton = document.createElement("button");
    this.randomButton.type = "button";
    this.randomButton.className = "mtr-random";
    this.randomButton.textContent = t("随机");
    this.randomButton.title = t("重新随机所有标签");
    this.randomButton.addEventListener("click", () => this.randomizeAll());
    bar.append(hint, this.copyButton, this.randomButton);
    this.root.append(bar, this.rows);
    this.rows.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    void this.load();
  }

  get state() {
    const properties = this.node.properties || (this.node.properties = {});
    let state = properties.mtrTagState;
    if (!state || typeof state !== "object") state = properties.mtrTagState = emptyState();
    if (!state.slots || typeof state.slots !== "object") state.slots = {};
    if (!state.custom || typeof state.custom !== "object") state.custom = {};
    if (typeof state.freeText !== "string") state.freeText = "";
    if (typeof state.extraText !== "string") state.extraText = "";
    return state;
  }

  engine() {
    if (!this.library) return null;
    const state = this.state;
    // 目录是共享设置，不应随节点状态序列化成一份过期快照。
    Object.defineProperty(state, "catalog", {
      value: this.library.editor,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return this.library.Engine.create({
      categories: this.library.categories,
      state,
      rules: this.library.builtin,
    });
  }

  async load() {
    if (!this.isTagMode()) return;
    try {
      this.library = await loadLibrary();
      this.error = "";
    } catch (error) {
      this.error = error?.message || t("标签引擎加载失败");
    }
    this.render();
  }

  nodeText() {
    const widget = (this.node.widgets || []).find((item) => item.name === "text");
    return typeof widget?.value === "string" ? widget.value.trim() : "";
  }

  widgetValue(name) {
    const widget = (this.node.widgets || []).find((item) => item.name === name);
    return widget ? widget.value : undefined;
  }

  isTagMode() {
    const value = this.widgetValue("标签模式");
    return value === undefined ? Boolean(this.widgetValue("tag_mode")) : Boolean(value);
  }

  isRandomEach() {
    const value = this.widgetValue("每次随机");
    return value === undefined ? true : Boolean(value);
  }

  // 标签部分 + 节点文本框里的自定义文字
  finalPrompt() {
    const engine = this.engine();
    const tags = engine ? String(engine.compose() || "").trim() : "";
    const custom = this.nodeText();
    if (tags && custom) return tags + ", " + custom;
    return custom || tags;
  }

  // 「标签模式」关着时整块标签面板收起来，节点长得就跟普通文本编码一样。
  // 高度不做任何加减法：交给前端按当前控件算自然高度，用户手动拖出来的余量单独记住。
  // resetExtra：从工作流加载后重新应用时用——此时节点高度是存下来的，
  // 不能当成"用户手动加高的余量"，否则面板高度会被算两遍。
  setVisible(visible, resetExtra = false) {
    visible = Boolean(visible);
    if (this.visible === visible && !resetExtra) return;
    const node = this.node;
    const current = Math.round(node?.size?.[1] || 0);
    if (resetExtra) {
      this.userExtra = 0;
    } else if (current > 0) {
      this.userExtra = Math.max(0, current - Math.round(this.naturalHeight()));
    }
    this.visible = visible;
    this.root.style.display = visible ? "" : "none";
    if (this.widget) {
      this.widget.computeSize = visible ? ((width) => [width, PANEL_HEIGHT]) : (() => [0, -4]);
    }
    // 「每次随机」只在标签模式下才有意义，跟着一起藏
    const sw = this.randomWidget();
    if (sw) sw.hidden = !visible;
    this.resize();
    if (visible && !this.library) void this.load();
  }


  // 复制当前完整提示词（随机标签 + 文本框里的自定义文字）。
  // 只读不改：文本框内容原样保留，不覆盖用户自己输入的东西。
  async copyPrompt() {
    const text = this.finalPrompt();
    const flash = (label) => {
      this.copyButton.textContent = label;
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => { this.copyButton.textContent = t("复制"); }, 1200);
    };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // 非安全上下文（比如经局域网 IP 访问）没有 clipboard API，退回老办法
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      flash(t("已复制"));
    } catch (error) {
      console.error("[Mobile Remote] 复制提示词失败", error);
      flash(t("复制失败"));
    }
  }

  randomizeAll() {
    const engine = this.engine();
    if (!engine) return;
    engine.randomize();
    this.render();
  }

  randomizeCategory(categoryId) {
    const engine = this.engine();
    if (!engine) return;
    engine.randomize(categoryId);
    this.render();
  }

  render() {
    this.rows.replaceChildren();
    if (this.error) {
      const tip = document.createElement("div");
      tip.className = "mtr-error";
      tip.textContent = this.error;
      this.rows.append(tip);
      this.resize();
      return;
    }
    const engine = this.engine();
    if (!engine) {
      const tip = document.createElement("div");
      tip.className = "mtr-error";
      tip.textContent = t("载入中…");
      this.rows.append(tip);
      this.resize();
      return;
    }
    const skipped = engine.skipped();
    (this.library.categories || []).forEach((category) => {
      const row = document.createElement("div");
      row.className = "mtr-row" + (skipped.has(category.id) ? " is-skipped" : "");
      const label = document.createElement("button");
      label.type = "button";
      label.className = "mtr-row-label";
      label.append(textSpan("mtr-row-label-text", category.label));
      label.title = t("随机") + category.label;
      label.addEventListener("click", () => this.randomizeCategory(category.id));
      const divider = document.createElement("span");
      divider.className = "mtr-divider";
      const values = document.createElement("div");
      values.className = "mtr-values";
      (category.slots || []).forEach((slot, index) => {
        if (index > 0) {
          const sep = document.createElement("span");
          sep.className = "mtr-sep";
          sep.textContent = t("、");
          values.append(sep);
        }
        const current = engine.slotState(category.id, slot.id);
        const value = current.value || t("未选");
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "mtr-chip";
        if (value.length <= 2) chip.classList.add("no-ellipsis");
        if ((category.slots || []).length >= 3) chip.classList.add("tight");
        if (current.locked) chip.classList.add("locked");
        if (current.ignored) chip.classList.add("ignored");
        chip.append(textSpan("mtr-chip-text", value));
        chip.title = current.locked ? t("已锁定") : current.ignored ? t("已忽略") : value;
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          openEditor(this, category, slot, chip);
        });
        values.append(chip);
      });
      row.append(label, divider, values);
      this.rows.append(row);
    });
    this.resize();
  }

  randomWidget() {
    return (this.node.widgets || []).find((item) => item.name === "每次随机") || null;
  }

  // 节点自然需要的高度：让前端按当前控件自己算，不写死、不加减。
  naturalHeight() {
    try { return this.node.computeSize()[1]; } catch { return 200; }
  }

  // 切换后重新贴合内容。文本框高度完全交给前端，不做任何钉死或补偿。
  resize() {
    const node = this.node;
    if (!node || !node.graph) return;
    const apply = () => {
      try {
        const width = Math.max(node.size?.[0] || 340, 340);
        const target = Math.max(110, Math.round(this.naturalHeight() + this.userExtra));
        if (node.size[1] !== target || node.size[0] !== width) node.setSize([width, target]);
        // 只改 node.size 画布不会重画节点背景，外框会停在旧高度——必须显式标脏
        node.setDirtyCanvas?.(true, true);
        node.graph?.setDirtyCanvas?.(true, true);
      } catch { /* 计算失败时保持默认 */ }
    };
    apply();                       // 同步先改一次：外框立刻跟上，不掉帧
    requestAnimationFrame(apply);  // 下一帧布局稳定后再校准一次
  }

}

// ---- 标签编辑弹层（对齐手机端的「点标签修改」）----
const tagRuntime = globalThis.__MTR_TAG_RUNTIME || (globalThis.__MTR_TAG_RUNTIME = { popup: null, popupOwner: null });

function closePopup() {
  if (!tagRuntime.popup) return;
  tagRuntime.popup.remove();
  tagRuntime.popup = null;
  tagRuntime.popupOwner = null;
  const outside = tagRuntime.outsideHandler || onPopupOutside;
  const key = tagRuntime.keyHandler || onPopupKey;
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("keydown", key, true);
  tagRuntime.outsideHandler = null;
  tagRuntime.keyHandler = null;
  tagRuntime.listenersInstalled = false;
}

function onPopupOutside(event) {
  if (tagRuntime.popup && !tagRuntime.popup.contains(event.target)) closePopup();
}

function onPopupKey(event) {
  if (event.key === "Escape") closePopup();
}

function openEditor(panel, category, slot, anchor) {
  closePopup();
  const engine = panel.engine();
  if (!engine) return;
  const current = engine.slotState(category.id, slot.id);
  const box = document.createElement("div");
  box.className = "mtr-popup";
  const head = document.createElement("div");
  head.className = "mtr-popup-head";
  const eyebrow = document.createElement("span");
  eyebrow.className = "mtr-popup-eyebrow";
  eyebrow.textContent = category.label;
  const title = document.createElement("strong");
  title.textContent = slot.label;
  head.append(eyebrow, title);

  const flags = document.createElement("div");
  flags.className = "mtr-flags";
  const lock = document.createElement("button");
  lock.type = "button";
  lock.className = "mtr-flag" + (current.locked ? " active" : "");
  lock.textContent = current.locked ? t("已锁定") : t("锁定");
  const ignore = document.createElement("button");
  ignore.type = "button";
  ignore.className = "mtr-flag" + (current.ignored ? " active" : "");
  ignore.textContent = current.ignored ? t("已忽略") : t("忽略");
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "mtr-flag";
  clear.textContent = t("清除");
  flags.append(lock, ignore, clear);

  const input = document.createElement("input");
  input.className = "mtr-input";
  input.type = "text";
  input.value = current.value || "";
  input.placeholder = t("自定义标签");

  const poolHead = document.createElement("div");
  poolHead.className = "mtr-pool-head";
  poolHead.textContent = (slot.label || t("标签")) + t(" 词库");
  const pool = document.createElement("div");
  pool.className = "mtr-pool";
  let chosen = current.value || "";
  const paint = () => {
    [...pool.children].forEach((chip) => chip.classList.toggle("active", chip.dataset.tag === chosen));
    lock.classList.toggle("active", current.locked);
    lock.textContent = current.locked ? t("已锁定") : t("锁定");
    ignore.classList.toggle("active", current.ignored);
    ignore.textContent = current.ignored ? t("已忽略") : t("忽略");
  };
  const commit = () => {
    current.value = chosen;
    panel.render();
  };
  engine.randomPool(category.id, slot).forEach((tag) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mtr-pool-chip";
    chip.dataset.tag = tag;
    chip.append(textSpan("mtr-pool-chip-text", tag));
    chip.addEventListener("click", () => { chosen = tag; input.value = tag; paint(); commit(); });
    pool.append(chip);
  });
  input.addEventListener("input", () => { chosen = input.value; paint(); commit(); });
  lock.addEventListener("click", () => { current.locked = !current.locked; if (current.locked) current.ignored = false; paint(); commit(); });
  ignore.addEventListener("click", () => { current.ignored = !current.ignored; if (current.ignored) current.locked = false; paint(); commit(); });
  clear.addEventListener("click", () => { chosen = ""; input.value = ""; current.locked = false; current.ignored = false; paint(); commit(); });

  box.append(head, flags, input, poolHead, pool);
  document.body.append(box);
  const rect = anchor.getBoundingClientRect();
  const width = 260;
  box.style.width = width + "px";
  const height = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
  box.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8)) + "px";
  tagRuntime.popup = box;
  tagRuntime.popupOwner = panel.node;
  paint();
  if (!tagRuntime.listenersInstalled) {
    tagRuntime.outsideHandler = onPopupOutside;
    tagRuntime.keyHandler = onPopupKey;
    document.addEventListener("pointerdown", tagRuntime.outsideHandler, true);
    document.addEventListener("keydown", tagRuntime.keyHandler, true);
    tagRuntime.listenersInstalled = true;
  }
}

// ---- 入队钩子：点「运行」时按标签模式随机组合并注入提示词 ----
const hookRuntime = globalThis.__MTR_TAG_HOOK || (globalThis.__MTR_TAG_HOOK = { installed: false });

function listNodes() {
  return app.graph?._nodes || app.graph?.nodes || [];
}

// 把标签组合写进即将提交的那份提示词里。
// 「每次随机」开着时先重新随机一次——这个函数对批量任务的每一项都会跑一遍，
// 所以批量发起时每一项的标签都不同，与手机端的批量随机逻辑一致。
function patchPrompt(prompt) {
  const output = prompt?.output;
  if (!output || typeof output !== "object") return;
  for (const node of listNodes()) {
    const panel = node.__mtrPanel;
    if (!panel || node.type !== NODE_TYPE || !panel.isTagMode()) continue;
    const entry = output[String(node.id)];
    if (!entry || typeof entry !== "object" || !entry.inputs) continue;
    if (panel.isRandomEach()) {
      const engine = panel.engine();
      if (engine) {
        engine.randomize();
        panel.render();
      }
    }
    entry.inputs.text = panel.finalPrompt();
  }
}

function installHook() {
  if (hookRuntime.installed) return;
  const api = app.api || globalThis.comfyAPI?.api?.api;
  if (api && typeof api.queuePrompt === "function") {
    const original = api.queuePrompt;
    api.queuePrompt = async function (index, prompt, ...rest) {
      try { patchPrompt(prompt); }
      catch (error) { console.error("[Mobile Remote] 标签随机失败", error); }
      return original.call(this, index, prompt, ...rest);
    };
    hookRuntime.installed = true;
    return;
  }
  if (typeof app.queuePrompt === "function") {
    const original = app.queuePrompt;
    app.queuePrompt = function (...args) {
      const restores = [];
      try {
        for (const node of listNodes()) {
          const panel = node.__mtrPanel;
          if (!panel || node.type !== NODE_TYPE || !panel.isTagMode()) continue;
          if (panel.isRandomEach()) {
            const engine = panel.engine();
            if (engine) { engine.randomize(); panel.render(); }
          }
          const widget = (node.widgets || []).find((item) => item.name === "text");
          if (widget) { restores.push([widget, widget.value]); widget.value = panel.finalPrompt(); }
        }
      } catch (error) { console.error("[Mobile Remote] 标签随机失败", error); }
      let result;
      try { result = original.apply(this, args); }
      finally {
        const undo = () => restores.forEach(([widget, value]) => { widget.value = value; });
        if (result && typeof result.then === "function") result.finally(undo);
        else undo();
      }
      return result;
    };
    hookRuntime.installed = true;
  }
}

// 文本框的空状态提示语（中文一行 + 英文一行）
const TEXT_PLACEHOLDER = t("此处输入的文字将注入所有标签后方\nText entered here will be appended after all the tags");

// 把提示词文本框挪到widgets 数组最后，让它显示在标签面板下方。
function moveTextToBottom(node) {
  const widgets = node?.widgets;
  if (!Array.isArray(widgets)) return;
  const index = widgets.findIndex((item) => item.name === "text");
  if (index < 0 || index === widgets.length - 1) return;
  const [textWidget] = widgets.splice(index, 1);
  widgets.push(textWidget);
}

// 输入框的 DOM 是前端异步渲染出来的，所以要重试几次
function applyTextPlaceholder(node, tries = 8) {
  const widget = (node?.widgets || []).find((item) => item.name === "text");
  const element = widget?.element;
  const area = element && (element.tagName === "TEXTAREA" ? element : element.querySelector?.("textarea"));
  if (area) {
    area.placeholder = TEXT_PLACEHOLDER;
    return;
  }
  if (tries > 0) setTimeout(() => applyTextPlaceholder(node, tries - 1), 150);
}

app.registerExtension({
  name: "ComfyUI.MobileRemote.TagNode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;
    ensureStyles();
    installHook();
    const proto = nodeType.prototype;
    if (proto.__mtrHooksInstalled) return;
    proto.__mtrHooksInstalled = true;
    const removed = proto.onRemoved;
    proto.onRemoved = function (...rest) {
      if (tagRuntime.popupOwner === this) closePopup();
      if (this.__mtrPanel) this.__mtrPanel = null;
      return removed?.apply(this, rest);
    };
    const created = proto.onNodeCreated;
    proto.onNodeCreated = function (...args) {
      const result = created?.apply(this, args);
      const node = this;
      const panel = new TagPanel(node);
      node.__mtrPanel = panel;
      const widget = node.addDOMWidget("mtrTagPanel", "mtr-tags", panel.root, {
        serialize: false,
        hideOnZoom: false,
      });
      panel.widget = widget || null;
      if (widget) widget.computeSize = () => [0, -4];
      moveTextToBottom(node);
      applyTextPlaceholder(node);
      panel.setVisible(panel.isTagMode());
      const modeWidget = (node.widgets || []).find((item) => item.name === "标签模式");
      if (modeWidget) {
        const originalCallback = modeWidget.callback;
        modeWidget.callback = function (value, ...rest) {
          panel.setVisible(Boolean(value));
          return originalCallback?.apply(this, [value, ...rest]);
        };
      }
      return result;
    };
    // 从工作流加载时前端会重建控件顺序，这里再兜一次（只包一层，不能放进 onNodeCreated）
    const configured = proto.onConfigure;
    proto.onConfigure = function (...rest) {
      const out = configured?.apply(this, rest);
      moveTextToBottom(this);
      applyTextPlaceholder(this);
      // 控件值是在 configure 阶段才从工作流恢复的：创建时按默认值（关）算过一次显隐，
      // 这里必须按恢复后的真实值重新应用一次，否则会出现"开关是开的、面板没出来"。
      const panel = this.__mtrPanel;
      if (panel) {
        panel.visible = null;
        panel.setVisible(panel.isTagMode(), true);
      }
      return out;
    };
  },
});