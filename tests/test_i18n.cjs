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

/* Python 源码里的字符串字面量：跳过注释与三引号文档串。 */
function pythonLiterals(text) {
  const out = [];
  let index = 0;
  while (index < text.length) {
    const triple = text.slice(index, index + 3);
    if (text[index] === "#") { while (index < text.length && text[index] !== "\n") index += 1; continue; }
    if (triple === '"""' || triple === "'''") {
      index += 3;
      while (index < text.length && text.slice(index, index + 3) !== triple) index += 1;
      index += 3;
      continue;
    }
    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index];
      index += 1;
      let value = "";
      while (index < text.length) {
        if (text[index] === "\\") { value += text[index] + (text[index + 1] || ""); index += 2; continue; }
        if (text[index] === quote) { index += 1; break; }
        value += text[index];
        index += 1;
      }
      out.push(value);
      continue;
    }
    index += 1;
  }
  return out;
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
  /* 服务端取「全部中文字面量」而不是逐个调用形态去匹配：之前正是漏了
   * message="..." 这类写法，12 条连接状态提示没进词典，界面上就露了中文。
   * 只有下面这几个是内部标识，不给人看。 */
  const PY_INTERNAL_ONLY = new Set(["反向", "负面", "正向", "每次随机"]);
  const hasChinese = (value) => /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/.test(value);
  for (const file of PY_SOURCES) {
    for (const value of pythonLiterals(fs.readFileSync(path.join(ROOT, file), "utf8"))) {
      if (!hasChinese(value) || PY_INTERNAL_ONLY.has(value)) continue;
      keys.add(value);
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
