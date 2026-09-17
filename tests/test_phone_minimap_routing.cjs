"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("../mobile/panel/node_modules/esbuild");
const filename = path.resolve(__dirname, "../mobile/panel/src/utils/phoneMinimapRouting.ts");
const result = esbuild.buildSync({
  entryPoints: [filename], bundle: true, write: false, platform: "node", format: "cjs",
});
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(result.outputFiles[0].text, filename);
const { routePhoneMinimapEdges: route } = loaded.exports;
const options = { nodeWidth: 24, nodeHeight: 12, columnStep: 56, rowStep: 28 };

function node(column, row) {
  return { key: `${column}:${row}`, column, x: column * 56, y: row * 28 };
}
function edge(source, target, key, wireless = false) {
  return { key, source: source.key, target: target.key, wireless };
}
function dense(columns, rows, stagger = false) {
  return Array.from({ length: columns }, (_, column) =>
    Array.from({ length: rows }, (_, row) => node(column, row + (stagger && column % 2 ? 0.5 : 0))));
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function segments(points) {
  return points.slice(1).map((point, index) => [points[index], point]);
}
function assertGeometry(nodes, edges, routed) {
  assert.deepEqual(routed.edges.map((item) => item.key).sort(), edges.map((item) => item.key).sort());
  const top = Math.min(...nodes.map((item) => item.y)) - 8;
  const bottom = Math.max(...nodes.map((item) => item.y + 12)) + 8;
  assert.equal(routed.bounds.top, top);
  assert.equal(routed.bounds.bottom, bottom);
  for (const item of routed.edges) {
    assert.ok(item.points.length >= 2, item.key);
    assert.ok(!/NaN|Infinity/.test(item.d), item.key);
    assert.equal(item.wireless, edges.find((original) => original.key === item.key).wireless);
    for (const point of item.points) {
      assert.ok(point.y >= top && point.y <= bottom, `${item.key} exceeded row tracks`);
      assert.ok(point.x >= routed.bounds.left && point.x <= routed.bounds.right);
    }
    for (const [a, b] of segments(item.points)) {
      assert.ok(a.x === b.x || a.y === b.y, `${item.key} has a diagonal`);
      for (const block of nodes) {
        const horizontalHit = a.y === b.y && a.y > block.y && a.y < block.y + 12 &&
          Math.min(Math.max(a.x, b.x), block.x + 24) > Math.max(Math.min(a.x, b.x), block.x);
        const verticalHit = a.x === b.x && a.x > block.x && a.x < block.x + 24 &&
          Math.min(Math.max(a.y, b.y), block.y + 12) > Math.max(Math.min(a.y, b.y), block.y);
        assert.ok(!horizontalHit && !verticalHit, `${item.key} crossed ${block.key}: ${JSON.stringify([a, b])}`);
      }
    }
  }
}

test("dense long edges occupy upper middle and lower internal channels without crossing blocks", () => {
  const columns = dense(8, 10);
  const nodes = columns.flat();
  const edges = [];
  for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) {
    edges.push(edge(columns[0][a], columns[7][b], `forward-${a}-${b}`, (a + b) % 3 === 0));
  }
  for (let i = 0; i < 10; i++) edges.push(edge(columns[7][i], columns[0][9 - i], `back-${i}`));
  const result = route(freeze(nodes), freeze(edges), options);
  assertGeometry(nodes, edges, result);
  const ys = result.edges.flatMap((item) => segments(item.points)
    .filter(([a, b]) => a.y === b.y && Math.abs(a.x - b.x) > 24).map(([a]) => a.y));
  const nodeBottom = 9 * 28 + 12;
  const bands = new Set(ys.filter((y) => y >= 0 && y <= nodeBottom)
    .map((y) => Math.min(2, Math.floor(y / nodeBottom * 3))));
  assert.deepEqual([...bands].sort(), [0, 1, 2]);
  assert.ok(new Set(ys).size >= 10, "horizontal tracks should not share just a few heights");
  assert.ok(ys.filter((y) => y >= 0 && y <= nodeBottom).length > ys.length * 0.8);
});

test("staggered dense columns switch rows in gutters instead of escaping above the graph", () => {
  const columns = dense(7, 9, true);
  const nodes = columns.flat();
  const edges = Array.from({ length: 18 }, (_, i) =>
    edge(columns[i % 2 ? 6 : 0][i % 9], columns[i % 2 ? 0 : 6][8 - i % 9], `stagger-${i}`));
  const result = route(nodes, edges, options);
  assertGeometry(nodes, edges, result);
  const changingRows = result.edges.filter((item) => new Set(segments(item.points)
    .filter(([a, b]) => a.y === b.y && Math.abs(a.x - b.x) > 24).map(([a]) => a.y)).size > 1);
  assert.ok(changingRows.length >= 12, "staggered barriers require internal gutter turns");
});

test("self loops same-column cycles adjacent links and wireless parallels remain complete", () => {
  const columns = dense(3, 4);
  const nodes = columns.flat();
  const edges = [
    edge(columns[0][0], columns[0][0], "self-top"),
    edge(columns[0][0], columns[0][0], "self-bottom", true),
    edge(columns[2][3], columns[2][3], "last-self"),
    edge(columns[1][0], columns[1][3], "cycle-down"),
    edge(columns[1][3], columns[1][0], "cycle-up"),
    edge(columns[0][0], columns[1][3], "adjacent"),
    edge(columns[1][3], columns[0][0], "adjacent-back"),
    edge(columns[0][2], columns[2][2], "physical"),
    edge(columns[0][2], columns[2][2], "wireless", true),
  ];
  const result = route(nodes, edges, options);
  assertGeometry(nodes, edges, result);
  assert.notEqual(result.edges.find((item) => item.key === "self-top").d,
    result.edges.find((item) => item.key === "self-bottom").d);
  assert.notEqual(result.edges.find((item) => item.key === "physical").d,
    result.edges.find((item) => item.key === "wireless").d);
});

test("routes are stable across input ordering and ignore display-only state", () => {
  const columns = dense(5, 7, true);
  const nodes = columns.flat();
  const edges = Array.from({ length: 25 }, (_, i) =>
    edge(columns[0][i % 7], columns[4][(i * 3) % 7], `stable-${i}`, i % 2 === 0));
  const first = route(freeze(nodes), freeze(edges), options);
  const second = route([...nodes].reverse().map((item) => ({ ...item, focus: true, mode: 4, color: "red" })),
    [...edges].reverse(), options);
  assert.deepEqual(first, second);
});

test("sparse and disconnected column spans keep all edge segments in the bounded tracks", () => {
  const nodes = [node(0, 0), node(2, 2), node(5, 0.5), node(5, 5), node(9, 3)];
  const edges = [edge(nodes[0], nodes[4], "far"), edge(nodes[4], nodes[0], "back"),
    edge(nodes[1], nodes[3], "branch"), edge(nodes[2], nodes[3], "same")];
  assertGeometry(nodes, edges, route(nodes, edges, options));
  assert.deepEqual(route([], [], options), { edges: [], bounds: { left: 0, top: 0, right: 0, bottom: 0 } });
});

test("mixed dense graph preserves every edge without any rectangle intersections", () => {
  const columns = dense(12, 12, true);
  const nodes = columns.flat();
  let seed = 731;
  const next = (max) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  const edges = Array.from({ length: 180 }, (_, i) => edge(nodes[next(nodes.length)], nodes[next(nodes.length)], `mixed-${i}`, i % 4 === 0));
  const result = route(nodes, edges, options);
  assertGeometry(nodes, edges, result);
});
