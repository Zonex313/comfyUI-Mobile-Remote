/* 「提示词语言」：标签查词典、连接词按语言换模板。
 * 中文是原始行为（去重「的」、删掉所有空格），其它语言必须保留空格与各自语序。
 * 用 node --test tests/test_preset_prompt_locale.cjs 运行。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MobilePresetCatalog = require("../mobile/preset-catalog.js");
const MobilePresetEngine = require("../mobile/preset-engine.js");

const slot = (id, pool) => ({ id, label: id, pool });
const category = (id, slots, join) => ({ id, label: id, slots, join });

function engineOf(categories, slots) {
  return MobilePresetEngine.create({
    categories,
    state: {
      slots: JSON.parse(JSON.stringify(slots)),
      custom: {},
      freeText: "",
      extraText: "",
      catalog: MobilePresetCatalog.empty(),
    },
    rules: {},
  });
}

const dictionary = (map) => (text) => (Object.prototype.hasOwnProperty.call(map, text) ? map[text] : text);

const PERSON = () => category("person", [slot("age", ["29岁"]), slot("origin", ["韩国"]), slot("look", ["美女"])], "person");
const TOP = () => category("top", [slot("color", ["白色"]), slot("type", ["蕾丝上衣"])], "of-color");
const OUTFIT = () => [
  category("bottom", [slot("color", ["黑色"]), slot("type", ["短裤"])], "of-color"),
  category("panties", [slot("color", ["白色"]), slot("type", ["蕾丝内裤"])], "of-color"),
];

test("不给语言时保持原来的中文拼法", () => {
  const engine = engineOf([PERSON()], { "person.age": { value: "29岁" }, "person.origin": { value: "韩国" }, "person.look": { value: "美女" } });
  assert.equal(engine.compose(), "29岁的韩国美女");
  assert.equal(engine.compose({ locale: "zh" }), "29岁的韩国美女");
});

test("未知语言退回中文模板，不会拼出半截东西", () => {
  const engine = engineOf([PERSON()], { "person.age": { value: "29岁" }, "person.origin": { value: "韩国" }, "person.look": { value: "美女" } });
  assert.equal(engine.compose({ locale: "fr", translate: dictionary({ "29岁": "29 ans" }) }), "29岁的韩国美女");
});

test("英文按空格拼接，绝不被中文那套删空格压成一串", () => {
  const engine = engineOf([PERSON()], { "person.age": { value: "29岁" }, "person.origin": { value: "韩国" }, "person.look": { value: "美女" } });
  const translate = dictionary({ "29岁": "29 years old", "韩国": "Korean", "美女": "beauty" });
  assert.equal(engine.compose({ locale: "en", translate }), "29 years old Korean beauty");
});

test("颜色 + 款式按各语言语序拼", () => {
  const engine = engineOf([TOP()], { "top.color": { value: "白色" }, "top.type": { value: "蕾丝上衣" } });
  const translate = dictionary({ "白色": "White", "蕾丝上衣": "lace top" });
  assert.equal(engine.compose(), "白色的蕾丝上衣");
  assert.equal(engine.compose({ locale: "en", translate }), "White lace top");
  assert.equal(engine.compose({ locale: "ja", translate: dictionary({ "白色": "白", "蕾丝上衣": "レースのトップス" }) }), "白のレースのトップス");
  assert.equal(engine.compose({ locale: "ko", translate: dictionary({ "白色": "화이트", "蕾丝上衣": "레이스 상의" }) }), "화이트 레이스 상의");
});

test("下衣漏出内裤：中文是「…的边缘漏出…」，英文要把顺序倒过来", () => {
  const slots = { "bottom.color": { value: "黑色" }, "bottom.type": { value: "短裤" },
    "panties.color": { value: "白色" }, "panties.type": { value: "蕾丝内裤" } };
  const translate = dictionary({ "黑色": "Black", "短裤": "shorts", "白色": "White", "蕾丝内裤": "lace panties" });
  const chinese = engineOf(OUTFIT(), slots);
  assert.equal(chinese.compose(), "黑色的短裤的边缘漏出白色的蕾丝内裤");
  const english = engineOf(OUTFIT(), slots);
  assert.equal(english.compose({ locale: "en", translate }), "White lace panties peeking out from under Black shorts");
  const japanese = engineOf(OUTFIT(), slots);
  assert.equal(japanese.compose({ locale: "ja", translate: dictionary({ "黑色": "黒", "短裤": "ショートパンツ", "白色": "白", "蕾丝内裤": "レースのパンティー" }) }),
    "黒のショートパンツの裾から白のレースのパンティーがのぞく");
});

test("单个标签才是「独立项」时也要跟着语言走", () => {
  const categories = [category("outfit", [slot("state", ["全裸"])])];
  const engine = engineOf(categories, { "outfit.state": { value: "全裸" } });
  assert.equal(engine.compose(), "全裸");
  assert.equal(engine.compose({ locale: "en", translate: dictionary({ "全裸": "Fully nude" }) }), "Fully nude");
});

test("没有译文的标签原样保留，不会变成空", () => {
  const engine = engineOf([PERSON()], { "person.age": { value: "29岁" }, "person.origin": { value: "韩国" }, "person.look": { value: "美女" } });
  const translate = dictionary({ "韩国": "Korean" });
  assert.equal(engine.compose({ locale: "en", translate }), "29岁 Korean 美女");
});

test("同一条提示词里多种语言互不干扰（同一个引擎反复调用）", () => {
  const engine = engineOf([TOP()], { "top.color": { value: "白色" }, "top.type": { value: "蕾丝上衣" } });
  const translate = dictionary({ "白色": "White", "蕾丝上衣": "lace top" });
  assert.equal(engine.compose({ locale: "en", translate }), "White lace top");
  assert.equal(engine.compose(), "白色的蕾丝上衣");
  assert.equal(engine.compose({ locale: "en", translate }), "White lace top");
});
