import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { Workflow, WorkflowNode } from "@/api/types";
import { useWorkflowStore } from "@/hooks/useWorkflow";
import { useI18n } from "@/i18n";
import { ArrowRightIcon, CloseIcon, CaretDownIcon } from "@/components/icons";
import { connectionButtonDomId } from "@/utils/connectionFlash";
import {
  collectPhoneRelations,
  type PhoneRelation,
} from "@/utils/phoneConnectionRelations";
import { choosePhoneFocus } from "@/utils/phoneConnectionFocus";
import { requestPhoneConnectionJump } from "@/utils/phoneConnectionNavigation";
import { getWidgetDefinitions } from "@/utils/widgetDefinitions";
import { getTypeClass } from "./NodeCard/Connections/slotTypeClass";
import { usePhoneConnectionTravel } from "./usePhoneConnectionTravel";

type Side = "input" | "output";
type Wire = {
  key: string;
  relation: string;
  side: Side;
  d: string;
  color: string;
  x: number;
  y: number;
  label: string;
  offscreen: boolean;
  wireless: boolean;
};
type Lane = { top: number; height: number; capacity: number };
type Geometry = {
  width: number;
  height: number;
  rail: number;
  edge: number;
  lanes: Record<Side, Lane>;
  wires: Wire[];
};
const emptyGeometry: Geometry = {
  width: 0,
  height: 0,
  rail: 36,
  edge: 0,
  lanes: {
    input: { top: 0, height: 0, capacity: 0 },
    output: { top: 0, height: 0, capacity: 0 },
  },
  wires: [],
};
const titleOf = (node: WorkflowNode) => node.title?.trim() || node.type;
const identity = (side: Side, relation: PhoneRelation) =>
  side + ":" + relation.node.itemKey;
function rowGeometry(
  count: number,
  index: number,
  capacity: number,
  height: number,
) {
  const single = count === 1;
  const rows = Math.min(count, capacity) + (count > capacity ? 1 : 0);
  const size = single
    ? Math.min(228, height - 36)
    : Math.min(76, (height - 36) / Math.max(1, rows));
  return {
    top: Math.max(12, (height - rows * size) / 2) + index * size + 3,
    height: size - 6,
  };
}
function laneRow(count: number, index: number, lane: Lane) {
  const row = rowGeometry(count, index, lane.capacity, lane.height);
  return { ...row, top: row.top + lane.top };
}

