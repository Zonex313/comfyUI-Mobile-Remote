import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Workflow,
  WorkflowInput,
  WorkflowLink,
  WorkflowNode,
  WorkflowOutput,
} from "@/api/types";
import { collectPhoneRelations } from "../phoneConnectionRelations";

const input = (name: string, type = "MODEL"): WorkflowInput => ({
  name,
  type,
  link: null,
});
const output = (name: string, type = "MODEL"): WorkflowOutput => ({
  name,
  type,
  links: [],
});
const node = (
  id: number,
  overrides: Partial<WorkflowNode> = {},
): WorkflowNode => ({
  id,
  itemKey: `root/node:${id}`,
  type: "TestNode",
  pos: [0, 0],
  size: [100, 100],
  flags: {},
  order: id,
  mode: 0,
  inputs: [],
  outputs: [],
  properties: {},
  ...overrides,
});
const graph = (...nodes: WorkflowNode[]): Workflow => ({
  nodes,
  links: [],
  groups: [],
  last_node_id: 99,
  last_link_id: 99,
  config: {},
  version: 1,
});
function connect(
  wf: Workflow,
  id: number,
  source: WorkflowNode,
  sourceSlot: number,
  target: WorkflowNode,
  targetSlot: number,
  type = "MODEL",
) {
  wf.links.push([id, source.id, sourceSlot, target.id, targetSlot, type]);
  source.outputs[sourceSlot].links!.push(id);
  target.inputs[targetSlot].link = id;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("collectPhoneRelations", () => {
  it("collects both directions, preserves link zero and exposes reciprocal slots and labels", () => {
    const source = node(1, { outputs: [output("model")] });
    source.outputs[0].localized_name = "Loaded model";
    const focus = node(2, {
      inputs: [input("model")],
      outputs: [output("latent", "LATENT")],
    });
    const target = node(3, { inputs: [input("samples", "LATENT")] });
    const wf = graph(source, focus, target);
    connect(wf, 0, source, 0, focus, 0);
    connect(wf, 1, focus, 0, target, 0, "LATENT");
    const result = collectPhoneRelations(wf, focus, {});
    assert.equal(result.input[0].node, source);
    assert.deepEqual(result.input[0].connections, [
      {
        slotIndex: 0,
        targetSlotIndex: 0,
        label: "model",
        targetLabel: "Loaded model",
        type: "MODEL",
        wireless: false,
      },
    ]);
    assert.equal(result.output[0].node, target);
    assert.equal(result.output[0].connections[0].targetLabel, "samples");
    assert.equal(result.output[0].connections[0].type, "LATENT");
    assert.equal(result.output[0].hidden, false);
  });

  it("aggregates one remote while retaining distinct ports and deduplicating repeated links", () => {
    const source = node(1, {
      outputs: [output("model"), output("clip", "CLIP")],
    });
    const target = node(2, {
      inputs: [input("model"), input("model_again"), input("clip", "CLIP")],
    });
    const wf = graph(source, target);
    connect(wf, 10, source, 0, target, 0);
    connect(wf, 11, source, 0, target, 1);
    connect(wf, 12, source, 1, target, 2, "CLIP");
    source.outputs[0].links!.push(10, 13);
    wf.links.push(wf.links[0], [13, source.id, 0, target.id, 0, "MODEL"]);
    const outgoing = collectPhoneRelations(wf, source, {}).output;
    assert.equal(outgoing.length, 1);
    assert.deepEqual(
      outgoing[0].connections.map((c) => [c.slotIndex, c.targetSlotIndex]),
      [
        [0, 0],
        [0, 1],
        [1, 2],
      ],
    );
    const incoming = collectPhoneRelations(wf, target, {}).input;
    assert.equal(incoming.length, 1);
    assert.deepEqual(
      incoming[0].connections.map((c) => [c.slotIndex, c.targetSlotIndex]),
      [
        [0, 0],
        [1, 0],
        [2, 1],
      ],
    );
  });

  it("orders by the earliest local port, then supplied node order, without dropping omitted nodes", () => {
    const source = node(1, { outputs: [output("first"), output("second")] });
    const a = node(2, { inputs: [input("a")] });
    const b = node(3, { inputs: [input("b")] });
    const c = node(4, { inputs: [input("c")] });
    const wf = graph(source, a, b, c);
    connect(wf, 1, source, 0, a, 0);
    connect(wf, 2, source, 0, b, 0);
    connect(wf, 3, source, 1, c, 0);
    assert.deepEqual(
      collectPhoneRelations(wf, source, {}, [c, b, a]).output.map(
        (r) => r.node.id,
      ),
      [3, 2, 4],
    );
    assert.deepEqual(
      collectPhoneRelations(wf, source, {}, [b]).output.map((r) => r.node.id),
      [3, 2, 4],
    );
    assert.deepEqual(
      collectPhoneRelations(wf, source, {}).output.map((r) => r.node.id),
      [2, 3, 4],
    );
  });

  it("ignores missing links, missing endpoints, invalid ports, malformed tuples and wrong directions", () => {
    const focus = node(1, { inputs: [input("in")], outputs: [output("out")] });
    const other = node(2, { inputs: [input("in")], outputs: [output("out")] });
    focus.inputs[0].link = 5;
    focus.outputs[0].links = [1, 2, 3, 4, 6, 999];
    const wf = graph(focus, other);
    wf.links = [
      [1, 1, 9, 2, 0, "MODEL"],
      [2, 1, 0, 99, 0, "MODEL"],
      [3, 1, 0, 2, 9, "MODEL"],
      [4, 2, 0, 1, 0, "MODEL"],
      [5, 2, 0, 2, 0, "MODEL"],
      [6, 1, -1, 2, 0, "MODEL"],
      null,
      ["bad", 1, 0, 2, 0, "MODEL"],
      [7],
    ] as unknown as WorkflowLink[];
    assert.deepEqual(collectPhoneRelations(wf, focus, {}), {
      input: [],
      output: [],
    });
  });

  it("does not return the focus itself for a self-loop", () => {
    const focus = node(1, { inputs: [input("in")], outputs: [output("out")] });
    const wf = graph(focus);
    connect(wf, 1, focus, 0, focus, 0);
    assert.deepEqual(collectPhoneRelations(wf, focus, {}), {
      input: [],
      output: [],
    });
  });

  it("keeps hidden direct neighbors explicit instead of guessing through a chain or cycle", () => {
    const focus = node(1, {
      inputs: [input("return")],
      outputs: [output("out")],
    });
    const hidden = node(2, { inputs: [input("in")], outputs: [output("out")] });
    const beyond = node(3, { inputs: [input("in")] });
    const wf = graph(focus, hidden, beyond);
    connect(wf, 1, focus, 0, hidden, 0);
    connect(wf, 2, hidden, 0, beyond, 0);
    connect(wf, 3, hidden, 0, focus, 0);
    const result = collectPhoneRelations(wf, focus, {
      [hidden.itemKey!]: true,
    });
    assert.deepEqual(
      result.output.map((r) => r.node.id),
      [2],
    );
    assert.equal(result.output[0].hidden, true);
    assert.equal(result.input[0].node, hidden);
    assert.equal(result.input[0].hidden, true);
    assert.equal(result.output[0].connections[0].targetSlotIndex, 0);
  });

  it("keeps bypassed nodes and their original direct wiring visible", () => {
    const source = node(1, { mode: 4, outputs: [output("out")] });
    const focus = node(2, { inputs: [input("in")] });
    const wf = graph(source, focus);
    connect(wf, 1, source, 0, focus, 0);
    const relation = collectPhoneRelations(wf, focus, {}).input[0];
    assert.equal(relation.node, source);
    assert.equal(relation.node.mode, 4);
    assert.equal(relation.hidden, false);
  });

  it("stays in the provided scope and resolves placeholder labels without entering definitions", () => {
    const source = node(1, { outputs: [output("model")] });
    const placeholder = node(2, {
      type: "sg",
      inputs: [input("cached_model")],
    });
    const inner = node(7, {
      itemKey: "root/subgraph:sg/node:7",
      inputs: [input("in")],
    });
    const wf = graph(source, placeholder);
    wf.definitions = {
      subgraphs: [
        {
          id: "sg",
          nodes: [inner],
          links: [],
          inputs: [{ name: "model", label: "Boundary model", type: "MODEL" }],
        },
      ],
    };
    connect(wf, 1, source, 0, placeholder, 0);
    wf.links.push([2, 1, 0, 7, 0, "MODEL"], [3, 1, 0, -20, 0, "MODEL"]);
    source.outputs[0].links!.push(2, 3);
    const result = collectPhoneRelations(wf, source, {}).output;
    assert.deepEqual(
      result.map((r) => r.node.id),
      [2],
    );
    assert.equal(result[0].connections[0].targetLabel, "Boundary model");
    assert.deepEqual(collectPhoneRelations(wf, inner, {}), {
      input: [],
      output: [],
    });
    assert.deepEqual(
      collectPhoneRelations(
        wf,
        { ...source, itemKey: "root/subgraph:sg/node:1" },
        {},
      ),
      { input: [], output: [] },
    );
  });

  it("matches Set/Get by relay name, including synthetic reciprocal input buttons", () => {
    const set = node(1, {
      type: "SetNode",
      widgets_values: ["shared"],
      outputs: [output("value")],
    });
    const getA = node(2, {
      type: "GetNode",
      widgets_values: ["shared"],
      outputs: [output("value")],
    });
    const getB = node(3, {
      type: "GetNode",
      widgets_values: { name: "shared" },
      outputs: [output("value")],
    });
    const other = node(4, {
      type: "GetNode",
      widgets_values: ["other"],
      outputs: [output("value")],
    });
    const duplicateSet = node(5, {
      type: "SetNode",
      widgets_values: ["shared"],
      outputs: [output("value")],
    });
    const wf = graph(set, getA, getB, other, duplicateSet);
    const outgoing = collectPhoneRelations(wf, set, {}, [getB, getA]).output;
    assert.deepEqual(
      outgoing.map((r) => r.node.id),
      [3, 2],
    );
    assert.deepEqual(outgoing[0].connections, [
      {
        slotIndex: 0,
        targetSlotIndex: 0,
        label: "shared",
        targetLabel: "shared",
        type: "MODEL",
        wireless: true,
      },
    ]);
    const incoming = collectPhoneRelations(wf, getA, {}, [
      duplicateSet,
      set,
    ]).input;
    assert.equal(incoming[0].node, set);
    assert.equal(incoming[0].connections[0].targetSlotIndex, 0);
  });

  it("uses no reciprocal index when a wireless Set source has no output button", () => {
    const set = node(1, { type: "SetNode", widgets_values: ["shared"] });
    const get = node(2, {
      type: "GetNode",
      widgets_values: ["shared"],
      outputs: [output("value")],
    });
    const result = collectPhoneRelations(graph(set, get), get, {}).input[0];
    assert.equal(result.node, set);
    assert.equal(result.connections[0].targetSlotIndex, null);
  });

  it("resolves UE consumers to the real source and controller outputs to every receiving slot", () => {
    const source = node(1, { outputs: [output("model")] });
    const controller = node(2, {
      type: "Anything Everywhere",
      inputs: [input("anything", "*")],
    });
    const consumer = node(3, {
      mode: 4,
      inputs: [input("model"), input("second_model")],
    });
    const wf = graph(source, controller, consumer);
    connect(wf, 1, source, 0, controller, 0);
    const incoming = collectPhoneRelations(wf, consumer, {}).input;
    assert.equal(incoming[0].node, source);
    assert.deepEqual(
      incoming[0].connections.map((c) => [
        c.slotIndex,
        c.targetSlotIndex,
        c.wireless,
      ]),
      [
        [0, 0, true],
        [1, 0, true],
      ],
    );
    const broadcast = collectPhoneRelations(wf, controller, {}).output;
    assert.equal(broadcast[0].node, consumer);
    assert.deepEqual(
      broadcast[0].connections.map((c) => [c.slotIndex, c.targetSlotIndex]),
      [
        [0, 0],
        [0, 1],
      ],
    );
    assert.equal(broadcast[0].connections[0].label, "MODEL");
    assert.equal(broadcast[0].connections[0].type, "MODEL");
    assert.deepEqual(
      collectPhoneRelations(wf, source, {}).output.map((r) => r.node.id),
      [2],
    );
  });

  it("does not invent broadcasts for bypassed UE controllers or already-wired inputs", () => {
    const source = node(1, { outputs: [output("model")] });
    const controller = node(2, {
      mode: 4,
      type: "Anything Everywhere",
      inputs: [input("anything", "*")],
    });
    const consumer = node(3, { inputs: [input("model")] });
    const wf = graph(source, controller, consumer);
    connect(wf, 1, source, 0, controller, 0);
    assert.deepEqual(collectPhoneRelations(wf, consumer, {}).input, []);
    assert.deepEqual(collectPhoneRelations(wf, controller, {}).output, []);
    controller.mode = 0;
    connect(wf, 2, source, 0, consumer, 0);
    assert.equal(
      collectPhoneRelations(wf, consumer, {}).input[0].connections[0].wireless,
      false,
    );
    assert.deepEqual(collectPhoneRelations(wf, controller, {}).output, []);
  });

  it("resolves a shared fanout label once rather than once per neighbor", () => {
    const source = node(1, { type: "Reroute", outputs: [output("fanout")] });
    let reads = 0;
    Object.defineProperty(source.outputs[0], "name", {
      get: () => {
        reads++;
        return "fanout";
      },
    });
    const targets = Array.from({ length: 1000 }, (_, index) =>
      node(index + 2, { inputs: [input("model")] }),
    );
    const wf = graph(source, ...targets);
    targets.forEach((target, index) =>
      connect(wf, index, source, 0, target, 0),
    );
    assert.equal(collectPhoneRelations(wf, source, {}).output.length, 1000);
    assert.ok(reads <= 3, "local output label should be cached: " + reads);
  });

  it("does not mutate frozen workflows, slot arrays, visibility maps or supplied order", () => {
    const source = node(1, { outputs: [output("model")] });
    const target = node(2, { inputs: [input("model")] });
    const wf = graph(source, target);
    connect(wf, 1, source, 0, target, 0);
    const hidden = freeze({ [target.itemKey!]: true });
    const order = freeze([target, source]);
    const before = JSON.stringify(wf);
    freeze(wf);
    const result = collectPhoneRelations(wf, source, hidden, order);
    assert.equal(result.output[0].node, target);
    assert.equal(JSON.stringify(wf), before);
    assert.deepEqual(
      order.map((n) => n.id),
      [2, 1],
    );
    assert.deepEqual(collectPhoneRelations(graph(node(9)), node(9), {}), {
      input: [],
      output: [],
    });
  });
});
