/* Shared i18n runtime for the phone page and the desktop panel.
 *
 * Source strings stay Chinese in the code and double as dictionary keys:
 * a missing translation always falls back to the Chinese original, so the
 * UI can never end up blank.  Dictionaries are plain JSON served by the
 * plugin itself, which lets the Python side reuse the very same files.
 */
const LOCALES = [
  { id: "zh", label: "中文", htmlLang: "zh-CN" },
  { id: "en", label: "English", htmlLang: "en" },
  { id: "ja", label: "日本語", htmlLang: "ja" },
  { id: "ko", label: "한국어", htmlLang: "ko" },
];
const DEFAULT_LOCALE = "en";
const LOCALE_IDS = LOCALES.map((item) => item.id);
const STORAGE_KEY = "comfy-mobile-remote.ui-locale";
// 和服务端 server.py 的 LOCALE_COOKIE 保持一致：直接连接时服务端靠它
// 决定提示语用哪种语言（隧道里 Cookie 不转发，那边退回 Accept-Language）。
const LOCALE_COOKIE = "mtr_locale";
const DICT_URL = (lang) => `/mobile/api/i18n/${lang}`;
const DICT_TIMEOUT_MS = 5000;

let locale = "zh";
let catalog = {};
/* 每份词典只取一次：界面语言之外的语言也要用——提示词可以指定拼成别的语言。
   键是 locale id，值是那份词典（zh 是空对象，中文就是原文）。 */
const catalogs = Object.create(null);
let storage = null;
try { storage = globalThis.localStorage || null; } catch { storage = null; }

function normalizeTag(tag) {
  const primary = String(tag || "").trim().toLowerCase().split(/[-_]/)[0];
  return LOCALE_IDS.includes(primary) ? primary : "";
}

/* Platform default first, then the browser preference list, then English:
 * a system language we do not ship (fr, de, ...) must not silently fall
 * back to Chinese for someone who cannot read it. */
