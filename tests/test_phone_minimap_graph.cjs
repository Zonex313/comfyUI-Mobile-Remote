"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("../mobile/panel/node_modules/esbuild");
const stronglyConnectedComponents = require("../mobile/panel/node_modules/strongly-connected-components");
const src = path.resolve(__dirname, "../mobile/panel/src");
const calls = { ue: 0, scc: 0 };
let reverseComponentOrder = false;

function loadUtility(name, external = []) {
  const filename = path.join(src, "utils", name + ".ts");
  const result = esbuild.buildSync({
    entryPoints: [filename], bundle: true, write: false, platform: "node", format: "cjs",
    alias: { "@": src }, external,
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded.require = (id) => {
    if (id.includes("useEverywhere")) return {
      ...wireless, resolveUseEverywhereLinks(...args) {
        calls.ue += 1;
        return wireless.resolveUseEverywhereLinks(...args);
      },
    };
    if (id === "strongly-connected-components") return (...args) => {
      calls.scc += 1;
      const result = stronglyConnectedComponents(...args);
      if (reverseComponentOrder) result.components.reverse();
      return result;
    };
    return module.require(id);
  };
  loaded._compile(result.outputFiles[0].text, filename);
  return loaded.exports;
}
const wireless = loadUtility("useEverywhere");
const { buildPhoneMinimapGraph: build, buildPhoneMinimapTopologySignature: signature, createPhoneMinimapLayout } =
  loadUtility("phoneMinimapGraph", ["strongly-connected-components", "*/useEverywhere", "*/useEverywhere.ts"]);

function input(name = "value", type = "MODEL") { return { name, type, link: null }; }
function output(name = "value", type = "MODEL") { return { name, type, links: [] }; }
function node(id, overrides = {}) {
  return {
    id, itemKey: `root/node:${id}`, type: "TestNode", pos: [id * 10, id * 20],
    size: [100, 80], flags: {}, order: id, mode: 0, properties: {}, widgets_values: [],
    inputs: [input(), input("second")], outputs: [output(), output("second")], ...overrides,
  };
}
function workflow(nodes, pairs = []) {
  return {
    nodes, links: pairs.map(([from, to, sourceSlot = 0, targetSlot = 0], index) => [index + 1, from, sourceSlot, to, targetSlot, "MODEL"]),
    groups: [], config: {}, version: 0.4, last_node_id: 9999, last_link_id: 9999,
  };
}
function lookup(graph, id) { return graph.nodes.find((entry) => entry.id === id); }
function pairs(graph) { return graph.edges.map((edge) => [edge.source, edge.target, edge.wireless]); }
function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function assertLayout(graph) {
  assert.equal(new Set(graph.nodes.map((entry) => entry.key)).size, graph.nodes.length);
  assert.equal(new Set(graph.edges.map((entry) => entry.key)).size, graph.edges.length);
  assert.equal(graph.columns, graph.nodes.reduce((max, entry) => Math.max(max, entry.column + 1), 0));
  assert.equal(graph.rows, graph.nodes.reduce((max, entry) => Math.max(max, entry.row + 1), 0));
  const columns = new Map();
  for (const entry of graph.nodes) {
    assert.ok(Number.isInteger(entry.column) && entry.column >= 0);
    assert.ok(Number.isFinite(entry.row) && entry.row >= 0);
    assert.ok(Number.isInteger(entry.component) && entry.component >= 0);
    const entries = columns.get(entry.column) || [];
    entries.push(entry.row);
    columns.set(entry.column, entries);
  }
  for (const rows of columns.values()) {
    rows.sort((a, b) => a - b);
    rows.slice(1).forEach((row, index) => assert.ok(row - rows[index] >= 1));
  }
  const byKey = new Map(graph.nodes.map((entry) => [entry.key, entry]));
  for (const edge of graph.edges) {
    const source = byKey.get(edge.source);
    const target = byKey.get(edge.target);
    assert.ok(source && target);
    if (source.component !== target.component) assert.ok(target.column > source.column);
  }
}

test("empty and singleton graphs have finite normalized extents", () => {
  const empty = build(workflow([]));
  assert.deepEqual(empty, { nodes: [], edges: [], columns: 0, rows: 0, signature: signature(workflow([])) });
  const single = build(workflow([node(7)]));
  assert.deepEqual(single.nodes, [{ key: "root/node:7", id: 7, column: 0, row: 0, component: 0 }]);
  assertLayout(single);
});

test("chain ranks follow longest upstream paths, not input mirrors", () => {
  const wf = workflow([1, 2, 3, 4].map((id) => node(id)), [[1, 2], [2, 3], [3, 4]]);
  const graph = build(wf);
  assert.deepEqual(graph.nodes.map((entry) => entry.column), [0, 1, 2, 3]);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.rows, 1);
  assertLayout(graph);
});

test("A-B-C-E-F and A-D-F leave D in the second column", () => {
  const wf = workflow([1, 2, 3, 4, 5, 6].map((id) => node(id)), [[1, 2], [2, 3], [3, 5], [5, 6], [1, 4], [4, 6, 0, 1]]);
  const graph = build(wf);
  assert.deepEqual(graph.nodes.map((entry) => entry.column), [0, 1, 2, 1, 3, 4]);
  assertLayout(graph);
});

test("merges use the maximum upstream rank plus one", () => {
  const graph = build(workflow([1, 2, 3, 4, 5, 6].map((id) => node(id)), [[1, 3], [3, 4], [4, 5], [2, 5, 0, 1], [1, 6]]));
  assert.equal(lookup(graph, 2).column, 0);
  assert.equal(lookup(graph, 5).column, 3);
  assert.equal(lookup(graph, 6).column, 1);
  assertLayout(graph);
});

test("independent sources and isolated nodes keep stable, separate branch bands", () => {
  const wf = workflow([1, 2, 3, 4, 5, 6].map((id) => node(id)), [[1, 5], [2, 4]]);
  const graph = build(wf);
  for (const id of [1, 2, 3, 6]) assert.equal(lookup(graph, id).column, 0);
  assert.equal(lookup(graph, 1).row, lookup(graph, 5).row);
  assert.equal(lookup(graph, 2).row, lookup(graph, 4).row);
  assert.ok(lookup(graph, 5).row < lookup(graph, 2).row);
  const reordered = structuredClone(wf);
  reordered.nodes.reverse();
  reordered.links.reverse();
  assert.deepEqual(build(reordered), graph);
  assertLayout(graph);
});

test("adding or removing isolated nodes never moves connected branches, wireless pairs or self-loops", () => {
  const connected = [node(10), node(20), node(30), node(40), node(50),
    node(60, { type: "SetNode", widgets_values: ["shared"] }),
    node(70, { type: "GetNode", widgets_values: ["shared"] })];
  const wf = workflow(connected, [[10, 20], [30, 40], [50, 50]]);
  const coordinates = (graph) => graph.nodes.filter((entry) => connected.some((original) => original.id === entry.id))
    .map(({ key, column, row }) => ({ key, column, row }));
  const baseline = coordinates(build(wf));
  const isolated = [1, 15, 25, 45, 65, 99].map((id) => node(id));
  wf.nodes = [...connected, ...isolated].sort((a, b) => a.id - b.id);
  const inserted = build(wf);
  assert.deepEqual(coordinates(inserted), baseline);
  assert.equal(inserted.nodes.length, connected.length + isolated.length);
  const connectedBottom = Math.max(...baseline.map((entry) => entry.row));
  isolated.forEach((entry) => {
    assert.equal(lookup(inserted, entry.id).column, 0);
    assert.ok(lookup(inserted, entry.id).row > connectedBottom);
  });
  assertLayout(inserted);
  wf.nodes = wf.nodes.filter((entry) => entry.id !== 15 && entry.id !== 45);
  assert.deepEqual(coordinates(build(wf)), baseline);
  wf.nodes = connected;
  assert.deepEqual(coordinates(build(wf)), baseline);
});

test("barycenter ordering removes a simple avoidable crossing without swapping sources", () => {
  const graph = build(workflow([1, 2, 3, 4, 5].map((id) => node(id)), [[1, 4], [2, 3], [3, 5], [4, 5, 0, 1]]));
  assert.ok(lookup(graph, 1).row < lookup(graph, 2).row);
  assert.ok(lookup(graph, 4).row < lookup(graph, 3).row);
  assertLayout(graph);
});

test("cycles condense for ranking but retain every member and self-loop", () => {
  const graph = build(workflow([1, 2, 3, 4, 5].map((id) => node(id)), [[1, 2], [2, 3], [3, 2, 0, 1], [3, 4], [4, 4, 0, 1], [5, 5]]));
  assert.equal(lookup(graph, 2).component, lookup(graph, 3).component);
  assert.equal(lookup(graph, 2).column, 1);
  assert.equal(lookup(graph, 3).column, 1);
  assert.equal(lookup(graph, 4).column, 2);
  assert.equal(lookup(graph, 5).column, 0);
  assert.equal(graph.edges.length, 6);
  assertLayout(graph);
});

test("malformed endpoints, slots and links are discarded, node-pair links deduplicate", () => {
  const wf = workflow([node(1), node(2)], [[1, 2], [1, 2, 1, 1], [1, 1]]);
  wf.links.push(wf.links[0], null, {}, [20], [21, 999, 0, 2, 0, "MODEL"], [22, 1, 99, 2, 0, "MODEL"],
    [23, 1, -1, 2, 0, "MODEL"], [24, 1, 0, -20, 0, "MODEL"], [25, 1, 0, 2, 1.5, "MODEL"],
    [26, 1, 0, 2, 0, {}], [27, 1, 0, 2, 77, "MODEL"], [28, "1", 0, 2, 0, "MODEL"]);
  wf.nodes[0].outputs[0].links = [999];
  wf.nodes[1].inputs[0].link = 998;
  const graph = build(wf);
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.some((edge) => edge.source === edge.target));
  assertLayout(graph);
});

