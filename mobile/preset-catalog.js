/* Shared preset catalog model. UMD: browser global and CommonJS. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MobilePresetCatalog = factory();
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var KEY = "comfy-mobile-remote.presetCatalog";
  var LEGACY_KEY = "comfy-mobile-remote.preset";
  var MAX_SLOTS = 256;
  var MAX_TAGS = 4096;
  var MAX_GROUPS = 256;
  var MAX_GROUP_TAGS = 64;
  var RESERVED = { "__proto__": true, prototype: true, constructor: true };

  function fail(message) { throw new TypeError(message); }
  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }
  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }
  function text(value, label) {
    if (typeof value !== "string") fail((label || "tag") + " must be a string");
    var result = value.trim();
    if (!result) fail((label || "tag") + " must be nonempty");
    return result;
  }
  function id(value, label) {
    var result = text(value, label || "id");
    if (result !== value || /[\u0000-\u001f\u007f]/.test(result)) fail((label || "id") + " must be a trimmed identifier");
    var pieces = result.split(/[.:/\\]/);
    for (var i = 0; i < pieces.length; i += 1) {
      if (RESERVED[pieces[i].toLowerCase()]) fail("reserved " + (label || "id"));
    }
    return result;
  }
  function looseList(value, label, limit) {
    if (!Array.isArray(value)) fail((label || "list") + " must be an array");
    if (value.length > (limit || 256)) fail((label || "list") + " is too large");
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < value.length; i += 1) {
      if (typeof value[i] !== "string") fail((label || "list") + " must contain strings");
      var item = value[i].trim();
      if (!item || own(seen, item)) continue;
      seen[item] = true;
      out.push(item);
    }
    return out;
  }
  function strictList(value, label, limit) {
    if (!Array.isArray(value)) fail((label || "list") + " must be an array");
    if (value.length > (limit || 256)) fail((label || "list") + " is too large");
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < value.length; i += 1) {
      if (typeof value[i] !== "string" || !value[i] || value[i] !== value[i].trim()) {
        fail((label || "list") + " must contain trimmed nonempty strings");
      }
      if (own(seen, value[i])) fail((label || "list") + " must not contain duplicates");
      seen[value[i]] = true;
      out.push(value[i]);
    }
    return out;
  }
  function empty() {
    return { custom: {}, removed: {}, removedCustom: {}, skipped: {}, mutex: [], singletons: [], skipCategories: [] };
  }
  function mapValue(value, label, strict) {
    if (value === undefined) return {};
    if (!isObject(value)) fail((label || "map") + " must be an object");
    var keys = Object.keys(value);
    if (keys.length > MAX_SLOTS) fail((label || "map") + " has too many slots");
    var out = {};
    var count = 0;
    for (var i = 0; i < keys.length; i += 1) {
      var key = id(keys[i], "slot");
      var list = strict ? strictList(value[keys[i]], label, 256) : looseList(value[keys[i]], label, 256);
      count += list.length;
      if (count > MAX_TAGS) fail((label || "map") + " has too many tags");
      if (list.length) out[key] = list;
    }
    return out;
  }
  function ruleValue(value, strict) {
    if (!isObject(value)) fail("skip rule must be an object");
    var keys = Object.keys(value);
    var allowed = strict ? { whenAny: true, skip: true } : { whenAny: true, whenTag: true, skip: true };
    if (keys.some(function (key) { return !allowed[key]; })) fail("invalid skip rule");
    if (!own(value, "skip")) fail("invalid skip rule");
    var whenAny;
    if (own(value, "whenAny")) {
      whenAny = strict ? strictList(value.whenAny, "skip trigger", 256) : looseList(value.whenAny, "skip trigger", 256);
    } else if (!strict && own(value, "whenTag")) {
      whenAny = looseList([value.whenTag], "skip trigger", 256);
    } else {
      fail("invalid skip trigger");
    }
    var skip = strict ? strictList(value.skip, "skip categories", 256) : looseList(value.skip, "skip categories", 256);
    if (!whenAny.length || !skip.length) fail("skip rule must not be empty");
    for (var i = 0; i < skip.length; i += 1) id(skip[i], "category");
    return { whenAny: whenAny, skip: skip };
  }
  function groupValue(value, strict) {
    var group = strict ? strictList(value, "mutex group", MAX_GROUP_TAGS) : looseList(value, "mutex group", MAX_GROUP_TAGS);
    if (group.length < 2) fail("mutex groups need at least two tags");
    return group;
  }
  function normalizeInternal(raw, strict) {
    if (raw === undefined) return empty();
    if (raw === null) {
      if (strict) fail("catalog must be an object");
      return empty();
    }
    if (!isObject(raw)) fail("catalog must be an object");
    var allowed = { custom: true, removed: true, removedCustom: true, skipped: true, mutex: true, singletons: true, skipCategories: true };
    Object.keys(raw).forEach(function (key) { if (!allowed[key]) fail("unknown catalog field"); });
    var out = empty();
    out.custom = mapValue(raw.custom, "custom", strict);
    out.removed = mapValue(raw.removed, "removed", strict);
    out.removedCustom = mapValue(raw.removedCustom, "removedCustom", strict);
    out.skipped = mapValue(raw.skipped, "skipped", strict);
    if (raw.mutex !== undefined) {
      if (!Array.isArray(raw.mutex)) fail("mutex must be an array");
      if (raw.mutex.length > MAX_GROUPS) fail("too many mutex groups");
      var seenGroups = Object.create(null);
      out.mutex = raw.mutex.map(function (group) { return groupValue(group, strict); }).filter(function (group) {
        var signature = group.slice().sort().join("\u0000");
        if (own(seenGroups, signature)) {
          if (strict) fail("mutex groups must be unique");
          return false;
        }
        seenGroups[signature] = true;
        return true;
      });
    }
    if (raw.singletons !== undefined) out.singletons = strict ? strictList(raw.singletons, "singletons", 256) : looseList(raw.singletons, "singletons", 256);
    if (raw.skipCategories !== undefined) {
      if (!Array.isArray(raw.skipCategories)) fail("skipCategories must be an array");
      if (raw.skipCategories.length > MAX_GROUPS) fail("too many skip rules");
      var seenRules = Object.create(null);
      out.skipCategories = raw.skipCategories.map(function (rule) { return ruleValue(rule, strict); }).filter(function (rule) {
        var signature = JSON.stringify(rule);
        if (own(seenRules, signature)) {
          if (strict) fail("skip rules must be unique");
          return false;
        }
        seenRules[signature] = true;
        return true;
      });
    }
    return out;
  }
  function normalize(raw) { return normalizeInternal(raw, false); }
  function strictNormalize(raw) { return normalizeInternal(raw, true); }

  function parseJson(raw, label) {
    if (typeof raw !== "string") fail((label || "value") + " must be a JSON string");
    try { return JSON.parse(raw); } catch (error) { fail("Invalid " + (label || "value") + " JSON"); }
  }
  function mergeLists(base, local, remote) {
    var b = Object.create(null), l = Object.create(null), r = Object.create(null), out = [], all = [];
    function put(target, list) { list.forEach(function (item) { target[item] = true; if (all.indexOf(item) < 0) all.push(item); }); }
    put(b, base || []); put(l, local || []); put(r, remote || []);
    all.forEach(function (item) {
      var keep = own(b, item) ? (own(l, item) && own(r, item)) : (own(l, item) || own(r, item));
      if (keep) out.push(item);
    });
    return out;
  }
  function mergeMap(base, local, remote) {
    var out = {}, keys = Object.create(null);
    [base || {}, local || {}, remote || {}].forEach(function (map) { Object.keys(map).forEach(function (key) { keys[key] = true; }); });
    Object.keys(keys).forEach(function (key) {
      var list = mergeLists((base || {})[key] || [], (local || {})[key] || [], (remote || {})[key] || []);
      if (list.length) out[key] = list;
    });
    return out;
  }
  function ruleKey(rule) { return JSON.stringify(rule); }
  function pairs(groups) {
    var out = Object.create(null);
    (groups || []).forEach(function (group) {
      for (var i = 0; i < group.length; i += 1) for (var j = i + 1; j < group.length; j += 1) {
        var pair = [group[i], group[j]].sort();
        out[pair[0] + "\u0000" + pair[1]] = pair;
      }
    });
    return out;
  }
  function mergePairs(base, local, remote) {
    var b = pairs(base), l = pairs(local), r = pairs(remote), all = Object.create(null), edges = [];
    [b, l, r].forEach(function (set) { Object.keys(set).forEach(function (key) { all[key] = true; }); });
    Object.keys(all).forEach(function (key) {
      var keep = own(b, key) ? (own(l, key) && own(r, key)) : (own(l, key) || own(r, key));
      if (keep) edges.push(l[key] || r[key] || b[key]);
    });
    return edges;
  }
  function completeBuiltinExtension(group, builtins) {
    return builtins.some(function (builtin) {
      return builtin.every(function (tag) { return group.indexOf(tag) >= 0; });
    });
  }
  function protectBuiltinExtensions(edges, baseGroups, sideGroups, builtins) {
    if (!builtins.length) return edges;
    var baseSignatures = Object.create(null), edgeSet = Object.create(null);
    baseGroups.forEach(function (group) { baseSignatures[group.slice().sort().join("\u0000")] = true; });
    edges.forEach(function (edge) { edgeSet[edge[0] + "\u0000" + edge[1]] = true; });
    sideGroups.forEach(function (group) {
      var signature = group.slice().sort().join("\u0000");
      // A newly-added complete builtin extension is independent of a deletion
      // of a different base extension; protect its full pair set.
      if (own(baseSignatures, signature) || !completeBuiltinExtension(group, builtins)) return;
      for (var i = 0; i < group.length; i += 1) for (var j = i + 1; j < group.length; j += 1) {
        var pair = [group[i], group[j]].sort(), key = pair[0] + "\u0000" + pair[1];
        if (!own(edgeSet, key)) { edgeSet[key] = true; edges.push(pair); }
      }
    });
    return edges;
  }
  function groupFromSources(sources, edges) {
    var edgeSet = Object.create(null), seen = Object.create(null), out = [];
    edges.forEach(function (edge) { edgeSet[edge[0] + "\u0000" + edge[1]] = true; });
    function hasEdge(left, right) {
      var pair = [left, right].sort();
      return own(edgeSet, pair[0] + "\u0000" + pair[1]);
    }
    function addGroup(group) {
      if (group.length < 2) return;
      var signature = group.slice().sort().join("\u0000");
      if (own(seen, signature)) return;
      seen[signature] = true;
      out.push(group);
    }
    sources.forEach(function (source) {
      var group = source.filter(function (tag, index) {
        for (var i = 0; i < index; i += 1) {
          if (!hasEdge(tag, source[i])) return false;
        }
        return true;
      });
      addGroup(group);
    });
    // A source group can split when one pair is deleted. Keep every accepted
    // edge, while avoiding redundant pair groups already covered by a source.
    edges.forEach(function (edge) {
      var covered = out.some(function (group) { return group.indexOf(edge[0]) >= 0 && group.indexOf(edge[1]) >= 0; });
      if (!covered) addGroup(edge.slice());
    });
    return out;
  }
  function catalogOf(value) {
    if (isObject(value) && own(value, "catalog")) return value.catalog;
    return value;
  }
  function merge(base, local, remote, options) {
    var b = normalize(catalogOf(base)), l = normalize(catalogOf(local)), r = normalize(catalogOf(remote));
    var result = empty();
    result.custom = mergeMap(b.custom, l.custom, r.custom);
    result.removed = mergeMap(b.removed, l.removed, r.removed);
    result.removedCustom = mergeMap(b.removedCustom, l.removedCustom, r.removedCustom);
    result.skipped = mergeMap(b.skipped, l.skipped, r.skipped);
    var mergedEdges = mergePairs(b.mutex, l.mutex, r.mutex);
    var builtinRules = options && own(options, "builtinRules") ? options.builtinRules :
      (options && Array.isArray(options.mutex) ? options : null);
    if (builtinRules) {
      var builtins = builtinGroups(builtinRules);
      protectBuiltinExtensions(mergedEdges, b.mutex, l.mutex.concat(r.mutex), builtins);
    }
    result.mutex = groupFromSources(l.mutex.concat(r.mutex), mergedEdges);
    result.singletons = mergeLists(b.singletons, l.singletons, r.singletons);
    var bRules = Object.create(null), lRules = Object.create(null), rRules = Object.create(null), ruleKeys = Object.create(null);
    [b.skipCategories, l.skipCategories, r.skipCategories].forEach(function (rules) { rules.forEach(function (rule) { ruleKeys[ruleKey(rule)] = true; }); });
    Object.keys(ruleKeys).forEach(function (key) {
      b.skipCategories.forEach(function (rule) { if (ruleKey(rule) === key) bRules[key] = true; });
      l.skipCategories.forEach(function (rule) { if (ruleKey(rule) === key) lRules[key] = true; });
      r.skipCategories.forEach(function (rule) { if (ruleKey(rule) === key) rRules[key] = true; });
      if (bRules[key] ? (lRules[key] && rRules[key]) : (lRules[key] || rRules[key])) result.skipCategories.push(JSON.parse(key));
    });
    return normalize(result);
  }

  function rulesOf(value) { return isObject(value) ? value : {}; }
  function builtinGroups(builtinRules) {
    var rules = rulesOf(builtinRules);
    if (!Array.isArray(rules.mutex)) return [];
    if (rules.mutex.length > MAX_GROUPS) fail("too many builtin mutex groups");
    return rules.mutex.map(function (group) { return looseList(group, "builtin mutex group", MAX_GROUP_TAGS); }).filter(function (group) { return group.length >= 2; });
  }
  function extendMutex(groupsOrCatalog, builtinRules) {
    var groups = Array.isArray(groupsOrCatalog) ? groupsOrCatalog : normalize(groupsOrCatalog).mutex;
    groups = groups.map(function (group) { return looseList(group, "mutex group", MAX_GROUP_TAGS); }).filter(function (group) { return group.length >= 2; });
    var builtins = builtinGroups(builtinRules), out = [];
    builtins.forEach(function (builtin) {
      var extensions = groups.filter(function (group) { return builtin.every(function (tag) { return group.indexOf(tag) >= 0; }); });
      if (extensions.length) {
        var complete = builtin.slice();
        extensions.forEach(function (group) {
          group.forEach(function (tag) { if (complete.indexOf(tag) < 0) complete.push(tag); });
        });
        if (complete.length <= MAX_GROUP_TAGS) out.push(complete);
        else {
          var extras = complete.filter(function (tag) { return builtin.indexOf(tag) < 0; });
          var room = MAX_GROUP_TAGS - builtin.length;
          if (room <= 0) out.push(builtin.slice());
          else {
            var offset;
            for (offset = 0; offset < extras.length; offset += room) {
              out.push(builtin.concat(extras.slice(offset, offset + room)));
            }
          }
        }
      } else out.push(builtin.slice());
    });
    groups.forEach(function (group) {
      var complete = builtins.some(function (builtin) { return builtin.every(function (tag) { return group.indexOf(tag) >= 0; }); });
      if (!complete) out.push(group.slice());
    });
    var seen = Object.create(null);
    var deduped = out.filter(function (group) {
      var key = group.slice().sort().join("\u0000");
      if (own(seen, key)) return false;
      seen[key] = true;
      return true;
    });
    if (deduped.length > MAX_GROUPS) fail("too many effective mutex groups");
    return deduped;
  }
  function effectiveRules(catalog, builtinRules, categories) {
    var c = normalize(catalog), b = rulesOf(builtinRules), out = {
      mutex: extendMutex(c.mutex, b),
      singletons: mergeLists([], Array.isArray(b.singletons) ? looseList(b.singletons, "builtin singletons") : [], c.singletons),
      skipCategories: []
    };
    var available = null;
    if (categories !== undefined && categories !== null) {
      available = Object.create(null);
      var categoryList = isObject(categories) && Array.isArray(categories.categories) ? categories.categories : categories;
      if (Array.isArray(categoryList)) categoryList.forEach(function (category) {
        if (!isObject(category) || !Array.isArray(category.slots)) return;
        category.slots.forEach(function (slot) {
          if (!isObject(slot) || typeof slot.id !== "string") return;
          pool(category, slot, c, {}).forEach(function (tag) { available[tag] = true; });
        });
      });
    }
    function filterTags(list) {
      return available ? list.filter(function (tag) { return own(available, tag); }) : list.slice();
    }
    out.mutex = out.mutex.map(function (group) { return filterTags(group); }).filter(function (group) { return group.length >= 2; });
    out.singletons = filterTags(out.singletons);
    var seen = Object.create(null);
    (Array.isArray(b.skipCategories) ? b.skipCategories : []).concat(c.skipCategories).forEach(function (rule) {
      var normalized = ruleValue(rule, false);
      normalized.whenAny = filterTags(normalized.whenAny);
      if (available) {
        var categoryIds = Object.create(null);
        var categoryList = isObject(categories) && Array.isArray(categories.categories) ? categories.categories : categories;
        if (Array.isArray(categoryList)) categoryList.forEach(function (category) {
          if (category && typeof category.id === "string") categoryIds[category.id] = true;
        });
        normalized.skip = normalized.skip.filter(function (category) { return own(categoryIds, category); });
      }
      if (!normalized.whenAny.length || !normalized.skip.length) return;
      var key = ruleKey(normalized);
      if (!own(seen, key)) { seen[key] = true; out.skipCategories.push(normalized); }
    });
    return out;
  }

  function slotKey(category, slot) {
    var categoryId = isObject(category) ? category.id : category;
    var slotId = isObject(slot) ? slot.id : slot;
    if (typeof categoryId === "string" && typeof slotId === "string") return categoryId + "." + slotId;
    if (isObject(slot) && typeof slot.key === "string") return slot.key;
    return null;
  }
  function builtinPool(slot) {
    if (Array.isArray(slot)) return slot;
    if (isObject(slot) && Array.isArray(slot.pool)) return slot.pool;
    return [];
  }
  function pool(category, slot, catalog, options) {
    var c = normalize(catalog), key = slotKey(category, slot), builtin = looseList(builtinPool(slot), "slot pool", 4096);
    if (!key) fail("category and slot ids are required");
    var custom = c.custom[key] || [], removed = Object.create(null), removedCustom = Object.create(null);
    (c.removed[key] || []).forEach(function (tag) { removed[tag] = true; });
    (c.removedCustom[key] || []).forEach(function (tag) { removedCustom[tag] = true; });
    var result = [];
    builtin.forEach(function (tag) { if (!own(removed, tag) && result.indexOf(tag) < 0) result.push(tag); });
    custom.forEach(function (tag) { if (!own(removed, tag) && !own(removedCustom, tag) && result.indexOf(tag) < 0) result.push(tag); });
    if (options && options.random) {
      var skipped = Object.create(null);
      (c.skipped[key] || []).forEach(function (tag) { skipped[tag] = true; });
      result = result.filter(function (tag) { return !own(skipped, tag); });
    }
    return result;
  }
  function categoryInfo(categories) {
    if (isObject(categories) && Array.isArray(categories.categories)) categories = categories.categories;
    if (!Array.isArray(categories)) categories = [];
    var slots = Object.create(null), tags = Object.create(null), categoryIds = Object.create(null);
    categories.forEach(function (category) {
      if (!isObject(category)) return;
      var categoryId = typeof category.id === "string" ? category.id : "";
      if (!categoryId) return;
      categoryIds[categoryId] = true;
      (Array.isArray(category.slots) ? category.slots : []).forEach(function (slot) {
        if (!isObject(slot) || typeof slot.id !== "string") return;
        var key = categoryId + "." + slot.id;
        slots[key] = true;
        builtinPool(slot).forEach(function (tag) { if (typeof tag === "string" && tag.trim()) tags[tag.trim()] = true; });
      });
    });
    return { slots: slots, tags: tags, categoryIds: categoryIds };
  }
  function pruneRules(catalog, categories) {
    var c = normalize(catalog), info = categoryInfo(categories), out = empty();
    function pruneMap(source, predicate) {
      var result = {};
      Object.keys(source).forEach(function (key) {
        if (!info.slots[key]) return;
        var list = source[key].filter(predicate.bind(null, key));
        if (list.length) result[key] = list;
      });
      return result;
    }
    out.custom = pruneMap(c.custom, function () { return true; });
    out.removed = pruneMap(c.removed, function (key, tag) {
      var catSlot = key.split(".");
      var category = (Array.isArray(categories) ? categories : (categories && categories.categories) || []).filter(function (item) { return item && item.id === catSlot[0]; })[0];
      var slot = category && Array.isArray(category.slots) ? category.slots.filter(function (item) { return item && item.id === catSlot.slice(1).join("."); })[0] : null;
      return builtinPool(slot).map(function (item) { return typeof item === "string" ? item.trim() : item; }).indexOf(tag) >= 0;
    });
    out.removedCustom = pruneMap(c.removedCustom, function (key, tag) { return (c.custom[key] || []).indexOf(tag) >= 0; });
    out.skipped = pruneMap(c.skipped, function (key, tag) {
      var catSlot = key.split("."), category = (Array.isArray(categories) ? categories : (categories && categories.categories) || []).filter(function (item) { return item && item.id === catSlot[0]; })[0];
      var slot = category && Array.isArray(category.slots) ? category.slots.filter(function (item) { return item && item.id === catSlot.slice(1).join("."); })[0] : null;
      return builtinPool(slot).concat(c.custom[key] || []).map(function (item) { return typeof item === "string" ? item.trim() : item; }).indexOf(tag) >= 0;
    });
    out.mutex = c.mutex.map(function (group) { return group.filter(function (tag) { return own(info.tags, tag) || Object.keys(c.custom).some(function (key) { return c.custom[key].indexOf(tag) >= 0; }); }); }).filter(function (group) { return group.length >= 2; });
    var customTags = Object.create(null);
    Object.keys(c.custom).forEach(function (key) { c.custom[key].forEach(function (tag) { customTags[tag] = true; }); });
    out.singletons = c.singletons.filter(function (tag) { return own(info.tags, tag) || own(customTags, tag); });
    out.skipCategories = c.skipCategories.map(function (rule) {
      return { whenAny: rule.whenAny.filter(function (tag) { return own(info.tags, tag) || own(customTags, tag); }), skip: rule.skip.filter(function (category) { return own(info.categoryIds, category); }) };
    }).filter(function (rule) { return rule.whenAny.length && rule.skip.length; });
    return out;
  }
  function fromValues(values) {
    if (!isObject(values)) fail("settings values must be an object");
    if (own(values, KEY)) return strictNormalize(parseJson(values[KEY], KEY));
    if (!own(values, LEGACY_KEY)) return empty();
    var legacy = parseJson(values[LEGACY_KEY], LEGACY_KEY);
    if (!isObject(legacy)) fail("legacy preset must be an object");
    var catalog = normalize(legacy.catalog === undefined ? {} : legacy.catalog);
    var custom = normalize({ custom: legacy.custom === undefined ? {} : legacy.custom }).custom;
    catalog.custom = mergeMap({}, catalog.custom, custom);
    return catalog;
  }

  return {
    KEY: KEY,
    LEGACY_KEY: LEGACY_KEY,
    key: KEY,
    legacyKey: LEGACY_KEY,
    empty: empty,
    normalize: normalize,
    fromValues: fromValues,
    merge: merge,
    pool: pool,
    pruneRules: pruneRules,
    effectiveRules: effectiveRules,
    extendMutex: extendMutex
  };
}));
