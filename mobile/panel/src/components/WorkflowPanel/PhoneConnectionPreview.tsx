import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { Workflow, WorkflowNode } from "@/api/types";
import { useWorkflowStore } from "@/hooks/useWorkflow";
import { usePhoneFocusStore } from "@/hooks/usePhoneFocus";
import { ArrowRightIcon } from "@/components/icons";
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
/** One vertical lane beside the focused card: every neighbour, never truncated. */
type Lane = { top: number; height: number };
type Geometry = {
  width: number;
  height: number;
  /** Width of the sliver that stays on screen; the rest reads as cut off. */
  strip: number;
  lanes: Record<Side, Lane>;
  wires: Wire[];
};
type Relations = { input: PhoneRelation[]; output: PhoneRelation[] };
const DEFAULT_STRIP = 26;
const emptyGeometry: Geometry = {
  width: 0,
  height: 0,
  strip: DEFAULT_STRIP,
  lanes: { input: { top: 0, height: 0 }, output: { top: 0, height: 0 } },
  wires: [],
};
const titleOf = (node: WorkflowNode) => node.title?.trim() || node.type;
const identity = (side: Side, relation: PhoneRelation) =>
  side + ":" + relation.node.itemKey;

/** Fit every neighbour in the available lane, shrinking gaps with the rows. */
function laneRow(count: number, index: number, lane: Lane, compact: boolean) {
  const inset = Math.min(8, lane.height * 0.05);
  const available = Math.max(0, lane.height - 2 * inset);
  const maxSize = count === 1 ? 232 : compact ? 78 : 96;
  const step = Math.min(maxSize, available / Math.max(1, count));
  const gap = count === 1 ? 0 : Math.min(compact ? 3 : 5, step * 0.14);
  const size = step - gap;
  const total = step * count - gap;
  return {
    top: lane.top + (lane.height - total) / 2 + index * step,
    size,
    height: size,
  };
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
  const hidden = useWorkflowStore((s) => s.hiddenItems);
  const connectionsVisible = useWorkflowStore(
    (s) => s.connectionButtonsVisible,
  );
  const nodeTypes = useWorkflowStore((s) => s.nodeTypes);
  const focusKey = usePhoneFocusStore((s) => s.focusKey);
  const setFocusKey = usePhoneFocusStore((s) => s.setFocusKey);
  const [geometry, setGeometry] = useState<Geometry>(emptyGeometry);
  const [highlight, setHighlight] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<string | null>(focusKey);
  focusRef.current = focusKey;
  const forcedUntil = useRef(0);
  const scheduleRef = useRef<() => void>(() => {});
  const focus =
    workflow?.nodes.find((node) => node.itemKey === focusKey) || null;
  const relations = useMemo(
    () =>
      workflow && focus && connectionsVisible
        ? collectPhoneRelations(workflow, focus, hidden, order)
        : { input: [], output: [] },
    [workflow, focus, hidden, order, connectionsVisible],
  );
  // A focus change replaces the whole rail at once. Holding the outgoing set for
  // one beat lets the old tabs slide back out of the screen while the new ones
  // slide in, instead of the two sides blinking from one node to the next.
  const [leaving, setLeaving] = useState<Relations | null>(null);
  const shownRelations = useRef<Relations>(relations);
  useEffect(() => {
    const previous = shownRelations.current;
    shownRelations.current = relations;
    // A travel owns the handover for its whole duration. Its own swap is not a
    // fresh change to animate, and replaying it here is what made an emptied
    // side slide its tabs away a second time.
    if (travelActive.current) return;
    const unchanged = (a: PhoneRelation[], b: PhoneRelation[]) =>
      a.length === b.length &&
      a.every((entry, index) => entry.node.itemKey === b[index]?.node.itemKey);
    if (
      unchanged(previous.input, relations.input) &&
      unchanged(previous.output, relations.output)
    )
      return;
    setLeaving(previous);
    const timer = window.setTimeout(() => setLeaving(null), 300);
    return () => window.clearTimeout(timer);
  }, [relations]);
  // During a travel the live tabs are the outgoing set: they leave the screen on
  // the same beat the list does, and the incoming set starts sliding in with the
  // list's own incoming slide, so both land together.
  const [departing, setDeparting] = useState(false);
  const travelActive = useRef(false);
  // Wires belong to the focused card's geometry, so they are wrong the moment a
  // travel starts and stay wrong until the new card has been measured. Drawing
  // them in between is what left them hanging at the old spot, and what flashed
  // there for a frame once the travel released its dimming. They are simply not
  // drawn until the measurement catches up.
  const [wiresHidden, setWiresHidden] = useState(false);
  const wiresHiddenRef = useRef(false);
  const onDepart = useCallback(() => {
    travelActive.current = true;
    wiresHiddenRef.current = true;
    // Drop them on this frame, not the next React one: the scroller flag that
    // starts the list sliding is written synchronously, and these wires belong
    // to the card that is on its way out.
    const svg = layerRef.current?.querySelector<SVGElement>(".phone-relation-wires");
    if (svg) svg.style.display = "none";
    setWiresHidden(true);
    setDeparting(true);
  }, []);
  const onSwap = useCallback((key: string) => {
    setDeparting(false);
    focusRef.current = key;
    forcedUntil.current = Date.now() + 500;
    setFocusKey(key);
    scheduleRef.current();
  }, []);
  const onArrive = useCallback((key: string) => {
    travelActive.current = false;
    setDeparting(false);
    focusRef.current = key;
    forcedUntil.current = Date.now() + 500;
    setFocusKey(key);
    scheduleRef.current();
  }, []);
  const onCancel = useCallback(() => {
    travelActive.current = false;
    setDeparting(false);
  }, []);
  const travelling = usePhoneConnectionTravel(scrollerRef, workflow, enabled, {
    onDepart,
    onSwap,
    onArrive,
    onCancel,
  });
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
      const style = getComputedStyle(scroller!);
      if (document.hidden || style.visibility === "hidden") {
        clearFocus();
        return;
      }
      const rect = scroller!.getBoundingClientRect();
      const origin = layer.getBoundingClientRect();
      const viewportBottom = Number.parseFloat(style.getPropertyValue("--phone-panel-visible-bottom"));
      const viewportTop = Number.parseFloat(style.getPropertyValue("--phone-panel-visible-top")) || 0;
      const bottom = Math.min(rect.bottom, Number.isFinite(viewportBottom) ? viewportBottom : rect.bottom - 88);
      const focusTop = Math.max(origin.top, viewportTop);
      const focusHeight = Math.max(0, bottom - focusTop);
      const height = Math.max(0, bottom - origin.top);
      const width = origin.width;
      if (!width || focusHeight < 100) {
        clearFocus();
        return;
      }
      const candidates = [...visible].map((element) => {
        const r = element.getBoundingClientRect();
        return {
          key: element.dataset.phoneNodeKey!,
          expanded: element.dataset.phoneExpanded === "true",
          top: r.top - focusTop,
          bottom: r.bottom - focusTop,
        };
      });
      let next = choosePhoneFocus(candidates, focusHeight, focusRef.current);
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
          node.top < focusHeight,
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
      const strip =
        Number.parseFloat(
          getComputedStyle(scroller!).getPropertyValue(
            "--phone-relation-strip",
          ),
        ) || DEFAULT_STRIP;
      const lanes: Record<Side, Lane> = {
        input: { top: focusTop - origin.top, height: focusHeight },
        output: { top: focusTop - origin.top, height: focusHeight },
      };
      const floatingControls = document.querySelectorAll<HTMLElement>(
        ".phone-panel-floating-controls #workflow-menu-container > button, #phone-minimap-toggle",
      );
      for (const control of floatingControls) {
        const box = control.getBoundingClientRect();
        if (!box.width || !box.height || box.top >= bottom || box.bottom <= focusTop) continue;
        const lane = lanes[box.left < origin.left + width / 2 ? "input" : "output"];
        const end = lane.top + lane.height;
        lane.top = Math.min(end, Math.max(lane.top, box.bottom - origin.top + 6));
        lane.height = Math.max(0, end - lane.top);
      }
      const bookmark = scroller!
        .closest("#node-list-wrapper")
        ?.querySelector<HTMLElement>("[data-phone-bookmark-bar]");
      const bookmarkRect = bookmark?.getBoundingClientRect();
      for (const side of ["input", "output"] as const) {
        const lane = lanes[side];
        const left = origin.left + (side === "input" ? 0 : width - strip);
        if (
          bookmarkRect &&
          bookmarkRect.width > 0 &&
          bookmarkRect.left < left + strip &&
          bookmarkRect.right > left
        ) {
          const laneEnd = lane.top + lane.height;
          const above = Math.max(
            0,
            Math.min(laneEnd, bookmarkRect.top - origin.top - 8) - lane.top,
          );
          const belowStart = Math.min(laneEnd, Math.max(lane.top, bookmarkRect.bottom - origin.top + 8));
          const below = Math.max(0, laneEnd - belowStart);
          if (above >= below) lane.height = above;
          else {
            lane.top = belowStart;
            lane.height = below;
          }
        }
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
          sideRelations.forEach((relation, index) => {
            const row = laneRow(sideRelations.length, index, lane, strip < 60);
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
              // Follow the port past the viewport edge. Clamping to the edge left
              // the line parked on screen after its own connection point had
              // scrolled away, which reads as a detached wire.
              const y = rawY;
              const x = real
                ? portRect.left + portRect.width / 2 - origin.left
                : (side === "input"
                    ? cardRect.left + 12
                    : cardRect.right - 12) - origin.left;
              const start = side === "input" ? strip : width - strip;
              const fromY =
                row.top +
                row.height / 2 +
                (lineIndex - (relation.connections.length - 1) / 2) *
                  Math.min(
                    5,
                    row.size / Math.max(1, relation.connections.length),
                  );
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
                offscreen: !real,
                wireless: connection.wireless,
              });
            });
          });
        }
      if (wiresHiddenRef.current) {
        wiresHiddenRef.current = false;
        setWiresHidden(false);
      }
      const value = { width, height, strip, lanes, wires };
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
    const panelRoot = scroller.closest("#panel-root");
    const visibility = new MutationObserver(schedule);
    if (panelRoot) visibility.observe(panelRoot, { attributes: true, attributeFilter: ["style"] });
    discover();
    scroller.addEventListener("scroll", schedule, { passive: true });
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
      resize.disconnect();
      mutation.disconnect();
      bookmarkChanges.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      scheduleRef.current = () => {};
    };
  }, [scrollerRef, enabled, workflow?.id]);

  useEffect(() => () => setFocusKey(null), [setFocusKey]);

  useEffect(() => {
    scheduleRef.current();
  }, [relations, travelling]);
  useEffect(() => {
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

  const go = (side: Side, relation: PhoneRelation) => {
    if (!relation.node.itemKey) return;
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
  const compact = geometry.strip < 60;
  const renderEntry = (
    side: Side,
    relation: PhoneRelation,
    index: number,
    count: number,
    ghost: boolean,
    departingRow: boolean,
  ) => {
    const leavingRow = ghost || departingRow;
    const lane = geometry.lanes[side];
    const row = laneRow(count, index, lane, compact);
    const single = count === 1;
    const key = identity(side, relation);
    // Below a readable height the entry degrades to a colour bar rather than
    // disappearing: the count on screen always matches the real connections.
    const bar = row.size < 14;
    const named = row.size >= (compact ? 42 : 30);
    const roomy = row.size >= (compact ? 62 : 44);
    const firstType = relation.connections[0]?.type ?? "";
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
        key={(ghost ? "leaving:" : "") + key}
        type="button"
        // A tab on its way out is decoration: no clicks, no focus, no tab stop.
        // A ghost also drops the rail attributes, so the live set stays exactly
        // the connections while the duplicate slides away.
        disabled={leavingRow}
        aria-hidden={leavingRow || undefined}
        data-phone-tab-leaving={leavingRow ? "true" : undefined}
        data-phone-relation={ghost ? undefined : relation.node.id}
        data-phone-side={ghost ? undefined : side}
        data-phone-relations-ui={ghost ? undefined : true}
        className={
          "phone-relation-preview " +
          (side === "input" ? "is-input " : "is-output ") +
          (leavingRow ? "is-leaving " : "is-entering ") +
          (single ? "is-single " : "is-stack ") +
          (bar ? "is-bar " : !named ? "is-tight " : "") +
          (roomy ? "is-roomy " : "") +
          (relation.node.mode === 4 ? "is-bypassed " : "") +
          (relation.hidden ? "is-hidden " : "") +
          (highlight === key ? "is-highlighted " : "") +
          (bar ? getTypeClass(firstType) : "")
        }
        style={
          {
            top: row.top,
            height: row.height,
            [side === "input" ? "left" : "right"]: 0,
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
        {!bar && named && (
          <span className="phone-relation-caption">
            <span className="phone-relation-title">
              {roomy
                ? titleOf(relation.node)
                : titleOf(relation.node).slice(0, 14)}
            </span>
          </span>
        )}
        {!bar && (roomy || !named) && (
          <span className="phone-relation-id">#{relation.node.id}</span>
        )}
        {!bar && roomy && (
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
        )}
        {!bar && relation.connections.length > 1 && roomy && (
          <span className="phone-relation-count">
            {relation.connections.length}
          </span>
        )}
        {!bar && single && (
          <span className="phone-relation-fields">
            {definitions.map((d) => (
              <span key={d.name}>
                <small>{d.inputName || d.name}</small>
                <span>{String(d.value).slice(0, 70)}</span>
              </span>
            ))}
          </span>
        )}
        {!bar && row.size >= 34 && (
          <span className="phone-relation-arrow">
            {side === "input" ? (
              <ArrowRightIcon className="w-3 h-3 rotate-180" />
            ) : (
              <ArrowRightIcon className="w-3 h-3" />
            )}
          </span>
        )}
      </button>
    );
  };
  const previews = (side: Side) =>
    relations[side].map((relation, index) =>
      renderEntry(
        side,
        relation,
        index,
        relations[side].length,
        false,
        departing,
      ),
    );
  // A tab that survives the switch stays put; the rest leave from the slot they
  // already occupied, so nothing jumps sideways before sliding out.
  const leavingPreviews = (side: Side) => {
    const previous = leaving?.[side] ?? [];
    if (!previous.length) return null;
    const stillShown = new Set(
      relations[side].map((relation) => relation.node.itemKey),
    );
    return previous.map((relation, index) =>
      stillShown.has(relation.node.itemKey)
        ? null
        : renderEntry(side, relation, index, previous.length, true, false),
    );
  };
  const hasRelations = Boolean(
    enabled && connectionsVisible &&
      ((focus && (relations.input.length || relations.output.length)) || leaving),
  );
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
            {!wiresHidden && (
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
                        <circle
                          cx={wire.x}
                          cy={wire.y}
                          r="3"
                          fill={wire.color}
                        />
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
            )}
            <div className="phone-relation-side is-input">
              {leavingPreviews("input")}
              {previews("input")}
            </div>
            <div className="phone-relation-side is-output">
              {leavingPreviews("output")}
              {previews("output")}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
