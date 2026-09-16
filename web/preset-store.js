import { t } from "./i18n.js?v=202610121";
import "/mobile/assets/preset-catalog.js?v=202610121";

const Model = globalThis.MobilePresetCatalog;
const LEGACY_KEY = "comfy-mobile-remote.catalog-editor.v2";
const TAB_KEY = "comfy-mobile-remote.catalog-editor.tab";
const PREFIX = "comfy-mobile-remote.catalog-editor.v3.";
const LEASE_MS = 120000;
const LEASE_RENEW_MS = 15000;
const copy = (value) => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function storageKeys(storage) {
  const keys = [];
  if (!storage) return keys;
  try {
    const count = Number(storage.length) || 0;
    for (let index = 0; index < count; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string") keys.push(key);
    }
  } catch { /* Storage may be unavailable. */ }
  return keys;
}

function readSlot(storage, key) {
  try { return storage?.getItem(key); } catch { return null; }
}

function writeSlot(storage, key, value) {
  if (!storage) return;
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

// The store outlives a sidebar view. Each tab writes an independent localStorage
// journal; the session only remembers this tab's id so refresh reclaims it.
export class CatalogStore {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.clock = options.clock || Date.now;
    this.setTimer = options.setTimeout || globalThis.setTimeout.bind(globalThis);
    this.clearTimer = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    try { this.storage = options.storage === undefined ? globalThis.localStorage : options.storage; } catch { this.storage = null; }
    try { this.session = options.session === undefined ? globalThis.sessionStorage : options.session; } catch { this.session = null; }
    this.listeners = new Set();
    this.base = Model.empty();
    this.value = Model.empty();
    this.revision = 0;
    this.known = false;
    this.retryUntil = 0;
    this.timer = null;
    this.leaseTimer = null;
    this.loading = null;
    this.saving = null;
    this.error = "";
    this.blocked = false;
    this.disposed = false;
    this.controller = null;
    this.leaseExpired = false;
    this.journalId = "";
    this.restoreJournal();
    if (!this.journalId) this.journalId = this.newJournalId();
    try { if (this.journalId) writeSlot(this.session, TAB_KEY, this.journalId); } catch { /* session is optional */ }
    if (this.dirty) this.journal();
    this.pagehide = (event) => { this.leaseExpired = !event?.persisted; this.journal(); };
    this.pageshow = () => { this.leaseExpired = false; this.journal(); this.scheduleLease(); };
    globalThis.addEventListener?.("pagehide", this.pagehide);
    globalThis.addEventListener?.("pageshow", this.pageshow);
    this.schedule();
    this.scheduleLease();
  }
  get dirty() { return !equal(this.base, this.value); }
  snapshot() {
    return { catalog: copy(this.value), dirty: this.dirty, saving: Boolean(this.saving),
      known: this.known, error: this.error, remainingMs: Math.max(0, this.retryUntil - this.clock()) };
  }
  subscribe(fn) { this.listeners.add(fn); fn(this.snapshot()); return () => this.listeners.delete(fn); }
  emit() { if (!this.disposed) for (const fn of this.listeners) fn(this.snapshot()); }
  newJournalId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = `${this.clock().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      if (!readSlot(this.storage, PREFIX + id)) return id;
    }
    return `${this.clock().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  parseEntry(raw) {
    const data = JSON.parse(raw);
    if (data.schema !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error("journal");
    const base = Model.normalize(data.base);
    const value = Model.normalize(data.value);
    return { base, value, revision: data.revision, retryUntil: Number(data.retryUntil) || 0,
      aliveUntil: Number(data.aliveUntil) || 0, updatedAt: Number(data.updatedAt) || 0 };
  }
  readJournal(id) {
    const raw = readSlot(this.storage, PREFIX + id);
    if (!raw) return null;
    return this.parseEntry(raw);
  }
  applyEntry(entry) {
    this.base = copy(entry.base);
    this.value = copy(entry.value);
    this.revision = entry.revision;
    this.retryUntil = entry.retryUntil;
  }
  takeLegacy() {
    for (const storage of [this.session, this.storage]) {
      const raw = readSlot(storage, LEGACY_KEY);
      if (!raw) continue;
      try {
        const entry = this.parseEntry(raw);
        try { writeSlot(this.session, LEGACY_KEY, null); } catch { /* ignore */ }
        try { writeSlot(this.storage, LEGACY_KEY, null); } catch { /* ignore */ }
        return entry;
      } catch { try { writeSlot(storage, LEGACY_KEY, null); } catch { /* ignore */ } }
    }
    return null;
  }
  collectOrphans() {
    const now = this.clock();
    const orphans = [];
    for (const key of storageKeys(this.storage)) {
      if (!key.startsWith(PREFIX)) continue;
      const id = key.slice(PREFIX.length);
      if (!id || id === this.journalId) continue;
      try {
        const entry = this.parseEntry(readSlot(this.storage, key));
        if (equal(entry.base, entry.value)) { writeSlot(this.storage, key, null); continue; }
        if (entry.aliveUntil > now) continue;
        orphans.push({ ...entry, id });
      } catch { writeSlot(this.storage, key, null); }
    }
    return orphans;
  }
  mergeEntries(entries) {
    const sorted = entries.slice().sort((a, b) => a.revision - b.revision || a.updatedAt - b.updatedAt);
    const acc = { base: copy(sorted[0].base), value: copy(sorted[0].value),
      revision: sorted[0].revision, retryUntil: sorted[0].retryUntil };
    for (let index = 1; index < sorted.length; index += 1) {
      const item = sorted[index];
      if (item.revision > acc.revision) {
        const rebased = Model.merge(acc.base, acc.value, item.base);
        acc.value = Model.merge(item.base, rebased, item.value);
        acc.base = copy(item.base);
        acc.revision = item.revision;
      } else if (item.revision < acc.revision) {
        const rebased = Model.merge(item.base, item.value, acc.base);
        acc.value = Model.merge(acc.base, acc.value, rebased);
      } else acc.value = Model.merge(acc.base, acc.value, item.value);
      acc.retryUntil = Math.max(acc.retryUntil, item.retryUntil);
    }
    return acc;
  }
  restoreJournal() {
    const sessionId = readSlot(this.session, TAB_KEY) || "";
    try {
      if (sessionId) {
        const own = this.readJournal(sessionId);
        if (own) {
          if (!equal(own.base, own.value)) { this.journalId = sessionId; this.applyEntry(own); this.error = ""; return; }
          writeSlot(this.storage, PREFIX + sessionId, null);
        }
      }
    } catch { this.error = t("本页暂存读取失败，请重新打开标签管理检查"); }

    try {
      const migrated = this.takeLegacy();
      if (migrated && !equal(migrated.base, migrated.value)) { this.applyEntry(migrated); this.error = ""; return; }
      const orphans = this.collectOrphans();
      if (!orphans.length) return;
      this.applyEntry(this.mergeEntries(orphans));
      for (const item of orphans) writeSlot(this.storage, PREFIX + item.id, null);
      this.error = "";
    } catch { if (!this.error) this.error = t("本页暂存读取失败，请重新打开标签管理检查"); }
  }
  journal() {
    try {
      const key = PREFIX + this.journalId;
      if (!this.journalId || !this.dirty) { if (this.journalId) writeSlot(this.storage, key, null); return; }
      const now = this.clock();
      const aliveUntil = this.leaseExpired ? now : Math.max(now + LEASE_MS, this.retryUntil + LEASE_MS);
      writeSlot(this.storage, key, JSON.stringify({ schema: 1, base: this.base, value: this.value,
        revision: this.revision, retryUntil: this.retryUntil, aliveUntil, updatedAt: now }));
      this.scheduleLease();
    } catch { this.error = t("浏览器暂存不可用，请等保存完成再关闭页面"); }
  }
  scheduleLease() {
    if (this.leaseTimer !== null) this.clearTimer(this.leaseTimer);
    this.leaseTimer = null;
    if (this.disposed || this.leaseExpired || !this.dirty) return;
    this.leaseTimer = this.setTimer(() => {
      this.leaseTimer = null;
      this.journal();
      this.scheduleLease();
    }, Math.max(LEASE_RENEW_MS, this.retryUntil - this.clock()));
  }
  journalMatches(entry) {
    return entry && entry.revision === this.revision && equal(entry.base, this.base) && equal(entry.value, this.value);
  }
  change(mutator) {
    if (this.disposed || !this.known) throw new Error(t("请等待目录读取完成"));
    const next = copy(this.value);
    mutator(next);
    this.value = Model.normalize(next);
    this.blocked = false;
    this.journal();
    this.emit();
    this.schedule();
  }
  async retry() {
    if (this.disposed) return;
    this.blocked = false;
    this.retryUntil = 0;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    return this.flush();
  }
  schedule() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.disposed || this.blocked || !this.dirty || this.saving || this.loading) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.flush(); },
      Math.max(400, this.retryUntil - this.clock()));
  }
  async request(payload) {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = this.setTimer(() => controller.abort(), 15000);
    try {
      const response = await this.fetch("/mobile/api/settings", {
        method: payload ? "POST" : "GET", cache: "no-store", signal: controller.signal,
        ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
      });
      let body = {};
      try { body = await response.json(); } catch { body = {}; }
      if (![200, 409, 429].includes(response.status)) {
        const error = new Error(body.error || t("目录保存服务暂未就绪"));
        error.status = response.status;
        throw error;
      }
      if (!Number.isSafeInteger(body.revision) || body.revision < 0 || !body.values || typeof body.values !== "object") {
        throw new Error(t("服务器返回的目录格式不完整"));
      }
      return { status: response.status, body };
    } finally {
      this.clearTimer(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }
  adopt(body, sent = null) {
    const remote = Model.fromValues(body.values);
    this.value = Model.merge(sent || this.base, this.value, remote);
    this.base = copy(remote);
    this.revision = body.revision;
    this.known = true;
    this.blocked = false;
    this.retryUntil = Math.max(this.retryUntil, this.clock() + (Number(body.retry_after_ms) || 0));
    this.journal();
  }
  async load() {
    if (this.disposed) return;
    if (this.loading) return this.loading;
    if (this.saving) await this.saving;
    this.loading = (async () => {
      const { status, body } = await this.request();
      if (status !== 200) throw new Error(body.error || t("读取目录失败"));
      if (!this.disposed) { this.adopt(body); this.error = ""; }
    })();
    try { await this.loading; }
    catch (error) { if (!this.disposed) this.error = error.message; throw error; }
    finally { this.loading = null; this.emit(); this.schedule(); }
  }
  async flush() {
    if (this.disposed) return;
    if (this.saving) return this.saving;
    if (this.loading) {
      try { await this.loading; } catch { /* The load error is surfaced by load(). */ }
    }
    if (!this.known) { try { await this.load(); } catch { this.retryUntil = this.clock() + 5000; this.schedule(); return; } }
    if (!this.dirty || this.clock() < this.retryUntil) { this.schedule(); return; }
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.saving = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const sent = copy(this.value);
        const { status, body } = await this.request({ base_revision: this.revision,
          changes: { [Model.key]: JSON.stringify(sent) } });
        if (this.disposed) return;
        // Success acknowledges only the transmitted snapshot. Changes made while
        // awaiting the request are replayed onto its response, never discarded.
        this.adopt(body, status === 200 ? sent : null);
        this.error = "";
        if (status === 200 || status === 429 || !this.dirty || this.clock() < this.retryUntil) return;
      }
    })();
    this.emit();
    try { await this.saving; }
    catch (error) {
      if (!this.disposed) {
        this.error = error.message || t("保存未成功，稍后重试");
        if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 409) {
          this.blocked = true;
        } else {
          this.retryUntil = this.clock() + 5000;
        }
      }
    } finally {
      this.saving = null;
      this.journal();
      this.emit();
      this.schedule();
    }
  }
  destroy() {
    this.leaseExpired = true;
    this.journal();
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.leaseTimer !== null) this.clearTimer(this.leaseTimer);
    this.controller?.abort();
    globalThis.removeEventListener?.("pagehide", this.pagehide);
    globalThis.removeEventListener?.("pageshow", this.pageshow);
    this.listeners.clear();
  }
}

let store;
export function sharedCatalogStore() { return store ||= new CatalogStore(); }
