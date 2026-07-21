import { useCallback, useEffect, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import {
  closeWorkbenchSurface,
  dock$,
  setWorkbenchFocusSize,
  syncHerdrWorkbenchSlot,
} from "../../lib/dock-state";
import { herdr$ } from "../../lib/herdr-state";
import {
  surfaceById,
  visiblePanes,
  zoneHasSurfaces,
} from "../../lib/surface-registry";
import { FocusSurface } from "../FocusSurface";
import { WorkbenchChrome } from "./WorkbenchChrome";
import { WorkbenchPanes } from "./WorkbenchPanes";

/**
 * Centered focus-zone shell. Mounts when focus zone is non-empty.
 * Measure: terminal when only herdr; workspace otherwise (browser / split).
 * All herdr streams go through workbench shells — modal yields when registered.
 */
export function WorkFocusShell() {
  const registry = use$(dock$.registry);
  const terminals = use$(herdr$.terminals);
  const terminalCount = Object.keys(terminals).length;

  // Keep herdr slots in registry whenever terminals open/close.
  useEffect(() => {
    syncHerdrWorkbenchSlot();
  }, [terminalCount]);

  const hasFocus = zoneHasSurfaces(registry, "focus");
  const focusSurfaces = registry.surfaces.filter((s) => s.zone === "focus");
  const onlyHerdr =
    focusSurfaces.length > 0 && focusSurfaces.every((s) => s.kind === "herdr");
  const measure = onlyHerdr ? "terminal" : "workspace";

  const panes = visiblePanes(registry, "focus");
  const activeId = panes.pane0;
  const active = activeId ? surfaceById(registry, activeId) : undefined;

  const closeAllFocus = useCallback(() => {
    const ids = dock$.registry
      .peek()
      .surfaces.filter((s) => s.zone === "focus")
      .map((s) => s.id);
    for (const id of ids) closeWorkbenchSurface(id);
  }, []);

  const panelObserverRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (!hasFocus) return;
    const id = requestAnimationFrame(() => {
      const panel = document.querySelector(
        ".focus-surface__panel.work-focus-shell__panel",
      ) as HTMLElement | null;
      if (!panel) return;
      const stored = registry.focusSize;
      if (stored) {
        panel.style.width = `${stored.width}px`;
        panel.style.height = `${stored.height}px`;
      }
      panelObserverRef.current?.disconnect();
      const obs = new ResizeObserver(() => {
        setWorkbenchFocusSize({
          width: panel.offsetWidth,
          height: panel.offsetHeight,
        });
      });
      obs.observe(panel);
      panelObserverRef.current = obs;
    });
    return () => {
      cancelAnimationFrame(id);
      panelObserverRef.current?.disconnect();
      panelObserverRef.current = null;
    };
  }, [hasFocus, measure, registry.focusSize?.width, registry.focusSize?.height]);

  if (!hasFocus) return null;

  return (
    <FocusSurface
      measure={measure}
      height="immersive"
      layer="work"
      label={active ? `Workbench · ${active.kind}` : "Workbench focus"}
      onClose={closeAllFocus}
      closeOnEscape={false}
      closeOnBackdrop
      panelClassName="work-focus-shell__panel"
    >
      <div className="work-focus-shell">
        <WorkbenchChrome
          zone="focus"
          paneIds={[panes.pane0, panes.pane1]}
          tabs={panes.tabs}
          activeId={activeId}
        />
        <WorkbenchPanes zone="focus" />
      </div>
    </FocusSurface>
  );
}
