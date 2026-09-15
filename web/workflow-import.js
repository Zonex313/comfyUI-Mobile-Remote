import "./workflow-library.js?v=202609261";
import { app } from "../../scripts/app.js";

/*
 * 「导入工作流」管理页。
 *
 * 手机端默认只能读到电脑端当前打开着的工作流；这个页面把磁盘上已保存的工作流
 * 转成可执行格式交给插件存下来，并标成「常驻」，于是电脑端全关手机端也照样能用。
 *
 * 转换在电脑端浏览器里完成：新建一张独立的 LiteGraph 图去 configure + graphToPrompt，
 * 全程不碰用户当前打开的画布（已实测与"打开该工作流再转换"结果完全一致）。
 */

const Library = globalThis.MobileWorkflowLibrary;
const LIBRARY_URL = "/userdata?dir=workflows&recurse=true&split=false&full_info=true";
const RECORDS_URL = "/mobile/api/workflows?all=1";
const IMPORT_URL = "/mobile/api/workflows/import";
const MAX_ROWS = 200;

const recordUrl = (id) => `/mobile/api/workflows/${encodeURIComponent(id)}`;

async function readJson(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return body;
}

function workdirLabel(folder) {
  return folder ? folder : "（工作流根目录）";
}

function sizeLabel(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function createWorkflowImporter({ element, button, setText, onSummary = () => {} }) {
  const root = element("section", "mobile-remote-tags mobile-remote-import");
  root.hidden = true;
  root.setAttribute("aria-label", "导入工作流");

  const toolbar = element("div", "mobile-remote-tags-toolbar");
  const search = element("input", "mobile-remote-tags-search");
  search.type = "search";
  search.placeholder = "搜索工作流名或目录";
  search.setAttribute("aria-label", "搜索工作流名或目录");
  const reload = button("重新读取工作流列表", "refresh");
  toolbar.append(search, reload.node);

  const status = element("p", "mobile-remote-tags-status");
  status.setAttribute("role", "status");
  const list = element("div", "mobile-remote-tags-list mobile-remote-import-list");
  root.append(toolbar, status, list);

  let library = [];            // 磁盘上的工作流清单
  let records = [];            // 插件里已有的记录（含没常驻的）
  let entries = [];            // 两者对上号之后的清单
  let summary = { total: 0, imported: 0, pinned: 0 };
  let query = "";
  let notice = null;           // { text, tone }
  let busyLabel = "";
  let ready = false;
  let disposed = false;
  let loading = null;

  function applyStatus() {
    if (busyLabel) {
      setText(status, `正在导入「${busyLabel}」…`);
      status.dataset.tone = "pending";
      return;
    }
    if (notice) {
      setText(status, notice.text);
      status.dataset.tone = notice.tone;
      return;
    }
    setText(status, `磁盘上有 ${summary.total} 个已保存工作流 · 已导入 ${summary.imported} 个（常驻 ${summary.pinned} 个）`);
    status.dataset.tone = "success";
  }

  function chip(label, iconName, onClick) {
    const control = button(label, iconName, label);
    control.node.classList.add("mobile-remote-import-btn");
    control.node.addEventListener("click", onClick);
    return control.node;
  }

  function makeRow(entry) {
    const row = element("article", "mobile-remote-import-row");
    row.dataset.state = entry.pinned ? "pinned" : entry.imported ? "imported" : "idle";
    const main = element("div", "mobile-remote-import-main");
    const title = element("span", "mobile-remote-import-name", entry.name);
    main.append(title);
    const meta = [workdirLabel(entry.folder), sizeLabel(entry.size)].filter(Boolean).join(" · ");
    main.append(element("span", "mobile-remote-import-folder", meta));
    if (entry.pinned) main.append(element("span", "mobile-remote-import-state", "常驻"));
    else if (entry.imported) main.append(element("span", "mobile-remote-import-state", "已导入"));
    row.append(main);

    const actions = element("div", "mobile-remote-import-actions");
    const busy = busyLabel === entry.name;
    const importLabel = entry.imported ? "刷新" : "导入";
    const importButton = chip(busy ? "处理中" : importLabel, "download", () => void importEntry(entry));
    importButton.disabled = Boolean(busyLabel);
    actions.append(importButton);
    if (entry.pinned && entry.recordId) {
      actions.append(chip("取消常驻", "times", () => void setPinned(entry.recordId, false)));
    } else if (entry.recordId) {
      actions.append(chip("设为常驻", "check", () => void setPinned(entry.recordId, true)));
    }
    if (entry.recordId) {
      actions.append(chip("删除", "trash", () => void deleteRecord(entry.recordId, entry.name)));
    }
    row.append(actions);
    return row;
  }

  function paint() {
    if (disposed) return;
    const filtered = Library.filterEntries(entries, query);
    const shown = filtered.slice(0, MAX_ROWS);
    list.replaceChildren();
    if (!entries.length) {
      list.append(element("p", "mobile-remote-note", ready ? "磁盘上没读到已保存的工作流" : "正在读取工作流列表…"));
    } else if (!filtered.length) {
      list.append(element("p", "mobile-remote-note", "没有匹配的工作流"));
    } else {
      for (const entry of shown) list.append(makeRow(entry));
      if (filtered.length > shown.length) {
        list.append(element(
          "p",
          "mobile-remote-note",
          `还有 ${filtered.length - shown.length} 个没显示，用上面的搜索框缩小范围`,
        ));
      }
    }
    applyStatus();
  }

  function sync() {
    entries = Library.describe(library, records);
    summary = Library.summarize(entries);
    onSummary(summary);
    paint();
  }

  /** 电脑端浏览器里把画布格式的工作流转成可执行格式，用一张独立的图，不动当前画布。 */
  async function convert(entry) {
    const response = await fetch(`/userdata/${encodeURIComponent(`workflows/${entry.path}`)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`读取工作流文件失败（HTTP ${response.status}）`);
    const graphData = await response.json();
    const factory = globalThis.LiteGraph;
    if (!factory || typeof factory.LGraph !== "function") throw new Error("读不到 ComfyUI 的画布接口，刷新页面再试");
    if (typeof app?.graphToPrompt !== "function") throw new Error("读不到 ComfyUI 的转换接口，刷新页面再试");

    const graph = new factory.LGraph();
    graph.configure(JSON.parse(JSON.stringify(graphData)));
    const expected = Array.isArray(graphData.nodes) ? graphData.nodes.length : 0;
    const built = Array.isArray(graph?._nodes) ? graph._nodes.length : 0;
    if (expected && built < expected) {
      throw new Error(`这个工作流有 ${expected - built} 个节点本机没装，先在电脑端打开确认能跑再导入`);
    }
    const converted = await app.graphToPrompt(graph);
    const prompt = converted?.output;
    if (!prompt || typeof prompt !== "object" || Object.keys(prompt).length === 0) {
      throw new Error("这个工作流里没有可执行的节点");
    }
    return { prompt, workflow: graphData };
  }

  async function importEntry(entry) {
    if (busyLabel) return;
    busyLabel = entry.name;
    notice = null;
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
      notice = { text: `已导入「${name}」，手机端电脑不开也能用了`, tone: "success" };
    } catch (error) {
      notice = { text: `导入失败：${error?.message || error}`, tone: "error" };
    } finally {
      busyLabel = "";
      await refreshRecords();
    }
  }

  async function setPinned(id, pinned) {
    if (busyLabel) return;
    notice = null;
    try {
      await readJson(await fetch(`${recordUrl(id)}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ pinned }),
      }));
      notice = { text: pinned ? "已设为常驻" : "已取消常驻（电脑端打开它时手机端还能看到）", tone: "success" };
    } catch (error) {
      notice = { text: `操作失败：${error?.message || error}`, tone: "error" };
    }
    await refreshRecords();
  }

  async function deleteRecord(id, name) {
    if (busyLabel) return;
    notice = null;
    try {
      await readJson(await fetch(recordUrl(id), { method: "DELETE", cache: "no-store" }));
      notice = { text: `已从手机端删除「${name}」（磁盘上的工作流文件没动）`, tone: "success" };
    } catch (error) {
      notice = { text: `删除失败：${error?.message || error}`, tone: "error" };
    }
    await refreshRecords();
  }

  async function refreshRecords() {
    try {
      const body = await readJson(await fetch(RECORDS_URL, { cache: "no-store" }));
      records = Array.isArray(body?.workflows) ? body.workflows : [];
    } catch (error) {
      notice = notice || { text: `读取已导入列表失败：${error?.message || error}`, tone: "error" };
    }
    sync();
  }

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      notice = null;
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
        notice = { text: `读取工作流列表失败：${error?.message || error}`, tone: "error" };
        paint();
      }
    } finally {
      loading = null;
    }
  }

  search.addEventListener("input", () => {
    query = search.value;
    notice = null;
    paint();
  });
  reload.node.addEventListener("click", () => {
    ready = false;
    void load();
  });

  return {
    node: root,
    /** 只读"已导入/常驻"数量，不碰工作流清单；连接页的卡片副标题用它。 */
    async loadSummary() {
      try {
        const body = await readJson(await fetch(RECORDS_URL, { cache: "no-store" }));
        const list = Array.isArray(body?.workflows) ? body.workflows : [];
        onSummary({
          total: summary.total,
          imported: list.length,
          pinned: list.filter((record) => record?.pinned).length,
        });
      } catch {
        /* 拿不到就保持原样，不打扰用户 */
      }
    },
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
    },
  };
}
