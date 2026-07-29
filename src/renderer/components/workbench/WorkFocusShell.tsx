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
  const onlyChats =
    focusSurfaces.length > 0 &&
    focusSurfaces.every((s) => s.kind === "chat");
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
  const lastWritten = useRef<number | null>(null);
  useEffect(() => {
    if (!hasFocus) return;
    const id = requestAnimationFrame(() => {
      const panel = document.querySelector(
        ".focus-surface__panel.work-focus-shell__panel",
      ) as HTMLElement | null;
      if (!panel) return;
      // Width only: height is stage-fixed in CSS so the shell opens at the
      // same height every time. A remembered height made each open inherit
      // the last resize (and the last surface kind's natural box).
      const stored = dock$.registry.peek().focusSize;
      if (stored) {
        panel.style.width = `${stored.width}px`;
        lastWritten.current = stored.width;
      }
      panelObserverRef.current?.disconnect();
      const obs = new ResizeObserver(() => {
        const w = panel.offsetWidth;
        if (lastWritten.current === w) return;
        lastWritten.current = w;
        setWorkbenchFocusSize({ width: w, height: panel.offsetHeight });
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

  // contain=parent: fill .vellum-stage-main only. Body portal would cover the
  // pinned dock sibling and break wheel/pointer on pinned PTYs whenever any
  // focus surface is still open (multi-stream pin + focus).
  return (
    <FocusSurface
      measure={measure}
      height="immersive"
      layer="work"
      contain="parent"
      label={active ? `Workbench · ${active.kind}` : "Workbench focus"}
      onClose={closeAllFocus}
      closeOnEscape={false}
      closeOnBackdrop
      panelClassName={`work-focus-shell__panel${onlyChats ? " work-focus-shell__panel--chat" : ""}`}
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