export function PhoneConnectionPreview({
  scrollerRef,
  workflow,
  order,
  enabled,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  workflow: Workflow | null;
  order: WorkflowNode[];
  enabled: boolean;
}) {
  const { t } = useI18n();
  const hidden = useWorkflowStore((s) => s.hiddenItems);
  const connectionsVisible = useWorkflowStore(
    (s) => s.connectionButtonsVisible,
  );
  enabled = enabled && connectionsVisible;
  const nodeTypes = useWorkflowStore((s) => s.nodeTypes);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<Geometry>(emptyGeometry);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [overflow, setOverflow] = useState<Side | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<string | null>(null);
  const forcedUntil = useRef(0);
  const scheduleRef = useRef<() => void>(() => {});
  const focus =
    workflow?.nodes.find((node) => node.itemKey === focusKey) || null;
  const relations = useMemo(
    () =>
      workflow && focus
        ? collectPhoneRelations(workflow, focus, hidden, order)
        : { input: [], output: [] },
    [workflow, focus, hidden, order],
  );
  const onArrive = useCallback((key: string) => {
    focusRef.current = key;
    forcedUntil.current = Date.now() + 500;
    setFocusKey(key);
    scheduleRef.current();
  }, []);
  const travelling = usePhoneConnectionTravel(
    scrollerRef,
    workflow,
    enabled,
    onArrive,
  );
  const live = useRef({ workflow, relations, travelling });
  live.current = { workflow, relations, travelling };

  useEffect(() => {
    const scroller = scrollerRef.current;
    const inner = scroller?.querySelector<HTMLElement>("#node-list-inner");
    if (!scroller || !inner || !enabled) {
      focusRef.current = null;
      setFocusKey(null);
      return;
    }
    let frame = 0,
      timer = 0,
      pending: string | null = null,
      pendingAt = 0;
    let disposed = false;
    const visible = new Set<HTMLElement>();
    const observed = new Set<HTMLElement>();
    const clearFocus = () => {
      focusRef.current = null;
      setFocusKey(null);
    };
    const schedule = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          if (entry.isIntersecting && entry.intersectionRect.height > 0)
            visible.add(element);
          else visible.delete(element);
        }
        schedule();
      },
      { root: scroller, threshold: [0, 0.1, 0.5, 1] },
    );
    const discover = () => {
      const current = new Set(
        inner.querySelectorAll<HTMLElement>("[data-phone-node-key]"),
      );
      for (const element of observed)
        if (!current.has(element)) {
          observer.unobserve(element);
          resize.unobserve(element);
          observed.delete(element);
          visible.delete(element);
        }
      for (const element of current)
        if (!observed.has(element)) {
          observed.add(element);
          observer.observe(element);
          resize.observe(element);
        }
      schedule();
    };
    function measure() {
      frame = 0;
      const layer = layerRef.current;
      if (!layer || live.current.travelling) return;
      const rect = scroller!.getBoundingClientRect();
      const origin = layer.getBoundingClientRect();
      const height = Math.max(0, rect.bottom - origin.top - 88);
      const width = origin.width;
      if (!width || height < 100) {
        clearFocus();
        return;
      }
      const candidates = [...visible].map((element) => {
        const r = element.getBoundingClientRect();
        return {
          key: element.dataset.phoneNodeKey!,
          expanded: element.dataset.phoneExpanded === "true",
          top: r.top - origin.top,
          bottom: r.bottom - origin.top,
        };
      });
      let next = choosePhoneFocus(candidates, height, focusRef.current);
      const active = document.activeElement;
      const editing =
        active instanceof HTMLElement &&
        active.matches(
          'input,textarea,select,[contenteditable="true"],[role="combobox"]',
        );
      const current = candidates.find(
        (node) =>
          node.key === focusRef.current &&
          node.expanded &&
          node.bottom > 0 &&
          node.top < height,
      );
      if (current && (editing || Date.now() < forcedUntil.current))
        next = current.key;
      if (next !== focusRef.current) {
        if (!next || !current) {
          focusRef.current = next;
          setFocusKey(next);
          pending = null;
        } else if (pending !== next) {
          pending = next;
          pendingAt = Date.now();
          window.clearTimeout(timer);
          timer = window.setTimeout(schedule, 125);
        } else if (Date.now() - pendingAt >= 110) {
          focusRef.current = next;
          setFocusKey(next);
          pending = null;
        }
      } else pending = null;
      const rail = width >= 900 ? 108 : 36;
      const innerRect = inner!.getBoundingClientRect();
      const edge = Math.max(0, (width - innerRect.width) / 2);
      const lanes: Record<Side, Lane> = {
        input: { top: 0, height, capacity: 0 },
        output: { top: 0, height, capacity: 0 },
      };
      const bookmark = scroller!
        .closest("#node-list-wrapper")
        ?.querySelector<HTMLElement>("[data-phone-bookmark-bar]");
      const bookmarkRect = bookmark?.getBoundingClientRect();
      for (const side of ["input", "output"] as const) {
        const lane = lanes[side];
        const left =
          origin.left + (side === "input" ? edge : width - edge - rail);
        if (
          bookmarkRect &&
          bookmarkRect.width > 0 &&
          bookmarkRect.left < left + rail &&
          bookmarkRect.right > left
        ) {
          const above = Math.max(
            0,
            Math.min(height, bookmarkRect.top - origin.top - 8),
          );
          const belowStart = Math.max(0, bookmarkRect.bottom - origin.top + 8);
          const below = Math.max(0, height - belowStart);
          if (above >= below) lane.height = above;
          else {
            lane.top = belowStart;
            lane.height = below;
          }
        }
        lane.capacity =
          lane.height < 130
            ? 0
            : Math.max(1, Math.min(5, Math.floor((lane.height - 60) / 76) - 1));
      }
      const wires: Wire[] = [];
      const activeNode = live.current.workflow?.nodes.find(
        (node) => node.itemKey === focusRef.current,
      );
      const card = activeNode
        ? document.getElementById("node-card-" + activeNode.id)
        : null;
      const cardRect = card?.getBoundingClientRect();
      if (activeNode && cardRect && next === focusRef.current)
        for (const side of ["input", "output"] as const) {
          const sideRelations = live.current.relations[side];
          const lane = lanes[side];
          sideRelations.slice(0, lane.capacity).forEach((relation, index) => {
            const row = laneRow(sideRelations.length, index, lane);
            relation.connections.forEach((connection, lineIndex) => {
              const port = document.getElementById(
                connectionButtonDomId(
                  activeNode.id,
                  side,
                  connection.slotIndex,
                ),
              );
              const portRect = port?.getBoundingClientRect();
              const real =
                portRect && portRect.width > 0 && portRect.height > 0;
              const rawY = real
                ? portRect.top + portRect.height / 2 - origin.top
                : cardRect.top - origin.top + 54 + connection.slotIndex * 20;
              const y = Math.max(14, Math.min(height - 14, rawY));
              const x = real
                ? portRect.left + portRect.width / 2 - origin.left
                : (side === "input"
                    ? cardRect.left + 12
                    : cardRect.right - 12) - origin.left;
              const start =
                side === "input" ? edge + rail : width - edge - rail;
              const fromY =
                row.top +
                row.height / 2 +
                (lineIndex - (relation.connections.length - 1) / 2) * 5;
              const bend = side === "input" ? 1 : -1;
              const color = port ? getComputedStyle(port).backgroundColor : "";
              wires.push({
                key:
                  side +
                  ":" +
                  relation.node.id +
                  ":" +
                  connection.slotIndex +
                  ":" +
                  lineIndex,
                relation: identity(side, relation),
                side,
                d:
                  "M " +
                  start +
                  " " +
                  fromY +
                  " C " +
                  (start + bend * 18) +
                  " " +
                  fromY +
                  ", " +
                  (x - bend * 20) +
                  " " +
                  y +
                  ", " +
                  x +
                  " " +
                  y,
                x,
                y,
                color:
                  color && color !== "rgba(0, 0, 0, 0)" ? color : "#94a3b8",
                label: connection.label,
                offscreen: !real || rawY !== y,
                wireless: connection.wireless,
              });
            });
          });
        }
      const value = { width, height, rail, edge, lanes, wires };
      setGeometry((old) =>
        JSON.stringify(old) === JSON.stringify(value) ? old : value,
      );
    }
    scheduleRef.current = schedule;
    resize.observe(scroller);
    resize.observe(inner);
    const mutation = new MutationObserver(discover);
    mutation.observe(inner, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-phone-expanded"],
    });
    const bookmarkChanges = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            (record.target as Element).closest?.("[data-phone-bookmark-bar]") ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                node.matches("[data-phone-bookmark-bar]"),
            ),
        )
      )
        schedule();
    });
    const wrapper = scroller.closest("#node-list-wrapper");
    if (wrapper)
      bookmarkChanges.observe(wrapper, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    discover();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
      resize.disconnect();
      mutation.disconnect();
      bookmarkChanges.disconnect();
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      scheduleRef.current = () => {};
    };
  }, [scrollerRef, enabled, workflow?.id]);

  useEffect(() => {
    scheduleRef.current();
  }, [relations, travelling]);
  useEffect(() => {
    setOverflow(null);
    setHighlight(null);
    const scroller = scrollerRef.current;
    const card = [
      ...(scroller?.querySelectorAll<HTMLElement>("[data-phone-node-key]") ||
        []),
    ].find((node) => node.dataset.phoneNodeKey === focusKey);
    if (card) card.dataset.phoneFocus = "true";
    return () => {
      card?.removeAttribute("data-phone-focus");
    };
  }, [focusKey, scrollerRef]);
  useEffect(() => {
    if (!overflow) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (
        event.type === "pointerdown" &&
        (event.target as Element)?.closest?.("[data-phone-relations-ui]")
      )
        return;
      setOverflow(null);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", close);
    };
  }, [overflow]);

  const go = (side: Side, relation: PhoneRelation) => {
    if (!relation.node.itemKey) return;
    setOverflow(null);
    const first = relation.connections[0];
    const reciprocal = first?.targetSlotIndex;
    requestPhoneConnectionJump({
      itemKey: relation.node.itemKey,
      nodeId: relation.node.id,
      direction: side,
      flashDomId:
        reciprocal != null
          ? connectionButtonDomId(
              relation.node.id,
              side === "input" ? "output" : "input",
              reciprocal,
            )
          : null,
      flashDomIds: [
        ...new Set(
          relation.connections
            .filter((c) => c.targetSlotIndex != null)
            .map((c) =>
              connectionButtonDomId(
                relation.node.id,
                side === "input" ? "output" : "input",
                c.targetSlotIndex!,
              ),
            ),
        ),
      ],
    });
  };
  const describe = (relation: PhoneRelation) =>
    relation.connections
      .map((c) => c.type + ": " + c.label + " / " + c.targetLabel)
      .join(", ");
  const previews = (side: Side) =>
    relations[side]
      .slice(0, geometry.lanes[side].capacity)
      .map((relation, index) => {
        const row = laneRow(
          relations[side].length,
          index,
          geometry.lanes[side],
        );
        const single = relations[side].length === 1;
        const key = identity(side, relation);
        const definitions = single
          ? getWidgetDefinitions(nodeTypes, relation.node)
              .filter(
                (d) =>
                  !d.connected &&
                  ["string", "number", "boolean"].includes(typeof d.value),
              )
              .slice(0, 2)
          : [];
        return (
          <button
            key={key}
            type="button"
            data-phone-relation={relation.node.id}
            data-phone-side={side}
            data-phone-relations-ui
            className={
              "phone-relation-preview " +
              (single ? "is-single" : "is-stack") +
              (relation.node.mode === 4 ? " is-bypassed" : "") +
              (relation.hidden ? " is-hidden" : "") +
              (highlight === key ? " is-highlighted" : "")
            }
            style={
              {
                top: row.top,
                height: row.height,
                [side === "input" ? "left" : "right"]: geometry.edge + 2,
              } as CSSProperties
            }
            aria-label={
              titleOf(relation.node) +
              " #" +
              relation.node.id +
              "; " +
              describe(relation)
            }
            title={
              titleOf(relation.node) +
              " #" +
              relation.node.id +
              " / " +
              describe(relation)
            }
            onClick={() => go(side, relation)}
            onPointerEnter={() => setHighlight(key)}
            onPointerLeave={() => setHighlight(null)}
            onFocus={() => setHighlight(key)}
            onBlur={() => setHighlight(null)}
          >
            <span className="phone-relation-caption">
              <span className="phone-relation-title">
                {titleOf(relation.node)}
              </span>
            </span>
            <span className="phone-relation-id">#{relation.node.id}</span>
            <span className="phone-relation-ports">
              {[...new Set(relation.connections.map((c) => c.type))]
                .slice(0, 3)
                .map((type) => (
                  <span
                    key={type}
                    className={"phone-relation-dot " + getTypeClass(type)}
                    title={type}
                  />
                ))}
            </span>
            {relation.connections.length > 1 && (
              <span className="phone-relation-count">
                {relation.connections.length}
              </span>
            )}
            {single && (
              <span className="phone-relation-fields">
                {definitions.map((d) => (
                  <span key={d.name}>
                    <small>{d.inputName || d.name}</small>
                    <span>{String(d.value).slice(0, 70)}</span>
                  </span>
                ))}
              </span>
            )}
            <span className="phone-relation-arrow">
              {side === "input" ? (
                <ArrowRightIcon className="w-3 h-3 rotate-180" />
              ) : (
                <ArrowRightIcon className="w-3 h-3" />
              )}
            </span>
          </button>
        );
      });
  const hasRelations =
    enabled && focus && (relations.input.length || relations.output.length);
  return (
    <div className="phone-relations-sticky">
      <div
        ref={layerRef}
        className="phone-relations-layer"
        data-phone-focus-key={focusKey || ""}
        data-phone-focus-id={focus?.id ?? ""}
        style={{ height: geometry.height || "calc(100% - 88px)" }}
      >
        {hasRelations ? (
          <>
            <svg
              className="phone-relation-wires"
              width={geometry.width}
              height={geometry.height}
              aria-hidden="true"
            >
              {geometry.wires.map((wire) => (
                <g
                  key={wire.key}
                  opacity={
                    highlight && highlight !== wire.relation ? 0.16 : 0.72
                  }
                >
                  <path
                    d={wire.d}
                    fill="none"
                    stroke={wire.color}
                    strokeWidth={highlight === wire.relation ? 2.4 : 1.5}
                    strokeDasharray={wire.wireless ? "4 4" : undefined}
                  />
                  {wire.offscreen && (
                    <>
                      <circle cx={wire.x} cy={wire.y} r="3" fill={wire.color} />
                      {highlight === wire.relation && (
                        <text
                          x={wire.x + (wire.side === "input" ? 6 : -6)}
                          y={wire.y < 20 ? wire.y + 14 : wire.y - 6}
                          textAnchor={wire.side === "input" ? "start" : "end"}
                        >
                          {wire.label}
                        </text>
                      )}
                    </>
                  )}
                </g>
              ))}
            </svg>
            {previews("input")}
            {previews("output")}
            {(["input", "output"] as const).map(
              (side) =>
                geometry.lanes[side].height >= 68 &&
                relations[side].length > geometry.lanes[side].capacity && (
                  <button
                    type="button"
                    key={side}
                    data-phone-relations-ui
                    data-phone-more={side}
                    className="phone-relation-more"
                    style={
                      {
                        top: laneRow(
                          relations[side].length,
                          geometry.lanes[side].capacity,
                          geometry.lanes[side],
                        ).top,
                        [side === "input" ? "left" : "right"]:
                          geometry.edge + 2,
                      } as CSSProperties
                    }
                    aria-label={
                      t("Connections") +
                      " " +
                      (relations[side].length - geometry.lanes[side].capacity)
                    }
                    title={t("Connections")}
                    onClick={() => setOverflow(overflow === side ? null : side)}
                  >
                    <CaretDownIcon className="w-4 h-4" />
                    <span>
                      +{relations[side].length - geometry.lanes[side].capacity}
                    </span>
                  </button>
                ),
            )}
            {overflow && (
              <div
                className="phone-relations-menu"
                data-phone-relations-ui
                role="dialog"
                aria-label={t("Connections")}
              >
                <button
                  type="button"
                  className="phone-relations-menu-close"
                  aria-label={t("Close")}
                  title={t("Close")}
                  onClick={() => setOverflow(null)}
                >
                  <CloseIcon className="w-4 h-4" />
                </button>
                {relations[overflow].map((relation) => (
                  <button
                    type="button"
                    key={relation.node.itemKey}
                    onClick={() => go(overflow, relation)}
                  >
                    <strong>
                      {titleOf(relation.node)}{" "}
                      <small>#{relation.node.id}</small>
                    </strong>
                    <span>{describe(relation)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
