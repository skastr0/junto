import { useCallback, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { use$ } from "@legendapp/state/react";
import { dock$, setWorkbenchPinnedWidthFrac } from "../lib/dock-state";
import {
  surfaceById,
  visiblePanes,
  zoneHasSurfaces,
} from "../lib/surface-registry";
import { WorkbenchChrome, WorkbenchPanes } from "./workbench";

/**
 * Stage-right pinned workbench dock. Only surfaces with zone === "pinned".
 * Left-edge drag resizes via pinnedWidthFrac (0.25–0.70 of stage width).
 * Focus-zone surfaces live in WorkFocusShell, not here.
 */
export function WorkSurfaceDock() {
  const registry = use$(dock$.registry);
  const hasPinned = zoneHasSurfaces(registry, "pinned");
  const panes = visiblePanes(registry, "pinned");
  const activeId = panes.pane0;
  const active = activeId ? surfaceById(registry, activeId) : undefined;
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

  const widthPct = Math.round(registry.pinnedWidthFrac * 1000) / 10;

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
      <div className="work-surface-dock__inner">
        <WorkbenchChrome
          zone="pinned"
          paneIds={[panes.pane0, panes.pane1]}
          tabs={panes.tabs}
          activeId={active?.id}
        />
        <WorkbenchPanes zone="pinned" />
      </div>
    </aside>
  );
}
