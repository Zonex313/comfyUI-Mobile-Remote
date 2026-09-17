import { t } from "./i18n.js?v=202610130";
import "./workflow-library.js?v=202610130";
import { app } from "../../scripts/app.js";

/*
 * 「导入工作流」管理页。
 *
 * 手机端默认只能读到电脑端当前打开着的工作流；这个页面把磁盘上已保存的工作流
 * 转成可执行格式交给插件存下来，并标成「常驻」，于是电脑端全关手机端也照样能用。
 *
 * 页面分两块：
 *   1. 「已导入的工作流」卡片 —— 插件里已经有记录的那些，直接在这里管理；
 *   2. 目录树 —— 按 workflows 目录的真实层级铺开，跟电脑端工作流浏览器一样。
 * 名称和地址一律全文显示、不省略号，按钮单独占一行，不挤文字。
 * 转换在电脑端浏览器里完成：新建一张独立的 LiteGraph 图去 configure + graphToPrompt，
 * 全程不碰用户当前打开的画布（已实测与"打开该工作流再转换"结果完全一致）。
 */

const Library = globalThis.MobileWorkflowLibrary;
const LIBRARY_URL = "/userdata?dir=workflows&recurse=true&split=false&full_info=true";
const RECORDS_URL = "/mobile/api/workflows?all=1";
const IMPORT_URL = "/mobile/api/workflows/import";
const MAX_ROWS = 400;
const NOTICE_MS = 3000;   // 操作提示只停留 3 秒，之后回到默认状态文字

const recordUrl = (id) => `/mobile/api/workflows/${encodeURIComponent(id)}`;

async function readJson(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return body;
}

