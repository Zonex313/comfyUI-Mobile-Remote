/* ComfyUI 手机端「高级」页：按组/节点浏览、搜索并编辑工作流参数。
 *
 * 与生成页解耦的四条硬规则：
 *  1. 页面 DOM 全部由本模块创建（#advancedList / #advancedStatus / #advancedSearch /
 *     #advancedEmpty / #advancedExpandButton），不依赖 index.html 里已有的元素；
 *     宿主里若已存在同 id 的元素则直接复用，不会产生重复 id。
 *  2. 依赖一律通过 mount() 注入（t / state / updateFieldValue），
 *     本模块不引用 app.js 里的任何变量，也不用生成页的 renderField。
 *  3. 控件 1:1 照着 graph.nodes[].inputs 自己渲染：画布上的节点有几个输入就是几个控件、
 *     什么类型就是什么类型；节点的 inputs 缺失（旧服务端）时退化成 field_ids 那套字段。
 *  4. 样式表由 mount() 自己挂 <link>，不改 mobile/styles.css。
 *
 * 数据来源：GET /mobile/api/workflows/<id> 返回的 workflow.graph（nodes/groups）。
 * 每个输入一个控件，值写进 state.values["<节点 id>::<输入名>"]（键的形状与 API prompt 的
 * inputs 键一致），提交时服务端按这个形状应用；节点自身 inputs 缺失的旧数据继续用字段 id。
 *
 * 两个页面互相同步：改一个控件的值只做局部更新（不整块重渲染，不打断输入），
 * 整块 render() 会记住并恢复正在编辑的控件焦点与光标；对外的同步入口是
 * syncValue(fieldId, value) / syncAll()（只对齐已渲染的控件，不碰 state.values）。
 */
