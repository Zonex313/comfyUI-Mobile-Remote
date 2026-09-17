import { useMemo, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { usePhoneFocusStore } from "@/hooks/usePhoneFocus";
import { useWorkflowStore } from "@/hooks/useWorkflow";
import { useI18n } from "@/i18n";
import { resolveWorkflowColor, themeColors } from "@/theme/colors";
import { computeGroupParentsFor, computeNodeGroupsFor } from "@/utils/nodeGroups";
import {
  createPhoneMinimapLayout,
  type PhoneMinimapGraph,
} from "@/utils/phoneMinimapGraph";
import { routePhoneMinimapEdges } from "@/utils/phoneMinimapRouting";
import "./phoneWorkflowMinimap.css";

const COLLAPSED_STORAGE_KEY = "mtr-phone-workflow-minimap-collapsed";
const NODE_WIDTH = 24;
const NODE_HEIGHT = 12;
const COLUMN_STEP = 56;
const ROW_STEP = 28;
let collapsedFallback = false;

const EMPTY_GRAPH: PhoneMinimapGraph = {
  nodes: [], edges: [], columns: 0, rows: 0, signature: "",
};
type PositionedNode = PhoneMinimapGraph["nodes"][number] & {
  x: number;
  y: number;
  isolated: boolean;
};
type RoutedEdge = PhoneMinimapGraph["edges"][number] & { d: string };

function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    collapsedFallback = stored === "true";
  } catch {
    // Keep the in-memory preference when browser storage is unavailable.
  }
  return collapsedFallback;
}

function positionGraph(graph: PhoneMinimapGraph) {
  const connectedKeys = new Set<string>();
  for (const edge of graph.edges) {
    connectedKeys.add(edge.source);
    connectedKeys.add(edge.target);
  }
  const nodes: PositionedNode[] = graph.nodes.map((node) => ({
    ...node,
    x: node.column * COLUMN_STEP,
    y: node.row * ROW_STEP,
    isolated: !connectedKeys.has(node.key),
  }));
  const mainNodes = nodes.filter((node) => !node.isolated);
  const isolatedNodes = nodes.filter((node) => node.isolated);
  const { edges, bounds } = routePhoneMinimapEdges(mainNodes, graph.edges, {
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    columnStep: COLUMN_STEP,
    rowStep: ROW_STEP,
  });
  let { left, top, right, bottom } = bounds;
  const includePoint = (x: number, y: number) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  };

  if (isolatedNodes.length) {
    const gap = 8;
    const columnStep = NODE_WIDTH + gap;
    const rowStep = NODE_HEIGHT + gap;
    const mainWidth = right - left;
    const compactColumns = Math.ceil(Math.sqrt(isolatedNodes.length * 2 * rowStep / columnStep));
    const columns = Math.min(isolatedNodes.length, Math.max(compactColumns,
      mainNodes.length ? Math.floor((mainWidth + gap) / columnStep) : 0));
    const gridWidth = columns * columnStep - gap;
    const gridLeft = mainNodes.length ? left + (mainWidth - gridWidth) / 2 : 0;
    const gridTop = mainNodes.length ? bottom + 24 : 0;
    // Pack only private drawing coordinates, preserving topology rows and columns.
    isolatedNodes.forEach((node, index) => {
      node.x = gridLeft + (index % columns) * columnStep;
      node.y = gridTop + Math.floor(index / columns) * rowStep;
      includePoint(node.x, node.y);
      includePoint(node.x + NODE_WIDTH, node.y + NODE_HEIGHT);
    });
  }

  // Padding contains all strokes and loops; a tiny graph stays a small diagram.
  const width = Math.max(240, right - left + 24);
  const height = Math.max(120, bottom - top + 24);
  const x = (left + right - width) / 2;
  const y = (top + bottom - height) / 2;
  return { nodes, edges, viewBox: `${x} ${y} ${width} ${height}` };
}

