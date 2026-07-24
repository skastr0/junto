import { useCallback, useEffect, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import {
  closeWorkbenchSurface,
  dock$,
  setWorkbenchFocusSize,
} from "../../lib/dock-state";
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
 * Herdr slots are registered synchronously via dock-state observe.
 */
export function WorkFocusShell() {
  const registry = use$(dock$.registry);

  const hasFocus = zoneHasSurfaces(registry, "focus");
  const focusSurfaces = registry.surfaces.filter((s) => s.zone === "focus");
  const onlyTerminals =
    focusSurfaces.length > 0 &&
    focusSurfaces.every((s) => s.kind === "herdr" || s.kind === "terminal");
  const measure = onlyTerminals ? "terminal" : "workspace";
  // Dock chrome (tabs / split / pin-all) is for multi-surface browser work.
  // Pure terminal/herdr focus uses surface-local Pin + Close — reusing the
  // side-dock strip here was noise (fake single tab + split toggle).
  const showDockChrome = focusSurfaces.length > 1 && !onlyTerminals;

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
  const lastWritten = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!hasFocus) return;
    const id = requestAnimationFrame(() => {
      const panel = document.querySelector(
        ".focus-surface__panel.work-focus-shell__panel",
      ) as HTMLElement | null;
      if (!panel) return;
      const stored = dock$.registry.peek().focusSize;
      if (stored) {
        panel.style.width = `${stored.width}px`;
        panel.style.height = `${stored.height}px`;
        lastWritten.current = { w: stored.width, h: stored.height };
      }
      panelObserverRef.current?.disconnect();
      const obs = new ResizeObserver(() => {
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        const prev = lastWritten.current;
        if (prev && prev.w === w && prev.h === h) return;
        lastWritten.current = { w, h };
        setWorkbenchFocusSize({ width: w, height: h });
      });
      obs.observe(panel);
      panelObserverRef.current = obs;
    });
    return () => {
      cancelAnimationFrame(id);
      panelObserverRef.current?.disconnect();
      panelObserverRef.current = null;
    };
  }, [hasFocus, measure]);

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
        {showDockChrome ? (
          <WorkbenchChrome
            zone="focus"
            paneIds={[panes.pane0, panes.pane1]}
            tabs={panes.tabs}
            activeId={activeId}
          />
        ) : null}
        <WorkbenchPanes zone="focus" />
      </div>
    </FocusSurface>
  );
}