test("only current-scope nodes are displayed, including hidden/collapsed placeholders", () => {
  const outer = node(2, { type: "inner", flags: { collapsed: true } });
  const inner = node(1, { itemKey: "root/subgraph:inner/node:1" });
  const wf = workflow([node(1), outer], [[1, 2]]);
  wf.extra = { mobileLayout: { root: [], hiddenBlocks: { hidden: [1, 2] } } };
  wf.definitions = { subgraphs: [{ id: "inner", nodes: [inner], links: [] }] };
  wf.links.push([99, 2, 0, 99, 0, "MODEL"]);
  assert.deepEqual(build(wf).nodes.map((entry) => entry.key), ["root/node:1", "root/node:2"]);
  const scoped = { ...wf, nodes: [inner], links: [] };
  assert.deepEqual(build(scoped).nodes.map((entry) => entry.key), ["root/subgraph:inner/node:1"]);
  assert.notEqual(signature(wf), signature(scoped));
});

test("itemKey identity prevents accidental cross-layer links or duplicate-id aliasing", () => {
  const graph = build(workflow([node(1), node(1, { itemKey: "root/subgraph:s/node:1" }),
    node(2, { itemKey: "root/subgraph:s/node:2" }), node(3)], [[1, 2], [3, 2]]));
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 0);
  assertLayout(graph);
});

