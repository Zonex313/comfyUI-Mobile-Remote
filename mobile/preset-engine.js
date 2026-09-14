/* Shared preset engine: random tag pools, skip/mutex rules and prompt composition.
   UMD: browser global MobilePresetEngine and CommonJS, same shape as preset-catalog.js.
   Pure logic only: no DOM, no storage. Persistence and rendering stay with the host.
   create({ categories, state, rules }) captures the three references it is given:
   categories = normalized category array, state = preset state { slots, custom,
   freeText, extraText, catalog }, rules = builtin rules. Hosts that replace any of
   them must call create() again (mobile app.js recreates the engine on change). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./preset-catalog.js"));
  else root.MobilePresetEngine = factory(root.MobilePresetCatalog);
}(typeof globalThis !== "undefined" ? globalThis : this, function (sharedCatalog) {
  "use strict";

  function presetCatalogApi() {
    if (sharedCatalog) return sharedCatalog;
    return typeof globalThis !== "undefined" ? globalThis.MobilePresetCatalog : undefined;
  }

  function stringList(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const item of value) {
      const text = String(item || "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  function normalizeCatalog(raw) {
    return presetCatalogApi().normalize(raw);
  }

  function create(options) {
    const settings = options || {};
    const presetCategories = settings.categories;
    const state = settings.state;
    const builtinRules = settings.rules;
    let rulesCache = null;

      function presetStateCatalog() {
        let catalog = state.catalog;
        if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
          catalog = normalizeCatalog(catalog);
          state.catalog = catalog;
        }
        if (state.custom !== catalog.custom) state.custom = catalog.custom;
        return catalog;
      }

      function effectivePresetRules() {
        const catalog = presetStateCatalog();
        const cached = rulesCache;
        if (cached
          && cached.catalog === catalog
          && cached.builtin === builtinRules
          && cached.categories === presetCategories) return cached.rules;
        const rules = presetCatalogApi().effectiveRules(catalog, builtinRules || {}, presetCategories || []);
        rulesCache = {
          catalog,
          builtin: builtinRules,
          categories: presetCategories,
          rules,
        };
        return rules;
      }

      function findPresetCategory(categoryId) {
        return presetCategories.find((item) => item.id === categoryId) || null;
      }

      function findPresetSlot(categoryId, slotId) {
        const category = findPresetCategory(categoryId);
        return category?.slots?.find((item) => item.id === slotId) || null;
      }

      function slotStorageKey(categoryId, slotId) {
        return `${categoryId}.${slotId}`;
      }

      function catalogTagSet(kind, categoryId, slotId) {
        const catalog = presetStateCatalog();
        const key = slotStorageKey(categoryId, slotId);
        return new Set([
          ...(catalog[kind]?.[key] || []),
          ...(kind === "removed" ? (catalog.removedCustom?.[key] || []) : []),
        ]);
      }

      function slotPool(categoryId, slot) {
        const key = slotStorageKey(categoryId, slot.id);
        const catalog = presetStateCatalog();
        const api = presetCatalogApi();
        const category = findPresetCategory(categoryId);
        const shared = api.pool(category, slot, catalog, { random: false });
        if (Array.isArray(shared)) return stringList(shared);
        return [];
      }

      function randomSlotPool(categoryId, slot) {
        const catalog = presetStateCatalog();
        const api = presetCatalogApi();
        const category = findPresetCategory(categoryId);
        const shared = api.pool(category, slot, catalog, { random: true });
        if (Array.isArray(shared)) return stringList(shared);
        return [];
      }

      function getSlotState(categoryId, slotId, { initialize = true } = {}) {
        const key = slotStorageKey(categoryId, slotId);
        let current = state.slots[key];
        if (!current || typeof current !== "object" || Array.isArray(current)) {
          if (!initialize) return { value: "", locked: false, ignored: false };
          const slot = findPresetSlot(categoryId, slotId);
          const pool = slot ? slotPool(categoryId, slot) : [];
          current = state.slots[key] = {
            value: pool[0] || "",
            locked: false,
            ignored: false,
          };
        }
        current.value = current.value === undefined || current.value === null ? "" : String(current.value);
        current.locked = Boolean(current.locked);
        current.ignored = Boolean(current.ignored);
        return current;
      }

      function pickRandomTag(pool, avoid) {
        if (!pool.length) return "";
        const list = pool.filter((item) => item && item !== avoid);
        const source = list.length ? list : pool;
        return source[Math.floor(Math.random() * source.length)];
      }

      function mutexGroups() {
        const rules = effectivePresetRules();
        return Array.isArray(rules.mutex) ? rules.mutex : [];
      }

      function tagConflicts(tag, accepted) {
        if (!tag) return false;
        return mutexGroups().some((group) => (
          Array.isArray(group)
          && group.includes(tag)
          && accepted.some((item) => item && item !== tag && group.includes(item))
        ));
      }

      function categorySkipSet(tags) {
        const skip = new Set();
        const rules = effectivePresetRules();
        const active = new Set(stringList(tags));
        for (const rule of (Array.isArray(rules.skipCategories) ? rules.skipCategories : [])) {
          const triggers = Array.isArray(rule?.whenAny)
            ? rule.whenAny
            : rule?.whenTag ? [rule.whenTag] : [];
          if (triggers.some((tag) => active.has(String(tag)))) {
            stringList(rule.skip).forEach((id) => skip.add(id));
          }
        }
        return skip;
      }

      function categoryActiveTags(category) {
        const tags = [];
        for (const slot of category.slots || []) {
          const current = state.slots[slotStorageKey(category.id, slot.id)];
          if (current?.value && !current.ignored && presetTagStatus(category.id, slot.id, current.value) !== "deleted") tags.push(current.value);
        }
        return tags;
      }

      function skippedCategoryIds(tags = null) {
        if (tags !== null) return categorySkipSet(tags);
        const rules = effectivePresetRules();
        const categories = [...presetCategories];
        const index = new Map(categories.map((category, position) => [category.id, position]));
        const activeByCategory = new Map(categories.map((category) => [category.id, new Set(categoryActiveTags(category))]));
        const edges = new Map(categories.map((category) => [category.id, new Set()]));
        const indegree = new Map(categories.map((category) => [category.id, 0]));
        const ruleList = Array.isArray(rules.skipCategories) ? rules.skipCategories : [];
        for (const category of categories) {
          const active = activeByCategory.get(category.id);
          for (const rule of ruleList) {
            const triggers = Array.isArray(rule?.whenAny) ? rule.whenAny : [];
            if (!triggers.some((tag) => active.has(String(tag)))) continue;
            for (const target of rule.skip || []) {
              if (!index.has(target) || target === category.id || edges.get(category.id).has(target)) continue;
              edges.get(category.id).add(target);
              indegree.set(target, indegree.get(target) + 1);
            }
          }
        }
        // Process rule owners topologically. A source skipped by an earlier owner
        // never gets to trigger another rule in this pass.
        const ready = categories.filter((category) => indegree.get(category.id) === 0);
        const ordered = [];
        while (ready.length) {
          ready.sort((left, right) => index.get(left.id) - index.get(right.id));
          const category = ready.shift();
          ordered.push(category);
          for (const target of edges.get(category.id)) {
            const next = indegree.get(target) - 1;
            indegree.set(target, next);
            if (next === 0) ready.push(categories[index.get(target)]);
          }
        }
        // Cycles have no topological winner; use one stable catalog-order pass.
        if (ordered.length < categories.length) {
          const seen = new Set(ordered.map((category) => category.id));
          categories.forEach((category) => { if (!seen.has(category.id)) ordered.push(category); });
        }
        const skip = new Set();
        for (const category of ordered) {
          if (skip.has(category.id)) continue;
          categorySkipSet([...activeByCategory.get(category.id)]).forEach((id) => {
            if (id !== category.id) skip.add(id);
          });
        }
        return skip;
      }

      function collectPresetConflicts() {
        const conflicts = new Map();
        const entries = [];
        const skipped = skippedCategoryIds();
        for (const category of presetCategories) {
          if (skipped.has(category.id)) continue;
          for (const slot of category.slots || []) {
            const key = slotStorageKey(category.id, slot.id);
            const current = state.slots[key];
            if (!current?.value || current.ignored || presetTagStatus(category.id, slot.id, current.value) === "deleted") continue;
            entries.push({ key, value: current.value });
          }
        }
        entries.forEach((entry) => {
          const others = entries.filter((other) => other.key !== entry.key).map((other) => other.value);
          if (tagConflicts(entry.value, others)) conflicts.set(entry.key, true);
        });
        return conflicts;
      }

      function markPresetConflicts() {
        const conflicts = collectPresetConflicts();
        for (const category of presetCategories) {
          for (const slot of category.slots || []) {
            const current = state.slots[slotStorageKey(category.id, slot.id)];
            if (current) current.conflict = conflicts.has(slotStorageKey(category.id, slot.id));
          }
        }
        return conflicts;
      }

      function presetTagStatus(categoryId, slotId, value) {
        const text = String(value || "");
        if (!text) return "empty";
        const slot = findPresetSlot(categoryId, slotId);
        if (!slot) return "free";
        const key = slotStorageKey(categoryId, slotId);
        const catalog = presetStateCatalog();
        const source = new Set([...(slot.pool || []), ...(catalog.custom[key] || [])].map(String));
        const removed = catalogTagSet("removed", categoryId, slotId);
        if (removed.has(text)) return "deleted";
        return source.has(text) ? "active" : "free";
      }

      function selectedTagsExcept(categoryId, slotId) {
        const selected = [];
        const skipped = skippedCategoryIds();
        for (const category of presetCategories) {
          if (skipped.has(category.id)) continue;
          for (const slot of category.slots || []) {
            if (category.id === categoryId && slot.id === slotId) continue;
          const current = state.slots[slotStorageKey(category.id, slot.id)];
          if (current?.value && !current.ignored && presetTagStatus(category.id, slot.id, current.value) !== "deleted") {
            selected.push(current.value);
          }
          }
        }
        return selected;
      }

      function filterSlotValues(values) {
        // Existing conflicts remain visible and are marked in the editor; they do
        // not silently disappear from the generated prompt.
        return { ...values };
      }

      function randomize(categoryId = "") {
        const targetOnly = Boolean(categoryId);
        const processed = new Set();
        const ordered = [...presetCategories].sort((left, right) => {
          if (left.id === "outfitState") return -1;
          if (right.id === "outfitState") return 1;
          return 0;
        });
        const acceptedValues = (currentKey) => {
          const accepted = [];
          const skipped = skippedCategoryIds();
          for (const category of presetCategories) {
            if (skipped.has(category.id)) continue;
            for (const slot of category.slots || []) {
              const key = slotStorageKey(category.id, slot.id);
              if (key === currentKey) continue;
              const current = state.slots[key];
              if (!current?.value || current.ignored || presetTagStatus(category.id, slot.id, current.value) === "deleted") continue;
              if (current.locked || processed.has(key) || !targetOnly || category.id !== categoryId) {
                accepted.push(current.value);
              }
            }
          }
          return accepted;
        };

        for (const category of ordered) {
          if (targetOnly && category.id !== categoryId) continue;
          if (skippedCategoryIds().has(category.id)) {
            for (const slot of category.slots || []) {
              const current = getSlotState(category.id, slot.id);
              if (!current.locked) {
                current.value = "";
                current.conflict = false;
              }
              processed.add(slotStorageKey(category.id, slot.id));
            }
            continue;
          }
          for (const slot of category.slots || []) {
            if (skippedCategoryIds().has(category.id)) {
              for (const rest of category.slots || []) {
                const leftover = getSlotState(category.id, rest.id);
                if (!leftover.locked && !processed.has(slotStorageKey(category.id, rest.id))) {
                  leftover.value = "";
                  leftover.conflict = false;
                }
                processed.add(slotStorageKey(category.id, rest.id));
              }
              break;
            }
            const key = slotStorageKey(category.id, slot.id);
            const current = getSlotState(category.id, slot.id);
            if (current.locked) {
              processed.add(key);
              continue;
            }
            const accepted = acceptedValues(key);
            const pool = randomSlotPool(category.id, slot);
            const allowed = pool.filter((item) => !tagConflicts(item, accepted));
            const next = pickRandomTag(allowed, current.value);
            if (next) current.value = next;
            else if (current.value && tagConflicts(current.value, accepted)) current.value = "";
            processed.add(key);
          }
        }
        markPresetConflicts();
      }

      function tidyPhrase(text) {
        return String(text || "")
          .replace(/的+/g, "的")
          .replace(/^的+|的+$/g, "")
          .replace(/\s+/g, "")
          .trim();
      }

      function activeSlotValues(category) {
        const values = {};
        for (const slot of category.slots || []) {
          const current = getSlotState(category.id, slot.id);
          if (!current.value || current.ignored) continue;
          if (presetTagStatus(category.id, slot.id, current.value) === "deleted") continue;
          // `skipped` only removes a tag from randomSlotPool. Manual selection and
          // locking remain prompt-visible when the tag is still in the catalog.
          values[slot.id] = current.value;
        }
        return values;
      }

      function composeCategoryPhrase(category, values = null) {
        values = values || activeSlotValues(category);
        const rules = effectivePresetRules();
        const singles = Array.isArray(rules.singletons) ? rules.singletons : [];
        if (singles.includes(values.type) || singles.includes(values.state) || singles.includes(values.item)) {
          return values.type || values.state || values.item || "";
        }
        const join = category.join || "";
        if (join === "person") {
          const age = values.age || "";
          const origin = values.origin || "";
          const look = values.look || "";
          if (age && (origin || look)) return tidyPhrase(`${age}的${origin}${look}`);
          return tidyPhrase(`${origin}${look}`) || age;
        }
        if (join === "breast") {
          const size = values.size || "";
          const shape = values.shape || "";
          if (shape && size) return tidyPhrase(`${shape}的${size}`);
          return size || shape;
        }
        if (join === "nipple") {
          const state = String(values.state || "").replace(/乳头/g, "");
          const look = values.look || "";
          if (state && look) {
            if (/乳头|乳晕/.test(look)) return tidyPhrase(`${state}的${look}`);
            return tidyPhrase(`${state}的${look}乳头`);
          }
          return look || values.state || "";
        }
        if (join === "of-color") {
          const color = values.color || "";
          const rest = (category.slots || [])
            .map((slot) => slot.id === "color" ? "" : values[slot.id] || "")
            .filter(Boolean)
            .join("");
          if (color && rest) return tidyPhrase(`${color}的${rest}`);
          return color || rest;
        }
        return (category.slots || []).map((slot) => values[slot.id]).filter(Boolean).join("");
      }

      function isPantsType(type) {
        const text = String(type || "");
        return /裤/.test(text) && !/裙/.test(text);
      }

      function composePresetPrompt() {
        const parts = [];
        const accepted = [];
        const skip = skippedCategoryIds();
        let skipPanties = false;
        const panties = presetCategories.find((category) => category.id === "panties");
        const take = (values) => {
          Object.values(values).forEach((value) => {
            if (value) accepted.push(value);
          });
        };
        for (const category of presetCategories) {
          if (skip.has(category.id)) continue;
          if (category.id === "panties" && skipPanties) continue;
          const values = filterSlotValues(activeSlotValues(category), accepted);
          if (category.id === "bottom") {
            const bottomPhrase = composeCategoryPhrase(category, values);
            const pantyValues = panties && !skip.has("panties")
              ? filterSlotValues(activeSlotValues(panties), accepted.concat(Object.values(values)))
              : {};
            const pantiesPhrase = panties ? composeCategoryPhrase(panties, pantyValues) : "";
            const type = values.type || "";
            if (isPantsType(type) && bottomPhrase && pantiesPhrase) {
              const phrase = tidyPhrase(`${bottomPhrase}的边缘漏出${pantiesPhrase}`);
              if (phrase && !parts.includes(phrase)) parts.push(phrase);
              take(values);
              take(pantyValues);
              skipPanties = true;
              continue;
            }
            if (bottomPhrase && !parts.includes(bottomPhrase)) parts.push(bottomPhrase);
            take(values);
            continue;
          }
          const phrase = composeCategoryPhrase(category, values);
          if (phrase && !parts.includes(phrase)) parts.push(phrase);
          take(values);
        }
        const tags = parts.join(", ");
        const extra = String(state.extraText || "").trim();
        if (tags && extra) return `${tags}, ${extra}`;
        return extra || tags;
      }

    return {
      effectiveRules: effectivePresetRules,
      invalidateRules() { rulesCache = null; },
      presetStateCatalog,
      stringList,
      findCategory: findPresetCategory,
      findSlot: findPresetSlot,
      slotKey: slotStorageKey,
      catalogTagSet,
      slotPool,
      randomPool: randomSlotPool,
      slotState: getSlotState,
      tagConflicts,
      skipped: skippedCategoryIds,
      collectConflicts: collectPresetConflicts,
      conflicts: markPresetConflicts,
      tagStatus: presetTagStatus,
      selectedTagsExcept,
      filterValues: filterSlotValues,
      randomize,
      activeValues: activeSlotValues,
      composePhrase: composeCategoryPhrase,
      compose: composePresetPrompt,
    };
  }

  return { create: create };
}));
