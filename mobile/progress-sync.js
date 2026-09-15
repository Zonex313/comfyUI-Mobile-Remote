(function (root, factory) {
  const exports = factory();
  if (typeof module === "object" && module.exports) module.exports = exports;
  else Object.assign(root, exports);
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";

  const idOf = (value) => value == null ? "" : String(value);
  const numeric = (value) => typeof value === "number" && Number.isFinite(value);
  const bounded = (value) => Math.max(0, Math.min(100, value));

  // Both displays use this node-level state. A 0/1 registry entry is preparation,
  // not a measured percentage of the workflow.
  class MobileProgressStore {
    constructor() {
      this.activeId = "";
      this.activeJob = null;
      this.nodes = new Map();
      this.selectedId = "";
      this.revision = 0;
      this.finished = new Set();
      this.known = false;
    }

    retire(id) {
      if (!id) return;
      this.finished.add(id);
      if (this.finished.size > 64) this.finished.delete(this.finished.values().next().value);
    }

    activate(id, job = null) {
      if (this.activeId !== id) {
        this.retire(this.activeId);
        this.nodes.clear();
        this.selectedId = "";
      }
      this.activeId = id;
      this.activeJob = job || { id, status: "in_progress" };
      this.known = true;
    }

    begin(promptId) {
      const id = idOf(promptId);
      if (!id || this.finished.has(id)) return false;
      this.activate(id, this.activeId === id ? this.activeJob : null);
      this.revision += 1;
      return true;
    }

    set(promptId, patch) {
      const id = idOf(promptId);
      if (!this.accepts(id)) return false;
      if (!this.activeId) this.activate(id);
      const nodeId = idOf(patch?.nodeId || this.selectedId || "sampling");
      const prior = this.nodes.get(nodeId) || { nodeId, displayId: nodeId, value: 0, max: 0, measured: false };
      const value = numeric(patch?.value) ? Math.max(0, patch.value) : prior.value;
      const max = numeric(patch?.max) ? Math.max(0, patch.max) : prior.max;
      this.nodes.set(nodeId, {
        ...prior,
        ...patch,
        nodeId,
        displayId: patch?.displayId || prior.displayId || nodeId,
        value,
        max,
        measured: max > 0 && (max > 1 || value > 0),
      });
      this.selectedId = nodeId;
      this.revision += 1;
      return true;
    }

    delete(promptId) {
      return this.finish(promptId);
    }

    finish(promptId) {
      const id = idOf(promptId);
      if (!id) return false;
      this.retire(id);
      if (this.activeId === id) {
        this.activeId = "";
        this.activeJob = null;
        this.nodes.clear();
        this.selectedId = "";
      }
      this.revision += 1;
      return true;
    }

    accepts(id) {
      return Boolean(id && !this.finished.has(id) && (!this.activeId || this.activeId === id));
    }

    node(raw, key) {
      const rawState = String(raw?.state || "").toLowerCase();
      if (!raw || rawState === "finished" || rawState === "error" || rawState === "pending") return null;
      const value = raw.value;
      const max = raw.max;
      if (!numeric(value) || !numeric(max) || value < 0 || max < 0) return null;
      const id = idOf(raw.node_id || key);
      if (!id) return null;
      return {
        nodeId: id,
        displayId: idOf(raw.display_node_id || id),
        parentId: idOf(raw.parent_node_id),
        value,
        max,
        measured: max > 0 && (max > 1 || value > 0),
      };
    }

    replaceNodes(nodes) {
      this.nodes = new Map(Object.entries(nodes || {}).map(([id, raw]) => {
        const node = this.node(raw, id);
        return node ? [node.nodeId, node] : null;
      }).filter(Boolean));
      const all = [...this.nodes.values()];
      const parents = new Set(all.map((node) => node.parentId).filter(Boolean));
      const leaves = all.filter((node) => !parents.has(node.nodeId));
      const candidates = (leaves.length ? leaves : all);
      const measured = candidates.filter((node) => node.measured);
      const pool = measured.length ? measured : candidates;
      const selected = pool.find((node) => node.nodeId === this.selectedId) || pool[pool.length - 1];
      this.selectedId = selected?.nodeId || "";
    }

    acceptProgressState(data) {
      const id = idOf(data?.prompt_id);
      if (!this.accepts(id)) return false;
      if (!this.activeId) this.activate(id);
      this.replaceNodes(data.nodes);
      this.revision += 1;
      return true;
    }

    executing(data) {
      const id = idOf(data?.prompt_id);
      if (!this.accepts(id)) return false;
      if (data.node == null) return this.finish(id);
      if (!this.activeId) this.activate(id);
      const nodeId = idOf(data.node);
      // progress_state normally arrives first and may already contain a
      // sampling child. Do not replace that child with a 0/1 parent.
      if (!this.nodes.has(nodeId) && ![...this.nodes.values()].some((node) => node.parentId === nodeId)) {
        this.nodes.clear();
        this.nodes.set(nodeId, { nodeId, displayId: idOf(data.display_node || nodeId), value: 0, max: 0, measured: false });
        this.selectedId = nodeId;
      }
      this.revision += 1;
      return true;
    }

    progress(data) {
      const id = idOf(data?.prompt_id);
      const value = Number(data?.value);
      const max = Number(data?.max);
      if (!this.accepts(id) || !numeric(value) || !numeric(max) || value < 0 || max <= 0) return false;
      if (!this.activeId) this.activate(id);
      const nodeId = idOf(data.node || this.selectedId || "sampling");
      const prior = this.nodes.get(nodeId);
      this.nodes.set(nodeId, { ...prior, nodeId, displayId: prior?.displayId || nodeId, value, max, measured: true });
      this.selectedId = nodeId;
      this.revision += 1;
      return true;
    }

    applySnapshot(body, requestRevision = this.revision) {
      if (body?.ok !== true || requestRevision !== this.revision) return false;
      const job = body.active_job;
      const id = idOf(job?.id);
      if (!id) {
        // An idle snapshot is a real transition when an active/unknown job was
        // being displayed.  Repeated idle polls are no-ops: do not churn the
        // revision, otherwise every in-flight snapshot becomes stale for no
        // visible change.
        const changed = Boolean(this.activeId || this.activeJob || this.nodes.size || this.selectedId);
        if (!changed) return false;
        this.retire(this.activeId);
        this.activeId = "";
        this.activeJob = null;
        this.nodes.clear();
        this.selectedId = "";
        this.known = true;
        this.revision += 1;
        return true;
      }
      if (this.finished.has(id)) return false;
      const changedId = this.activeId !== id;
      this.activate(id, { ...job, id, status: "in_progress" });
      if (changedId || Object.keys(body.nodes || {}).length) this.replaceNodes(body.prompt_id === id ? body.nodes : {});
      this.revision += 1;
      return true;
    }

    get(jobId) {
      if (idOf(jobId) !== this.activeId || !this.activeId) return null;
      const node = this.nodes.get(this.selectedId);
      return {
        nodeId: node?.nodeId || "",
        displayId: node?.displayId || "",
        label: node?.displayId ? `节点 ${node.displayId}` : "正在采样",
        value: node?.value ?? null,
        max: node?.max ?? null,
        percent: node?.measured ? bounded(node.value / node.max * 100) : null,
      };
    }
  }

  // A timer joining a slow request must not invalidate it forever. Explicit
  // refreshes request one trailing fetch, while routine polls only join it.
  class MobileSingleFlight {
    constructor(task) {
      this.task = task;
      this.pending = null;
      this.again = false;
    }

    run(urgent = false) {
      if (this.pending) {
        this.again ||= urgent;
        return this.pending;
      }
      this.pending = (async () => {
        do {
          this.again = false;
          await this.task();
        } while (this.again);
      })().finally(() => { this.pending = null; });
      return this.pending;
    }
  }

  return { MobileProgressStore, MobileSingleFlight };
});
