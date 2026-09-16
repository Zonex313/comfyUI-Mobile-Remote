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
 *  4. 连线画在对应的输入/输出行上（照参考项目 CueForge 的做法）：输入行是「← 对端节点标题 ·
 *     插槽号」方向按钮，卡片底部是「→ 输出到」区，逐条列「→ 对端节点标题 · 对端输入名」。
 *     点方向按钮跳到对端节点（展开组与节点、滚到视野中间、高亮 1.2 秒）。
 *  5. 一个输出槽接了多个节点时，点方向按钮先弹就地小菜单让用户选去哪一个；只有一条时直接跳。
 *  6. 样式表由 mount() 自己挂 <link>，不改 mobile/styles.css。
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

  const VERSION = "202610125";
  const STYLE_ID = "mtr-advanced-styles";
  const DEFAULT_STYLE_HREF = "/mobile/assets/advanced.css?v=" + VERSION;
  // 组折叠状态：{ "<工作流 id>": { "<组 id>": true|false } }
  const STORAGE_KEY = "comfy-mobile-remote.advancedGroups";
  const UNGROUPED_ID = "__ungrouped__";
  const FLASH_MS = 1200;
  // 小菜单刚弹出后这么久内的滚动不算「用户在滚」（上一次跳转的平滑滚动可能还在飞）。
  const JUMP_MENU_GRACE_MS = 400;
  const SVG_NS = "http://www.w3.org/2000/svg";
  // 只读回显要限长：自定义节点可能把整个对象塞进一个不认识的输入。
  const MAX_READONLY_CHARS = 240;

  const ICONS = {
    chevron: ["m6 9 6 6 6-6"],
    chevronRight: ["m9 6 6 6-6 6"],
    chevronDown: ["m6 9 6 6 6-6"],
    expand: ["M4 9V6a2 2 0 0 1 2-2h3", "M15 4h3a2 2 0 0 1 2 2v3", "M20 15v3a2 2 0 0 1-2 2h-3", "M9 20H6a2 2 0 0 1-2-2v-3"],
    collapse: ["M9 4v3a2 2 0 0 1-2 2H4", "M15 4v3a2 2 0 0 0 2 2h3", "M20 15h-3a2 2 0 0 0-2 2v3", "M4 15h3a2 2 0 0 1 2 2v3"],
    search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "M21 21l-4.3-4.3"],
    empty: ["M4 7h16", "M4 12h16", "M4 17h10"],
    // 菜单图标：照参考项目（lucide 风格）的一套描边图标。
    pencil: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
    palette: ["M12 21a9 9 0 1 1 0-18c4.97 0 9 3.58 9 8 0 2.5-2 4-4.5 4H15a2 2 0 0 0-1.6 3.2A2 2 0 0 1 12 21Z", "M7.5 10.5h.01", "M11 7.5h.01", "M15.5 9h.01"],
    check: ["M20 6 9 17l-5-5"],
    power: ["M12 3v9", "M18.4 6.6a9 9 0 1 1-12.8 0"],
    eyeOff: ["M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94", "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19", "M1 1l22 22"],
    copy: ["M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
    clipboard: ["M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M9 2h6v4H9z"],
    paste: ["M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M12 11v6", "M9 14l3 3 3-3"],
    trash: ["M3 6h18", "M8 6V4h8v2", "M6 6l1 14h10l1-14"],
    bookmark: ["M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"],
    plus: ["M12 5v14", "M5 12h14"],
  };

  /* ------------------------------------------------------------------ 依赖 */

  const deps = {
    doc: null,
    t: null,
    state: null,
    updateFieldValue: null,
    onEdit: null,
    onAction: null,
    onGroupAction: null,
    window: null,
    storage: undefined,
    view: null,
    styleHref: null,
  };

  const els = {
    host: null, heading: null, eyebrow: null, title: null, expandButton: null,
    toolbar: null, search: null, legendIn: null, legendOut: null,
    status: null, list: null, empty: null, emptyTitle: null,
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
  // 就地弹出的「选择要跳转的节点」小菜单（同一时刻最多一个）。
  let jumpMenu = null;
  let jumpMenuAnchor = null;
  let jumpMenuOpenedAt = 0;
  const undoStack = [];
  const redoStack = [];
  let applyingHistory = false;

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

  // 连线里的槽位号：服务端给的是数字，旧数据可能是字符串，缺了就按 0 算。
  function normalizeSlot(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
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
    // 入边以 inputs[].link 为准（服务端已算好）；节点的 inputs 缺失（旧服务端）时退回
    // node.links，至少让连线还看得见。出边反过来推：遍历每个节点的 inputs[].link，
    // 指向本节点的那些就是本节点的出边（同一个输出槽可以接好几个节点）。
    const entriesByNode = new Map();
    const orphanLinks = new Map();
    const outgoing = new Map();
    const index = new Map();
    let editableCount = 0;
    for (const node of nodes) {
      const id = String(node.id);
      const list = buildInputEntries(node, fieldById);
      entriesByNode.set(id, list);

      const linked = new Map();
      for (const entry of list) {
        if (entry.link) linked.set(entry.name, entry.link);
      }
      const rawLinks = Array.isArray(node.links) ? node.links : [];
      for (const link of rawLinks) {
        const name = link && link.name !== undefined && link.name !== null ? String(link.name) : "";
        const source = link && link.node !== undefined && link.node !== null ? String(link.node) : "";
        if (!name || !source || source === id || !byId.has(source)) continue;
        if (!linked.has(name)) linked.set(name, { node: source, slot: link.slot });
      }

      const attached = new Set();
      for (const entry of list) {
        if (!index.has(entry.key)) index.set(entry.key, entry);
        // 连线住哪个输入，哪个输入就只读（applyEdit / syncValue 都看 entry.link）。
        const link = linked.get(entry.name);
        if (link) {
          const source = String(link.node);
          entry.link = { node: source, slot: normalizeSlot(link.slot) };
          attached.add(entry.name);
          if (byId.has(source)) {
            if (!outgoing.has(source)) outgoing.set(source, []);
            outgoing.get(source).push({ node: id, input: entry.name, slot: entry.link.slot });
          }
        }
        if (entry.kind !== "readonly" && !entry.link) editableCount += 1;
      }

      // 连线名在输入行里找不到对应行（旧服务端只有 field_ids）：单独列出来，别把连线丢了。
      const orphans = [];
      for (const [name, link] of linked) {
        if (attached.has(name)) continue;
        const source = String(link.node);
        if (!byId.has(source)) continue;
        const slot = normalizeSlot(link.slot);
        orphans.push({ name, node: source, slot });
        if (!outgoing.has(source)) outgoing.set(source, []);
        outgoing.get(source).push({ node: id, input: name, slot });
      }
      if (orphans.length) orphanLinks.set(id, orphans);
    }
    entryIndex = index;

    return {
      workflow, graph, fields, fieldById, nodes, byId, orderIndex, outgoing, orphanLinks,
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
    // 图例：连线按钮上的箭头读作什么（灰字，随语言走）。
    const legend = el("p", "advanced-legend");
    legend.append(el("span", "advanced-legend-in"), el("span", "advanced-legend-out"));
    const actions = el("div", "advanced-toolbar-actions");
    const makeAction = (label, title, callback) => {
      const button = el("button", "advanced-toolbar-button", label);
      button.type = "button";
      button.title = title;
      button.addEventListener("click", callback);
      actions.append(button);
      return button;
    };
    makeAction("↶", "撤销", undoLast);
    makeAction("↷", "重做", redoLast);
    makeAction("展开", "展开全部节点", () => toggleAll(true));
    makeAction("收起", "收起全部节点", () => toggleAll(false));
    wrap.append(field, actions, legend);
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
    els.legendIn = els.toolbar.querySelector(".advanced-legend-in");
    els.legendOut = els.toolbar.querySelector(".advanced-legend-out");
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

  /* ---------------------------------------------------------- 浮层菜单 */

  // 参考项目的「…」菜单（WorkflowObjectContextMenu / NodeCard.Menu）：菜单项不铺在卡片里，
  // 而是挂到 body 上的一层浮层，按段分组、段间一条分隔线，点外面 / 滚动 / Esc 关闭，
  // 位置按锚点钳在视口内，下面放不开就翻到锚点上方。
  let contextMenu = null;
  let contextMenuAnchor = null;
  let contextMenuOpenedAt = 0;

  function closeContextMenu() {
    const doc = deps.doc;
    if (doc) {
      doc.removeEventListener("mousedown", onContextMenuOutside, true);
      doc.removeEventListener("scroll", onContextMenuScroll, true);
      doc.removeEventListener("keydown", onContextMenuKey, true);
    }
    const view = win();
    if (view && typeof view.removeEventListener === "function") {
      view.removeEventListener("resize", onContextMenuResize);
    }
    if (contextMenu && contextMenu.parentNode) contextMenu.parentNode.removeChild(contextMenu);
    contextMenu = null;
    contextMenuAnchor = null;
  }

  function onContextMenuOutside(event) {
    const target = event.target;
    // 菜单自己也要排除：mousedown 先把浮层拆掉的话，随后的 click 根本到不了菜单项上，
    // 动作就永远不会执行（参考项目的 useDismissOnOutsideClick 同样排除 content）。
    if (contextMenu && target && typeof contextMenu.contains === "function" && contextMenu.contains(target)) return;
    if (contextMenuAnchor && target && typeof contextMenuAnchor.contains === "function" && contextMenuAnchor.contains(target)) return;
    closeContextMenu();
  }

  // 刚弹出那一下的惯性滚动不算「用户在滚」（和跳转菜单同一套宽限）。
  function onContextMenuScroll() {
    if (Date.now() - contextMenuOpenedAt < JUMP_MENU_GRACE_MS) return;
    closeContextMenu();
  }

  function onContextMenuKey(event) {
    if (!contextMenu || event.key !== "Escape") return;
    event.preventDefault();
    const anchor = contextMenuAnchor;
    closeContextMenu();
    if (anchor && typeof anchor.focus === "function") {
      try { anchor.focus({ preventScroll: true }); } catch (error) { /* 老浏览器不认参数 */ }
    }
  }

  function onContextMenuResize() {
    if (contextMenu && contextMenuAnchor) positionContextMenu(contextMenu, contextMenuAnchor);
  }

  function positionContextMenu(menu, anchor) {
    const view = win();
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 208;
    const height = menu.offsetHeight || 260;
    const padding = 8;
    const dockReserve = 96;   // 底部导航 dock 的高度，别把菜单压到底下
    const maxLeft = Math.max(padding, (view.innerWidth || 0) - width - padding);
    const left = Math.max(padding, Math.min(rect.right - width, maxLeft));
    let top = rect.bottom + 6;
    if (top + height > (view.innerHeight || 0) - dockReserve) {
      top = Math.max(padding, rect.top - height - 6);
    }
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
    menu.style.visibility = "visible";
  }

  // sections = [[{ label, icon, danger?, onSelect }], ...]；空段自动跳过，段间自动加分隔。
  function openContextMenu(anchor, sections) {
    closeContextMenu();
    closeJumpMenu();
    const doc = deps.doc;
    if (!doc || !anchor || !doc.body) return null;
    const menu = el("div", "advanced-context-menu");
    menu.setAttribute("role", "menu");
    let started = false;
    for (const section of sections || []) {
      const items = (Array.isArray(section) ? section : []).filter(Boolean);
      if (!items.length) continue;
      if (started) menu.append(el("div", "advanced-context-separator"));
      started = true;
      for (const item of items) {
        const button = el("button", "advanced-context-item" + (item.danger ? " is-danger" : "") + (item.icon ? "" : " is-plain"));
        button.type = "button";
        button.setAttribute("role", "menuitem");
        if (item.icon) button.append(icon(item.icon, "advanced-context-icon"));
        button.append(el("span", "advanced-context-label", String(item.label || "")));
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeContextMenu();
          try {
            if (typeof item.onSelect === "function") item.onSelect();
          } catch (error) {
            console.warn("[Mobile Remote] 菜单动作失败", error);
          }
        });
        menu.append(button);
      }
    }
    doc.body.append(menu);
    contextMenu = menu;
    contextMenuAnchor = anchor;
    contextMenuOpenedAt = Date.now();
    positionContextMenu(menu, anchor);
    doc.addEventListener("mousedown", onContextMenuOutside, true);
    doc.addEventListener("scroll", onContextMenuScroll, true);
    doc.addEventListener("keydown", onContextMenuKey, true);
    win().addEventListener("resize", onContextMenuResize);
    return menu;
  }

  function menuTrigger(label, onOpen) {
    const button = el("button", "advanced-menu-trigger", "⋯");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-haspopup", "menu");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (contextMenu && contextMenuAnchor === button) {
        closeContextMenu();
        return;
      }
      onOpen(button);
    });
    return button;
  }

  function nodeAction(node, action, options) {
    const settings = options || {};
    let value = settings.value === undefined ? true : settings.value;
    if (settings.kind === "rename") {
      value = win().prompt ? win().prompt(t("节点标签"), String(node.title || "")) : null;
    } else if (settings.kind === "color") {
      value = win().prompt ? win().prompt(t("节点颜色"), String(node.color || "")) : null;
    } else if (settings.confirm && win().confirm && !win().confirm(settings.confirm)) {
      return;
    }
    if (value === null || value === undefined) return;
    if (typeof deps.onAction === "function") deps.onAction(String(node.id), String(action), value);
  }

  function groupMemberNodes(group) {
    if (!model) return [];
    return model.nodes.filter((node) => model.groupOf.get(String(node.id)) === String(group.id));
  }

  function groupDesktopIndex(group) {
    const match = /^g(\d+)$/.exec(String((group && group.id) || ""));
    return match ? Number(match[1]) : -1;
  }

  function setGroupNodesExpanded(group, expanded) {
    for (const node of groupMemberNodes(group)) {
      if (expanded) expandedNodes.add(String(node.id));
      else expandedNodes.delete(String(node.id));
    }
    render();
  }

  function forEachGroupNode(group, action, value) {
    for (const node of groupMemberNodes(group)) nodeAction(node, action, { value });
  }

  function renderGroupMenuButton(group) {
    return menuTrigger(t("组操作"), (anchor) => {
      const index = groupDesktopIndex(group);
      const canEditGroup = index >= 0 && typeof deps.onGroupAction === "function";
      openContextMenu(anchor, [
        [
          canEditGroup ? { label: t("编辑标签"), icon: "pencil", onSelect: () => openGroupRename(group, index) } : null,
          canEditGroup ? { label: t("修改颜色"), icon: "palette", onSelect: () => openGroupColor(group, index) } : null,
        ],
        [
          { label: t("全部展开"), icon: "chevronDown", onSelect: () => setGroupNodesExpanded(group, true) },
          { label: t("全部收起"), icon: "chevronRight", onSelect: () => setGroupNodesExpanded(group, false) },
        ],
        [
          { label: t("旁路/启用"), icon: "power", onSelect: () => forEachGroupNode(group, "bypass", true) },
          { label: t("隐藏/显示"), icon: "eyeOff", onSelect: () => forEachGroupNode(group, "hide", true) },
          { label: t("选择节点"), icon: "check", onSelect: () => forEachGroupNode(group, "select", true) },
        ],
      ]);
    });
  }

  function openGroupRename(group, index) {
    const view = win();
    const next = view && typeof view.prompt === "function" ? view.prompt(t("组名称"), String(group.title || "")) : null;
    if (next === null || next === undefined) return;
    const title = String(next);
    group.title = title;
    for (const node of groupMemberNodes(group)) node.group = title;
    groupState.set("title:" + group.id, true);
    deps.onGroupAction(index, "group-rename", title);
    render();
  }

  function openGroupColor(group, index) {
    const view = win();
    const next = view && typeof view.prompt === "function" ? view.prompt(t("组颜色"), String(group.color || "#7eb4d4")) : null;
    if (next === null || next === undefined) return;
    const color = String(next);
    group.color = color;
    deps.onGroupAction(index, "group-color", color);
    render();
  }

  // 组头铺底：参考项目按组色 15% 透明度染一层，没有组色就不染色。
  function groupTint(color) {
    const text = String(color || "").trim();
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
    if (!match) return "";
    let hex = match[1];
    if (hex.length === 3) hex = hex.split("").map((part) => part + part).join("");
    const value = parseInt(hex, 16);
    return "rgba(" + ((value >> 16) & 255) + ", " + ((value >> 8) & 255) + ", " + (value & 255) + ", 0.15)";
  }

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
    // 参考项目的组头：整条用组色淡淡铺底，左边折叠箭头 + 组名 + 数量，右边「…」。
    const tint = groupTint(group.color);
    if (tint) summary.style.backgroundColor = tint;
    const fold = el("button", "advanced-fold-button");
    fold.type = "button";
    fold.setAttribute("aria-expanded", open ? "true" : "false");
    fold.title = t("折叠/展开");
    fold.append(icon(open ? "chevronDown" : "chevronRight", "advanced-group-chevron"));
    fold.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      details.open = !details.open;
      details.dataset.mtrOpen = details.open ? "1" : "0";
      if (!searching) setGroupOpen(group.id, details.open);
    });
    const dot = el("span", "advanced-group-dot");
    dot.setAttribute("aria-hidden", "true");
    if (group.color) dot.style.backgroundColor = group.color;
    const title = el("span", "advanced-group-title");
    title.append(highlight(group.title || t("未分组"), null));
    const count = el("span", "advanced-group-count", String(entries.length) + " " + t("个节点"));
    const spacer = el("span", "advanced-group-spacer");
    summary.append(fold, dot, title, count, spacer, renderGroupMenuButton(group));
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
    const headTop = el("span", "advanced-node-head-top");
    headTop.append(title);
    if (nodeModified(node)) headTop.append(modifiedStar());
    head.append(headTop, meta);
    // 参考项目的节点卡标题栏：左边折叠箭头 + 标题/类型，右边「…」。
    toggle.append(icon(open ? "chevronDown" : "chevronRight", "advanced-node-chevron"), head);
    toggle.addEventListener("click", () => toggleNode(id));
    const header = el("div", "advanced-node-header");
    header.append(toggle);
    if (isBookmarked("node:" + id)) {
      const mark = el("span", "advanced-node-bookmark", "★");
      mark.title = t("已收藏");
      header.append(mark);
    }
    header.append(renderNodeActions(node));
    card.append(header);

    if (open) card.append(renderBody(node));
    // 出边区（卡片底部）：没有出边时整块不渲染。
    const outputs = renderOutputs(node);
    if (outputs) card.append(outputs);

    cards.set(id, card);
    return card;
  }

  // 书签（参考项目的 bookmarks）：本机记住节点/组，不写回工作流文件。
  const BOOKMARK_KEY = "comfy-mobile-remote.advancedBookmarks";

  function bookmarkList() {
    try {
      const parsed = JSON.parse((storageArea() && storageArea().getItem(BOOKMARK_KEY)) || "[]");
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch (error) {
      return [];
    }
  }

  function isBookmarked(key) {
    return bookmarkList().includes(String(key));
  }

  function toggleBookmark(key) {
    const area = storageArea();
    if (!area) return false;
    const list = bookmarkList();
    const text = String(key);
    const next = list.includes(text) ? list.filter((item) => item !== text) : list.concat(text);
    try { area.setItem(BOOKMARK_KEY, JSON.stringify(next)); } catch (error) { /* 隐私模式：不落盘 */ }
    return next.includes(text);
  }

  // 节点「…」菜单：段顺序照参考项目 NodeCard/Menu。
  function renderNodeActions(node) {
    const bar = el("div", "advanced-node-actions");
    bar.append(menuTrigger(t("节点操作"), (anchor) => {
      const bookmarked = isBookmarked("node:" + String(node.id));
      openContextMenu(anchor, [
        [
          { label: t("编辑标签"), icon: "pencil", onSelect: () => nodeAction(node, "rename", { kind: "rename" }) },
          { label: t("修改颜色"), icon: "palette", onSelect: () => nodeAction(node, "color", { kind: "color" }) },
        ],
        [
          { label: bookmarked ? t("取消收藏") : t("收藏"), icon: "bookmark", onSelect: () => toggleNodeBookmark(node.id) },
        ],
        [
          { label: t("选择节点"), icon: "check", onSelect: () => nodeAction(node, "select", { value: true }) },
          { label: t("旁路/启用"), icon: "power", onSelect: () => nodeAction(node, "bypass", { value: true }) },
          { label: t("隐藏/显示"), icon: "eyeOff", onSelect: () => nodeAction(node, "hide", { value: true }) },
          { label: t("复制节点"), icon: "copy", onSelect: () => nodeAction(node, "duplicate", { value: true }) },
          { label: t("复制"), icon: "clipboard", onSelect: () => nodeAction(node, "copy", { value: true }) },
          { label: t("粘贴到下方"), icon: "paste", onSelect: () => nodeAction(node, "paste-below", { value: true }) },
        ],
        [
          {
            label: t("删除节点"), icon: "trash", danger: true,
            onSelect: () => nodeAction(node, "delete", { confirm: t("确定删除此节点？") }),
          },
        ],
      ]);
    }));
    return bar;
  }

  function toggleNodeBookmark(nodeId) {
    const marked = toggleBookmark("node:" + String(nodeId));
    const card = cards.get(String(nodeId));
    if (card) {
      const star = card.querySelector(".advanced-node-bookmark");
      if (marked && !star) {
        const mark = el("span", "advanced-node-bookmark", "★");
        mark.title = t("已收藏");
        const anchor = card.querySelector(".advanced-node-actions");
        if (anchor) card.querySelector(".advanced-node-header").insertBefore(mark, anchor);
      } else if (!marked && star) star.remove();
    }
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
      // 一个输入都没有（含旧服务端的脏数据）：灰字提示，不能让卡片空白。
      body.append(el("p", "advanced-node-empty", t("无可调参数")));
      return body;
    }
    // 旧数据兜底：连线名在输入行里找不到对应行时，单独列在控件前面，只读。
    const orphans = (model && model.orphanLinks.get(String(node.id))) || [];
    for (const link of orphans) body.append(renderOrphanLink(link));
    for (const entry of list) body.append(renderInput(entry));
    return body;
  }

  // 一个输入一行：行内是输入名（不翻译，必须与画布/API 一致）+ 类型小字。
  // 被连线接管的输入，行内直接画「← 对端节点标题 · 插槽号」方向按钮，这一行不再渲染
  // 可编辑控件（画布上它本来也改不动）；没被连线的照旧在下面渲染可编辑控件。
  function renderInput(entry) {
    const wrap = el("div", "advanced-input");
    wrap.dataset.valueKey = entry.key;
    wrap.dataset.inputName = entry.name;
    if (entry.type) wrap.dataset.inputType = entry.type;
    const head = el("div", "advanced-input-head");
    head.append(el("span", "advanced-input-name", entry.name));
    if (entry.link) {
      wrap.dataset.inputLinked = "1";
      head.append(connectionButton("in", { node: entry.link.node, slot: entry.link.slot }, [entry.link]));
    } else {
      const connect = el("button", "advanced-connect-button", "+");
      connect.type = "button";
      connect.title = "连接输入";
      connect.setAttribute("aria-label", "连接输入");
      connect.addEventListener("click", (event) => openInputConnectionMenu(entry, event.currentTarget));
      head.append(connect);
    }
    if (entry.type) head.append(el("span", "advanced-input-type", entry.type));
    wrap.append(head);
    inputRows.set(entry.key, wrap);
    if (entry.link) return wrap;

    const slot = el("div", "advanced-input-control");
    if (entry.frontend) {
      wrap.dataset.inputFrontend = "1";
      slot.classList.add("is-frontend");
    }
    wrap.append(slot);
    const control = buildControl(entry);
    if (control) slot.append(control);
    // 前端专有控件（种子模式之类）只影响手机端，旁边灰字说明一句。
    if (entry.frontend) slot.append(el("span", "advanced-input-note", t("仅手机端设置")));
    if (entry.kind === "number") wrap.append(el("p", "advanced-input-warning", t("输入值无效")));
    const rowMenu = renderInputActions(entry, wrap);
    if (rowMenu) head.append(rowMenu);
    return wrap;
  }

  // 参数行的「…」：和节点菜单同一套浮层（参考项目 RowActionsMenu）。
  function renderInputActions(entry, wrap) {
    if (entry.kind === "readonly") return null;
    const trigger = menuTrigger(t("参数操作"), (anchor) => {
      const node = model ? model.byId.get(String(entry.nodeId)) : null;
      const inputSlot = node && Array.isArray(node.inputs)
        ? node.inputs.findIndex((item) => String(item && item.name) === String(entry.name))
        : -1;
      openContextMenu(anchor, [
        [
          entry.link
            ? {
              label: t("断开连线"), icon: "eyeOff",
              onSelect: () => {
                if (Number.isFinite(inputSlot) && inputSlot >= 0) {
                  deps.onAction?.(String(entry.nodeId), "disconnect", inputSlot);
                }
              },
            }
            : { label: t("恢复默认值"), icon: "chevronRight", onSelect: () => applyEdit(entry.key, entry.initial) },
        ],
        [
          {
            label: t("复制参数值"), icon: "clipboard",
            onSelect: async () => {
              const value = currentValue(entry);
              try { await win().navigator?.clipboard?.writeText(String(value === undefined || value === null ? "" : value)); } catch (error) { /* 剪贴板不可用就算了 */ }
            },
          },
          { label: t("标记参数"), icon: "bookmark", onSelect: () => wrap.classList.toggle("is-pinned") },
        ],
      ]);
    });
    return trigger;
  }

  // 空输入的「+」：和参考项目一样列出可以作为来源的节点，选中即在画布上连线。
  function openInputConnectionMenu(entry, anchor) {
    if (!model || !anchor) return;
    const target = model.byId.get(String(entry.nodeId));
    const inputSlot = target && Array.isArray(target.inputs)
      ? target.inputs.findIndex((item) => String(item && item.name) === String(entry.name))
      : -1;
    if (!Number.isFinite(inputSlot) || inputSlot < 0) return;
    const candidates = model.nodes.filter((node) => String(node.id) !== String(entry.nodeId));
    const items = candidates.map((source) => {
      const outgoing = model.outgoing.get(String(source.id)) || [];
      const outputSlot = outgoing.length ? normalizeSlot(outgoing[0].slot) : 0;
      return {
        label: nodeTitle(source) + " #" + String(source.id) + " · " + t("输出") + " " + outputSlot,
        icon: "power",
        onSelect: () => deps.onAction?.(
          String(entry.nodeId),
          "connect",
          JSON.stringify({ source: String(source.id), outputSlot, inputSlot }),
        ),
      };
    });
    openContextMenu(anchor, [items.length ? items : [{ label: t("没有可用的连接来源"), onSelect: () => {} }]]);
  }

  // 对端节点标题：节点不在图里（脏数据）就退回 #编号。
  function peerTitle(nodeId) {
    const node = model && model.byId.get(String(nodeId));
    return node ? nodeTitle(node) : "#" + String(nodeId);
  }

  // 连接点上的方向按钮：输入侧箭头指进（← 对端标题 · 插槽号），
  // 输出侧箭头指出（→ 对端标题 · 对端输入名）。点一下就跳到对端节点。
  // peers 是这个连接点上的全部对端：多于一条时点按钮先弹就地菜单让用户选去哪一个。
  function connectionButton(direction, self, peers) {
    const name = peerTitle(self.node);
    const text = direction === "in"
      ? name + " · " + String(normalizeSlot(self.slot))
      : name + " · " + String(self.input || "");
    const label = direction === "in" ? t("来自 {name}", { name }) : t("被 {name} 使用", { name });
    const button = el("button", "advanced-link is-" + direction);
    button.type = "button";
    button.dataset.jump = String(self.node);
    button.dataset.slot = String(normalizeSlot(self.slot));
    if (direction === "out" && self.input) button.dataset.input = String(self.input);
    button.title = label;
    button.setAttribute("aria-label",
      direction === "in" ? t("已连接：来自 {name}", { name }) : label);
    const arrow = el("span", "advanced-link-arrow", direction === "in" ? "←" : "→");
    arrow.setAttribute("aria-hidden", "true");
    button.append(arrow, el("span", "advanced-link-text", text));
    if (peers.length > 1) {
      button.dataset.multi = "1";
      button.mtrPeers = peers;   // 菜单要的对端清单，见 openJumpMenu
    }
    return button;
  }

  // 旧数据兜底行：连线名没有对应的输入行（节点只有 field_ids），只画方向按钮。
  function renderOrphanLink(link) {
    const row = el("div", "advanced-link-row is-in is-orphan");
    row.dataset.linkName = link.name;
    row.append(el("span", "advanced-link-name", link.name));
    row.append(connectionButton("in", { node: link.node, slot: link.slot }, [link]));
    return row;
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

  function pushHistory(key, before, after) {
    if (applyingHistory || Object.is(before, after)) return;
    undoStack.push({ key: String(key), before, after });
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
  }

  function replayHistory(item, undo) {
    if (!item) return;
    const value = undo ? item.before : item.after;
    const entry = entryIndex.get(item.key);
    if (!entry) return;
    applyingHistory = true;
    try {
      const table = values();
      if (table && typeof table === "object") table[item.key] = value;
      deps.updateFieldValue?.(fieldForEntry(entry), value);
      deps.onEdit?.(fieldForEntry(entry), value);
      syncValue(item.key, value);
      paintNodeFlag(entry.nodeId);
    } finally { applyingHistory = false; }
  }

  function undoLast() {
    const item = undoStack.pop();
    if (!item) return;
    redoStack.push(item);
    replayHistory(item, true);
  }

  function redoLast() {
    const item = redoStack.pop();
    if (!item) return;
    undoStack.push(item);
    replayHistory(item, false);
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
    const before = table && typeof table === "object" ? table[entry.key] : entry.initial;
    pushHistory(entry.key, before, next);
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
    const holder = toggle.querySelector(".advanced-node-head-top") || toggle;
    const star = holder.querySelector(".advanced-node-modified");
    if (modified && !star) holder.append(modifiedStar());
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
      const link = target.closest("[data-jump]");
      if (link) {
        event.preventDefault();
        // 一个连接点连着好几个节点：先弹就地菜单让用户选去哪一个。
        if (link.dataset.multi === "1" && Array.isArray(link.mtrPeers) && link.mtrPeers.length > 1) {
          openJumpMenu(link, link.mtrPeers);
          return;
        }
        closeJumpMenu();
        openNode(link.dataset.jump);
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

  // 卡片底部「→ 输出到」区：逐条列出这条出边去了哪个节点的哪个输入。
  // 无出边时整块不渲染；同一个输出槽接了多个节点时，每条都标上条数，点按钮先弹菜单。
  function renderOutputs(node) {
    const edges = (model.outgoing.get(String(node.id)) || [])
      .slice()
      .sort((a, b) => (model.orderIndex.get(String(a.node)) || 0) - (model.orderIndex.get(String(b.node)) || 0));
    if (!edges.length) return null;

    const section = el("div", "advanced-node-outputs");
    section.append(el("p", "advanced-outputs-title", t("→ 输出到")));
    const list = el("div", "advanced-outputs-list");
    for (const edge of edges) {
      const slot = normalizeSlot(edge.slot);
      const peers = edges.filter((other) => normalizeSlot(other.slot) === slot);
      const row = el("div", "advanced-link-row is-out");
      row.append(connectionButton("out", edge, peers));
      if (peers.length > 1) {
        const count = el("span", "advanced-link-count", String(peers.length));
        count.title = t("选择要跳转的节点");
        count.setAttribute("aria-hidden", "true");
        row.append(count);
      }
      list.append(row);
    }
    section.append(list);
    return section;
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

  /* ---------------------------------------------------------- 跳转小菜单 */

  // 一个连接点连着好几个节点时，就地弹一个小浮层让用户选去哪一个
  // （菜单项 = 对端节点标题 + 插槽名）。浮层挂在 body 上用 position: fixed：
  // 卡片的 content-visibility 会把卡内的浮层裁掉。点空白、滚动、Esc、重渲染都关掉。

  function closeJumpMenu() {
    const doc = deps.doc;
    if (doc) {
      doc.removeEventListener("mousedown", onJumpMenuOutside, true);
      doc.removeEventListener("scroll", onJumpMenuScroll, true);
      doc.removeEventListener("keydown", onJumpMenuKey, true);
    }
    const view = win();
    if (view && typeof view.removeEventListener === "function") view.removeEventListener("resize", onJumpMenuResize);
    if (jumpMenu && jumpMenu.parentNode) jumpMenu.parentNode.removeChild(jumpMenu);
    jumpMenu = null;
    jumpMenuAnchor = null;
  }

  function onJumpMenuOutside(event) {
    if (!jumpMenu) return;
    const target = event.target;
    if (target && typeof target.closest === "function" && target.closest(".advanced-menu")) return;
    if (jumpMenuAnchor && typeof jumpMenuAnchor.contains === "function" && jumpMenuAnchor.contains(target)) return;
    closeJumpMenu();
  }

  function onJumpMenuScroll() {
    if (Date.now() - jumpMenuOpenedAt < JUMP_MENU_GRACE_MS) return;
    closeJumpMenu();
  }

  function onJumpMenuKey(event) {
    if (!jumpMenu || event.key !== "Escape") return;
    event.preventDefault();
    const anchor = jumpMenuAnchor;
    closeJumpMenu();
    if (anchor && typeof anchor.focus === "function") {
      try { anchor.focus({ preventScroll: true }); } catch (error) { /* 老浏览器不认这个参数 */ }
    }
  }

  function onJumpMenuResize() {
    if (jumpMenu && jumpMenuAnchor) positionJumpMenu(jumpMenu, jumpMenuAnchor);
  }

  function positionJumpMenu(menu, anchor) {
    const view = win();
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 220;
    const height = menu.offsetHeight || 0;
    const maxLeft = Math.max(8, (view.innerWidth || 0) - width - 8);
    const left = Math.max(8, Math.min(rect.left, maxLeft));
    let top = rect.bottom + 6;
    // 下面放不下就翻到按钮上面，别顶出屏幕。
    if (height && top + height > (view.innerHeight || 0) - 8) top = Math.max(8, rect.top - height - 6);
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
  }

  function openJumpMenu(anchor, peers) {
    const doc = deps.doc;
    if (!doc) return null;
    closeJumpMenu();
    const menu = el("div", "advanced-menu");
    menu.setAttribute("role", "menu");
    const title = t("选择要跳转的节点");
    menu.setAttribute("aria-label", title);
    menu.append(el("p", "advanced-menu-title", title));
    for (const peer of peers) {
      const item = el("button", "advanced-menu-item");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.dataset.jump = String(peer.node);
      item.append(el("span", "advanced-menu-node", peerTitle(peer.node)));
      item.append(el("span", "advanced-menu-slot",
        peer.input ? String(peer.input) : "#" + String(normalizeSlot(peer.slot))));
      item.addEventListener("click", () => {
        const target = String(peer.node);
        closeJumpMenu();
        openNode(target);
      });
      menu.append(item);
    }
    (doc.body || doc.documentElement).append(menu);
    positionJumpMenu(menu, anchor);
    jumpMenu = menu;
    jumpMenuAnchor = anchor;
    jumpMenuOpenedAt = Date.now();
    doc.addEventListener("mousedown", onJumpMenuOutside, true);
    doc.addEventListener("scroll", onJumpMenuScroll, true);
    doc.addEventListener("keydown", onJumpMenuKey, true);
    const view = win();
    if (view && typeof view.addEventListener === "function") view.addEventListener("resize", onJumpMenuResize);
    return menu;
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
    if (els.legendIn) els.legendIn.textContent = t("← 输入来自");
    if (els.legendOut) els.legendOut.textContent = t("→ 输出到");
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
    // 整块重渲染会把菜单的锚点（那一行按钮）换掉，先关掉旧菜单。
    closeJumpMenu();
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
    if (settings.onAction) deps.onAction = settings.onAction;
    if (settings.onGroupAction) deps.onGroupAction = settings.onGroupAction;
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
    closeJumpMenu();
    closeContextMenu();
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
