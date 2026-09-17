import type { PhoneMinimapEdge } from "./phoneMinimapGraph";

interface RoutingNode {
  key: string;
  column: number;
  x: number;
  y: number;
}
interface RoutingOptions {
  nodeWidth: number;
  nodeHeight: number;
  columnStep: number;
  rowStep: number;
}
type Point = { x: number; y: number };
type Interval = [number, number];
export type PhoneMinimapRoute = PhoneMinimapEdge & { d: string; points: Point[] };

function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const low = Math.max(a[i][0], b[j][0]);
    const high = Math.min(a[i][1], b[j][1]);
    if (high >= low) result.push([low, high]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return result;
}

function candidates(intervals: Interval[]): number[] {
  return intervals.flatMap(([low, high]) => {
    const count = Math.max(1, Math.floor((high - low) / 6));
    const values = Array.from({ length: count }, (_, index) =>
      low + (index + 0.5) * (high - low) / count);
    if (high - low >= 8) values.push(low, high);
    return values;
  }).sort((a, b) => a - b);
}

function compactPoints(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last?.x === point.x && last.y === point.y) continue;
    const before = result.at(-2);
    if (before && last &&
      ((before.x === last.x && last.x === point.x) ||
       (before.y === last.y && last.y === point.y))) result.pop();
    result.push(point);
  }
  return result;
}

