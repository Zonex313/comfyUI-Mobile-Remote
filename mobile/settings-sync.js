/* Shared phone preferences: one deferred upload per minute, never on unload. */
(function (root) {
  "use strict";
  const MINUTE = 60000;
  const CACHE = "comfy-mobile-remote.settings-cache";
  const ATTEMPT = "comfy-mobile-remote.settings-last-attempt";
  const API = "/mobile/api/settings";
  const PREFIX = "comfy-mobile-remote.";
  const Catalog = root.MobilePresetCatalog || (typeof require === "function" ? require("./preset-catalog.js") : null);
  const ALLOWED = /^(?:workflow|preset|presetCatalog|randomGenerate|repeatCount|favoritesOnly|historyCols|multiModel|fixedSeed|multiModels|draft\.[a-f0-9]{20})$/;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const validKey = (key) => typeof key === "string" && key.startsWith(PREFIX) && ALLOWED.test(key.slice(PREFIX.length));
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const filtered = (value, nullable = false) => Object.fromEntries(Object.entries(object(value) ? value : {})
    .filter(([key, item]) => validKey(key) && (typeof item === "string" || (nullable && item === null))));

  class MobileSettingsSync {
    constructor(options = {}) {
      try { this.storage = options.storage === undefined ? root.localStorage : options.storage; } catch { this.storage = null; }
      this.fetch = options.fetch || root.fetch.bind(root);
      this.clock = options.clock || (() => Date.now());
      this.setTimeout = options.setTimeout || root.setTimeout.bind(root);
      this.clearTimeout = options.clearTimeout || root.clearTimeout.bind(root);
      this.onStatus = options.onStatus || (() => {});
      this.locks = options.locks === undefined ? root.navigator?.locks : options.locks;
      this.base = {};
      this.pending = {};
      this.revision = 0;
      this.savedAt = 0;
      this.exists = false;
      this.known = false;
      this.ready = false;
      this.firstDirty = null;
      this.lastAttempt = null;
      this.retryUntil = 0;
      this.batchDepth = 0;
      this.sending = false;
      this.disposed = false;
      this.conflict = null;
      this.error = "";
      this.serverResponseKnown = false;
      this.serverCatalogInvalid = false;
      this.catalogRebased = false;
      this.timer = null;
      this.journalTimer = null;
      this.reading = null;
      this.generation = 0;
      this.afterSendDirtyAt = null;
      this.controllers = new Set();
      this.pagehide = () => this._persist();
      this.online = () => { this._schedule(); };
      root.addEventListener?.("pagehide", this.pagehide);
      root.addEventListener?.("online", this.online);
      this._emit("loading");
    }

    get dirty() { return Object.keys(this.pending).length > 0; }
    getItem(key) {
      if (!validKey(key)) return null;
      return own(this.pending, key) ? this.pending[key] : (this.base[key] ?? null);
    }
    setItem(key, value) {
      if (!validKey(key)) throw new Error("不支持的手机设置");
      if (value !== null && typeof value !== "string") throw new Error("设置值应为文本");
      if (this.getItem(key) === value || this.disposed) return;
      const hadDirty = this.dirty;
      this.pending[key] = value;
      if (!this.sending && value === (this.base[key] ?? null)) delete this.pending[key];
      this.generation += 1;
      if (!hadDirty && this.dirty) this.firstDirty = this.clock();
      if (this.sending && this.afterSendDirtyAt === null) this.afterSendDirtyAt = this.clock();
      if (!this.dirty) this.firstDirty = null;
      this._journal();
      this._schedule();
      this._emit();
    }
    beginBatch() { this.batchDepth += 1; this._schedule(); }
    endBatch() { this.batchDepth = Math.max(0, this.batchDepth - 1); this._schedule(); }

    _snapshot() {
      const values = { ...this.base };
      for (const [key, value] of Object.entries(this.pending)) {
        if (value === null) delete values[key]; else values[key] = value;
      }
      return { ok: true, revision: this.revision, saved_at: this.savedAt, exists: this.exists, values };
    }
    _emit(force) {
      if (this.disposed) return;
      const state = force || (this.conflict ? "conflict" : this.sending ? "saving" :
        this.error ? "offline" : this.dirty ? "pending" : "synced");
      const catalogRebased = this.catalogRebased;
      this.catalogRebased = false;
      this.onStatus({ state, savedAt: this.savedAt, exists: this.exists, error: this.error,
        remainingMs: this.dirty ? Math.max(0, this._due() - this.clock()) : 0,
        catalogRebased, catalogInvalid: this.serverCatalogInvalid });
    }
    _get(key) { try { return this.storage?.getItem(key); } catch { return null; } }
    _put(key, value) { try { this.storage?.setItem(key, value); } catch { /* In-memory operation remains available. */ } }
    _journal() {
      if (this.journalTimer !== null || this.disposed) return;
      this.journalTimer = this.setTimeout(() => { this.journalTimer = null; this._persist(); }, 400);
    }
    _persist() {
      if (this.journalTimer !== null) this.clearTimeout(this.journalTimer);
      this.journalTimer = null;
      this._put(CACHE, JSON.stringify({ revision: this.revision, savedAt: this.savedAt, exists: this.exists,
        values: this.base, pending: this.pending, firstDirty: this.firstDirty, lastAttempt: this.lastAttempt,
        retryUntil: this.retryUntil, known: this.known || this.cachedKnown === true }));
    }
    _loadCache() {
      try {
        const cached = JSON.parse(this._get(CACHE) || "null");
        if (!object(cached) || !Number.isSafeInteger(cached.revision) || cached.revision < 0) return;
        this.base = filtered(cached.values);
        this.pending = filtered(cached.pending, true);
        this.revision = cached.revision;
        this.savedAt = Number(cached.savedAt) || 0;
        this.exists = cached.exists === true;
        this.firstDirty = this.dirty && Number.isFinite(cached.firstDirty) ? cached.firstDirty : null;
        this.lastAttempt = Number.isFinite(cached.lastAttempt) ? cached.lastAttempt : null;
        this.retryUntil = Number(cached.retryUntil) || 0;
        this.cachedKnown = cached.known === true;
        this.conflict = null;
        if (this.dirty && this.firstDirty === null) this.firstDirty = this.clock();
      } catch { /* A damaged local backup must not replace the computer's settings. */ }
    }
    _validate(body) {
      if (!object(body) || !Number.isSafeInteger(body.revision) || body.revision < 0 ||
          !Number.isFinite(body.saved_at) || typeof body.exists !== "boolean" || !object(body.values) ||
          Object.entries(body.values).some(([key, value]) => !validKey(key) || typeof value !== "string")) {
        throw new Error("电脑返回的设置格式不完整");
      }
      return body;
    }
    async _request(payload) {
      const controller = new AbortController();
      this.controllers.add(controller);
      const timer = this.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await this.fetch(API, { method: payload ? "POST" : "GET", cache: "no-store",
          signal: controller.signal, ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}) });
        const body = await response.json();
        if (response.ok || response.status === 409 || response.status === 429) this._validate(body);
        if (!response.ok && response.status !== 409 && response.status !== 429) throw new Error(body?.error || "电脑端设置暂未连接");
        return { status: response.status, body };
      } finally {
        this.clearTimeout(timer);
        this.controllers.delete(controller);
      }
    }
    _adopt(body) {
      this.base = filtered(body.values);
      this.revision = body.revision;
      this.savedAt = body.saved_at;
      this.exists = body.exists;
      this.known = true;
      this.cachedKnown = true;
      this.error = "";
      this.retryUntil = Math.max(this.retryUntil, this.clock() + (Number(body.retry_after_ms) || 0));
    }
    _prunePending() {
      for (const [key, value] of Object.entries(this.pending)) {
        if (value === (this.base[key] ?? null)) delete this.pending[key];
      }
      if (!this.dirty) this.firstDirty = null;
    }
    _consider(body) {
      const remote = this._validate(body);
      const pending = { ...this.pending };
      const beforeCatalog = Catalog ? this.getItem(Catalog.key) : null;
      const remoteValues = { ...remote.values };
      if (Catalog && own(remoteValues, Catalog.key)) {
        try {
          Catalog.fromValues(remoteValues);
          this.serverCatalogInvalid = false;
        } catch {
          this.serverCatalogInvalid = true;
          delete remoteValues[Catalog.key];
        }
      } else if (Catalog) this.serverCatalogInvalid = false;
      if (Catalog && typeof pending[Catalog.key] === "string") {
        let localCatalog = null;
        try { localCatalog = Catalog.normalize(JSON.parse(pending[Catalog.key])); }
        catch { delete pending[Catalog.key]; }
        if (localCatalog && !this.serverCatalogInvalid) {
          try {
            pending[Catalog.key] = JSON.stringify(Catalog.merge(
              Catalog.fromValues(this.base), localCatalog, Catalog.fromValues(remoteValues)));
          } catch { /* Keep the local catalog when only the remote side is unusable. */ }
        }
      }
      this._adopt({ ...remote, values: remoteValues });
      this.pending = pending;
      this.conflict = null;
      this._prunePending();
      if (Catalog && this.getItem(Catalog.key) !== beforeCatalog) this.catalogRebased = true;
      if (this.dirty && this.firstDirty === null) this.firstDirty = this.clock();
      return this.dirty ? "rebase" : "adopt";
    }
    _migration() {
      if (this.exists) return;
      const legacy = [];
      try {
        for (let index = 0; index < (this.storage?.length || 0); index += 1) {
          const key = this.storage.key(index);
          if (validKey(key)) legacy.push([key, this._get(key)]);
        }
      } catch { /* Optional browser storage. */ }
      for (const [key, value] of legacy) if (value !== null && !own(this.pending, key)) this.setItem(key, value);
    }
    async init() {
      this._loadCache();
      try {
        const { status, body } = await this._request();
        if (status !== 200) throw new Error("读取电脑设置失败");
        this.serverResponseKnown = true;
        this.serverCatalogInvalid = false;
        this._consider(body);
        this._migration();
      } catch (error) {
        this.known = false;
        this.error = error.message || "电脑暂未连接";
        if (!this.dirty && !this.serverCatalogInvalid) this._migration();
      }
      this.ready = true;
      this._persist();
      this._schedule();
      this._emit();
      return this._snapshot();
    }
    _due() {
      const globalAttempt = Number(this._get(ATTEMPT));
      const shared = this._get(ATTEMPT) !== null && Number.isFinite(globalAttempt) ? globalAttempt : null;
      const last = Math.max(this.lastAttempt ?? -Infinity, shared ?? -Infinity);
      return Math.max((this.firstDirty ?? this.clock()) + MINUTE, last + MINUTE, this.retryUntil);
    }
    _schedule() {
      if (this.timer !== null) this.clearTimeout(this.timer);
      this.timer = null;
      if (this.disposed || !this.ready || !this.dirty || this.sending || this.batchDepth || this.conflict) return;
      this.timer = this.setTimeout(() => { this.timer = null; void this._upload(); }, Math.max(0, this._due() - this.clock()));
    }
    async _recover() {
      const { status, body } = await this._request();
      if (status !== 200) throw new Error("读取电脑设置失败");
      this._consider(body);
      return true;
    }
    async _upload() {
      if (this.disposed || this.sending || this.batchDepth || this.conflict || !this.dirty) return;
      if (this.clock() < this._due()) { this._schedule(); return; }
      this.sending = true;
      this._emit();
      const perform = async () => {
        if (this.disposed || this.batchDepth || this.conflict || this.clock() < this._due()) return;
        if (!this.known && !await this._recover()) return;
        if (this.disposed || this.batchDepth || this.clock() < this._due()) return;
        this.lastAttempt = this.clock();
        this._put(ATTEMPT, String(this.lastAttempt));
        this.afterSendDirtyAt = null;
        this._persist();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (!this.dirty) return;
          const sent = { ...this.pending };
          const baseRevision = this.revision;
          const { status, body } = await this._request({ base_revision: baseRevision, changes: sent });
          if (this.disposed) return;
          if (status === 409 || (status === 429 && body.revision !== baseRevision)) {
            this._consider(body);
            if (attempt === 0 && this.dirty) continue;
            this.error = "等待下一次设置同步";
            return;
          }
          if (status === 429) {
            this.retryUntil = Math.max(this.retryUntil, this.clock() + Math.max(MINUTE, Number(body.retry_after_ms) || 0));
            this.error = "等待下一次设置同步";
            return;
          }
          if (Catalog && typeof sent[Catalog.key] === "string" && typeof this.pending[Catalog.key] === "string"
            && this.pending[Catalog.key] !== sent[Catalog.key]) {
            this.pending[Catalog.key] = JSON.stringify(Catalog.merge(
              Catalog.normalize(JSON.parse(sent[Catalog.key])),
              Catalog.normalize(JSON.parse(this.pending[Catalog.key])), Catalog.fromValues(body.values)));
          }
          this._adopt(body);
          this.cachedKnown = true;
          for (const [key, value] of Object.entries(sent)) {
            if (own(this.pending, key) && this.pending[key] === value) delete this.pending[key];
          }
          this._prunePending();
          this.firstDirty = this.dirty ? (this.afterSendDirtyAt ?? this.clock()) : null;
          this.error = "";
          return;
        }
      };
      try {
        if (this.locks?.request) await this.locks.request("comfy-mobile-settings-upload", perform);
        else await perform();
      } catch (error) {
        this.error = error.message || "同步未成功，稍后重试";
        this.retryUntil = Math.max(this.retryUntil, this.clock() + MINUTE);
      } finally {
        this.sending = false;
        this._persist();
        this._schedule();
        this._emit();
      }
    }
    async refresh() {
      if (this.disposed || this.sending || this.batchDepth || this.conflict || this.dirty) return false;
      if (this.reading) return this.reading;
      const generation = this.generation;
      this.reading = (async () => {
        try {
          const { status, body } = await this._request();
          if (status !== 200 || this.disposed || this.dirty || generation !== this.generation) return false;
          const beforeRevision = this.revision;
          const before = JSON.stringify(this.base);
          this._consider(body);
          const changed = this.revision !== beforeRevision || JSON.stringify(this.base) !== before || this.catalogRebased;
          this._persist();
          this._emit();
          return changed;
        } catch (error) {
          this.error = error.message || "读取设置失败";
          this._emit();
          return false;
        } finally { this.reading = null; }
      })();
      return this.reading;
    }
    async resolveConflict(choice) {
      if (!this.conflict || this.sending || this.batchDepth) return;
      if (!["server", "local"].includes(choice)) throw new Error("请选择设置版本");
      const { status, body } = await this._request();
      if (status !== 200) throw new Error("读取最新设置失败");
      if (choice === "server") this.pending = {};
      this._consider(body);
      this.cachedKnown = true;
      this.conflict = null;
      for (const [key, value] of Object.entries(this.pending)) if (value === (this.base[key] ?? null)) delete this.pending[key];
      this.firstDirty = this.dirty ? this.clock() : null;
      this._persist();
      this._schedule();
      this._emit();
    }
    destroy() {
      this._persist();
      this.disposed = true;
      if (this.timer !== null) this.clearTimeout(this.timer);
      for (const controller of this.controllers) controller.abort();
      root.removeEventListener?.("pagehide", this.pagehide);
      root.removeEventListener?.("online", this.online);
    }
  }
  root.MobileSettingsSync = MobileSettingsSync;
  if (typeof module !== "undefined" && module.exports) module.exports = MobileSettingsSync;
})(typeof window !== "undefined" ? window : globalThis);