test("fallback and unusual itemKeys remain stable and safe for the graph library", () => {
  const wf = workflow([node(1, { itemKey: undefined }), node(2, { itemKey: "__proto__" }),
    node(3, { itemKey: "constructor" }), node(4, { itemKey: "x\u0001y" })], [[1, 2], [2, 3], [3, 4]]);
  const graph = build(wf);
  assert.equal(graph.nodes[0].key, "node:1");
  assert.deepEqual(graph.nodes.map((entry) => entry.column), [0, 1, 2, 3]);
  assertLayout(graph);
});

test("Set/Get uses existing name parsing, first-set precedence and same-scope matching", () => {
  const set = node(1, { type: "SetNode", widgets_values: ["shared"], outputs: [] });
  const get = node(2, { type: "GetNode", widgets_values: { name: "shared" } });
  const duplicateSet = node(3, { type: "SetNode", widgets_values: { value: "shared" } });
  const otherScope = node(4, { type: "GetNode", widgets_values: ["shared"], itemKey: "root/subgraph:s/node:4" });
  const graph = build(workflow([set, get, duplicateSet, otherScope, node(5, { type: "GetNode", widgets_values: ["other"] })]));
  assert.deepEqual(pairs(graph), [["root/node:1", "root/node:2", true]]);
  assertLayout(graph);
});

test("wired and wireless edges on the same pair remain distinct while slots deduplicate", () => {
  const wf = workflow([node(1, { type: "SetNode", widgets_values: ["x"] }),
    node(2, { type: "GetNode", widgets_values: ["x"] })], [[1, 2], [1, 2, 1, 1]]);
  const graph = build(wf);
  assert.deepEqual(graph.edges.map((edge) => edge.wireless), [false, true]);
  assert.equal(graph.edges.length, 2);
});

