import { t } from "./i18n.js?v=202609304";
import "/mobile/assets/preset-catalog.js?v=202609304";
import { sharedCatalogStore } from "./preset-store.js?v=202609304";

const Model = globalThis.MobilePresetCatalog;
const CATALOG_URL = "/mobile/assets/prompt-presets.json?v=202609304";
const keyOf = (category, slot) => `${category.id}.${slot.id}`;
const unique = (tags) => [...new Set(tags)];
const sameMembers = (a, b) => a.length === b.length && a.every((tag) => b.includes(tag));
function setTags(map, key, tags) {
  if (tags.length) map[key] = unique(tags); else delete map[key];
}

export function createPresetManager({ element, button, setText, store = sharedCatalogStore(), fetchCatalog = null }) {
  const root = element("section", "mobile-remote-tags");
  root.hidden = true;
  root.setAttribute("aria-label", t("标签管理"));
  const toolbar = element("div", "mobile-remote-tags-toolbar");
  const search = element("input", "mobile-remote-tags-search");
  search.type = "search";
  search.placeholder = t("搜索分类或标签");
  search.setAttribute("aria-label", t("搜索分类或标签"));
  const removedLabel = element("label", "mobile-remote-tags-toggle");
  const showRemoved = element("input", "mobile-remote-checkbox");
  showRemoved.type = "checkbox";
  removedLabel.append(showRemoved, element("span", "", t("已删除")));
  const retry = button(t("重新读取与保存"), "refresh");
  toolbar.append(search, removedLabel, retry.node);
  const status = element("p", "mobile-remote-tags-status");
  status.setAttribute("role", "status");
  const list = element("div", "mobile-remote-tags-list");
  const form = element("form", "mobile-remote-tags-form");
  form.hidden = true;
  root.append(toolbar, status, list, form);

  let categories = [];
  let rules = {};
  let catalog = Model.empty();
  let ready = false;
  let disposed = false;
  let loading = null;
  let editor = null;
  let returnFocus = "";
  let query = "";
  let painting = false;
  let lastCatalog = "";
  const openIds = new Set();
  const searchClosed = new Set();

  function focusId(...parts) { return JSON.stringify(parts); }
  function focusTarget(id) {
    [...root.querySelectorAll("[data-focus]")].find((n) => n.dataset.focus === id)?.focus({ preventScroll: true });
  }
  function smallButton(label, icon, id) {
    const control = button(label, icon);
    control.node.classList.add("mobile-remote-chip-btn");
    control.node.dataset.focus = id;
    return control.node;
  }
  function isBuiltin(category, slot, tag) { return (slot.pool || []).includes(tag); }
  function removedTags(category, slot) {
    const key = keyOf(category, slot);
    return unique([...(catalog.removed[key] || []), ...(catalog.removedCustom[key] || [])]);
  }
  function pool(category, slot) { return Model.pool(category, slot, catalog); }
  function knownTags() {
    return unique(categories.flatMap((c) => (c.slots || []).flatMap((s) => pool(c, s))));
  }
  function effectiveGroups() {
    try { return Model.extendMutex(catalog, rules); }
    catch { return (catalog.mutex || []).filter((group) => Array.isArray(group) && group.length >= 2); }
  }
  function captureEditorDraft() {
    if (!editor || !form.childElementCount) return;
    const input = form.querySelector("input[name=tag]");
    editor.draft = {
      text: input ? input.value : editor.tag,
      selected: [...form.querySelectorAll(".mobile-remote-peer-list input:checked")].map((box) => box.value),
      groups: [...form.querySelectorAll("input[name=mutex-group]:checked:not(:disabled)")].map((box) => box.dataset.members),
      skips: [...form.querySelectorAll("input[name=skip-target]:checked:not(:disabled)")].map((box) => box.value),
      single: form.querySelector("input[name=singleton]")?.checked,
      peerQuery: form.querySelector(".mobile-remote-tags-search")?.value || "",
    };
  }
  function editorTagRemoved() {
    if (!editor?.tag) return false;
    const key = keyOf(editor.category, editor.slot);
    return (catalog.removed[key] || []).includes(editor.tag)
      || (catalog.removedCustom[key] || []).includes(editor.tag);
  }
  function change(mutator, focus = "") {
    try {
      const scroll = list.scrollTop;
      store.change(mutator);
      list.scrollTop = scroll;
      if (focus) focusTarget(focus);
    } catch (error) {
      setText(status, error.message);
      status.dataset.tone = "error";
    }
  }
  function closeEditor(restore = true) {
    editor = null;
    form.hidden = true;
    list.hidden = false;
    toolbar.hidden = false;
    form.replaceChildren();
    if (restore) focusTarget(returnFocus);
  }
  function openEditor(category, slot, tag = "", origin = "") {
    returnFocus = origin;
    editor = { category, slot, tag };
    list.hidden = true;
    toolbar.hidden = true;
    form.hidden = false;
    renderEditor();
  }
  function renderEditor() {
    captureEditorDraft();
    if (editorTagRemoved()) {
      closeEditor();
      setText(status, t("这个标签已被另一端删除"));
      status.dataset.tone = "error";
      return;
    }
    const { category, slot, tag } = editor;
    const draft = editor.draft;
    form.replaceChildren();
    const heading = element("h3", "mobile-remote-card-title", t("{mode} · {category} / {slot}", {
      mode: tag ? t("标签规则") : t("新增标签"), category: category.label, slot: slot.label,
    }));
    const fieldLabel = element("label", "mobile-remote-tags-label", t("标签"));
    const input = element("input", "mobile-remote-tags-input");
    input.name = "tag";
    input.required = true;
    input.maxLength = 80;
    input.value = !tag && draft?.text ? draft.text : tag;
    input.readOnly = Boolean(tag);
    fieldLabel.append(input);
    const error = element("p", "mobile-remote-tags-form-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const groupSection = element("details", "mobile-remote-rule-section");
    groupSection.append(element("summary", "", t("加入互斥组")));
    const groups = effectiveGroups();
    const availableTags = new Set(knownTags());
    groups.forEach((group, index) => {
      const visibleMembers = group.filter((member) => availableTags.has(member));
      if (visibleMembers.length < 2) return;
      const label = element("label", "mobile-remote-tags-toggle");
      const box = element("input", "mobile-remote-checkbox");
      box.type = "checkbox";
      box.name = "mutex-group";
      box.value = String(index);
      box.dataset.members = group.join("\u0000");
      box.disabled = Boolean(tag && group.includes(tag));
      box.checked = box.disabled || Boolean(draft?.groups?.includes(box.dataset.members));
      label.title = visibleMembers.join(t("、"));
      label.append(box, element("span", "", t("组 {index} ({count}) · {members}", {
        index: index + 1, count: visibleMembers.length, members: visibleMembers.join(t("、")),
      })));
      groupSection.append(label);
    });
    const peersSection = element("details", "mobile-remote-rule-section");
    peersSection.append(element("summary", "", t("与其他标签互斥")));
    const peerSearch = element("input", "mobile-remote-tags-search");
    peerSearch.type = "search";
    peerSearch.value = draft?.peerQuery || "";
    peerSearch.placeholder = t("搜索全部分类的标签");
    peerSearch.setAttribute("aria-label", t("搜索互斥候选"));
    const candidates = knownTags().filter((t) => t !== tag);
    const selected = new Set(draft?.selected?.filter((text) => candidates.includes(text)) || []);
    const peerList = element("div", "mobile-remote-peer-list");
    const peerCount = element("p", "mobile-remote-note");
    const more = button(t("更多互斥候选"), "plus", t("更多"));
    let limit = 80;
    const MAX_MUTEX_GROUP = 64;
    function peerBudget() {
      const chosen = [...groupSection.querySelectorAll("input:checked:not(:disabled)")].map((box) => groups[Number(box.value)]);
      const members = new Set(chosen.flat());
      members.add(input.value.trim());
      return Math.max(0, MAX_MUTEX_GROUP - members.size);
    }
    function renderPeers() {
      const visible = candidates.filter((t) => t.toLocaleLowerCase().includes(peerSearch.value.trim().toLocaleLowerCase()));
      peerList.replaceChildren();
      visible.slice(0, limit).forEach((text) => {
        const row = element("label", "mobile-remote-tags-toggle");
        const box = element("input", "mobile-remote-checkbox");
        box.type = "checkbox";
        box.checked = selected.has(text);
        box.value = text;
        box.addEventListener("change", () => {
          const budget = peerBudget();
          if (box.checked && selected.size >= budget) {
            box.checked = false;
            setText(peerCount, budget ? t("该组最多再选 {budget} 个互斥候选", { budget, n: budget }) : t("这个互斥组已满，无法继续添加"));
            return;
          }
          if (box.checked) selected.add(text); else selected.delete(text);
          setText(peerCount, t("{length} 个候选 · 已选 {size}", { length: visible.length, size: selected.size, n: visible.length }));
        });
        row.append(box, element("span", "", text));
        peerList.append(row);
      });
      setText(peerCount, t("{visible} 个候选 · 已选 {selected}", { visible: visible.length, selected: selected.size, n: visible.length })
        + (peerBudget() < 63 ? t(" · 本组上限 {budget}", { budget: peerBudget() }) : ""));
      more.node.hidden = visible.length <= limit;
    }
    peerSearch.addEventListener("input", () => { limit = 80; renderPeers(); });
    more.node.addEventListener("click", () => { limit += 80; renderPeers(); });
    peersSection.append(peerSearch, peerCount, peerList, more.node);
    renderPeers();
    const advanced = element("details", "mobile-remote-rule-section");
    advanced.append(element("summary", "", t("组合规则")));
    const singleLabel = element("label", "mobile-remote-tags-toggle");
    const single = element("input", "mobile-remote-checkbox");
    single.type = "checkbox";
    single.name = "singleton";
    const builtinSingle = (rules.singletons || []).includes(tag);
    single.checked = builtinSingle || catalog.singletons.includes(tag) || Boolean(draft?.single);
    single.disabled = builtinSingle;
    singleLabel.append(single, element("span", "", t("单独输出，不拼接同类修饰词")));
    advanced.append(singleLabel, element("p", "mobile-remote-note", t("选中此标签时跳过的分类")));
    const skipTargets = new Set(catalog.skipCategories.filter((r) => (r.whenAny || [r.whenTag]).includes(tag)).flatMap((r) => r.skip));
    const skipChecks = [];
    for (const target of categories) {
      if (target.id === category.id) continue;
      const label = element("label", "mobile-remote-tags-toggle");
      const box = element("input", "mobile-remote-checkbox");
      box.type = "checkbox";
      box.name = "skip-target";
      box.value = target.id;
      box.checked = skipTargets.has(target.id) || Boolean(draft?.skips?.includes(target.id));
      const builtin = (rules.skipCategories || []).some((r) => (r.whenAny || [r.whenTag]).includes(tag) && r.skip.includes(target.id));
      if (builtin) { box.checked = true; box.disabled = true; }
      label.append(box, element("span", "", target.label));
      skipChecks.push(box);
      advanced.append(label);
    }
    if (tag) {
      catalog.mutex.forEach((group) => {
        if (!group.includes(tag)) return;
        const row = element("div", "mobile-remote-rule-row");
        row.append(element("span", "", group.join(t("、"))));
        const remove = button(t("删除自定义互斥规则"), "trash");
        remove.node.addEventListener("click", () => {
          if (!window.confirm(t("删除这条自定义互斥规则？"))) return;
          change((next) => { next.mutex = next.mutex.filter((g) => !sameMembers(g, group)); });
          renderEditor();
        });
        row.append(remove.node);
        advanced.append(row);
      });
    }
    const actions = element("div", "mobile-remote-tags-form-actions");
    const save = button(t("保存标签"), "check", t("保存"));
    save.node.type = "submit";
    const cancel = button(t("取消编辑"), "times", t("取消"));
    cancel.node.addEventListener("click", () => closeEditor());
    actions.append(save.node, cancel.node);
    form.append(heading, fieldLabel, error, groupSection, peersSection, advanced, actions);
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = input.value.trim();
      const key = keyOf(category, slot);
      try {
        if (!text) throw new Error(t("请输入标签"));
        if (!tag && pool(category, slot).includes(text)) throw new Error(t("这个分类中已有相同标签"));
        if (!tag && knownTags().includes(text) && !window.confirm(t("其他分类已有同名标签，规则会按文字共同生效。继续添加？"))) return;
        const chosen = [...groupSection.querySelectorAll("input:checked:not(:disabled)")].map((box) => groups[Number(box.value)]);
        const targets = skipChecks.filter((box) => box.checked && !box.disabled).map((box) => box.value);
        for (const group of chosen) {
          const members = new Set([...group, text]);
          const extensions = catalog.mutex.filter((g) => group.every((t) => g.includes(t)));
          extensions.forEach((g) => g.forEach((t) => members.add(t)));
          if (members.size + selected.size > 64) {
            throw new Error(t("这个互斥组最多 64 个标签，还能再选 {value} 个", { value: Math.max(0, 64 - members.size) }));
          }
        }
        if (!chosen.length && selected.size + 1 > 64) {
          throw new Error(t("这个互斥组最多 64 个标签"));
        }
        store.change((next) => {
          if (!isBuiltin(category, slot, text)) setTags(next.custom, key, [...(next.custom[key] || []), text]);
          for (const kind of ["removed", "removedCustom"]) setTags(next[kind], key, (next[kind][key] || []).filter((t) => t !== text));
          for (const group of chosen) {
            const extensions = next.mutex.filter((g) => group.every((t) => g.includes(t)));
            next.mutex = next.mutex.filter((g) => !extensions.includes(g));
            next.mutex.push(unique([...group, ...extensions.flat(), text]));
          }
          if (selected.size) next.mutex.push(unique([text, ...selected]));
          if (!single.disabled) next.singletons = unique([...next.singletons.filter((t) => t !== text), ...(single.checked ? [text] : [])]);
          next.skipCategories = next.skipCategories.map((r) => ({ whenAny: (r.whenAny || [r.whenTag]).filter((t) => t !== text), skip: r.skip }))
            .filter((r) => r.whenAny.length);
          if (targets.length) next.skipCategories.push({ whenAny: [text], skip: targets });
        });
        closeEditor();
      } catch (problem) {
        error.hidden = false;
        setText(error, problem.message);
      }
    };
    input.focus({ preventScroll: true });
  }
  form.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); closeEditor(); } });

  function chip(category, slot, text, removed = false) {
    const key = keyOf(category, slot);
    const skipped = (catalog.skipped[key] || []).includes(text);
    const item = element("div", `mobile-remote-chip${removed ? " is-removed" : skipped ? " is-skipped" : ""}`);
    const name = element("button", "mobile-remote-chip-name", text);
    name.type = "button";
    name.title = t("{text} · {kind} · 编辑规则", {
      text, kind: isBuiltin(category, slot, text) ? t("内置") : t("自定义"),
    });
    name.dataset.focus = focusId(key, text, "edit");
    name.addEventListener("click", () => openEditor(category, slot, text, name.dataset.focus));
    item.append(name);
    if (removed) {
      const restore = smallButton(t("恢复 {text}", { text: text }), "undo", focusId(key, text, "restore"));
      restore.addEventListener("click", () => change((next) => {
        for (const kind of ["removed", "removedCustom"]) setTags(next[kind], key, (next[kind][key] || []).filter((t) => t !== text));
      }, focusId(key, text, "edit")));
      item.append(restore);
    } else {
      const skip = smallButton(t("{action} {text}", { action: skipped ? t("取消跳过") : t("跳过随机"), text }), "ban", focusId(key, text, "skip"));
      skip.setAttribute("aria-pressed", String(skipped));
      skip.addEventListener("click", () => change((next) => {
        const tags = new Set(next.skipped[key] || []);
        if (tags.has(text)) tags.delete(text); else tags.add(text);
        setTags(next.skipped, key, [...tags]);
      }, skip.dataset.focus));
      const remove = smallButton(t("删除 {text}", { text: text }), "times", focusId(key, text, "remove"));
      remove.addEventListener("click", () => {
        if (!window.confirm(t("删除“{text}”？可在“已删除”中恢复。", { text: text }))) return;
        change((next) => {
          const kind = isBuiltin(category, slot, text) ? "removed" : "removedCustom";
          setTags(next[kind], key, [...(next[kind][key] || []), text]);
          // Keep skipped/mutex/rule tombstones so restoring the tag restores
          // its prior random and rule behavior.
          // their deleted members until the tag is restored.
        }, focusId(key, "add"));
      });
      item.append(skip, remove);
    }
    return item;
  }

  function paint() {
    if (disposed || !ready) return;
    const activeId = root.contains(document.activeElement) ? document.activeElement.dataset.focus : "";
    const scroll = list.scrollTop;
    const needle = query.trim().toLocaleLowerCase();
    painting = true;
    list.replaceChildren();
    categories.forEach((category) => {
      const matchesCategory = (category.label || "").toLocaleLowerCase().includes(needle);
      const slots = (category.slots || []).map((slot) => {
        const matches = matchesCategory || (slot.label || "").toLocaleLowerCase().includes(needle);
        const match = (text) => !needle || matches || text.toLocaleLowerCase().includes(needle);
        return { slot, visible: pool(category, slot).filter(match), removed: removedTags(category, slot).filter(match) };
      }).filter((item) => !needle || item.visible.length || (showRemoved.checked && item.removed.length));
      if (!slots.length) return;
      const detail = element("details", "mobile-remote-tag-category");
      const summary = element("summary", "mobile-remote-tag-summary");
      summary.dataset.focus = focusId(category.id, "summary");
      summary.append(element("span", "mobile-remote-tag-summary-name", category.label),
        element("span", "mobile-remote-tag-summary-count", String(slots.reduce((sum, s) => sum + s.visible.length, 0))));
      detail.append(summary);
      let body = null;
      function expandBody() {
        if (body) return;
        body = element("div", "mobile-remote-tag-body");
        for (const { slot, visible, removed } of slots) {
          const block = element("div", "mobile-remote-tag-slot");
          const head = element("div", "mobile-remote-tag-slot-head");
          head.append(element("h4", "mobile-remote-tag-slot-title", slot.label));
          const id = focusId(keyOf(category, slot), "add");
          const add = smallButton(t("新增{label} / {label1}标签", { label: category.label, label1: slot.label }), "plus", id);
          add.addEventListener("click", () => openEditor(category, slot, "", id));
          head.append(add);
          const wrap = element("div", "mobile-remote-chip-wrap");
          visible.forEach((text) => wrap.append(chip(category, slot, text)));
          if (showRemoved.checked) removed.forEach((text) => wrap.append(chip(category, slot, text, true)));
          block.append(head, wrap);
          if (!Model.pool(category, slot, catalog, { random: true }).length) block.append(element("p", "mobile-remote-note", t("暂无可随机标签")));
          body.append(block);
        }
        detail.append(body);
      }
      detail.open = needle ? !searchClosed.has(category.id) : openIds.has(category.id);
      if (detail.open) expandBody();
      detail.addEventListener("toggle", () => {
        if (painting || !detail.isConnected) return;
        if (needle) {
          if (detail.open) searchClosed.delete(category.id); else searchClosed.add(category.id);
        } else if (detail.open) openIds.add(category.id); else openIds.delete(category.id);
        if (detail.open) expandBody();
      });
      list.append(detail);
    });
    if (!list.childElementCount) list.append(element("p", "mobile-remote-note", t("没有匹配的标签")));
    painting = false;
    list.scrollTop = scroll;
    if (activeId) focusTarget(activeId);
  }

  const unsubscribe = store.subscribe((snapshot) => {
    const serialized = JSON.stringify(snapshot.catalog);
    catalog = snapshot.catalog;
    status.dataset.tone = snapshot.error ? "error" : snapshot.dirty ? "pending" : "success";
    setText(status, snapshot.error || (!snapshot.known ? t("正在读取目录…") : snapshot.saving ? t("正在保存…") : snapshot.dirty
      ? (snapshot.remainingMs ? t("待保存，约 {value} 秒后重试", { value: Math.ceil(snapshot.remainingMs / 1000) }) : t("待保存")) : t("已同步")));
    if (serialized !== lastCatalog) {
      lastCatalog = serialized;
      if (editor) renderEditor();
      paint();
    }
  });
  search.addEventListener("input", () => { query = search.value; paint(); });
  showRemoved.addEventListener("change", paint);
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      const getCatalog = fetchCatalog || (async () => {
        const response = await fetch(CATALOG_URL, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(t("内置目录读取失败"));
        return response.json();
      });
      const [data] = await Promise.all([getCatalog(), store.load()]);
      if (disposed) return;
      if (!Array.isArray(data.categories)) throw new Error(t("内置目录格式错误"));
      categories = data.categories;
      rules = data.rules || {};
      ready = true;
      paint();
    })();
    try { await loading; }
    catch (error) { if (!disposed) { setText(status, error.message); status.dataset.tone = "error"; } }
    finally { loading = null; }
  }
  retry.node.addEventListener("click", () => {
    void Promise.allSettled([store.retry ? store.retry() : Promise.resolve(), load()]);
  });
  return {
    node: root,
    async open() { root.hidden = false; await load(); },
    close() { root.hidden = true; closeEditor(false); },
    destroy() { disposed = true; unsubscribe(); store.journal(); },
  };
}