function detectLocale() {
  const candidates = [];
  try {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
    if (navigator.language) candidates.push(navigator.language);
  } catch { /* No navigator (tests, workers): keep the fallback. */ }
  for (const tag of candidates) {
    const match = normalizeTag(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

function storedLocale() {
  try {
    const value = storage && storage.getItem(STORAGE_KEY);
    return LOCALE_IDS.includes(value) ? value : "";
  } catch { return ""; }
}

function persistLocale(id) {
  try { storage && storage.setItem(STORAGE_KEY, id); } catch { /* Storage is optional. */ }
  try {
    document.cookie = `${LOCALE_COOKIE}=${id}; path=/; max-age=31536000; SameSite=Lax`;
  } catch { /* No document (tests, workers). */ }
}

/* `{name}` placeholders are substituted after the lookup, so a translation
 * may reorder them freely.  A value containing `|` gives a singular|plural
 * pair, but only when the caller actually passes a count as `n` — some
 * titles legitimately contain a "|" separator of their own. */
function translate(source, params) {
  /* 传进来的不是文本就原样返回。曾经有人把 DOM 元素递给 t()，结果元素被
   * String() 成了 "[object HTMLParagraphElement]"，界面直接崩在赋值上。 */
  if (typeof source !== "string") return source;
  const text = source;
  if (!text) return text;
  let value = catalog && Object.prototype.hasOwnProperty.call(catalog, text) ? catalog[text] : text;
  if (typeof value !== "string") value = text;
  if (params && Object.prototype.hasOwnProperty.call(params, "n") && value.includes("|")) {
    const forms = value.split("|");
    const count = Number(params.n);
    value = forms[Number.isFinite(count) && count === 1 ? 0 : 1] ?? forms[0];
  }
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

/* Per-locale Intl formatting: "今天 14:03" cannot be assembled from
 * translated fragments without producing broken Japanese or Korean. */
function formatTime(value, options) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try { return date.toLocaleTimeString(currentHtmlLang(), options); }
  catch { return date.toLocaleTimeString(); }
}

function formatDate(value, options) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try { return date.toLocaleDateString(currentHtmlLang(), options); }
  catch { return date.toLocaleDateString(); }
}

function currentHtmlLang() {
  const entry = LOCALES.find((item) => item.id === locale);
  return entry ? entry.htmlLang : locale;
}

const listeners = new Set();

function notify() {
  for (const listener of [...listeners]) {
    try { listener(locale); } catch (error) { console.error("[Mobile Remote] locale listener failed", error); }
  }
}

/* Static markup opts in with data-i18n / data-i18n-aria-label /
 * data-i18n-title / data-i18n-placeholder, so a language switch does not
 * need a page reload. */
const ATTR_BINDINGS = [
  ["data-i18n-aria-label", "aria-label"],
  ["data-i18n-title", "title"],
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-alt", "alt"],
];

function applyStatic(root) {
  const scope = root || (typeof document !== "undefined" ? document : null);
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  for (const node of scope.querySelectorAll("[data-i18n]")) {
    const key = node.getAttribute("data-i18n");
    if (!key) continue;
    if (node.hasAttribute("data-i18n-html")) node.innerHTML = translate(key);
    else node.textContent = translate(key);
  }
  for (const [attribute, target] of ATTR_BINDINGS) {
    for (const node of scope.querySelectorAll(`[${attribute}]`)) {
      node.setAttribute(target, translate(node.getAttribute(attribute)));
    }
  }
}

/* 词典拿不到就退回中文原文，绝不能让界面卡在等待上：桌面端是在扩展注册前
 * await 它的，请求挂住就等于整块面板不出现。 */
async function loadCatalog(id) {
  if (id === "zh") return {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DICT_TIMEOUT_MS);
  try {
    const response = await fetch(DICT_URL(id), { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return body && typeof body === "object" ? body : {};
  } catch (error) {
    console.error("[Mobile Remote] locale dictionary unavailable", error);
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function setDocumentLang() {
  try { document.documentElement.setAttribute("lang", currentHtmlLang()); } catch { /* Not a document: fine. */ }
}

async function ensureCatalog(id) {
  const next = LOCALE_IDS.includes(id) ? id : DEFAULT_LOCALE;
  if (!catalogs[next]) catalogs[next] = await loadCatalog(next);
  return catalogs[next];
}

/* 先按 locale 取词：拿不到词典就退回原文（中文），绝不拿界面语言的词去顶，
   否则日文界面配英文提示词会拼出一个三不像的东西。 */
function translateIn(id, source, params) {
  if (typeof source !== "string" || !source) return source;
  const key = LOCALE_IDS.includes(id) ? id : DEFAULT_LOCALE;
  if (key === "zh") return source;
  const dict = catalogs[key];
  if (!dict) return source;
  const value = Object.prototype.hasOwnProperty.call(dict, source) ? dict[source] : source;
  let text = typeof value === "string" && value ? value : source;
  if (params && Object.prototype.hasOwnProperty.call(params, "n") && text.includes("|")) {
    const forms = text.split("|");
    const count = Number(params.n);
    text = forms[Number.isFinite(count) && count === 1 ? 0 : 1] ?? forms[0];
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

async function useLocale(id, options = {}) {
  const next = LOCALE_IDS.includes(id) ? id : DEFAULT_LOCALE;
  catalog = await ensureCatalog(next);
  locale = next;
  if (options.persist !== false) persistLocale(next);
  setDocumentLang();
  applyStatic(options.root);
  notify();
  return next;
}

function start() {
  return (async () => {
    const initial = storedLocale() || detectLocale();
    await useLocale(initial, { persist: true });
    return api;
  })();
}


const runtime = {
  locales: LOCALES.map((item) => ({ ...item })),
  defaultLocale: DEFAULT_LOCALE,
  storageKey: STORAGE_KEY,
  get locale() { return locale; },
  get htmlLang() { return currentHtmlLang(); },
  get ready() { return readyPromise; },
  t: translate,
  /* 指定语言取词：提示词语言要和界面语言分开，所以不能只有一个当前词典。 */
  tIn: translateIn,
  ensureLocale: ensureCatalog,
  hasLocale(id) { return Boolean(catalogs[LOCALE_IDS.includes(id) ? id : DEFAULT_LOCALE]); },
  set: useLocale,
  onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  applyStatic,
  formatTime,
  formatDate,
  detect: detectLocale,
  start,
  /* Exposed for tests and for the desktop panel, which resolves its own
   * default before the runtime has touched the document. */
  normalizeTag,
  labelOf(id) { const entry = LOCALES.find((item) => item.id === id); return entry ? entry.label : id; },
};

/* ComfyUI 会把扩展目录里的 .js 逐个 import 一次，而这个运行时同时还会从
 * /mobile/assets/i18n.js 加载。同一个页面里出现两份模块实例时，必须复用先
 * 建好的那一份，否则词典和语言切换监听会各持一套、互相看不见。 */
const api = globalThis.MobileI18n || runtime;
globalThis.MobileI18n = api;

const readyPromise = globalThis.MobileI18nReady || start();
globalThis.MobileI18nReady = readyPromise;

export const t = (text, params) => api.t(text, params);
export { api as MobileI18n, readyPromise as mobileI18nReady };
export const ready = readyPromise;
export default api;
