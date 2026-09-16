/* ComfyUI 手机端「高级」页：按组/节点浏览、搜索并编辑工作流参数。
 *
 * 与生成页解耦的三条硬规则：
 *  1. 页面 DOM 全部由本模块创建（#advancedList / #advancedStatus / #advancedSearch /
 *     #advancedEmpty / #advancedExpandButton），不依赖 index.html 里已有的元素；
 *     宿主里若已存在同 id 的元素则直接复用，不会产生重复 id。
 *  2. 依赖一律通过 mount() 注入（t / state / $ / renderField / updateFieldValue），
 *     本模块不引用 app.js 里的任何变量。
 *  3. 样式表由 mount() 自己挂 <link>，不改 mobile/styles.css。
 *
 * 数据来源：GET /mobile/api/workflows/<id> 返回的 workflow.graph（nodes/groups）
 * 与 workflow.fields。字段值只有一份真相：state.values[field.id]，
 * 所以高级页改完，回到生成页点生成即生效。
 */
(() => {
  "use strict";

  const VERSION = "202609306";
  const STYLE_ID = "mtr-advanced-styles";
  const DEFAULT_STYLE_HREF = "/mobile/assets/advanced.css?v=" + VERSION;
  // 组折叠状态：{ "<工作流 id>": { "<组 id>": true|false } }
  const STORAGE_KEY = "comfy-mobile-remote.advancedGroups";
  const UNGROUPED_ID = "__ungrouped__";
  const FLASH_MS = 1200;
  const SVG_NS = "http://www.w3.org/2000/svg";

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
    $: null,
    state: null,
    renderField: null,
    updateFieldValue: null,
    onEdit: null,
    window: null,
    storage: undefined,
  };

  const els = {
    host: null, heading: null, eyebrow: null, title: null, expandButton: null,
    toolbar: null, search: null, status: null, list: null, empty: null, emptyTitle: null,
  };

  // 本模块自己的控件表（生成页那份 state.fieldControls 不碰）。
  const controls = new Map();
  const cards = new Map();
  const expandedNodes = new Set();
  const groupState = new Map();
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

  function pick(id) {
    if (typeof deps.$ === "function") {
      try {
        const found = deps.$(id);
        if (found) return found;
      } catch (error) { /* 注入的 $ 只认自己的表，找不到就退回 document */ }
    }
    // 生成页的控件在另一个 view 里，必须查整篇文档。
    return deps.doc ? deps.doc.getElementById(id) : null;
  }

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

  function collectModel() {
    const current = state();
    const workflow = current.workflow || null;
    const graph = (workflow && workflow.graph) || null;
    const fields = Array.isArray(workflow && workflow.fields) ? workflow.fields : [];
    const fieldById = new Map();
    fields.forEach((field, index) => {
      if (field && field.id !== undefined && field.id !== null) fieldById.set(String(field.id), { field, index });
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

    let editableCount = 0;
    const seen = new Set();
    for (const node of nodes) {
      const ids = Array.isArray(node.field_ids) ? node.field_ids : [];
      for (const id of ids) {
        const key = String(id);
        if (seen.has(key) || !fieldById.has(key)) continue;
        seen.add(key);
        editableCount += 1;
      }
    }

    return { workflow, graph, fields, fieldById, nodes, byId, orderIndex, outgoing, groups: visible, groupOf, editableCount };
  }

  function nodeFields(node) {
    const ids = Array.isArray(node && node.field_ids) ? node.field_ids : [];
    const out = [];
    const seen = new Set();
    for (const id of ids) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = model && model.fieldById.get(key);
      if (entry) out.push(entry);
    }
    return out;
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

  function fieldValue(field) {
    const table = values();
    return Object.prototype.hasOwnProperty.call(table, field.id) ? table[field.id] : field.value;
  }

  function isModified(field) {
    const table = values();
    if (!Object.prototype.hasOwnProperty.call(table, field.id)) return false;
    return !sameValue(table[field.id], field.value);
  }

  function nodeModified(node) {
    return nodeFields(node).some(({ field }) => isModified(field));
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
    const fields = nodeFields(node);
    if (!fields.length) {
      body.append(el("p", "advanced-node-empty", t("无可调参数")));
      return body;
    }
    for (const entry of fields) body.append(renderControl(entry.field, entry.index));
    return body;
  }

  function sharedControlMap() {
    const current = state();
    return current && current.fieldControls && typeof current.fieldControls.get === "function"
      ? current.fieldControls
      : null;
  }

  function fallbackField(field) {
    const wrapper = el("label", "field");
    wrapper.dataset.input = String(field.input || "");
    const row = el("span", "field-label-row");
    row.append(el("span", "field-label", t(field.label || field.id)));
    const input = el("input");
    input.type = field.kind === "number" ? "number" : "text";
    const current = fieldValue(field);
    input.value = current === undefined || current === null ? "" : String(current);
    wrapper.append(row, input);
    return wrapper;
  }

  function renderControl(field, index) {
    const before = controls.get(field.id) || null;
    const shared = sharedControlMap();
    const sharedBefore = shared ? shared.get(field.id) || null : null;

    let wrapper = null;
    if (typeof deps.renderField === "function") {
      try {
        // 第 4 个参数是生成页 renderField 新增的可选控件表；旧版本会忽略它，
        // 这时控件会被塞进 state.fieldControls，下面负责还回去。
        wrapper = deps.renderField(field, index, false, controls);
      } catch (error) {
        wrapper = null;
      }
    }
    if (!wrapper || !wrapper.nodeType) wrapper = fallbackField(field);

    let control = null;
    const mine = controls.get(field.id);
    if (mine && wrapper.contains(mine)) control = mine;
    if (!control && shared) {
      const candidate = shared.get(field.id);
      if (candidate && wrapper.contains(candidate)) control = candidate;
    }
    if (!control) control = wrapper.querySelector("input, textarea, select");
    if (control) controls.set(field.id, control);

    // 注入的 renderField 若不认第 4 个参数，会把生成页那份引用覆盖掉：恢复它，
    // 免得生成页的尺寸预设等逻辑写到高级页的控件上。
    if (shared && control) {
      const sharedAfter = shared.get(field.id) || null;
      if (sharedAfter === control && sharedAfter !== sharedBefore) {
        if (sharedBefore) shared.set(field.id, sharedBefore);
        else shared.delete(field.id);
      }
    }

    wrapper.dataset.fieldId = String(field.id);
    // 生成页的控件 id 是 field-<下标>，高级页再来一份会撞车（getElementById 只认第一个），
    // 所以这里摘掉自己的 id，两个页面各更新各的。
    if (control && control.id) control.removeAttribute("id");
    return wrapper;
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

  function readControlValue(control) {
    if (!control) return "";
    if (control.type === "checkbox") return Boolean(control.checked);
    return control.value === undefined ? "" : control.value;
  }

  function isImageField(field) {
    return Boolean(field) && (field.kind === "image" || field.input === "image");
  }

  // 和生成页保持同一种取值形态（数字字段给 number、开关给 boolean），
  // 否则 state.values 里会混进字符串，提交给 ComfyUI 的类型就对不上了。
  function normaliseValue(field, value) {
    if (field && field.kind === "number") {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : value;
    }
    if (field && field.kind === "toggle") return Boolean(value);
    return value;
  }

  function applyEdit(fieldId, value) {
    const entry = model ? model.fieldById.get(String(fieldId)) : null;
    if (!entry) return;
    const field = entry.field;
    const next = normaliseValue(field, value);
    const table = values();
    if (table && typeof table === "object") table[field.id] = next;
    if (typeof deps.updateFieldValue === "function") {
      try {
        deps.updateFieldValue(field, next);
      } catch (error) { /* 生成页的副作用失败也不能拦住高级页自己的改动 */ }
    }
    syncGenerateControl(field, entry.index, next);
    paintNodeFlag(nodeIdOfField(field));
    if (typeof deps.onEdit === "function") {
      try {
        deps.onEdit(field, value);
      } catch (error) { /* 回调由调用方负责 */ }
    }
  }

  // 生成页对应控件 id 是 field-<该字段在 workflow.fields 里的下标>。
  function syncGenerateControl(field, index, value) {
    if (!Number.isInteger(index) || index < 0) return;
    const node = pick("field-" + index);
    if (!node || node === controls.get(field.id)) return;
    if (node.type === "checkbox") node.checked = Boolean(value);
    else if ("value" in node) node.value = value === undefined || value === null ? "" : String(value);
  }

  // fields 里通常带 node_id；万一没有，就按 field_ids 反查。
  function nodeIdOfField(field) {
    if (field && field.node_id !== undefined && field.node_id !== null && field.node_id !== "") {
      return String(field.node_id);
    }
    const id = String((field && field.id) || "");
    for (const node of (model ? model.nodes : [])) {
      const ids = Array.isArray(node.field_ids) ? node.field_ids : [];
      if (ids.some((value) => String(value) === id)) return String(node.id);
    }
    return "";
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

  // 节点里的小按钮（例如数字步进）可能绕过 input 事件直接改值：点完统一回读一次。
  function readBack(fieldId) {
    const timer = win();
    if (!timer || typeof timer.setTimeout !== "function") return;
    timer.setTimeout(() => {
      const entry = model ? model.fieldById.get(String(fieldId)) : null;
      if (!entry || isImageField(entry.field)) return;
      const control = controls.get(String(fieldId));
      if (!control || control.isConnected === false) return;
      applyEdit(fieldId, readControlValue(control));
    }, 0);
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
      const wrapper = target.closest("[data-field-id]");
      if (wrapper) readBack(wrapper.dataset.fieldId);
      return;
    }
    const wrapper = target.closest("[data-field-id]");
    if (!wrapper) return;
    // 图像控件由生成页自己上传，这里既不读也不写。
    if (target.type === "file") return;
    const tag = target.tagName;
    const toggleLike = tag === "SELECT" || target.type === "checkbox" || target.type === "radio";
    if (event.type === "input" && toggleLike) return;
    if (event.type === "change" && !toggleLike) return;
    const entry = model ? model.fieldById.get(String(wrapper.dataset.fieldId)) : null;
    if (entry && isImageField(entry.field)) return;
    applyEdit(wrapper.dataset.fieldId, readControlValue(target));
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
    els.list.replaceChildren(fragment);
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
    if (settings.t) deps.t = settings.t;
    if (settings.$) deps.$ = settings.$;
    if (settings.state) deps.state = settings.state;
    if (settings.renderField) deps.renderField = settings.renderField;
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
    cards.clear();
    expandedNodes.clear();
    groupState.clear();
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
    setQuery,
    getQuery: () => query,
    toggleAll,
    isMounted: () => mounted,
    elements: () => els,
  };

  const root = typeof window !== "undefined" ? window : globalThis;
  root.MobileAdvanced = api;
})();
