"use strict";

const assert = require("assert");
const Model = require("../mobile/preset-catalog.js");

const key = Model.key;
const legacyKey = Model.legacyKey;

function catalog(extra = {}) {
  return Model.normalize({
    custom: {}, removed: {}, removedCustom: {}, skipped: {}, mutex: [], singletons: [], skipCategories: [],
    ...extra,
  });
}

function throws(fn, message) {
  assert.throws(fn, /.+/, message);
}

(function exportsAndNormalization() {
  assert.strictEqual(key, "comfy-mobile-remote.presetCatalog");
  assert.strictEqual(legacyKey, "comfy-mobile-remote.preset");
  assert.deepStrictEqual(Model.empty(), {
    custom: {}, removed: {}, removedCustom: {}, skipped: {}, mutex: [], singletons: [], skipCategories: [],
  });
  assert.deepStrictEqual(Model.normalize({
    custom: { "person.origin": ["", " tag ", "tag"] },
    mutex: [["a", "b"], ["b", "a"]],
    skipCategories: [{ whenAny: ["x", "x"], skip: ["top", "top"] }],
  }), {
    custom: { "person.origin": ["tag"] }, removed: {}, removedCustom: {}, skipped: {},
    mutex: [["a", "b"]], singletons: [],
    skipCategories: [{ whenAny: ["x"], skip: ["top"] }],
  });
  throws(() => Model.fromValues({ [key]: "{broken", [legacyKey]: JSON.stringify({ custom: { x: ["keep"] } }) }), "malformed authoritative key throws");
  throws(() => Model.fromValues({ [key]: JSON.stringify({ custom: { x: ["", "x"] } }) }), "new key rejects empty/duplicate tags");
  throws(() => Model.fromValues({ [key]: JSON.stringify({ mutex: [["a", "b"], ["b", "a"]] }) }), "new key rejects duplicate mutex groups");
})();

(function valuesMigrationAndAuthority() {
  const legacy = {
    custom: { "person.origin": ["", "old", "old"] },
    catalog: { custom: { "person.origin": ["catalog"] }, removedCustom: { "person.origin": ["old"] } },
  };
  assert.deepStrictEqual(Model.fromValues({ [legacyKey]: JSON.stringify(legacy) }), {
    custom: { "person.origin": ["catalog", "old"] }, removed: {},
    removedCustom: { "person.origin": ["old"] }, skipped: {}, mutex: [], singletons: [], skipCategories: [],
  });
  const authoritative = catalog({ custom: { "person.origin": ["new"] } });
  assert.deepStrictEqual(Model.fromValues({ [key]: JSON.stringify(authoritative), [legacyKey]: "{bad" }), authoritative);
  assert.deepStrictEqual(Model.fromValues({ [legacyKey]: JSON.stringify({ catalog: { skipCategories: [{ whenTag: "legacy", skip: ["top"] }] } }) }).skipCategories,
    [{ whenAny: ["legacy"], skip: ["top"] }]);
  assert.deepStrictEqual(Model.fromValues({}), Model.empty());
})();

(function tagMergeIsDeleteAware() {
  const base = catalog({ custom: { s: ["base", "keep"] }, removed: { s: ["gone"] } });
  const local = catalog({ custom: { s: ["keep", "local"] }, removed: { s: [] } });
  const remote = catalog({ custom: { s: ["base", "keep", "remote"] }, removed: { s: ["gone"] } });
  const merged = Model.merge(base, local, remote);
  assert.deepStrictEqual(merged.custom.s, ["keep", "local", "remote"]);
  assert.deepStrictEqual(merged.removed, {});
  assert.deepStrictEqual(Model.merge(catalog({ custom: { s: ["last"] } }), catalog({ custom: {} }), catalog({ custom: { s: ["last"] } })).custom, {});
})();

(function mutexMergeKeepsEdgesWithoutTransitiveUnion() {
  const nontransitive = Model.merge(catalog(), catalog({ mutex: [["a", "b"]] }), catalog({ mutex: [["b", "c"]] }));
  assert.deepStrictEqual(nontransitive.mutex, [["a", "b"], ["b", "c"]]);
  const split = Model.merge(
    catalog({ mutex: [["a", "b", "c"]] }),
    catalog({ mutex: [["a", "c"], ["b", "c"]] }),
    catalog({ mutex: [["a", "b", "c"]] }),
  );
  assert.deepStrictEqual(split.mutex, [["a", "c"], ["b", "c"]]);
  const extensions = Model.merge(
    catalog(),
    catalog({ mutex: [["a", "b", "x"]] }),
    catalog({ mutex: [["a", "b", "y"]] }),
    { builtinRules: { mutex: [["a", "b"]] } },
  );
  assert.deepStrictEqual(extensions.mutex, [["a", "b", "x"], ["a", "b", "y"]]);
  assert.deepStrictEqual(Model.effectiveRules(catalog({ mutex: [["a", "b", "x"], ["a", "b", "y"]] }), { mutex: [["a", "b"]] }).mutex,
    [["a", "b", "x", "y"]]);
  const replacement = Model.merge(
    catalog({ mutex: [["a", "b", "x"]] }), catalog(), catalog({ mutex: [["a", "b", "y"]] }),
    { builtinRules: { mutex: [["a", "b"]] } },
  );
  assert.deepStrictEqual(replacement.mutex, [["a", "b", "y"]]);
  const extras = Array.from({ length: 70 }, (_, index) => `x${index}`);
  const overflow = Model.extendMutex(
    extras.map((tag) => ["a", "b", tag]),
    { mutex: [["a", "b"]] },
  );
  assert.ok(overflow.every((group) => group.length <= 64));
  assert.ok(overflow.every((group) => group.includes("a") && group.includes("b")));
  assert.deepStrictEqual(new Set(overflow.flat()).size, 72);
})();

(function poolsAndRules() {
  const category = { id: "person", slots: [{ id: "origin", pool: ["builtin", "same"] }] };
  const c = catalog({
    custom: { "person.origin": ["custom", "same"] },
    removed: { "person.origin": ["same"] },
    removedCustom: { "person.origin": ["custom"] },
    skipped: { "person.origin": ["builtin"] },
  });
  assert.deepStrictEqual(Model.pool(category, category.slots[0], c), ["builtin"]);
  assert.deepStrictEqual(Model.pool(category, category.slots[0], c, { random: true }), []);
  const rules = Model.effectiveRules(c, {
    mutex: [["builtin", "gone"]], singletons: ["builtin", "gone"],
    skipCategories: [{ whenAny: ["builtin", "gone"], skip: ["person", "gone-category"] }],
  }, [category]);
  assert.deepStrictEqual(rules.mutex, []);
  assert.deepStrictEqual(rules.singletons, ["builtin"]);
  assert.deepStrictEqual(rules.skipCategories, [{ whenAny: ["builtin"], skip: ["person"] }]);
  const pruned = Model.pruneRules(c, [category]);
  assert.deepStrictEqual(pruned.custom, c.custom);
  assert.deepStrictEqual(pruned.removedCustom, c.removedCustom);
  assert.deepStrictEqual(pruned.removed, { "person.origin": ["same"] });
})();

console.log("preset-catalog tests passed");