(() => {
  "use strict";

  const VERSION = "202609307";
  const STYLE_ID = "mtr-advanced-styles";
  const DEFAULT_STYLE_HREF = "/mobile/assets/advanced.css?v=" + VERSION;
  // 组折叠状态：{ "<工作流 id>": { "<组 id>": true|false } }
  const STORAGE_KEY = "comfy-mobile-remote.advancedGroups";
  const UNGROUPED_ID = "__ungrouped__";
  const FLASH_MS = 1200;
  const SVG_NS = "http://www.w3.org/2000/svg";
  // 只读回显要限长：自定义节点可能把整个对象塞进一个不认识的输入。
  const MAX_READONLY_CHARS = 240;

  const ICONS = {
    chevron: ["m6 9 6 6 6-6"],
    expand: ["M4 9V6a2 2 0 0 1 2-2h3", "M15 4h3a2 2 0 0 1 2 2v3", "M20 15v3a2 2 0 0 1-2 2h-3", "M9 20H6a2 2 0 0 1-2-2v-3"],
    collapse: ["M9 4v3a2 2 0 0 1-2 2H4", "M15 4v3a2 2 0 0 0 2 2h3", "M20 15h-3a2 2 0 0 0-2 2v3", "M4 15h3a2 2 0 0 1 2 2v3"],
    search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "M21 21l-4.3-4.3"],
    empty: ["M4 7h16", "M4 12h16", "M4 17h10"],
  };

  /* ------------------------------------------------------------------ 依赖 */

  const deps = {
    doc: null,
    t: null,
    state: null,
    updateFieldValue: null,
    onEdit: null,
    window: null,
    storage: undefined,
    view: null,
    styleHref: null,
  };

  const els = {
    host: null, heading: null, eyebrow: null, title: null, expandButton: null,
    toolbar: null, search: null, status: null, list: null, empty: null, emptyTitle: null,
  };

  // 本模块自己的控件表（生成页那份 state.fieldControls 一律不碰），键 = 值键 "<节点>::<输入名>"。
  const controls = new Map();
  const inputRows = new Map();
  const cards = new Map();
  const expandedNodes = new Set();
  const groupState = new Map();
  let entryIndex = new Map();
  let groupScope = null;
  let query = "";
  let autoExpandedFor = null;
  let mounted = false;
  let model = null;
  let flashTimer = 0;

  function t(text, params) {
    let value = text;
    try {
      if (typeof deps.t === "function") value = deps.t(text, params);
    } catch (error) {
      value = text;
    }
    return typeof value === "string" && value ? value : text;
  }

  const win = () => deps.window || (typeof window !== "undefined" ? window : globalThis);
  const state = () => deps.state || {};

  /* ------------------------------------------------------------- DOM 小工具 */

  function el(tag, className, text) {
    const node = deps.doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(name, className) {
    const svg = deps.doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    for (const path of ICONS[name] || []) {
      const shape = deps.doc.createElementNS(SVG_NS, "path");
      shape.setAttribute("d", path);
      svg.append(shape);
    }
    return svg;
  }

  /* ------------------------------------------------------ 折叠状态（localStorage） */

  function storageArea() {
    if (deps.storage !== undefined) return deps.storage;
    try {
      return win().localStorage || null;
    } catch (error) {
      // 无来源的页面（about:blank）读 localStorage 会抛 SecurityError。
      return null;
    }
  }

  function storageRead() {
    const area = storageArea();
    if (!area) return {};
    try {
      const parsed = JSON.parse(area.getItem(STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function storageWrite(value) {
    const area = storageArea();
    if (!area) return;
    try {
      area.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (error) { /* 隐私模式 / 配额满：折叠状态不落盘也不影响使用 */ }
  }

  function scopeId() {
    const workflow = state().workflow;
    return String((workflow && workflow.id) || "");
  }

  function loadGroupState() {
    groupState.clear();
    groupScope = scopeId();
    const all = storageRead();
    let scoped = all[groupScope];
    if (!scoped || typeof scoped !== "object") {
      // 兼容「只有一个工作流」的扁平写法。
      const flat = Object.entries(all).filter(([, value]) => typeof value === "boolean");
      scoped = flat.length ? Object.fromEntries(flat) : {};
    }
    for (const [id, open] of Object.entries(scoped)) groupState.set(id, open !== false);
  }

  function groupOpen(id) {
    return groupState.get(id) !== false;
  }

  function setGroupOpen(id, open, persist = true) {
    groupState.set(id, Boolean(open));
    if (!persist) return;
    const all = storageRead();
    const scoped = {};
    for (const [key, value] of groupState) scoped[key] = value;
    all[groupScope === null ? scopeId() : groupScope] = scoped;
    storageWrite(all);
  }

  /* ----------------------------------------------------------------- 数据模型 */

  function nodeTitle(node) {
    if (!node) return "";
    return String(node.title || node.type || node.id || "");
  }

  function normaliseType(value) {
    return String(value === undefined || value === null ? "" : value).trim().toUpperCase();
  }

  function optionList(input) {
    return Array.isArray(input && input.options) ? input.options : [];
  }

  // 画布上的控件类型 → 本模块的控件种类。
  function kindForType(type, multiline, options) {
    if (type === "BOOLEAN" || type === "BOOL") return "toggle";
    if (type === "INT" || type === "FLOAT") return "number";
    if (type === "COMBO" || type === "ENUM" || options.length) return "select";
    if (type === "STRING" || type === "TEXT") return multiline ? "textarea" : "text";
    return "readonly";
  }

  // 旧服务端只会给 field_ids：把生成页那套字段定义翻译成同样的控件条目。
  const LEGACY_KIND = { number: "number", toggle: "toggle", select: "select", textarea: "textarea", image: "readonly" };
  const LEGACY_TYPE = { number: "NUMBER", toggle: "BOOLEAN", select: "COMBO", textarea: "STRING", image: "IMAGE" };

  function legacyEntry(nodeId, field) {
    const kind = LEGACY_KIND[field.kind] || (field.kind === "image" ? "readonly" : "text");
    return {
      key: String(field.id),
      nodeId,
      name: String(field.input || field.id),
      type: LEGACY_TYPE[field.kind] || "STRING",
      options: Array.isArray(field.options) ? field.options : [],
      min: field.min,
      max: field.max,
      step: field.step,
      multiline: kind === "textarea",
      link: null,
      kind,
      initial: field.value,
      frontend: false,
      legacy: true,
    };
  }

  function buildInputEntries(node, fieldById) {
    const id = String(node.id);
    const raw = Array.isArray(node.inputs) ? node.inputs : null;
    if (raw && raw.length) {
      const out = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const name = String(item.name === undefined || item.name === null ? "" : item.name);
        if (!name) continue;
        const type = normaliseType(item.type);
        const options = optionList(item);
        const multiline = Boolean(item.multiline);
        const linkNode = item.link && typeof item.link === "object" && item.link.node !== undefined && item.link.node !== null
          ? String(item.link.node)
          : "";
        out.push({
          key: id + "::" + name,
          nodeId: id,
          name,
          type,
          options,
          min: item.min,
          max: item.max,
          step: item.step,
          multiline,
          link: linkNode ? { node: linkNode, slot: item.link.slot } : null,
          kind: kindForType(type, multiline, options),
          initial: item.value,
          // 前端专有控件（例如种子模式 control_after_generate）：值只存在手机端，
          // 仍然照 COMBO 渲染成下拉，旁边标一句灰字。
          frontend: Boolean(item.frontend),
        });
      }
      return out;
    }
    // 旧数据：节点只有 field_ids。仍然自己渲染控件，不去碰生成页的 renderField。
    const ids = Array.isArray(node.field_ids) ? node.field_ids : [];
    const out = [];
    const seen = new Set();
    for (const rawId of ids) {
      const key = String(rawId);
      if (seen.has(key)) continue;
      seen.add(key);
      const field = fieldById.get(key);
      if (!field) continue;   // 字段表里没有的 id 直接跳过，不能让整页白屏
      out.push(legacyEntry(id, field));
    }
    return out;
  }

  function collectModel() {
    const current = state();
    const workflow = current.workflow || null;
    const graph = (workflow && workflow.graph) || null;
    const fields = Array.isArray(workflow && workflow.fields) ? workflow.fields : [];
    const fieldById = new Map();
    fields.forEach((field) => {
      if (field && field.id !== undefined && field.id !== null) fieldById.set(String(field.id), field);
    });

    const nodes = (Array.isArray(graph && graph.nodes) ? graph.nodes : []).filter(Boolean);
    const byId = new Map();
    const orderIndex = new Map();
    nodes.forEach((node, index) => {
      const id = String(node.id);
      byId.set(id, node);
      orderIndex.set(id, index);
    });

    // 出边＝把入边反过来；同一对节点之间多条连线只算一次。
    const outgoing = new Map();
    for (const node of nodes) {
      const target = String(node.id);
      const links = Array.isArray(node.links) ? node.links : [];
      for (const link of links) {
        const source = link && link.node !== undefined && link.node !== null ? String(link.node) : "";
        if (!source || source === target || !byId.has(source)) continue;
        if (!outgoing.has(source)) outgoing.set(source, []);
        const list = outgoing.get(source);
        if (!list.includes(target)) list.push(target);
      }
    }

    // 分组以「节点自己的 group 标题」为准（服务端已按最内层组算好），
    // graph.groups 只提供顺序和颜色；组里没有节点就不显示。
    const buckets = new Map();
    const ordered = [];
    const byTitle = new Map();
    const bucketFor = (id, title, color) => {
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = { id, title, color, nodes: [] };
        buckets.set(id, bucket);
        ordered.push(bucket);
      }
      if (title && !bucket.title) bucket.title = title;
      if (color && !bucket.color) bucket.color = color;
      if (bucket.title && !byTitle.has(bucket.title)) byTitle.set(bucket.title, bucket);
      return bucket;
    };

    const groups = (Array.isArray(graph && graph.groups) ? graph.groups : []).filter(Boolean);
    groups.forEach((group, index) => {
      const id = group.id === undefined || group.id === null || group.id === "" ? "g" + index : String(group.id);
      bucketFor(id, String(group.title || group.name || ""), String(group.color || ""));
    });

    const ungrouped = { id: UNGROUPED_ID, title: "", color: "", nodes: [] };
    const groupOf = new Map();
    for (const node of nodes) {
      const id = String(node.id);
      const title = String(node.group || "");
      let bucket = title ? byTitle.get(title) : null;
      // 标题在 graph.groups 里没有对应项（服务端漏了组）也要能看到，按标题补一个。
      if (!bucket && title) bucket = bucketFor("title:" + title, title, "");
      if (!bucket) bucket = ungrouped;
      bucket.nodes.push(node);
      groupOf.set(id, bucket.id);
    }

    const visible = ordered.filter((bucket) => bucket.nodes.length > 0);
    if (ungrouped.nodes.length) visible.push(ungrouped);
    for (const bucket of visible) groupOf.set(bucket.id, bucket.id);

    // 每个节点的输入 → 控件条目（顺序照抄服务端给的 inputs）。
    const entriesByNode = new Map();
    const index = new Map();
    let editableCount = 0;
    for (const node of nodes) {
      const id = String(node.id);
      const list = buildInputEntries(node, fieldById);
      entriesByNode.set(id, list);
      for (const entry of list) {
        if (!index.has(entry.key)) index.set(entry.key, entry);
        if (entry.kind !== "readonly" && !entry.link) editableCount += 1;
      }
    }
    entryIndex = index;

    return {
      workflow, graph, fields, fieldById, nodes, byId, orderIndex, outgoing,
      groups: visible, groupOf, entriesByNode, editableCount,
    };
  }

  function nodeInputs(node) {
    if (!node || !model) return [];
    return model.entriesByNode.get(String(node.id)) || [];
  }

  function values() {
    const current = state();
    return current && current.values && typeof current.values === "object" ? current.values : {};
  }

  function sameValue(left, right) {
    if (left === right) return true;
    if (left === null || left === undefined) return String(right === null || right === undefined ? "" : right) === "";
    if (right === null || right === undefined) return String(left) === "";
    if (typeof left === "number" || typeof right === "number") {
      const a = Number(left);
      const b = Number(right);
      if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
    }
    if (typeof left === "boolean" || typeof right === "boolean") return Boolean(left) === Boolean(right);
    return String(left) === String(right);
  }

  // 当前值 = state.values["<节点>::<输入名>"] ?? inputs[].value（服务器给的初始值）。
  function currentValue(entry) {
    const table = values();
    return Object.prototype.hasOwnProperty.call(table, entry.key) ? table[entry.key] : entry.initial;
  }

  function entryModified(entry) {
    return !sameValue(currentValue(entry), entry.initial);
  }

  function nodeModified(node) {
    return nodeInputs(node).some(entryModified);
  }

  function displayValue(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") {
      try {
        const text = JSON.stringify(value);
        if (typeof text === "string") {
          return text.length > MAX_READONLY_CHARS ? text.slice(0, MAX_READONLY_CHARS) + "…" : text;
        }
      } catch (error) { /* 循环引用之类：退回 String() */ }
    }
    return String(value);
  }

  /* -------------------------------------------------------------- 搜索与高亮 */

  function tokenize(value) {
    return String(value === undefined || value === null ? "" : value)
      .toLowerCase()
      .split(/[\s\u3000]+/)
      .filter(Boolean);
  }

  // 先找子串，再退化成子序列；返回命中字符的掩码（与入参文本等长）。
  function fuzzyMask(text, token) {
    if (!token) return null;
    const direct = text.indexOf(token);
    if (direct >= 0) {
      const mask = new Array(text.length).fill(0);
      for (let i = 0; i < token.length; i += 1) mask[direct + i] = 1;
      return mask;
    }
    const mask = new Array(text.length).fill(0);
    let cursor = 0;
    for (const char of token) {
      const found = text.indexOf(char, cursor);
      if (found < 0) return null;
      mask[found] = 1;
      cursor = found + 1;
    }
    return mask;
  }

  function mergeMask(current, length, next) {
    if (!current) return next;
    for (let i = 0; i < length; i += 1) if (next[i]) current[i] = 1;
    return current;
  }

  // 每个 token 都必须命中（标题/类型/#编号 任一即可），返回各字段的高亮掩码。
  function matchNode(node, tokens) {
    const texts = { title: nodeTitle(node), type: String(node.type || ""), id: "#" + String(node.id) };
    const lower = { title: texts.title.toLowerCase(), type: texts.type.toLowerCase(), id: texts.id.toLowerCase() };
    const marks = { title: null, type: null, id: null };
    for (const token of tokens) {
      let hit = false;
      for (const key of ["title", "type", "id"]) {
        if (!lower[key]) continue;
        const mask = fuzzyMask(lower[key], token);
        if (!mask) continue;
        marks[key] = mergeMask(marks[key], lower[key].length, mask);
        hit = true;
      }
      if (!hit) return null;
    }
    return marks;
  }

  function highlight(text, mask) {
    if (!mask || !mask.length) return deps.doc.createTextNode(text);
    const fragment = deps.doc.createDocumentFragment();
    let buffer = "";
    let mode = 0;
    const flush = () => {
      if (!buffer) return;
      if (mode) {
        const mark = el("mark");
        mark.textContent = buffer;
        fragment.append(mark);
      } else {
        fragment.append(deps.doc.createTextNode(buffer));
      }
      buffer = "";
    };
    for (let i = 0; i < text.length; i += 1) {
      const next = mask[i] ? 1 : 0;
      if (next !== mode && buffer) flush();
      mode = next;
      buffer += text[i];
    }
    flush();
    return fragment;
  }

  /* ------------------------------------------------------------- 页面骨架 */

  function ensurePieces(host, specs) {
    const nodes = specs.map((spec) => (spec.id ? deps.doc.getElementById(spec.id) : null) || spec.create());
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (host.contains(node)) continue;
      let anchor = null;
      for (let j = i + 1; j < nodes.length; j += 1) {
        if (host.contains(nodes[j])) { anchor = nodes[j]; break; }
      }
      host.insertBefore(node, anchor);
    }
    return nodes;
  }

  function createHeading() {
    const wrap = el("div", "section-heading page-heading");
    wrap.id = "advancedHeading";
    const copy = el("div");
    const eyebrow = el("span", "eyebrow", t("工作流"));
    const title = el("h2", null, t("高级"));
    title.id = "advancedTitle";
    copy.append(eyebrow, title);
    const button = el("button", "icon-button");
    button.id = "advancedExpandButton";
    button.type = "button";
    button.append(icon("expand"));
    wrap.append(copy, button);
    return wrap;
  }

  function createToolbar() {
    const wrap = el("div", "advanced-toolbar");
    wrap.id = "advancedToolbar";
    const field = el("span", "advanced-search");
    const input = el("input", "advanced-search-input");
    input.id = "advancedSearch";
    input.type = "search";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("搜索节点名、类型或编号");
    field.append(icon("search", "advanced-search-icon"), input);
    wrap.append(field);
    return wrap;
  }

  function createStatus() {
    const status = el("p", "advanced-status");
    status.id = "advancedStatus";
    status.setAttribute("role", "status");
    return status;
  }

  function createList() {
    const list = el("div", "advanced-list");
    list.id = "advancedList";
    return list;
  }

  function createEmpty() {
    const box = el("div", "empty-state hidden");
    box.id = "advancedEmpty";
    const shape = el("span", "empty-icon");
    shape.setAttribute("aria-hidden", "true");
    shape.append(icon("empty"));
    const title = el("h3", null, t("暂无工作流"));
    box.append(shape, title);
    return box;
  }

  function buildShell() {
    const doc = deps.doc;
    const host = deps.view || doc.getElementById("view-advanced") || doc.body;
    els.host = host;
    if (host && host.classList) host.classList.add("advanced-page");
    const pieces = ensurePieces(host, [
      { id: "advancedHeading", create: createHeading },
      { id: "advancedToolbar", create: createToolbar },
      { id: "advancedStatus", create: createStatus },
      { id: "advancedList", create: createList },
      { id: "advancedEmpty", create: createEmpty },
    ]);
    els.heading = pieces[0];
    els.toolbar = pieces[1];
    els.status = doc.getElementById("advancedStatus") || pieces[2];
    els.list = doc.getElementById("advancedList") || pieces[3];
    els.empty = doc.getElementById("advancedEmpty") || pieces[4];
    els.eyebrow = els.heading.querySelector(".eyebrow");
    els.title = els.heading.querySelector("h2");
    els.expandButton = els.heading.querySelector("#advancedExpandButton");
    els.search = els.toolbar.querySelector("#advancedSearch");
    els.emptyTitle = els.empty.querySelector("h3");
    if (els.expandButton && !els.expandButton.querySelector("svg")) els.expandButton.append(icon("expand"));
    if (els.search && !els.search.classList.contains("advanced-search-input")) els.search.classList.add("advanced-search-input");
  }

  function bindOnce(node, type, handler) {
    if (!node || !node.dataset) return;
    const key = "mtr" + type.charAt(0).toUpperCase() + type.slice(1) + "Bound";
    if (node.dataset[key] === "1") return;
    node.dataset[key] = "1";
    node.addEventListener(type, handler);
  }

  /* ------------------------------------------------------------ 卡片渲染 */

  function renderGroup(group, entries, searching) {
    const doc = deps.doc;
    const details = el("details", "advanced-group");
    details.dataset.groupId = group.id;
    const open = searching ? true : groupOpen(group.id);
    // 先脱机设好 open 再插入。注意 Chromium 之后仍会补一个 toggle 事件，
    // 所以这里记下「渲染时的预期状态」，toggle 时只有和预期不一致才算用户操作。
    details.dataset.mtrOpen = open ? "1" : "0";
    if (open) details.setAttribute("open", "");

    const summary = el("summary", "advanced-group-summary");
    const dot = el("span", "advanced-group-dot");
    dot.setAttribute("aria-hidden", "true");
    if (group.color) dot.style.backgroundColor = group.color;
    const title = el("span", "advanced-group-title");
    title.append(highlight(group.title || t("未分组"), null));
    const count = el("span", "advanced-group-count", String(entries.length));
    count.title = entries.length + " " + t("个节点");
    summary.append(dot, title, count, icon("chevron", "advanced-group-chevron"));
    details.append(summary);

    const body = el("div", "advanced-group-nodes");
    for (const entry of entries) body.append(renderNode(entry.node, entry.marks, searching));
    details.append(body);

    details.addEventListener("toggle", () => {
      const expected = details.dataset.mtrOpen === "1";
      if (details.open === expected) return;   // 建元素时补发的那一次，不是用户操作
      details.dataset.mtrOpen = details.open ? "1" : "0";
      if (searching) return;                   // 搜索期间的临时展开不覆盖用户偏好
      setGroupOpen(group.id, details.open);
    });
    return details;
  }

  function renderNode(node, marks, searching) {
    const doc = deps.doc;
    const id = String(node.id);
    const card = el("article", "advanced-node");
    card.dataset.nodeId = id;
    const open = searching || expandedNodes.has(id);
    if (open) card.classList.add("is-open");
    if (nodeModified(node)) card.classList.add("is-modified");

    const toggle = el("button", "advanced-node-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    const head = el("span", "advanced-node-head");
    const title = el("span", "advanced-node-title");
    title.append(highlight(nodeTitle(node), marks && marks.title));
    const meta = el("span", "advanced-node-meta");
    const type = String(node.type || "");
    if (type) {
      const typeText = el("span", "advanced-node-type");
      typeText.append(highlight(type, marks && marks.type));
      meta.append(typeText);
    }
    const idText = el("span", "advanced-node-id");
    idText.append(highlight("#" + id, marks && marks.id));
    meta.append(idText);
    head.append(title, meta);
    toggle.append(icon("chevron", "advanced-node-chevron"), head);
    if (nodeModified(node)) toggle.append(modifiedStar());
    toggle.addEventListener("click", () => toggleNode(id));
    card.append(toggle);

    if (open) card.append(renderBody(node));
    const links = renderLinks(node);
    if (links) card.append(links);

    cards.set(id, card);
    return card;
  }

  function modifiedStar() {
    const star = el("span", "advanced-node-modified", "★");
    const label = t("已修改");
    star.title = label;
    star.setAttribute("aria-label", label);
    return star;
  }

  function renderBody(node) {
    const body = el("div", "advanced-node-body");
    const list = nodeInputs(node);
    if (!list.length) {
      body.append(el("p", "advanced-node-empty", t("无可调参数")));
      return body;
    }
    for (const entry of list) body.append(renderInput(entry));
    return body;
  }

  // 一个输入一行：上行是输入名（不翻译，必须与画布/API 一致）+ 类型小字，下行是控件。
  function renderInput(entry) {
    const wrap = el("div", "advanced-input");
    wrap.dataset.valueKey = entry.key;
    wrap.dataset.inputName = entry.name;
    if (entry.type) wrap.dataset.inputType = entry.type;
    const head = el("div", "advanced-input-head");
    head.append(el("span", "advanced-input-name", entry.name));
    if (entry.type) head.append(el("span", "advanced-input-type", entry.type));
    const slot = el("div", "advanced-input-control");
    if (entry.frontend) {
      wrap.dataset.inputFrontend = "1";
      slot.classList.add("is-frontend");
    }
    wrap.append(head, slot);
    inputRows.set(entry.key, wrap);

    if (entry.link) {
      slot.append(linkChip(entry));
      return wrap;
    }
    const control = buildControl(entry);
    if (control) slot.append(control);
    // 前端专有控件（种子模式之类）只影响手机端，旁边灰字说明一句。
    if (entry.frontend) slot.append(el("span", "advanced-input-note", t("仅手机端设置")));
    if (entry.kind === "number") wrap.append(el("p", "advanced-input-warning", t("输入值无效")));
    return wrap;
  }

  // 被连线接管的输入：只读芯片，点一下仍然跳到源节点。
  function linkChip(entry) {
    const source = model && entry.link ? model.byId.get(String(entry.link.node)) : null;
    const nodeId = String(entry.link ? entry.link.node : "");
    const name = source ? nodeTitle(source) : "#" + nodeId;
    const button = el("button", "advanced-chip is-in advanced-input-link");
    button.type = "button";
    button.dataset.jump = nodeId;
    button.title = "#" + nodeId;
    button.append(el("span", "advanced-chip-text", t("已连接：来自 {name}", { name })));
    return button;
  }

  function numericAttr(value) {
    if (value === undefined || value === null || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? String(numeric) : null;
  }

  function buildControl(entry) {
    const current = currentValue(entry);
    if (entry.kind === "readonly") {
      const box = el("div", "advanced-input-readonly");
      box.append(el("span", "advanced-input-value", displayValue(current)));
      box.append(el("span", "advanced-input-hint", t("此类型暂不支持编辑")));
      return box;
    }
    if (entry.kind === "select") {
      const select = el("select", "advanced-input-select");
      const options = entry.options.map((value) => String(value));
      const text = displayValue(current);
      // 当前值不在候选里（换过模型/自定义值）也要能显示，补一个当前值项在最前面。
      if (!options.includes(text)) options.unshift(text);
      for (const value of options) {
        const option = el("option", null, value);
        option.value = value;
        select.append(option);
      }
      select.value = text;
      controls.set(entry.key, select);
      return select;
    }
    if (entry.kind === "toggle") {
      const label = el("label", "advanced-input-toggle");
      const box = el("input", "advanced-checkbox");
      box.type = "checkbox";
      box.checked = Boolean(current);
      box.setAttribute("aria-label", entry.name);
      label.append(box);
      controls.set(entry.key, box);
      return label;
    }
    if (entry.kind === "number") {
      const input = el("input", "advanced-input-number");
      input.type = "number";
      const min = numericAttr(entry.min);
      const max = numericAttr(entry.max);
      const step = numericAttr(entry.step);
      if (min !== null) input.min = min;
      if (max !== null) input.max = max;
      if (step !== null) input.step = step;
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.value = current === undefined || current === null || typeof current === "object" ? "" : String(current);
      controls.set(entry.key, input);
      return input;
    }
    if (entry.kind === "textarea") {
      const area = el("textarea", "advanced-input-textarea");
      area.rows = 2;
      area.spellcheck = false;
      area.value = displayValue(current);
      controls.set(entry.key, area);
      growLater(area);
      return area;
    }
    const input = el("input", "advanced-input-text");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = displayValue(current);
    controls.set(entry.key, input);
    return input;
  }

  /* ------------------------------------------------------------ 值的读写 */

  // 合成 field：id = "<节点>::<输入名>"，服务端按这个形状应用到 prompt 上。
  function fieldForEntry(entry) {
    return {
      id: entry.key,
      node_id: entry.nodeId,
      input: entry.name,
      kind: entry.kind === "readonly" ? "text" : entry.kind,
      value: entry.initial,
    };
  }

  function parseNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const text = String(value === undefined || value === null ? "" : value).trim();
    if (!text) return null;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function markInvalid(key, invalid) {
    const wrap = inputRows.get(String(key));
    if (wrap) wrap.classList.toggle("is-invalid", Boolean(invalid));
  }

  function applyEdit(key, raw) {
    const entry = entryIndex.get(String(key));
    if (!entry || entry.link || entry.kind === "readonly") return;
    let next = raw;
    if (entry.kind === "number") {
      const parsed = parseNumber(raw);
      // 空/非数字：不写进 state.values（提交上去也是错的），只在控件下面提示。
      if (parsed === null) { markInvalid(entry.key, true); return; }
      next = parsed;
    } else if (entry.kind === "toggle") {
      next = Boolean(raw);
    } else {
      next = raw === undefined || raw === null ? "" : String(raw);
    }
    markInvalid(entry.key, false);
    const table = values();
    if (table && typeof table === "object") table[entry.key] = next;
    const field = fieldForEntry(entry);
    if (typeof deps.updateFieldValue === "function") {
      try {
        deps.updateFieldValue(field, next);
      } catch (error) { /* 生成页的副作用失败也不能拦住高级页自己的改动 */ }
    }
    paintNodeFlag(entry.nodeId);
    if (typeof deps.onEdit === "function") {
      try {
        deps.onEdit(field, next);
      } catch (error) { /* 回调由调用方负责 */ }
    }
  }

  function paintNodeFlag(nodeId) {
    const card = cards.get(String(nodeId));
    if (!card) return;
    const node = model ? model.byId.get(String(nodeId)) : null;
    const modified = node ? nodeModified(node) : false;
    card.classList.toggle("is-modified", modified);
    const toggle = card.querySelector(".advanced-node-toggle");
    if (!toggle) return;
    const star = toggle.querySelector(".advanced-node-modified");
    if (modified && !star) toggle.append(modifiedStar());
    else if (!modified && star) star.remove();
  }

  function selectHasOption(select, value) {
    for (const option of select.options) {
      if (option.value === value) return true;
    }
    return false;
  }

  // 只改显示，不碰 state.values（调用方负责那份数据）。
  function setControlValue(entry, control, value) {
    if (!control) return;
    if (entry.kind === "toggle") {
      control.checked = Boolean(value);
      return;
    }
    if (entry.kind === "select") {
      const text = displayValue(value);
      if (!selectHasOption(control, text)) {
        const option = el("option", null, text);
        option.value = text;
        control.prepend(option);
      }
      control.value = text;
      return;
    }
    if (control.value === undefined) return;
    const text = displayValue(value);
    if (control.value === text) return;
    // 正在这个控件里打字时别把光标甩到末尾。
    const focused = deps.doc && deps.doc.activeElement === control;
    const start = focused ? control.selectionStart : null;
    const end = focused ? control.selectionEnd : null;
    control.value = text;
    if (typeof start === "number" && typeof control.setSelectionRange === "function") {
      try { control.setSelectionRange(start, end); } catch (error) { /* number 之类不支持选区 */ }
    }
  }

  // 生成页改了值（多模型轮换、草稿、尺寸预设……）时，只对齐这一个已渲染的控件。
  function syncValue(fieldId, value) {
    const entry = entryIndex.get(String(fieldId));
    if (!entry || entry.link) return api;
    const control = controls.get(entry.key);
    if (!control || control.isConnected === false) return api;
    setControlValue(entry, control, value);
    markInvalid(entry.key, false);
    paintNodeFlag(entry.nodeId);
    return api;
  }

  // 切页时把当前已渲染的控件按 state.values 全部对齐一遍（不整块重渲染）。
  function syncAll() {
    if (!mounted) return api;
    for (const [key, control] of controls) {
      const entry = entryIndex.get(key);
      if (!entry || !control || control.isConnected === false) continue;
      setControlValue(entry, control, currentValue(entry));
      markInvalid(key, false);
    }
    if (model) {
      for (const node of model.nodes) paintNodeFlag(String(node.id));
    }
    return api;
  }

  // 多行文本按内容长高（量不到高度就算了，CSS 里有 min-height 兜底）。
  function growArea(area) {
    if (!area) return;
    area.style.height = "auto";
    const height = area.scrollHeight;
    if (typeof height !== "number" || height <= 0) {
      area.style.height = "";
      return;
    }
    area.style.height = height + "px";
  }

  function growLater(area) {
    const timer = win();
    if (!timer || typeof timer.requestAnimationFrame !== "function") return;
    timer.requestAnimationFrame(() => growArea(area));
  }

  // 节点里的小按钮（例如数字步进）可能绕过 input 事件直接改值：点完统一回读一次。
  function readBack(key) {
    const timer = win();
    if (!timer || typeof timer.setTimeout !== "function") return;
    timer.setTimeout(() => {
      const entry = entryIndex.get(String(key));
      if (!entry || entry.link || entry.kind === "readonly") return;
      const control = controls.get(String(key));
      if (!control || control.isConnected === false) return;
      applyEdit(key, readControlValue(control));
    }, 0);
  }

  function readControlValue(control) {
    if (!control) return "";
    if (control.type === "checkbox") return Boolean(control.checked);
    return control.value === undefined ? "" : control.value;
  }

  function onListEvent(event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    if (event.type === "click") {
      const chip = target.closest("[data-jump]");
      if (chip) {
        event.preventDefault();
        openNode(chip.dataset.jump);
        return;
      }
      const row = target.closest("[data-value-key]");
      if (row) readBack(row.dataset.valueKey);
      return;
    }
    const row = target.closest("[data-value-key]");
    if (!row) return;
    const tag = target.tagName;
    const toggleLike = tag === "SELECT" || target.type === "checkbox" || target.type === "radio";
    if (event.type === "input" && toggleLike) return;
    if (event.type === "change" && !toggleLike) return;
    applyEdit(row.dataset.valueKey, readControlValue(target));
    if (event.type === "input" && tag === "TEXTAREA") growArea(target);
  }

  function renderLinks(node) {
    const doc = deps.doc;
    const incoming = [];
    const links = Array.isArray(node.links) ? node.links : [];
    for (const link of links) {
      const source = link && link.node !== undefined && link.node !== null ? String(link.node) : "";
      if (!source || !model.byId.has(source) || incoming.includes(source)) continue;
      incoming.push(source);
    }
    const outgoing = (model.outgoing.get(String(node.id)) || [])
      .slice()
      .sort((a, b) => (model.orderIndex.get(a) || 0) - (model.orderIndex.get(b) || 0));
    if (!incoming.length && !outgoing.length) return null;

    const wrap = el("div", "advanced-node-links");
    const chip = (kind, targetId, text) => {
      const button = el("button", "advanced-chip is-" + kind);
      button.type = "button";
      button.dataset.jump = targetId;
      button.title = "#" + targetId;
      button.append(el("span", "advanced-chip-text", text));
      return button;
    };
    for (const id of incoming) {
      wrap.append(chip("in", id, t("来自 {name}", { name: nodeTitle(model.byId.get(id)) })));
    }
    for (const id of outgoing) {
      wrap.append(chip("out", id, t("被 {name} 使用", { name: nodeTitle(model.byId.get(id)) })));
    }
    return wrap;
  }

  /* -------------------------------------------------------------- 交互 */

  function allExpanded() {
    if (!model || !model.nodes.length) return false;
    const groupsOpen = model.groups.every((group) => groupOpen(group.id));
    const nodesOpen = model.nodes.every((node) => expandedNodes.has(String(node.id)));
    return groupsOpen && nodesOpen;
  }

  function toggleNode(id) {
    if (expandedNodes.has(id)) expandedNodes.delete(id);
    else expandedNodes.add(id);
    render();
  }

  function toggleAll() {
    if (!model) return api;
    const expand = !allExpanded();
    for (const group of model.groups) setGroupOpen(group.id, expand);
    expandedNodes.clear();
    if (expand) for (const node of model.nodes) expandedNodes.add(String(node.id));
    render();
    return api;
  }

  function openNode(nodeId) {
    if (!mounted) return null;
    const id = String(nodeId);
    if (!model || !model.byId.has(id)) return null;
    // 搜索框里有内容时目标可能被过滤掉，先清空再跳。
    if (query) setQuery("", { render: false });
    expandedNodes.add(id);
    const groupId = model.groupOf.get(id);
    if (groupId) setGroupOpen(groupId, true);
    render();
    const card = cards.get(id);
    if (!card) return null;
    const timer = win();
    if (timer && typeof timer.clearTimeout === "function") timer.clearTimeout(flashTimer);
    card.classList.add("is-flash");
    if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "center", behavior: "smooth" });
    if (timer && typeof timer.setTimeout === "function") {
      flashTimer = timer.setTimeout(() => card.classList.remove("is-flash"), FLASH_MS);
    }
    return card;
  }

  /* -------------------------------------------------------------- 渲染 */

  function paintChrome() {
    const expanded = allExpanded();
    if (els.eyebrow) els.eyebrow.textContent = t("工作流");
    if (els.title) els.title.textContent = t("高级");
    if (els.search) {
      const placeholder = t("搜索节点名、类型或编号");
      if (els.search.placeholder !== placeholder) els.search.placeholder = placeholder;
      els.search.setAttribute("aria-label", placeholder);
    }
    if (els.expandButton) {
      const label = expanded ? t("全部收起") : t("全部展开");
      els.expandButton.classList.toggle("active", expanded);
      els.expandButton.setAttribute("aria-pressed", expanded ? "true" : "false");
      els.expandButton.setAttribute("aria-label", label);
      els.expandButton.title = label;
      els.expandButton.replaceChildren(icon(expanded ? "collapse" : "expand"));
    }
    const count = model ? model.nodes.length : 0;
    if (els.status) {
      els.status.textContent = count
        ? count + " " + t("个节点") + " · " + model.editableCount + " " + t("个可调参数")
        : "";
    }
    if (els.empty) {
      els.empty.classList.toggle("hidden", count > 0);
      if (els.emptyTitle) els.emptyTitle.textContent = t("暂无工作流");
    }
  }

  // 整块重渲染（搜索/展开收起/切页）时记住正在编辑的控件，重建后把焦点和光标还回去，
  // 免得用户打到一半被踢出输入框。
  function focusSnapshot() {
    const doc = deps.doc;
    const active = doc && doc.activeElement;
    if (!active || !els.list || !els.list.contains(active)) return null;
    const row = typeof active.closest === "function" ? active.closest("[data-value-key]") : null;
    if (!row) return null;
    const snapshot = { key: row.dataset.valueKey };
    if (typeof active.selectionStart === "number") {
      snapshot.start = active.selectionStart;
      snapshot.end = active.selectionEnd;
    }
    return snapshot;
  }

  function restoreFocus(snapshot) {
    if (!snapshot) return;
    const control = controls.get(snapshot.key);
    if (!control || typeof control.focus !== "function") return;
    try {
      control.focus({ preventScroll: true });
    } catch (error) {
      try { control.focus(); } catch (inner) { return; }
    }
    if (typeof snapshot.start === "number" && typeof control.setSelectionRange === "function") {
      try { control.setSelectionRange(snapshot.start, snapshot.end); } catch (error) { /* number 之类不支持选区 */ }
    }
  }

  function render() {
    if (!mounted) return api;
    if (groupScope !== scopeId()) loadGroupState();
    model = collectModel();
    const tokens = tokenize(query);
    // 搜索命中时自动展开命中的节点；同一条搜索只自动展开一次，
    // 之后用户手动收起就保持收起。
    if (!tokens.length) {
      autoExpandedFor = null;
    } else if (autoExpandedFor !== query) {
      autoExpandedFor = query;
      for (const node of model.nodes) if (matchNode(node, tokens)) expandedNodes.add(String(node.id));
    }

    paintChrome();
    cards.clear();
    controls.clear();
    inputRows.clear();
    if (!els.list) return api;
    const fragment = deps.doc.createDocumentFragment();
    let shown = 0;
    for (const group of model.groups) {
      const entries = [];
      for (const node of group.nodes) {
        const marks = tokens.length ? matchNode(node, tokens) : null;
        if (tokens.length && !marks) continue;
        entries.push({ node, marks });
      }
      if (!entries.length) continue;
      shown += entries.length;
      fragment.append(renderGroup(group, entries, tokens.length > 0));
    }
    if (tokens.length && !shown) fragment.append(el("p", "advanced-nomatch", t("没有匹配的节点")));
    const focused = focusSnapshot();
    els.list.replaceChildren(fragment);
    restoreFocus(focused);
    return api;
  }

  function setQuery(value, options) {
    query = String(value === undefined || value === null ? "" : value);
    if (els.search && els.search.value !== query) els.search.value = query;
    if (!options || options.render !== false) render();
    return api;
  }

  /* ------------------------------------------------------------------ 样式 */

  function ensureStyles() {
    const doc = deps.doc;
    if (doc.getElementById(STYLE_ID)) return;
    const link = doc.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = deps.styleHref || DEFAULT_STYLE_HREF;
    doc.head.append(link);
  }

  /* ------------------------------------------------------------------ 接口 */

  function mount(options) {
    const settings = options || {};
    const doc = settings.document || (typeof document !== "undefined" ? document : null);
    if (!doc) throw new Error("MobileAdvanced.mount 需要一个 document");
    deps.doc = doc;
    // settings.renderField / settings.$ 仍然接受但不再使用：控件由本模块自己渲染。
    if (settings.t) deps.t = settings.t;
    if (settings.state) deps.state = settings.state;
    if (settings.updateFieldValue) deps.updateFieldValue = settings.updateFieldValue;
    if (settings.onEdit) deps.onEdit = settings.onEdit;
    if (settings.window) deps.window = settings.window;
    if (Object.prototype.hasOwnProperty.call(settings, "storage")) deps.storage = settings.storage;
    if (settings.styleHref) deps.styleHref = settings.styleHref;
    if (settings.view) {
      deps.view = typeof settings.view === "string" ? doc.getElementById(settings.view) : settings.view;
    }
    if (settings.styles !== false) ensureStyles();
    buildShell();
    bindOnce(els.search, "input", (event) => setQuery(event.target.value));
    bindOnce(els.search, "search", (event) => setQuery(event.target.value));
    bindOnce(els.expandButton, "click", () => toggleAll());
    bindOnce(els.list, "input", onListEvent);
    bindOnce(els.list, "change", onListEvent);
    bindOnce(els.list, "click", onListEvent);
    mounted = true;
    loadGroupState();
    render();
    return api;
  }

  function setState(next) {
    deps.state = next;
    if (mounted) render();
    return api;
  }

  function show() {
    if (!mounted) return api;
    ensureStyles();
    // 回到高级页时按 state.values 整块重渲染：生成页/草稿里的改动立刻可见。
    render();
    return api;
  }

  function destroy() {
    if (flashTimer) win().clearTimeout(flashTimer);
    flashTimer = 0;
    for (const node of [els.heading, els.toolbar, els.status, els.list, els.empty]) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    const link = deps.doc && deps.doc.getElementById(STYLE_ID);
    if (link && link.parentNode) link.parentNode.removeChild(link);
    controls.clear();
    inputRows.clear();
    cards.clear();
    expandedNodes.clear();
    groupState.clear();
    entryIndex = new Map();
    groupScope = null;
    model = null;
    mounted = false;
    return api;
  }

  const api = {
    version: VERSION,
    mount,
    render,
    setState,
    refresh: () => render(),
    show,
    destroy,
    openNode,
    syncValue,
    syncAll,
    setQuery,
    getQuery: () => query,
    toggleAll,
    isMounted: () => mounted,
    elements: () => els,
  };

  const root = typeof window !== "undefined" ? window : globalThis;
  root.MobileAdvanced = api;
})();