function ueWorkflow() {
  return workflow([node(1, { inputs: [] }), node(2, { type: "Anything Everywhere", inputs: [input("anything", "*")], outputs: [] }),
    node(3, { inputs: [input("model"), input("second_model")] })], [[1, 2]]);
}

test("UE resolves once per scope and uses validated table despite stale input mirrors", () => {
  const wf = ueWorkflow();
  wf.nodes[2].inputs[0].link = 999;
  const before = calls.ue;
  const graph = build(wf);
  assert.equal(calls.ue - before, 1);
  assert.deepEqual(pairs(graph), [["root/node:1", "root/node:2", false], ["root/node:1", "root/node:3", true], ["root/node:2", "root/node:3", true]]);
  assertLayout(graph);
  wf.links.push([2, 1, 0, 3, 0, "MODEL"], [3, 1, 0, 3, 1, "MODEL"]);
  assert.equal(build(wf).edges.filter((edge) => edge.wireless).length, 0);
});

test("UE never leaks broadcasts across scopes or trusts foreign mirror endpoints", () => {
  const wf = ueWorkflow();
  wf.nodes[2].itemKey = "root/subgraph:s/node:3";
  assert.equal(build(wf).edges.length, 1);
  wf.nodes[2].itemKey = "root/node:3";
  wf.links = [[7, 1, 0, 3, 0, "MODEL"]];
  wf.nodes[1].inputs[0].link = 7;
  assert.deepEqual(pairs(build(wf)), [["root/node:1", "root/node:3", false]]);
});

test("UE conversion, priority ties and restrictions reuse resolver semantics", () => {
  const converted = node(1, { inputs: [], outputs: [output()], properties: { ue_convert: true } });
  const consumer = node(2);
  const wf = workflow([converted, consumer]);
  assert.deepEqual(pairs(build(wf)), [["root/node:1", "root/node:2", true]]);
  wf.nodes.push(node(3, { ...converted, id: 3, itemKey: "root/node:3" }));
  assert.equal(build(wf).edges.length, 0);
  wf.nodes[2].properties = { ue_convert: true, ue_properties: { priority: 100 } };
  assert.deepEqual(pairs(build(wf)), [["root/node:3", "root/node:2", true]]);
  consumer.properties.rejects_ue_links = true;
  assert.equal(build(wf).edges.length, 0);
});

test("all builders leave even deeply frozen workflows and layout data untouched", () => {
  const wf = ueWorkflow();
  wf.nodes[2].inputs[0].link = 999;
  const snapshot = structuredClone(wf);
  frozen(wf);
  build(wf);
  signature(wf);
  const layout = createPhoneMinimapLayout();
  layout(wf);
  layout(wf);
  assert.deepEqual(wf, snapshot);
});

test("parameters, position, order, visibility, color, bypass and focus do not reorder ordinary topology", () => {
  const wf = workflow([1, 2, 3, 4].map((id) => node(id)), [[1, 2], [1, 3], [3, 4]]);
  const graph = build(wf);
  const changed = structuredClone(wf);
  changed.nodes.forEach((entry, index) => Object.assign(entry, {
    widgets_values: ["changed", index], title: "Updated", pos: [900 - index, -index], order: -index,
    size: [700, 12], mode: index % 2 ? 4 : 2, color: "#ff0000", bgcolor: "#00ff00", flags: { collapsed: true },
  }));
  changed.extra = { hidden: [1, 2, 3], focus: 4 };
  changed.nodes.reverse();
  assert.equal(signature(changed), graph.signature);
  assert.deepEqual(build(changed), graph);
});

test("layout cache reuses graph identity and skips SCC/toposort for unchanged topology", () => {
  const layout = createPhoneMinimapLayout();
  const wf = ueWorkflow();
  const initial = layout(wf);
  const before = { ...calls };
  const changed = structuredClone(wf);
  changed.nodes[2].mode = 4;
  changed.nodes[2].color = "#123456";
  changed.nodes[2].widgets_values = [42];
  changed.nodes[0].pos = [0, 0];
  assert.strictEqual(layout(changed), initial);
  assert.equal(calls.scc, before.scc);
  assert.equal(calls.ue - before.ue, 1);
  const beforeSignature = { ...calls };
  assert.equal(signature(changed), initial.signature);
  assert.equal(calls.scc, beforeSignature.scc);
  changed.nodes[1].mode = 4;
  const disabled = layout(changed);
  assert.notStrictEqual(disabled, initial);
  assert.equal(disabled.edges.filter((edge) => edge.wireless).length, 0);
  assert.equal(calls.scc, before.scc + 2);
});

