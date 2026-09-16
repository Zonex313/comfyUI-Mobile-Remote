/* i18n 词典一致性：源码里每一个 t("...") 都要有译文，且占位符必须对得上。
 * 用 node --test tests/test_i18n.cjs 运行。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const LOCALES = ["en", "ja", "ko"];
const JS_SOURCES = [
  "mobile/app.js",
  "mobile/settings-sync.js",
  "mobile/progress-sync.js",
  "mobile/index.html",
  "web/remote.js",
  "web/tag-node.js",
  "web/workflow-import.js",
  "web/preset-manager.js",
  "web/preset-store.js",
  "web/sync.js",
];
const PY_SOURCES = ["server.py", "connections.py"];

function unescapeJs(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

function htmlDecode(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/* 与源码同源的键提取：t("…") / _t("…") / data-i18n* 属性。 */
function collectSourceKeys() {
  const keys = new Set();
  for (const file of JS_SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (file.endsWith(".html")) {
      const re = /\sdata-i18n(?:-aria-label|-title|-placeholder|-alt)?="([^"]*)"/g;
      let match;
      while ((match = re.exec(text))) keys.add(htmlDecode(match[1]));
      continue;
    }
    const re = /(^|[^\w$.])t\("((?:[^"\\]|\\.)*)"/g;
    let match;
    while ((match = re.exec(text))) keys.add(unescapeJs(match[2]));
  }
  /* 服务端进词典的路径有两类：显式翻译点（_t / _json_error 的入参）一律算；
   * 结果字典的 error/message 字段与异常文案只挑中文的——像 "action"、
   * "Invalid workflow id" 这类是内部标记，不是给人看的文案。 */
  const PY_EXPLICIT = [
    /(^|[^\w$.])_t\("((?:[^"\\]|\\.)*)"/g,
    /(^|[^\w$.])_json_error\("((?:[^"\\]|\\.)*)"/g,
  ];
  const PY_CHINESE_ONLY = [
    /"error":\s*f?"((?:[^"\\]|\\.)*)"/g,
    /"message":\s*f?"((?:[^"\\]|\\.)*)"/g,
    /raise\s+(?:ValueError|RuntimeError)\("((?:[^"\\]|\\.)*)"/g,
  ];
  const hasChinese = (value) => /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/.test(value);
  for (const file of PY_SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const re of PY_EXPLICIT) {
      let match;
      while ((match = re.exec(text))) keys.add(unescapeJs(match[2] ?? match[1]));
    }
    for (const re of PY_CHINESE_ONLY) {
      let match;
      while ((match = re.exec(text))) {
        const value = unescapeJs(match[1]);
        if (hasChinese(value)) keys.add(value);
      }
    }
  }
  return keys;
}

function placeholders(text) {
  return (String(text).match(/\{\w+\}/g) || []).slice().sort();
}

function readCatalog(locale) {
  const file = path.join(ROOT, "i18n", `${locale}.json`);
  assert.ok(fs.existsSync(file), `缺少词典文件 i18n/${locale}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${locale}.json 必须是对象`);
  return parsed;
}

test("三种语言都随插件一起发布", () => {
  const source = collectSourceKeys();
  assert.ok(source.size > 300, `源码里应该有几百条文案，实际 ${source.size}`);
  for (const locale of LOCALES) readCatalog(locale);
});

test("每种语言都覆盖全部源码文案", () => {
  const source = collectSourceKeys();
  for (const locale of LOCALES) {
    const catalog = readCatalog(locale);
    const missing = [...source].filter((key) => !Object.prototype.hasOwnProperty.call(catalog, key));
    assert.deepEqual(missing, [], `${locale}.json 缺少 ${missing.length} 条译文`);
  }
});

test("词典里没有源码已经不用的键", () => {
  const source = collectSourceKeys();
  for (const locale of LOCALES) {
    const catalog = readCatalog(locale);
    const orphans = Object.keys(catalog).filter((key) => !source.has(key));
    assert.deepEqual(orphans, [], `${locale}.json 有 ${orphans.length} 条源码里已不存在的键`);
  }
});

test("占位符与原文一一对应，译文非空", () => {
  const source = collectSourceKeys();
  for (const locale of LOCALES) {
    const catalog = readCatalog(locale);
    for (const key of source) {
      const value = catalog[key];
      if (typeof value !== "string") continue;
      assert.notEqual(value.trim(), "", `${locale}.json 中 ${JSON.stringify(key)} 的译文为空`);
      const expected = new Set(placeholders(key));
      for (const form of value.split("|")) {
        const actual = new Set(placeholders(form));
        assert.deepEqual(
          [...actual].sort(),
          [...expected].sort(),
          `${locale}.json 中 ${JSON.stringify(key)} 的占位符与原文不一致：${value}`,
        );
      }
    }
  }
});

test("中文原文不需要词典，运行时直接回落", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "i18n", "zh.json")), "中文就是源码原文，不应有 zh.json");
});
