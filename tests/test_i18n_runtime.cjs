/* 前端 i18n 运行时：词典回落、占位符、单复数、单例复用。
 * 用假的 fetch 喂词典，再动态 import 真实的 web/i18n.js。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const RUNTIME = pathToFileURL(path.join(__dirname, "..", "web", "i18n.js")).href;

const CATALOGS = {
  en: {
    "设置": "Settings",
    "{n} 个": "{n} item|{n} items",
    "Cloudflare丨临时公网": "Cloudflare | Temporary public network",
    "更新失败：{error}": "Update failed: {error}",
  },
  ja: { "设置": "設定" },
};

function installFixture() {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const lang = String(url).split("/").pop();
    if (!CATALOGS[lang]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => CATALOGS[lang] };
  };
  Object.defineProperty(globalThis, "navigator", { value: { language: "en-GB" }, configurable: true });
  return calls;
}

test("运行时按平台语言加载词典并翻译", async () => {
  const calls = installFixture();
  const { MobileI18n } = await import(RUNTIME);
  await MobileI18n.ready;
  assert.equal(MobileI18n.locale, "en");
  assert.ok(calls.some((url) => url.endsWith("/mobile/api/i18n/en")), "应该按平台语言请求词典");
  assert.equal(MobileI18n.t("设置"), "Settings");
  assert.equal(MobileI18n.t("没有翻译过的文案"), "没有翻译过的文案");
  assert.equal(MobileI18n.t("更新失败：{error}", { error: "timeout" }), "Update failed: timeout");
});

test("占位符缺失时原样保留，不吞掉花括号", async () => {
  installFixture();
  const { MobileI18n } = await import(RUNTIME);
  await MobileI18n.ready;
  assert.equal(MobileI18n.t("更新失败：{error}", { other: 1 }), "Update failed: {error}");
});

test("复数只在调用方给出计数时生效", async () => {
  installFixture();
  const { MobileI18n } = await import(RUNTIME);
  await MobileI18n.ready;
  assert.equal(MobileI18n.t("{n} 个", { n: 1 }), "1 item");
  assert.equal(MobileI18n.t("{n} 个", { n: 3 }), "3 items");
  // 标题里的竖线是分隔符，不是复数：不带 n 时原样返回。
  assert.equal(MobileI18n.t("Cloudflare丨临时公网"), "Cloudflare | Temporary public network");
});

test("切换语言后立即生效，并记住选择", async () => {
  installFixture();
  const { MobileI18n } = await import(RUNTIME);
  await MobileI18n.ready;
  const changes = [];
  const stop = MobileI18n.onChange((locale) => changes.push(locale));
  await MobileI18n.set("ja");
  stop();
  assert.equal(MobileI18n.locale, "ja");
  assert.equal(MobileI18n.t("设置"), "設定");
  assert.deepEqual(changes, ["ja"]);
  assert.equal(globalThis.localStorage, undefined);
});

test("同一个页面里多次加载只保留一份运行时", async () => {
  installFixture();
  const first = await import(RUNTIME);
  await first.MobileI18n.ready;
  // ComfyUI 会把扩展目录里的 .js 逐个 import，URL 上的 ?v= 又各不相同：
  // 第二次求值必须复用先建好的那一个，否则词典和监听会各持一套。
  const second = await import(RUNTIME + "?second=1");
  assert.equal(second.MobileI18n, first.MobileI18n);
});

test("词典拿不到也不会抛错，只是退回中文原文", async () => {
  delete globalThis.MobileI18n;
  delete globalThis.MobileI18nReady;
  globalThis.fetch = async () => { throw new Error("offline"); };
  const { MobileI18n } = await import(RUNTIME + "?offline=1");
  await MobileI18n.ready;
  assert.equal(MobileI18n.locale, "en");
  assert.equal(MobileI18n.t("设置"), "设置");
});