test("wireless routing names and real node/link changes invalidate signatures and cache", () => {
  const layout = createPhoneMinimapLayout();
  const wf = workflow([node(1, { type: "SetNode", widgets_values: ["x"] }), node(2, { type: "GetNode", widgets_values: ["x"] })]);
  const connected = layout(wf);
  wf.nodes[1].widgets_values = ["y"];
  const disconnected = layout(wf);
  assert.notEqual(connected.signature, disconnected.signature);
  assert.notStrictEqual(connected, disconnected);
  wf.nodes.push(node(3));
  const added = layout(wf);
  assert.notEqual(added.signature, disconnected.signature);
  wf.links.push([1, 1, 0, 3, 0, "MODEL"]);
  assert.notEqual(layout(wf).signature, added.signature);
});

test("SCC discovery order cannot change columns, rows or component identity", () => {
  const wf = workflow([1, 2, 3, 4, 5, 6].map((id) => node(id)), [[1, 2], [2, 3], [3, 2, 0, 1], [3, 4], [5, 6]]);
  const expected = build(wf);
  reverseComponentOrder = true;
  try { assert.deepEqual(build(wf), expected); } finally { reverseComponentOrder = false; }
});

test("random small graphs agree with independent reachability and longest-path properties", () => {
  let seed = 173;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let sample = 0; sample < 80; sample += 1) {
    const count = 8 + sample % 9;
    const links = [];
    for (let a = 0; a < count; a += 1) {
      for (let b = sample % 2 ? a + 1 : 0; b < count; b += 1) {
        if (random() < 0.18) links.push([a + 1, b + 1]);
      }
    }
    const wf = workflow(Array.from({ length: count }, (_, index) => node(index + 1)), links);
    const reach = Array.from({ length: count }, (_, a) => Array.from({ length: count }, (_, b) => a === b));
    for (const [a, b] of links) reach[a - 1][b - 1] = true;
    for (let k = 0; k < count; k += 1) {
      for (let a = 0; a < count; a += 1) {
        for (let b = 0; b < count; b += 1) reach[a][b] ||= reach[a][k] && reach[k][b];
      }
    }
    const representative = reach.map((row, a) => row.findIndex((reachable, b) => reachable && reach[b][a]));
    const ranks = Array(count).fill(0);
    for (let pass = 0; pass < count; pass += 1) {
      for (const [a, b] of links) {
        const from = representative[a - 1];
        const to = representative[b - 1];
        if (from !== to) ranks[to] = Math.max(ranks[to], ranks[from] + 1);
      }
    }
    const graph = build(wf);
    graph.nodes.forEach((entry, a) => {
      assert.equal(entry.column, ranks[representative[a]]);
      graph.nodes.forEach((other, b) => assert.equal(entry.component === other.component, reach[a][b] && reach[b][a]));
    });
    assertLayout(graph);
    wf.nodes.reverse();
    wf.links.reverse();
    assert.deepEqual(build(wf), graph);
  }
});

test("large chain, cycle and wireless fanout remain complete and non-overlapping", (context) => {
  const count = 5000;
  const nodes = Array.from({ length: count }, (_, index) => node(index + 1));
  const edges = nodes.slice(1).map((entry) => [entry.id - 1, entry.id]);
  const started = performance.now();
  const chain = build(workflow(nodes, edges));
  assert.equal(chain.columns, count);
  assertLayout(chain);
  edges.push([count, 1]);
  const cycle = build(workflow(nodes, edges));
  assert.equal(cycle.columns, 1);
  assert.equal(cycle.nodes.length, count);
  assert.equal(cycle.rows, count);
  assertLayout(cycle);
  const wf = ueWorkflow();
  wf.nodes.push(...Array.from({ length: 997 }, (_, index) => node(index + 4)));
  const before = calls.ue;
  const fanout = build(wf);
  assert.equal(calls.ue - before, 1);
  assert.equal(fanout.nodes.length, 1000);
  assert.equal(fanout.edges.length, 1997);
  assertLayout(fanout);
  context.diagnostic(`5000-node chain + 5000-node cycle + 1000-node UE fanout: ${(performance.now() - started).toFixed(1)}ms`);
});