function sizeLabel(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function createWorkflowImporter({ element, button, setText }) {
  const root = element("section", "mobile-remote-tags mobile-remote-import");
  root.hidden = true;
  root.setAttribute("aria-label", t("导入工作流"));

  const toolbar = element("div", "mobile-remote-tags-toolbar");
  const search = element("input", "mobile-remote-tags-search");
  search.type = "search";
  search.placeholder = t("搜索工作流名或目录");
  search.setAttribute("aria-label", t("搜索工作流名或目录"));
  const expandToggle = button(t("展开全部"), "chevron-down", t("展开全部"));
  const reload = button(t("重新读取工作流列表"), "refresh");
  toolbar.append(search, expandToggle.node, reload.node);

  const status = element("p", "mobile-remote-tags-status");
  status.setAttribute("role", "status");

  // 「已导入」卡片：插件里已经有记录的工作流，在这里直接管理
  const owned = element("section", "mobile-remote-card mobile-remote-import-owned");
  const ownedHeader = element("div", "mobile-remote-card-header");
  const ownedTitleGroup = element("div", "mobile-remote-card-title-group");
  ownedTitleGroup.append(element("h3", "mobile-remote-card-title", t("已导入的工作流")));
  const ownedState = element("span", "mobile-remote-status", t("读取中"));
  ownedHeader.append(ownedTitleGroup, ownedState);
  const ownedList = element("div", "mobile-remote-import-owned-list");
  owned.append(ownedHeader, ownedList);

  const list = element("div", "mobile-remote-tags-list mobile-remote-import-list");
  // 关于工作流的说明都放在这个子页里，连接页那张卡片上只剩按钮
  const intro = element(
    "p",
    "mobile-remote-note",
    t("没导入的工作流，电脑端开着手机端才看得到；导入并常驻后，电脑端全关手机端也一直能用。"),
  );
  root.append(intro, toolbar, status, owned, list);

  let library = [];            // 磁盘上的工作流清单
  let records = [];            // 插件里已有的记录
  let entries = [];            // 两者对上号之后的清单
  let entryByRecordId = new Map();
  let allFolders = [];         // 全部文件夹路径，供"展开全部/收起全部"用
  let summary = { total: 0, imported: 0, pinned: 0 };
  let query = "";
  let notice = null;           // { text, tone }
  let busyKey = "";
  let busyName = "";
  let ready = false;
  let disposed = false;
  let loading = null;
  let painting = false;
  let lastFocus = "";
  let dirsSeeded = false;
  let noticeTimer = 0;
  const openDirs = new Set();
  const closedWhileSearching = new Set();

  /** 临时提示：显示 3 秒后自动回到「磁盘上共 N 个…」，期间再出提示会重新计时。 */
  function setNotice(text, tone) {
    window.clearTimeout(noticeTimer);
    noticeTimer = 0;
    notice = text ? { text, tone } : null;
    if (!notice) return;
    noticeTimer = window.setTimeout(() => {
      noticeTimer = 0;
      notice = null;
      if (!disposed) applyStatus();
    }, NOTICE_MS);
  }

  function applyStatus() {
    if (busyName) {
      setText(status, t("正在导入「{busyName}」…", { busyName: busyName }));
      status.dataset.tone = "pending";
      return;
    }
    if (notice) {
      setText(status, notice.text);
      status.dataset.tone = notice.tone;
      return;
    }
    setText(status, t("磁盘上共 {total} 个已保存工作流", { total: summary.total }));
    status.dataset.tone = "success";
  }

  function allExpanded() {
    return allFolders.length > 0 && allFolders.every((path) => openDirs.has(path));
  }

  function updateExpandLabel() {
    const expanded = allExpanded();
    const label = expanded ? t("收起全部") : t("展开全部");
    setText(expandToggle.caption, label);
    expandToggle.node.title = expanded ? t("收起全部文件夹") : t("展开全部文件夹");
    expandToggle.node.setAttribute("aria-label", expandToggle.node.title);
  }

  function isOpen(node, searching) {
    if (searching) return !closedWhileSearching.has(node.path);
    return openDirs.has(node.path);
  }

  function chip(label, iconName, focusId, onClick) {
    const control = button(label, iconName, label);
    control.node.classList.add("mobile-remote-import-btn");
    control.node.dataset.focus = focusId;
    control.node.addEventListener("click", onClick);
    return control.node;
  }

  /** 目录树里的一行：来源是磁盘清单项。 */
  function entryModel(entry) {
    return {
      key: `lib:${entry.path}`,
      name: entry.name,
      address: entry.path,
      size: entry.size,
      pinned: entry.pinned,
      imported: entry.imported,
      recordId: entry.recordId,
      entry,
    };
  }

  /** 已导入卡片里的一行：来源是插件记录，能对回磁盘清单就带上路径和大小。 */
  function recordModel(record) {
    const id = String(record?.id || "");
    const entry = entryByRecordId.get(id) || null;
    return {
      key: `rec:${id}`,
      name: String(record?.name || t("未命名工作流")),
      address: entry ? entry.path : String(record?.library_path || record?.source || t("（磁盘上已找不到这个文件）")),
      size: entry ? entry.size : 0,
      pinned: Boolean(record?.pinned),
      imported: true,
      recordId: id,
      entry,
      showChip: false,
    };
  }

  function makeRow(model, rendered) {
    if (rendered && rendered.rows >= MAX_ROWS) {
      rendered.trimmed += 1;
      return null;
    }
    if (rendered) rendered.rows += 1;

    const row = element("article", "mobile-remote-import-row");
    row.dataset.state = model.pinned ? "pinned" : model.imported ? "imported" : "idle";

    const main = element("div", "mobile-remote-import-main");
    main.append(element("span", "mobile-remote-import-name", model.name));
    if (model.showChip !== false) {
      if (model.pinned) main.append(element("span", "mobile-remote-import-state", t("常驻")));
      else if (model.imported) main.append(element("span", "mobile-remote-import-state", t("已导入")));
    }
    row.append(main);

    // 地址永久全文显示：不截断、不加省略号
    const size = sizeLabel(model.size);
    row.append(element("span", "mobile-remote-import-path", size ? `${model.address} · ${size}` : model.address));

    const actions = element("div", "mobile-remote-import-actions");
    const busy = busyKey === model.key;
    if (model.entry) {
      const importButton = chip(
        busy ? t("处理中") : model.imported ? t("刷新") : t("导入"),
        "download",
        `import:${model.key}`,
        () => void importEntry(model),
      );
      importButton.disabled = Boolean(busyKey);
      actions.append(importButton);
    }
    if (model.recordId) {
      actions.append(chip(
        model.pinned ? t("取消常驻") : t("设为常驻"),
        model.pinned ? "times" : "check",
        `pin:${model.key}`,
        () => void setPinned(model.recordId, !model.pinned),
      ));
      actions.append(chip(t("删除"), "trash", `delete:${model.key}`, () => void deleteRecord(model.recordId, model.name)));
    }
    row.append(actions);
    return row;
  }

  function paintOwned() {
    const models = records
      .filter((record) => record && record.id)
      .map(recordModel)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
    const pinnedCount = models.filter((model) => model.pinned).length;
    setText(ownedState, models.length ? t("已导入 {length} 个 · 常驻 {pinnedCount} 个", { length: models.length, pinnedCount: pinnedCount }) : t("还没有"));
    ownedList.replaceChildren();

    if (!models.length) {
      ownedList.append(element("p", "mobile-remote-note", t("还没有导入任何工作流。在下面的目录树里点「导入」，它就会常驻在手机端。")));
      return;
    }
    const group = (label, items) => {
      if (!items.length) return;
      ownedList.append(element("p", "mobile-remote-import-group-label", label));
      for (const model of items) {
        const row = makeRow(model, null);
        if (row) ownedList.append(row);
      }
    };
    group(t("常驻 · 电脑端不开也能用"), models.filter((model) => model.pinned));
    group(t("仅电脑端打开时可见"), models.filter((model) => !model.pinned));
  }

  /** 递归铺一层文件夹：<details> 套 <details>，跟磁盘上的目录结构一一对应。 */
  function makeFolder(node, depth, rendered, searching) {
    if (rendered.rows >= MAX_ROWS) {
      rendered.trimmed += node.count;
      return null;
    }
    const details = element("details", "mobile-remote-import-dir");
    details.dataset.depth = String(Math.min(depth, 5));
    const heading = element("summary", "mobile-remote-import-dir-summary");
    heading.append(
      element("span", "mobile-remote-import-dir-name", node.name),
      element("span", "mobile-remote-import-dir-count", String(node.count)),
    );
    const body = element("div", "mobile-remote-import-children");
    for (const entry of node.files) {
      const row = makeRow(entryModel(entry), rendered);
      if (row) body.append(row);
    }
    for (const child of node.folders) {
      const block = makeFolder(child, depth + 1, rendered, searching);
      if (block) body.append(block);
    }
    details.append(heading, body);
    details.open = isOpen(node, searching);
    details.addEventListener("toggle", () => {
      if (painting || !details.isConnected) return;
      if (searching) {
        if (details.open) closedWhileSearching.delete(node.path);
        else closedWhileSearching.add(node.path);
      } else if (details.open) {
        openDirs.add(node.path);
      } else {
        openDirs.delete(node.path);
      }
      updateExpandLabel();
    });
    return details;
  }

  function paint() {
    if (disposed) return;
    painting = true;
    paintOwned();

    const searching = Boolean(query.trim());
    const filtered = Library.filterEntries(entries, query);
    const tree = Library.buildTree(filtered);
    const rendered = { rows: 0, trimmed: 0 };
    list.replaceChildren();

    if (!entries.length) {
      list.append(element("p", "mobile-remote-note", ready ? t("磁盘上没读到已保存的工作流") : t("正在读取工作流列表…")));
    } else if (!filtered.length) {
      list.append(element("p", "mobile-remote-note", t("没有匹配的工作流")));
    } else {
      for (const entry of tree.files) {
        const row = makeRow(entryModel(entry), rendered);
        if (row) list.append(row);
      }
      for (const node of tree.folders) {
        const block = makeFolder(node, 0, rendered, searching);
        if (block) list.append(block);
      }
      if (rendered.trimmed) {
        list.append(element("p", "mobile-remote-note", t("还有 {trimmed} 个没显示，用上面的搜索框缩小范围", { trimmed: rendered.trimmed })));
      }
    }

    painting = false;
    updateExpandLabel();
    applyStatus();
    if (lastFocus) {
      const target = root.querySelector(`[data-focus="${CSS.escape(lastFocus)}"]`);
      if (target) target.focus({ preventScroll: true });
    }
  }

  function sync() {
    entries = Library.describe(library, records);
    entryByRecordId = new Map();
    for (const entry of entries) {
      if (entry.recordId) entryByRecordId.set(entry.recordId, entry);
    }
    summary = Library.summarize(entries);
    const fullTree = Library.buildTree(entries);
    allFolders = Library.folderPaths(fullTree);
    if (!dirsSeeded && fullTree.folders.length) {
      // 顶层目录默认展开，进去看到的就是「全部 / 开箱即用」这一层
      for (const node of fullTree.folders) openDirs.add(node.path);
      dirsSeeded = true;
    }
    paint();
  }

  /** 画布内部的报错翻译成能照做的话；认不出来的原样抛出。 */
  function describeError(error) {
    const message = String(error?.message || error || "");
    const broken = /No link found in parent graph for id \[(\d+)\] slot \[(\d+)\] (\S+)/.exec(message);
    if (!broken) return message;
    return t("这个工作流的连线记录不完整：节点 {node} 的输入「{input}」指向一条已经不存在的连线。请在电脑端打开它，把那条线重新连一次再保存，然后重新导入。", { node: broken[1], input: broken[3] });
  }

  /** 电脑端浏览器里把画布格式的工作流转成可执行格式，用一张独立的图，不动当前画布。 */
  async function convert(entry) {
    const response = await fetch(`/userdata/${encodeURIComponent(`workflows/${entry.path}`)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(t("读取工作流文件失败（HTTP {status}）", { status: response.status }));
    const graphData = await response.json();
    const factory = globalThis.LiteGraph;
    if (!factory || typeof factory.LGraph !== "function") throw new Error(t("读不到 ComfyUI 的画布接口，刷新页面再试"));
    if (typeof app?.graphToPrompt !== "function") throw new Error(t("读不到 ComfyUI 的转换接口，刷新页面再试"));

    const graph = new factory.LGraph();
    const dropped = Library.reconcileLinks(graphData);
    graph.configure(JSON.parse(JSON.stringify(graphData)));
    const expected = Array.isArray(graphData.nodes) ? graphData.nodes.length : 0;
    const built = Array.isArray(graph?._nodes) ? graph._nodes.length : 0;
    if (expected && built < expected) {
      throw new Error(t("这个工作流有 {value} 个节点本机没装，先在电脑端打开确认能跑再导入", { value: expected - built, n: expected - built }));
    }
    const converted = await app.graphToPrompt(graph);
    const prompt = converted?.output;
    if (!prompt || typeof prompt !== "object" || Object.keys(prompt).length === 0) {
      throw new Error(t("这个工作流里没有可执行的节点"));
    }
    return { prompt, workflow: graphData, dropped };
  }

  async function importEntry(model) {
    const entry = model.entry;
    if (!entry || busyKey) return;
    busyKey = model.key;
    busyName = model.name;
    setNotice(null);
    paint();
    try {
      const payload = await convert(entry);
      const response = await fetch(IMPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          name: entry.name,
          source: entry.source,
          library_path: entry.path,
          prompt: payload.prompt,
          workflow: payload.workflow,
        }),
      });
      const body = await readJson(response);
      const name = body?.workflow?.name || entry.name;
      setNotice(
        payload.dropped
          ? t("已导入「{name}」（{count} 条失效连线已忽略）", { name: name, count: payload.dropped })
          : t("已导入「{name}」，手机端电脑不开也能用了", { name: name }),
        "success",
      );
    } catch (error) {
      setNotice(t("导入失败：{value}", { value: describeError(error) }), "error");
    } finally {
      busyKey = "";
      busyName = "";
      await refreshRecords();
    }
  }

  async function setPinned(id, pinned) {
    if (busyKey) return;
    setNotice(null);
    try {
      await readJson(await fetch(`${recordUrl(id)}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ pinned }),
      }));
      setNotice(pinned ? t("已设为常驻") : t("已取消常驻（电脑端打开它时手机端还能看到）"), "success");
    } catch (error) {
      setNotice(t("操作失败：{value}", { value: error?.message || error }), "error");
    }
    await refreshRecords();
  }

  async function deleteRecord(id, name) {
    if (busyKey) return;
    setNotice(null);
    try {
      await readJson(await fetch(recordUrl(id), { method: "DELETE", cache: "no-store" }));
      setNotice(t("已从手机端删除「{name}」（磁盘上的工作流文件没动）", { name: name }), "success");
    } catch (error) {
      setNotice(t("删除失败：{value}", { value: error?.message || error }), "error");
    }
    await refreshRecords();
  }

  async function refreshRecords() {
    try {
      const body = await readJson(await fetch(RECORDS_URL, { cache: "no-store" }));
      records = Array.isArray(body?.workflows) ? body.workflows : [];
    } catch (error) {
      if (!notice) setNotice(t("读取已导入列表失败：{value}", { value: error?.message || error }), "error");
    }
    sync();
  }

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      setNotice(null);
      applyStatus();
      const [libraryBody, recordsBody] = await Promise.all([
        readJson(await fetch(LIBRARY_URL, { cache: "no-store" })),
        readJson(await fetch(RECORDS_URL, { cache: "no-store" })),
      ]);
      if (disposed) return;
      library = Library.normalizeEntries(libraryBody);
      records = Array.isArray(recordsBody?.workflows) ? recordsBody.workflows : [];
      ready = true;
      sync();
    })();
    try {
      await loading;
    } catch (error) {
      if (!disposed) {
        setNotice(t("读取工作流列表失败：{value}", { value: error?.message || error }), "error");
        paint();
      }
    } finally {
      loading = null;
    }
  }

  search.addEventListener("input", () => {
    query = search.value;
    setNotice(null);
    paint();
  });
  expandToggle.node.addEventListener("click", () => {
    const expanded = allExpanded();
    openDirs.clear();
    if (!expanded) for (const path of allFolders) openDirs.add(path);
    closedWhileSearching.clear();
    paint();
  });
  reload.node.addEventListener("click", () => {
    ready = false;
    dirsSeeded = false;
    openDirs.clear();
    closedWhileSearching.clear();
    void load();
  });
  root.addEventListener("focusin", (event) => {
    lastFocus = event.target?.dataset?.focus || "";
  });

  return {
    node: root,
    async open() {
      root.hidden = false;
      if (ready) await refreshRecords();
      else await load();
    },
    close() {
      root.hidden = true;
    },
    summary() {
      return { total: summary.total, imported: summary.imported, pinned: summary.pinned };
    },
    destroy() {
      disposed = true;
      window.clearTimeout(noticeTimer);
    },
  };
}