export function PhoneWorkflowMinimap() {
  const { t } = useI18n();
  const workflow = useWorkflowStore((state) => state.workflow);
  const hiddenItems = useWorkflowStore((state) => state.hiddenItems);
  const focusKey = usePhoneFocusStore((state) => state.focusKey);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const layout = useMemo(createPhoneMinimapLayout, []);
  const graph = useMemo(
    () => workflow ? layout(workflow) : EMPTY_GRAPH,
    [workflow, layout],
  );
  const geometry = useMemo(() => positionGraph(graph), [graph]);
  const workflowNodes = useMemo(
    () => new Map(workflow?.nodes.map((node) => [node.id, node])),
    [workflow],
  );
  const hiddenNodeIds = useMemo(() => {
    const hidden = new Set<number>();
    if (!workflow) return hidden;
    const groups = workflow.groups ?? [];
    const nodeGroups = computeNodeGroupsFor(workflow.nodes, groups);
    const parents = computeGroupParentsFor(groups);
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    for (const node of workflow.nodes) {
      if (node.itemKey && hiddenItems[node.itemKey]) {
        hidden.add(node.id);
        continue;
      }
      let groupId = nodeGroups.get(node.id);
      const visited = new Set<number>();
      while (groupId != null && !visited.has(groupId)) {
        visited.add(groupId);
        const group = groupsById.get(groupId);
        if (group?.itemKey && hiddenItems[group.itemKey]) {
          hidden.add(node.id);
          break;
        }
        groupId = parents.get(groupId) ?? undefined;
      }
    }
    return hidden;
  }, [workflow, hiddenItems]);
  const orderedEdges = useMemo(() => {
    const normal: RoutedEdge[] = [];
    const focused: RoutedEdge[] = [];
    for (const edge of geometry.edges) {
      (edge.source === focusKey || edge.target === focusKey ? focused : normal).push(edge);
    }
    return [...normal, ...focused];
  }, [geometry, focusKey]);

  if (!workflow?.nodes.length || !geometry.nodes.length) return null;

  const toggleCollapsed = () => {
    const next = !collapsed;
    collapsedFallback = next;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
    } catch {
      // Collapsing remains usable even with blocked or full storage.
    }
  };
  const toggleLabel = collapsed
    ? t("Expand workflow minimap")
    : t("Collapse workflow minimap");

  return (
    <section
      id="phone-workflow-minimap"
      className="phone-workflow-minimap"
      data-collapsed={collapsed}
      aria-label={t("Workflow minimap")}
    >
      <div className="phone-workflow-minimap__viewport" aria-hidden={collapsed}>
        <div className="phone-workflow-minimap__drawing">
          <svg
            id="phone-minimap-graph"
            viewBox={geometry.viewBox}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={t("Workflow minimap")}
            focusable="false"
          >
            <g fill="none" strokeLinecap="round" strokeLinejoin="round">
              {orderedEdges.map((edge) => {
                const focused = edge.source === focusKey || edge.target === focusKey;
                return (
                  <path
                    key={edge.key}
                    data-minimap-edge={edge.key}
                    data-source={edge.source}
                    data-target={edge.target}
                    data-wireless={edge.wireless}
                    data-focused={focused}
                    d={edge.d}
                    stroke={focused ? themeColors.border.focusCyan : themeColors.text.muted}
                    strokeOpacity={focused ? 0.95 : 0.4}
                    strokeWidth={focused ? 1.3 : 0.6}
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray={edge.wireless ? "3 3" : undefined}
                  />
                );
              })}
            </g>
            <g>
              {geometry.nodes.map((node) => {
                const current = workflowNodes.get(node.id);
                const bypassed = current?.mode === 4;
                const hidden = hiddenNodeIds.has(node.id);
                const focused = node.key === focusKey;
                const color = resolveWorkflowColor(current?.bgcolor?.trim() || current?.color);
                return (
                  <rect
                    key={node.key}
                    data-minimap-node-key={node.key}
                    data-node-id={node.id}
                    data-column={node.column + 1}
                    data-row={node.row}
                    data-focused={focused}
                    data-bypassed={bypassed}
                    data-hidden={hidden}
                    data-isolated={node.isolated}
                    x={node.x}
                    y={node.y}
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={1.5}
                    fill={bypassed ? themeColors.brand.bypassPurple : color}
                    fillOpacity={(hidden ? 0.25 : 1) * (bypassed ? 0.55 : 1)}
                    stroke={focused ? "#ffffff" : themeColors.text.muted}
                    strokeOpacity={focused ? 1 : hidden ? 0.25 : 0.65}
                    strokeWidth={1.25}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </g>
          </svg>
        </div>
      </div>
      <button
        id="phone-minimap-toggle"
        className="phone-workflow-minimap__toggle"
        type="button"
        aria-expanded={!collapsed}
        aria-controls="phone-minimap-graph"
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={toggleCollapsed}
      >
        {collapsed
          ? <Maximize2 className="phone-workflow-minimap__zoom" aria-hidden="true" strokeWidth={2.2} />
          : <Minimize2 className="phone-workflow-minimap__zoom" aria-hidden="true" strokeWidth={2.2} />}
      </button>
    </section>
  );
}
