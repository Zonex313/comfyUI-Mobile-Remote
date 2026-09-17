import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Workflow } from "@/api/types";
import { useWorkflowStore } from "@/hooks/useWorkflow";
import { useConnectionSectionFoldsStore } from "@/hooks/useConnectionSectionFolds";
import { useParameterSectionFoldsStore } from "@/hooks/useParameterSectionFolds";
import { flashJumpTarget } from "@/utils/workflowJumpDom";
import {
  PHONE_CONNECTION_JUMP,
  type PhoneConnectionJump,
} from "@/utils/phoneConnectionNavigation";

export function usePhoneConnectionTravel(
  scrollerRef: RefObject<HTMLDivElement | null>,
  workflow: Workflow | null,
  enabled: boolean,
  onArrive: (key: string) => void,
) {
  const [travelling, setTravelling] = useState(false);
  const live = useRef({ workflow, onArrive });
  live.current = { workflow, onArrive };

  useEffect(() => {
    const scroller = scrollerRef.current;
    setTravelling(false);
    if (!scroller || !enabled) return;
    let generation = 0;
    let disposed = false;
    let animation: Animation | undefined;
    let unblock: (() => void) | undefined;
    let content: HTMLElement | null = null;
    let active = false;
    const restore = (releaseViewport = true) => {
      animation?.cancel();
      animation = undefined;
      if (content) {
        content.style.removeProperty("transform");
        content.style.removeProperty("opacity");
      }
      if (releaseViewport) {
        content?.style.removeProperty("--phone-arrival-scroll-space");
        scroller.removeAttribute("data-phone-travelling");
      }
    };
    const cancel = () => {
      generation++;
      unblock?.();
      unblock = undefined;
      restore();
      active = false;
      if (!disposed) setTravelling(false);
    };
    const play = async (frames: Keyframe[], duration: number) => {
      if (!content?.animate) return;
      animation = content.animate(frames, {
        duration,
        easing: "cubic-bezier(.2,.7,.2,1)",
        fill: "forwards",
      });
      try {
        await animation.finished;
      } catch {
        /* A manual gesture or newer jump owns the viewport. */
      }
    };
    const travel = async (detail: PhoneConnectionJump) => {
      cancel();
      const token = generation;
      const isCancelled = () => disposed || token !== generation;
      const state = useWorkflowStore.getState();
      const target = live.current.workflow?.nodes.find(
        (node) => node.itemKey === detail.itemKey && node.id === detail.nodeId,
      );
      if (!target) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement) focused.blur();
      state.setSearchQuery("");
      state.setSearchOpen(false);
      const wasFolded = Boolean(state.collapsedItems[detail.itemKey]);
      content = scroller.querySelector("#node-list-inner");
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const animate = !reduced && Boolean(content?.animate);
      const sign = detail.direction === "input" ? 1 : -1;
      active = true;
      setTravelling(true);
      scroller.dataset.phoneTravelling = detail.direction;
      try {
        if (animate) {
          await play(
            [
              { transform: "translateX(0)", opacity: 1 },
              { transform: "translateX(" + sign * 80 + "px)", opacity: 0 },
            ],
            110,
          );
          if (isCancelled()) return;
          content!.style.opacity = "0";
          animation?.cancel();
        }
        // Let a folded last node align before its expanded body supplies that range.
        if (animate && wasFolded)
          content?.style.setProperty(
            "--phone-arrival-scroll-space",
            scroller.clientHeight + "px",
          );
        const aligned = await new Promise<boolean>((resolve) => {
          let done = false;
          const finish = (success = false) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unblock = undefined;
            resolve(success);
          };
          const timer = window.setTimeout(() => finish(), 900);
          unblock = () => finish();
          useWorkflowStore
            .getState()
            .scrollToNode(target.itemKey!, undefined, detail.flashDomId, {
              behavior: "auto",
              preserveFold: animate && wasFolded,
              cancelled: isCancelled,
              onAligned: () => finish(true),
            });
        });
        if (isCancelled()) return;
        if (!aligned) {
          cancel();
          return;
        }
        if (animate) {
          content!.style.opacity = "1";
          await play(
            [
              { transform: "translateX(" + -sign * 80 + "px)", opacity: 0 },
              { transform: "translateX(0)", opacity: 1 },
            ],
            180,
          );
          if (isCancelled()) return;
          restore(false);
        }
        const current = useWorkflowStore.getState();
        current.setItemCollapsed(target.itemKey!, false);
        useConnectionSectionFoldsStore.getState().expand(detail.itemKey);
        if (wasFolded)
          useParameterSectionFoldsStore.getState().expand(detail.itemKey);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (isCancelled()) return;
        if (animate && wasFolded) {
          // The real card unfolds with a 200ms grid transition. Keep its borrowed range until it settles.
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              unblock = undefined;
              resolve();
            };
            const timer = window.setTimeout(finish, 220);
            unblock = finish;
          });
          if (isCancelled()) return;
        }
        flashJumpTarget(
          document.getElementById("node-card-" + detail.nodeId) ||
            document.getElementById("node-" + detail.nodeId),
        );
        for (const id of detail.flashDomIds ||
          (detail.flashDomId ? [detail.flashDomId] : [])) {
          const port = document.getElementById(id);
          port?.classList.add("connection-highlight-pulse");
          window.setTimeout(
            () => port?.classList.remove("connection-highlight-pulse"),
            1200,
          );
        }
        window.dispatchEvent(
          new CustomEvent("workflow-node-highlighted", {
            detail: { nodeId: detail.nodeId, itemKey: detail.itemKey },
          }),
        );
        live.current.onArrive(detail.itemKey);
      } finally {
        if (!isCancelled()) {
          restore();
          active = false;
          setTravelling(false);
        }
      }
    };
    const receive = (event: Event) => {
      const custom = event as CustomEvent<PhoneConnectionJump>;
      const target = live.current.workflow?.nodes.find(
        (node) =>
          node.itemKey === custom.detail?.itemKey &&
          node.id === custom.detail?.nodeId,
      );
      if (!target || !["input", "output"].includes(custom.detail.direction))
        return;
      event.preventDefault();
      void travel(custom.detail);
    };
    const interrupt = (event: Event) => {
      if (!active) return;
      if (
        ["pointerdown", "touchstart"].includes(event.type) &&
        (event.target as Element)?.closest?.("[data-phone-relations-ui]")
      )
        return;
      cancel();
    };
    const interruptKey = (event: KeyboardEvent) => {
      if (
        active &&
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          "Escape",
          " ",
        ].includes(event.key)
      )
        cancel();
    };
    const viewport = new ResizeObserver(() => {
      if (active && (!scroller.clientWidth || !scroller.clientHeight)) cancel();
    });
    viewport.observe(scroller);
    window.addEventListener("keydown", interruptKey);
    window.addEventListener(PHONE_CONNECTION_JUMP, receive);
    scroller.addEventListener("wheel", interrupt, { passive: true });
    scroller.addEventListener("touchstart", interrupt, { passive: true });
    scroller.addEventListener("touchmove", interrupt, { passive: true });
    scroller.addEventListener("pointerdown", interrupt, { passive: true });
    return () => {
      disposed = true;
      cancel();
      viewport.disconnect();
      window.removeEventListener("keydown", interruptKey);
      window.removeEventListener(PHONE_CONNECTION_JUMP, receive);
      scroller.removeEventListener("wheel", interrupt);
      scroller.removeEventListener("touchstart", interrupt);
      scroller.removeEventListener("touchmove", interrupt);
      scroller.removeEventListener("pointerdown", interrupt);
    };
  }, [scrollerRef, enabled, workflow?.id]);
  return travelling;
}
