/* Desktop workflow-library model for the "导入工作流" card. UMD: browser global and CommonJS.
 *
 * 只做纯计算：把 ComfyUI /userdata 的工作流清单、和插件里已有的记录对上号，
 * 好让导入卡片知道哪些已经导入过、哪些还没导入。不碰 DOM、不联网，方便单测。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MobileWorkflowLibrary = factory();
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_ENTRIES = 5000;
  var MAX_PATH = 500;
  var MAX_NAME = 120;
  var JSON_SUFFIX = /\.json$/i;
  var CONTROL = /[\u0000-\u001f\u007f]/g;

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /** 去掉控制字符并裁剪长度；非字符串返回空串。 */
  function clean(value, limit) {
    if (typeof value !== "string") return "";
    var result = value.replace(CONTROL, "").trim();
    return result.length > limit ? result.slice(0, limit) : result;
  }

  function fileName(path) {
    var cut = path.lastIndexOf("/");
    return cut === -1 ? path : path.slice(cut + 1);
  }

  function folderName(path) {
    var cut = path.lastIndexOf("/");
    return cut === -1 ? "" : path.slice(0, cut);
  }

  /** 判断一条 /userdata 清单项是不是能进导入列表的工作流文件。 */
  function safePath(value) {
    var path = clean(value, MAX_PATH);
    if (!path || !JSON_SUFFIX.test(path)) return "";
    if (path.charAt(0) === "/" || path.indexOf("..") !== -1 || path.indexOf("\\") !== -1) return "";
    return path;
  }

  /** 把一条 /userdata 清单项（路径相对于 workflows 目录）整理成导入列表要用的形状。 */
  function normalizeEntry(raw) {
    if (!isObject(raw)) return null;
    var path = safePath(raw.path);
    if (!path) return null;
    var name = clean(fileName(path).replace(JSON_SUFFIX, ""), MAX_NAME) || path;
    return {
      path: path,
      name: name,
      folder: clean(folderName(path), MAX_PATH),
      size: typeof raw.size === "number" && raw.size > 0 ? Math.floor(raw.size) : 0,
      modified: typeof raw.modified === "number" && raw.modified > 0 ? Math.floor(raw.modified) : 0,
    };
  }

  /** 整理整份清单：去重、按目录和名字排序、封顶。 */
  function normalizeEntries(raw) {
    if (!Array.isArray(raw)) return [];
    var seen = Object.create(null);
    var entries = [];
    for (var i = 0; i < raw.length && entries.length < MAX_ENTRIES; i += 1) {
      var entry = normalizeEntry(raw[i]);
      if (!entry || seen[entry.path]) continue;
      seen[entry.path] = true;
      entries.push(entry);
    }
    entries.sort(function (a, b) {
      if (a.folder !== b.folder) return a.folder < b.folder ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return entries;
  }

  /** 清单路径 → 电脑端同步时用的 source（和 ComfyUI 标签页的 path 完全一致）。 */
  function sourceOf(entry) {
    return entry && entry.path ? "workflows/" + entry.path : "";
  }

  function matches(entry, query) {
    var needle = clean(query, MAX_NAME).toLowerCase();
    if (!needle) return true;
    return entry.name.toLowerCase().indexOf(needle) !== -1
      || entry.folder.toLowerCase().indexOf(needle) !== -1;
  }

  function filterEntries(entries, query) {
    if (!Array.isArray(entries)) return [];
    var needle = clean(query, MAX_NAME);
    if (!needle) return entries.slice();
    return entries.filter(function (entry) { return matches(entry, needle); });
  }

  function indexRecords(records) {
    var bySource = Object.create(null);
    var byLibraryPath = Object.create(null);
    if (!Array.isArray(records)) return { bySource: bySource, byLibraryPath: byLibraryPath };
    for (var i = 0; i < records.length; i += 1) {
      var record = records[i];
      if (!isObject(record)) continue;
      var source = clean(record.source, MAX_PATH);
      if (source && !bySource[source]) bySource[source] = record;
      var libraryPath = clean(record.library_path, MAX_PATH);
      if (libraryPath && !byLibraryPath[libraryPath]) byLibraryPath[libraryPath] = record;
    }
    return { bySource: bySource, byLibraryPath: byLibraryPath };
  }

  /** 给每条清单项标上「插件里有没有这条记录」「是不是常驻」。 */
  function describe(entries, records) {
    if (!Array.isArray(entries)) return [];
    var index = indexRecords(records);
    return entries.map(function (entry) {
      var source = sourceOf(entry);
      var record = index.bySource[source] || index.byLibraryPath[entry.path] || null;
      return {
        path: entry.path,
        name: entry.name,
        folder: entry.folder,
        size: entry.size,
        modified: entry.modified,
        source: source,
        recordId: record ? clean(String(record.id || ""), 64) : "",
        imported: Boolean(record),
        pinned: Boolean(record && record.pinned),
        recordName: record ? clean(String(record.name || ""), MAX_NAME) : "",
      };
    });
  }

  /** 卡片副标题用：一共多少个、已经导入多少个、其中常驻多少个。 */
  function summarize(described) {
    var list = Array.isArray(described) ? described : [];
    var summary = { total: list.length, imported: 0, pinned: 0 };
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].imported) summary.imported += 1;
      if (list[i] && list[i].pinned) summary.pinned += 1;
    }
    return summary;
  }

  return {
    MAX_ENTRIES: MAX_ENTRIES,
    normalizeEntry: normalizeEntry,
    normalizeEntries: normalizeEntries,
    sourceOf: sourceOf,
    filterEntries: filterEntries,
    describe: describe,
    summarize: summarize,
  };
}));
