import stronglyConnectedComponents from "strongly-connected-components";
import type { Workflow, WorkflowLink, WorkflowNode } from "@/api/types";
import { parseLocationPointer } from "@/utils/mobileLayout";
import { getSetGetName, isGetNode, isSetNode } from "@/utils/setGetNodes";
import { canBroadcast, resolveUseEverywhereLinks, ueSlotKey } from "@/utils/useEverywhere";

export interface PhoneMinimapNode {
  key: string;
  id: number;
  column: number;
  row: number;
  /** Stable, zero-based strongly connected component index. */
  component: number;
}

export interface PhoneMinimapEdge {
  key: string;
  source: string;
  target: string;
  wireless: boolean;
}

export interface PhoneMinimapGraph {
  nodes: PhoneMinimapNode[];
  edges: PhoneMinimapEdge[];
  /** Extents: max coordinate + 1, or zero for an empty graph. */
  columns: number;
  rows: number;
  signature: string;
}

interface Topology {
  nodes: Array<Pick<PhoneMinimapNode, "key" | "id">>;
  edges: PhoneMinimapEdge[];
  signature: string;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nodeKey(node: WorkflowNode): string {
  return node.itemKey || `node:${node.id}`;
}

function nodeScope(node: WorkflowNode): string | null {
  const location = node.itemKey ? parseLocationPointer(node.itemKey) : null;
  return location?.subgraphId ?? null;
}

function collectTopology(workflow: Workflow): Topology {
  const byKey = new Map<string, WorkflowNode>();
  const byId = new Map<number, WorkflowNode | null>();
  for (const node of workflow.nodes ?? []) {
    if (!node || !Number.isSafeInteger(node.id) || byKey.has(nodeKey(node))) continue;
    byKey.set(nodeKey(node), node);
    // Tuple links cannot disambiguate duplicate numeric IDs from different scopes.
    byId.set(node.id, byId.has(node.id) ? null : node);
  }
  const allNodes = [...byKey.values()];
  const scopes = new Map(allNodes.map((node) => [nodeKey(node), nodeScope(node)]));
  const byLinkId = new Map<number, WorkflowLink>();
  for (const link of workflow.links ?? []) {
    if (!Array.isArray(link) || link.length < 6 || byLinkId.has(link[0])) continue;
    if (!link.slice(0, 5).every(Number.isSafeInteger) || typeof link[5] !== "string") continue;
    const source = byId.get(link[1]);
    const target = byId.get(link[3]);
    if (!source || !target || link[2] < 0 || link[4] < 0) continue;
    if (!source.outputs?.[link[2]] || !target.inputs?.[link[4]]) continue;
    if (scopes.get(nodeKey(source)) !== scopes.get(nodeKey(target))) continue;
    byLinkId.set(link[0], link);
  }
  const links = [...byLinkId.values()].sort((a, b) => a[0] - b[0]);
  const byEdgeKey = new Map<string, PhoneMinimapEdge>();
  const addEdge = (source: WorkflowNode, target: WorkflowNode, wireless: boolean) => {
    const sourceKey = nodeKey(source);
    const targetKey = nodeKey(target);
    if (scopes.get(sourceKey) !== scopes.get(targetKey)) return;
    const key = JSON.stringify([sourceKey, targetKey, wireless]);
    byEdgeKey.set(key, { key, source: sourceKey, target: targetKey, wireless });
  };
  for (const link of links) addEdge(byId.get(link[1])!, byId.get(link[3])!, false);

  const scopeNodes = new Map<string | null, WorkflowNode[]>();
  for (const node of allNodes) {
    const scope = scopes.get(nodeKey(node))!;
    const entries = scopeNodes.get(scope) ?? [];
    entries.push(node);
    scopeNodes.set(scope, entries);
  }
  for (const [scope, nodes] of scopeNodes) {
    // First matching Set in document order is the existing Get resolver contract.
    const setters = new Map<string, WorkflowNode>();
    for (const node of nodes) {
      const name = isSetNode(node) ? getSetGetName(node) : null;
      if (name && !setters.has(name)) setters.set(name, node);
    }
    for (const node of nodes) {
      const name = isGetNode(node) ? getSetGetName(node) : null;
      const source = name ? setters.get(name) : undefined;
      if (source) addEdge(source, node, true);
    }
    if (!nodes.some(canBroadcast)) continue;

    const scopedLinks = links.filter((link) => scopes.get(nodeKey(byId.get(link[1])!)) === scope);
    const incoming = new Map<string, number>();
    for (const link of scopedLinks) {
      const slot = ueSlotKey(link[3], link[4]);
      if (!incoming.has(slot)) incoming.set(slot, link[0]);
    }
    // Rebuild input mirrors on private copies: only the validated table is authoritative.
    // UE mode/colour/group restrictions retain their existing routing semantics.
    const scoped: Workflow = {
      ...workflow,
      nodes: nodes.filter((node) => byId.get(node.id) === node).map((node) => ({
        ...node,
        inputs: (node.inputs ?? []).map((input, index) => input && ({
          ...input,
          link: incoming.get(ueSlotKey(node.id, index)) ?? null,
        })),
      })),
      links: scopedLinks,
    };
    const wirelessLinks = resolveUseEverywhereLinks(scoped);
    for (const target of scoped.nodes) {
      (target.inputs ?? []).forEach((input, index) => {
        if (!input || input.link != null) return;
        const broadcast = wirelessLinks.get(ueSlotKey(target.id, index));
        if (!broadcast) return;
        const source = byId.get(broadcast.originId);
        const controller = byId.get(broadcast.controllerId);
        if (!source?.outputs?.[broadcast.originSlot] || !controller) return;
        addEdge(source, target, true);
        addEdge(controller, target, true);
      });
    }
  }

  const nodes = allNodes.map((node) => ({ key: nodeKey(node), id: node.id }))
    .sort((a, b) => a.id - b.id || compareText(a.key, b.key));
  const edges = [...byEdgeKey.values()].sort((a, b) => compareText(a.key, b.key));
  // An exact signature avoids hash collisions and excludes every non-topological field.
  const signature = JSON.stringify([nodes.map((node) => [node.key, node.id]), edges.map((edge) => edge.key)]);
  return { nodes, edges, signature };
}

/** Extract topology only, without SCC analysis or row ordering. */
export function buildPhoneMinimapTopologySignature(workflow: Workflow): string {
  return collectTopology(workflow).signature;
}

function layoutTopology(topology: Topology): PhoneMinimapGraph {
  const { nodes, edges, signature } = topology;
  if (nodes.length === 0) return { nodes: [], edges, columns: 0, rows: 0, signature };

  const indexByKey = new Map(nodes.map((node, index) => [node.key, index]));
  const adjacency = nodes.map(() => new Set<number>());
  for (const edge of edges) {
    adjacency[indexByKey.get(edge.source)!].add(indexByKey.get(edge.target)!);
  }
  const components = stronglyConnectedComponents(adjacency.map((neighbors) => [...neighbors])).components
    .map((members) => members.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  const componentOf = new Array<number>(nodes.length);
  components.forEach((members, component) => {
    for (const index of members) componentOf[index] = component;
  });
  const dag = components.map(() => new Set<number>());
  const undirected = components.map(() => new Set<number>());
  const indegrees = components.map(() => 0);
  adjacency.forEach((neighbors, index) => {
    const source = componentOf[index];
    for (const neighbor of neighbors) {
      const target = componentOf[neighbor];
      if (source === target || dag[source].has(target)) continue;
      dag[source].add(target);
      undirected[source].add(target);
      undirected[target].add(source);
      indegrees[target] += 1;
    }
  });

  // Explicit Kahn traversal of the condensed DAG: component discovery order is
  // irrelevant, and no recursive walk can exhaust the stack on deep workflows.
  const componentColumns = components.map(() => 0);
  const ready = components.map((_members, index) => index).filter((index) => indegrees[index] === 0);
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const source = ready[cursor];
    for (const target of dag[source]) {
      componentColumns[target] = Math.max(componentColumns[target], componentColumns[source] + 1);
      indegrees[target] -= 1;
      if (indegrees[target] === 0) ready.push(target);
    }
  }
  const result = nodes.map((node, index): PhoneMinimapNode => ({
    ...node, component: componentOf[index], column: componentColumns[componentOf[index]], row: 0,
  }));
  const upstream = result.map(() => new Set<number>());
  const downstream = result.map(() => new Set<number>());
  adjacency.forEach((neighbors, source) => {
    for (const target of neighbors) {
      if (result[source].column === result[target].column) continue;
      upstream[target].add(source);
      downstream[source].add(target);
    }
  });

  // Keep zero-degree singletons last so UI can pack them separately without
  // leaving gaps or shifting connected branches when isolated nodes change.
  const isIsolated = (branch: number[]): boolean => {
    if (branch.length !== 1 || components[branch[0]].length !== 1) return false;
    const index = components[branch[0]][0];
    return adjacency[index].size === 0 && upstream[index].size === 0;
  };
  // SCCs of the symmetric DAG are its weakly connected branch bands.
  const branches = stronglyConnectedComponents(undirected.map((neighbors) => [...neighbors])).components
    .map((members) => members.sort((a, b) => a - b))
    .sort((a, b) => Number(isIsolated(a)) - Number(isIsolated(b)) || a[0] - b[0]);
  let rowOffset = 0;
  for (const branch of branches) {
    const layers = new Map<number, number[]>();
    for (const component of branch) {
      for (const index of components[component]) {
        const column = result[index].column;
        const layer = layers.get(column) ?? [];
        layer.push(index);
        layers.set(column, layer);
      }
    }
    const orderedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
    const height = orderedLayers.reduce((max, layer) => Math.max(max, layer.length), 0);
    const position = (layer: number[]) => {
      layer.forEach((index, row) => { result[index].row = rowOffset + (height - layer.length) / 2 + row; });
    };
    for (const layer of orderedLayers) {
      layer.sort((a, b) => a - b);
      position(layer);
    }
    const sweep = (layer: number[], neighbors: Set<number>[]) => {
      const centers = new Map(layer.map((index) => {
        const adjacent = neighbors[index];
        let total = 0;
        for (const neighbor of adjacent) total += result[neighbor].row;
        return [index, adjacent.size ? total / adjacent.size : result[index].row];
      }));
      layer.sort((a, b) => centers.get(a)! - centers.get(b)! || result[a].row - result[b].row || a - b);
      position(layer);
    };
    // Keep source order fixed. A bounded barycenter sweep reduces crossings without
    // moving short branches to the right or letting neighboring nodes overlap.
    for (let pass = 0; pass < 3; pass += 1) {
      for (let column = 1; column < orderedLayers.length; column += 1) sweep(orderedLayers[column], upstream);
      for (let column = orderedLayers.length - 2; column > 0; column -= 1) sweep(orderedLayers[column], downstream);
    }
    rowOffset += height + 1;
  }
  return {
    nodes: result, edges, signature,
    columns: result.reduce((max, node) => Math.max(max, node.column + 1), 0),
    rows: result.reduce((max, node) => Math.max(max, node.row + 1), 0),
  };
}

/** Read one root/current scope only. Hidden and collapsed nodes remain in the graph. */
export function buildPhoneMinimapGraph(workflow: Workflow): PhoneMinimapGraph {
  return layoutTopology(collectTopology(workflow));
}

/**
 * One bounded cache per view. Parameters/styles reuse the exact result object;
 * actual wireless routing changes invalidate it just like physical link changes.
 * Treat returned graphs as read-only. Each call resolves UE at most once per scope.
 */
export function createPhoneMinimapLayout(): (workflow: Workflow) => PhoneMinimapGraph {
  let previous: PhoneMinimapGraph | undefined;
  return (workflow) => {
    const topology = collectTopology(workflow);
    if (previous?.signature !== topology.signature) previous = layoutTopology(topology);
    return previous;
  };
}