/** Route within row tracks; only gutters carry vertical segments. Inputs stay read-only. */
export function routePhoneMinimapEdges(
  nodes: readonly RoutingNode[],
  edges: readonly PhoneMinimapEdge[],
  { nodeWidth, nodeHeight, columnStep, rowStep }: RoutingOptions,
) {
  if (!nodes.length) return {
    edges: [] as PhoneMinimapRoute[],
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
  };
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const columns = new Map<number, RoutingNode[]>();
  let left = Infinity;
  let right = -Infinity;
  let nodeTop = Infinity;
  let nodeBottom = -Infinity;
  for (const node of nodes) {
    const column = columns.get(node.column) ?? [];
    column.push(node);
    columns.set(node.column, column);
    left = Math.min(left, node.x);
    right = Math.max(right, node.x + nodeWidth);
    nodeTop = Math.min(nodeTop, node.y);
    nodeBottom = Math.max(nodeBottom, node.y + nodeHeight);
  }
  const padding = (rowStep - nodeHeight) / 2;
  const top = nodeTop - padding;
  const bottom = nodeBottom + padding;
  const freeByColumn = new Map<number, Interval[]>();
  const choicesByColumn = new Map<number, number[]>();
  const freeInColumn = (column: number): Interval[] => {
    const cached = freeByColumn.get(column);
    if (cached) return cached;
    const free: Interval[] = [];
    let cursor = top + 2;
    for (const node of [...(columns.get(column) ?? [])].sort((a, b) => a.y - b.y)) {
      if (node.y - 3 >= cursor) free.push([cursor, node.y - 3]);
      cursor = Math.max(cursor, node.y + nodeHeight + 3);
    }
    if (cursor <= bottom - 2) free.push([cursor, bottom - 2]);
    freeByColumn.set(column, free);
    return free;
  };
  const choicesInColumn = (column: number) => {
    let values = choicesByColumn.get(column);
    if (!values) {
      values = candidates(freeInColumn(column));
      choicesByColumn.set(column, values);
    }
    return values;
  };
  const usage = new Map<string, number>();
  const useKey = (column: number, bucket: number) => `${column}:${bucket}`;
  const channelUsage = (column: number, y: number) => {
    const bucket = Math.round(y / 4);
    return (usage.get(useKey(column, bucket)) ?? 0) +
      0.4 * ((usage.get(useKey(column, bucket - 1)) ?? 0) +
        (usage.get(useKey(column, bucket + 1)) ?? 0));
  };
  const gutterUsage = new Map<number, number[]>();
  const selfUsage = new Map<string, number>();
  const routed: PhoneMinimapRoute[] = [];
  let longIndex = 0;

  for (const edge of [...edges].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) {
    const source = byKey.get(edge.source);
    const target = byKey.get(edge.target);
    if (!source || !target) continue;
    const sourceY = source.y + nodeHeight / 2;
    const targetY = target.y + nodeHeight / 2;
    const gutters = new Map<number, number>();
    const gutter = (boundary: number) => {
      const cached = gutters.get(boundary);
      if (cached !== undefined) return cached;
      const offsets = [0, -4, 4, -8, 8, -12, 12];
      const counts = gutterUsage.get(boundary) ?? offsets.map(() => 0);
      let slot = 0;
      for (let i = 1; i < counts.length; i++) if (counts[i] < counts[slot]) slot = i;
      counts[slot]++;
      gutterUsage.set(boundary, counts);
      const x = boundary * columnStep + (columnStep + nodeWidth) / 2 + offsets[slot];
      gutters.set(boundary, x);
      return x;
    };
    let points: Point[];
    if (source.key === target.key) {
      const count = selfUsage.get(source.key) ?? 0;
      selfUsage.set(source.key, count + 1);
      const above = count % 2 === 0;
      const loopY = above ? source.y - padding / 2 : source.y + nodeHeight + padding / 2;
      const laneX = gutter(source.column);
      points = [
        { x: source.x + nodeWidth, y: sourceY }, { x: laneX, y: sourceY },
        { x: laneX, y: loopY }, { x: source.x + nodeWidth / 2, y: loopY },
        { x: source.x + nodeWidth / 2, y: above ? source.y : source.y + nodeHeight },
      ];
    } else if (source.column === target.column) {
      const downward = targetY > sourceY;
      const portX = source.x + (downward ? nodeWidth : 0);
      const laneX = gutter(source.column - (downward ? 0 : 1));
      points = [
        { x: portX, y: sourceY }, { x: laneX, y: sourceY },
        { x: laneX, y: targetY }, { x: portX, y: targetY },
      ];
    } else {
      const direction = target.column > source.column ? 1 : -1;
      const sourceX = source.x + (direction > 0 ? nodeWidth : 0);
      const targetX = target.x + (direction > 0 ? 0 : nodeWidth);
      const firstGutter = gutter(source.column - (direction > 0 ? 0 : 1));
      const lastGutter = gutter(target.column - (direction > 0 ? 1 : 0));
      points = [{ x: sourceX, y: sourceY }, { x: firstGutter, y: sourceY }];
      const crossed: number[] = [];
      for (let column = source.column + direction; column !== target.column; column += direction) crossed.push(column);
      if (crossed.length) {
        // A stable low-discrepancy sequence spreads long edges over the full track height.
        const fraction = (0.5 + longIndex++ * 0.38196601125) % 1;
        const preferred = nodeTop + fraction * (nodeBottom - nodeTop);
        const score = (column: number, y: number) =>
          channelUsage(column, y) * rowStep * 4 + Math.abs(y - preferred) +
          0.08 * (Math.abs(y - sourceY) + Math.abs(y - targetY));
        let common: Interval[] = [[nodeTop, nodeBottom]];
        for (const column of crossed) common = intersectIntervals(common, freeInColumn(column));
        let sharedY: number | undefined;
        let sharedCost = Infinity;
        for (const y of candidates(common)) {
          const cost = crossed.reduce((sum, column) => sum + score(column, y), 0);
          if (cost < sharedCost) { sharedCost = cost; sharedY = y; }
        }
        let previousY = sourceY;
        const stepped = crossed.map((column) => {
          let bestY = choicesInColumn(column)[0];
          let bestCost = Infinity;
          for (const y of choicesInColumn(column)) {
            const cost = score(column, y) + Math.abs(y - previousY) * 0.25;
            if (cost < bestCost) { bestCost = cost; bestY = y; }
          }
          previousY = bestY;
          return bestY;
        });
        const steppedCost = stepped.reduce((sum, y, index) => sum + score(crossed[index], y) +
          (index && y !== stepped[index - 1] ? 4 + Math.abs(y - stepped[index - 1]) * 0.25 : 0), 0);
        const heights = sharedY !== undefined && sharedCost <= steppedCost
          ? crossed.map(() => sharedY!) : stepped;
        let currentX = firstGutter;
        crossed.forEach((column, index) => {
          const y = heights[index];
          const nextX = gutter(column - (direction > 0 ? 0 : 1));
          points.push({ x: currentX, y }, { x: nextX, y });
          currentX = nextX;
          const key = useKey(column, Math.round(y / 4));
          usage.set(key, (usage.get(key) ?? 0) + 1);
        });
      }
      points.push({ x: lastGutter, y: targetY }, { x: targetX, y: targetY });
    }
    const compact = compactPoints(points);
    for (const point of compact) {
      left = Math.min(left, point.x);
      right = Math.max(right, point.x);
    }
    const d = compact.map((point, index) =>
      `${index ? "L" : "M"} ${Number(point.x.toFixed(3))} ${Number(point.y.toFixed(3))}`).join(" ");
    routed.push({ ...edge, points: compact, d });
  }
  return { edges: routed, bounds: { left, top, right, bottom } };
}
