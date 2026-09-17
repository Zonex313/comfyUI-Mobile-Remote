import type { Workflow, WorkflowLink, WorkflowNode } from "@/api/types";
import { resolveRerouteConnectionLabel } from "@/utils/rerouteLabels";
import { resolveSetGetConnectionLabel } from "@/utils/setGetLabels";
import {
  getSetGetName,
  isGetNode,
  isSetGetNode,
  isSetNode,
} from "@/utils/setGetNodes";
import { resolveSubgraphPlaceholderConnectionLabel } from "@/utils/subgraphPlaceholderLabels";
import {
  isUseEverywhereNode,
  listUeReceivers,
  resolveUseEverywhereLinks,
  ueSlotKey,
} from "@/utils/useEverywhere";
import { resolveUseEverywhereConnectionLabel } from "@/utils/useEverywhereLabels";

export interface PhoneRelation {
  node: WorkflowNode;
  connections: Array<{
    slotIndex: number;
    /** The opposite-direction button to flash; null when no reciprocal slot exists. */
    targetSlotIndex: number | null;
    label: string;
    targetLabel: string;
    type: string;
    wireless: boolean;
  }>;
  hidden?: boolean;
}

type Direction = "input" | "output";

/** Read one already-scoped graph. Hidden neighbors remain explicit; no graph is rewritten. */
export function collectPhoneRelations(
  workflow: Workflow,
  node: WorkflowNode,
  hiddenItems: Record<string, boolean>,
  order: WorkflowNode[] = workflow.nodes,
): { input: PhoneRelation[]; output: PhoneRelation[] } {
  const nodes = new Map(workflow.nodes.map((entry) => [entry.id, entry]));
  const own = nodes.get(node.id);
  if (!own || (node.itemKey && own.itemKey !== node.itemKey)) {
    return { input: [], output: [] };
  }

  // Validate both endpoints before label/broadcast resolvers inspect a stale link.
  // Sentinels and inner definitions are deliberately not destinations in this view.
  const links = new Map<number, WorkflowLink>();
  for (const link of workflow.links ?? []) {
    if (!Array.isArray(link) || link.length < 6 || links.has(link[0])) continue;
    if (!link.slice(0, 5).every((value) => Number.isInteger(value))) continue;
    const source = nodes.get(link[1]);
    const target = nodes.get(link[3]);
    if (link[2] < 0 || link[4] < 0) continue;
    if (!source?.outputs?.[link[2]] || !target?.inputs?.[link[4]]) continue;
    links.set(link[0], link);
  }
  const scoped: Workflow = { ...workflow, links: [...links.values()] };
  const ueLinks = resolveUseEverywhereLinks(scoped);
  const relations: Record<Direction, Map<number, PhoneRelation>> = {
    input: new Map(),
    output: new Map(),
  };

  const labelCache = new Map<string, string>();
  const slotLabel = (
    target: WorkflowNode,
    direction: Direction,
    index: number | null,
  ): string => {
    const key = `${target.id}:${direction}:${index}`;
    if (labelCache.has(key)) return labelCache.get(key)!;
    const slot =
      index == null
        ? undefined
        : direction === "input"
          ? target.inputs?.[index]
          : (target.outputs?.[index] ??
            (isUseEverywhereNode(target) ? target.inputs?.[index] : undefined));
    const fallback =
      slot?.localized_name || slot?.name || getSetGetName(target) || "*";
    const label = resolveSubgraphPlaceholderConnectionLabel(
      scoped,
      target.id,
      direction,
      index ?? 0,
      fallback,
    );
    const broadcastLabel = resolveUseEverywhereConnectionLabel(
      scoped,
      target.id,
      index ?? 0,
      label,
    );
    const resolved = isSetGetNode(target)
      ? resolveSetGetConnectionLabel(scoped, target.id, direction, label)
      : broadcastLabel !== label
        ? broadcastLabel
        : resolveRerouteConnectionLabel(scoped, target.id, direction, label);
    labelCache.set(key, resolved);
    return resolved;
  };

  const add = (
    direction: Direction,
    slotIndex: number,
    targetId: number,
    targetSlotIndex: number | null,
    type: string,
    wireless = false,
  ) => {
    const target = nodes.get(targetId);
    if (!target || target.id === own.id) return;
    let relation = relations[direction].get(targetId);
    if (!relation) {
      relation = {
        node: target,
        connections: [],
        hidden: Boolean(target.itemKey && hiddenItems[target.itemKey]),
      };
      relations[direction].set(targetId, relation);
    }
    if (
      relation.connections.some(
        (connection) =>
          connection.slotIndex === slotIndex &&
          connection.targetSlotIndex === targetSlotIndex &&
          connection.wireless === wireless,
      )
    )
      return;
    relation.connections.push({
      slotIndex,
      targetSlotIndex,
      label: slotLabel(own, direction, slotIndex),
      targetLabel: slotLabel(
        target,
        direction === "input" ? "output" : "input",
        targetSlotIndex,
      ),
      type: String(type || "*"),
      wireless,
    });
  };

  (own.inputs ?? []).forEach((input, slotIndex) => {
    if (input.link != null) {
      const link = links.get(input.link);
      if (link && link[3] === own.id && link[4] === slotIndex) {
        add("input", slotIndex, link[1], link[2], link[5] || input.type);
      }
      return;
    }
    const broadcast = ueLinks.get(ueSlotKey(own.id, slotIndex));
    if (
      broadcast &&
      nodes.get(broadcast.originId)?.outputs?.[broadcast.originSlot]
    ) {
      add(
        "input",
        slotIndex,
        broadcast.originId,
        broadcast.originSlot,
        broadcast.type,
        true,
      );
    }
  });

  (own.outputs ?? []).forEach((output, slotIndex) => {
    for (const linkId of output.links ?? []) {
      const link = links.get(linkId);
      if (link && link[1] === own.id && link[2] === slotIndex) {
        add("output", slotIndex, link[3], link[4], link[5] || output.type);
      }
    }
  });

  const relayName = getSetGetName(own);
  if (isGetNode(own) && relayName) {
    const source = workflow.nodes.find(
      (entry) => isSetNode(entry) && getSetGetName(entry) === relayName,
    );
    if (source) {
      add(
        "input",
        0,
        source.id,
        source.outputs?.length ? 0 : null,
        own.outputs?.[0]?.type || "*",
        true,
      );
    }
  }
  if (isSetNode(own) && relayName) {
    (own.outputs ?? []).forEach((output, slotIndex) => {
      for (const target of workflow.nodes) {
        if (isGetNode(target) && getSetGetName(target) === relayName) {
          // GetNode's incoming button is synthetic and uses index zero.
          add("output", slotIndex, target.id, 0, output.type, true);
        }
      }
    });
  }

  if (isUseEverywhereNode(own)) {
    (own.inputs ?? []).forEach((input, slotIndex) => {
      if (input.link == null) return;
      for (const receiver of listUeReceivers(ueLinks, own.id, slotIndex)) {
        const broadcast = ueLinks.get(
          ueSlotKey(receiver.nodeId, receiver.slotIndex),
        );
        if (broadcast)
          add(
            "output",
            slotIndex,
            receiver.nodeId,
            receiver.slotIndex,
            broadcast.type,
            true,
          );
      }
    });
  }

  const rank = new Map<number, number>();
  for (const entry of [...order, ...workflow.nodes]) {
    if (!rank.has(entry.id)) rank.set(entry.id, rank.size);
  }
  const sorted = (direction: Direction): PhoneRelation[] => {
    const result = [...relations[direction].values()];
    for (const relation of result) {
      relation.connections.sort(
        (a, b) =>
          a.slotIndex - b.slotIndex ||
          (a.targetSlotIndex ?? Number.MAX_SAFE_INTEGER) -
            (b.targetSlotIndex ?? Number.MAX_SAFE_INTEGER),
      );
    }
    return result.sort(
      (a, b) =>
        a.connections[0].slotIndex - b.connections[0].slotIndex ||
        rank.get(a.node.id)! - rank.get(b.node.id)!,
    );
  };
  return { input: sorted("input"), output: sorted("output") };
}
