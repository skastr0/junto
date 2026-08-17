import {
  memo,
  useCallback,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { use$ } from "@legendapp/state/react";
import { dock$, setWorkbenchPinnedWidthFrac } from "../lib/dock-state";
import { panesForLayout } from "../lib/surface-registry";
import { WorkbenchChrome, WorkbenchPanes } from "./workbench";

/**
 * The interactive dock contents are deliberately separated from the width
 * shell. Pointer-move resize updates can repaint the aside without walking
 * every mounted terminal, chat, or form below it.
 */
const PinnedDockContents = memo(function PinnedDockContents() {
  const mru = use$(dock$.registry.pinnedMru);
  const layout = use$(dock$.registry.pinnedLayout);
  const paneCount = panesForLayout(layout);
  const pane0 = mru[0];
  const pane1 = paneCount === 2 ? mru[1] : undefined;
  const tabs = mru.slice(paneCount);

  return (
    <div className="work-surface-dock__inner">
      <WorkbenchChrome
        zone="pinned"
        paneIds={[pane0, pane1]}
        tabs={tabs}
        activeId={pane0}
      />
      <WorkbenchPanes zone="pinned" />
    </div>
  );
});

/**
 * Stage-right pinned workbench dock. Only surfaces with zone === "pinned".
 * Left-edge drag resizes via pinnedWidthFrac (0.25–0.70 of stage width).
 * Focus-zone surfaces live in WorkFocusShell, not here.
 */
export function WorkSurfaceDock() {
  const hasPinned = use$(() => dock$.registry.pinnedMru.get().length > 0);
  const pinnedWidthFrac = use$(dock$.registry.pinnedWidthFrac);
  const dragRef = useRef<{ startX: number; startFrac: number } | null>(null);

  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startFrac: dock$.registry.peek().pinnedWidthFrac,
      };

      const onMove = (ev: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const stage = document.querySelector(".vellum-stage") as HTMLElement | null;
        const stageW = stage?.clientWidth ?? window.innerWidth;
        if (stageW < 1) return;
        // Dragging left edge rightward shrinks the dock.
        const deltaPx = ev.clientX - drag.startX;
        const nextFrac = drag.startFrac - deltaPx / stageW;
        setWorkbenchPinnedWidthFrac(nextFrac);
      };

      const onUp = (ev: PointerEvent) => {
        dragRef.current = null;
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          // already released
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  if (!hasPinned) return null;

  const widthPct = Math.round(pinnedWidthFrac * 1000) / 10;

  return (
    <aside
      className="work-surface-dock work-surface-dock--pinned"
      aria-label="Pinned work surface dock"
      style={
        {
          ["--workbench-pinned-width" as string]: `${widthPct}%`,
          flex: `0 0 ${widthPct}%`,
          maxWidth: "70%",
          minWidth: "25%",
        } as CSSProperties
      }
    >
      <div
        className="workbench-resize-handle workbench-resize-handle--left"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize pinned dock"
        onPointerDown={onResizePointerDown}
      />
      <PinnedDockContents />
    </aside>
  );
}
