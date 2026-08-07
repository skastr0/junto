import { useCallback, useEffect, useMemo, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import {
  closeWorkbenchSurface,
  dock$,
  parseTerminalSurfaceId,
  setWorkbenchFocusSize,
} from "../../lib/dock-state";
import { actorEdgeRows } from "../../lib/actor-edges";
import {
  surfaceById,
  visiblePanes,
  workFocusSizeKeyForSurfaces,
  zoneHasSurfaces,
  type WorkFocusSizeKey,
} from "../../lib/surface-registry";
import type { FocusMeasure } from "../../lib/focus-measure";
import { state$ } from "../../lib/state";
import { terminal$ } from "../../lib/terminal-state";
import { FocusSurface } from "../FocusSurface";
import { ActorEdgesGlance } from "../terminal/ActorEdgesGlance";
import { WorkbenchChrome } from "./WorkbenchChrome";
import { WorkbenchPanes } from "./WorkbenchPanes";

/** Map shell size family → FocusSurface measure token. */
const measureForSizeKey = (key: WorkFocusSizeKey): FocusMeasure => {
  switch (key) {
    case "terminal":
      return "terminal";
    case "chat":
    case "task-create":
    case "workspace":
      return "workspace";
  }
};

/**
 * Centered focus-zone shell. Mounts when focus zone is non-empty.
 * Measure / remembered width is keyed by surface family so a resized
 * terminal cannot leave task-create (or other) modals stuck narrow.
 * Herdr slots are registered synchronously via dock-state observe.
 */
export function WorkFocusShell() {
  const registry = use$(dock$.registry);

  const hasFocus = zoneHasSurfaces(registry, "focus");
  const focusSurfaces = registry.surfaces.filter((s) => s.zone === "focus");
  const sizeKey = workFocusSizeKeyForSurfaces(focusSurfaces);
  const onlyTerminals = sizeKey === "terminal";
  const onlyChats = sizeKey === "chat";
  const onlyTaskCreate = sizeKey === "task-create";
  const measure = measureForSizeKey(sizeKey);
  // Dock chrome (tabs / split / pin-all) is for multi-surface browser work.
  // Pure terminal/herdr focus uses surface-local Pin + Close — reusing the
  // side-dock strip here was noise (fake single tab + split toggle).
  const showDockChrome = focusSurfaces.length > 1 && !onlyTerminals;

  const panes = visiblePanes(registry, "focus");
  const activeId = panes.pane0;
  const active = activeId ? surfaceById(registry, activeId) : undefined;
  // Terminal open map — edges rail rides outside the modal plate for the active agent.
  const openByNodeId = use$(terminal$.openByNodeId);
  const doc = use$(state$.doc);
  const edgesAsideNode = useMemo(() => {
    if (!active || active.kind !== "terminal") return null;
    const nodeId = parseTerminalSurfaceId(active.id);
    if (!nodeId) return null;
    const node = openByNodeId?.[nodeId];
    if (!node) return null;
    // Only mount the aside when there is at least one incident edge — empty
    // aside would still shrink the panel via --has-aside.
    return actorEdgeRows(doc, node.id).length > 0 ? node : null;
  }, [active, openByNodeId, doc]);

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
      // Width only, and only when memory matches this surface family.
      // Mismatched keys clear inline width so CSS measure (terminal / workspace
      // / task-create) owns the box after pin/unpin or kind switches.
      const stored = dock$.registry.peek().focusSize;
      if (stored && stored.key === sizeKey) {
        panel.style.width = `${stored.width}px`;
        lastWritten.current = stored.width;
      } else {
        panel.style.removeProperty("width");
        lastWritten.current = null;
      }
      panelObserverRef.current?.disconnect();
      const obs = new ResizeObserver(() => {
        const w = panel.offsetWidth;
        if (lastWritten.current === w) return;
        lastWritten.current = w;
        setWorkbenchFocusSize({
          key: sizeKey,
          width: w,
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
  }, [hasFocus, sizeKey]);

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
      label={active ? `Workbench - ${active.kind}` : "Workbench focus"}
      onClose={closeAllFocus}
      closeOnEscape={false}
      closeOnBackdrop
      panelClassName={`work-focus-shell__panel${onlyChats ? " work-focus-shell__panel--chat" : ""}${onlyTaskCreate ? " work-focus-shell__panel--task-create" : ""}`}
      aside={
        edgesAsideNode ? <ActorEdgesGlance node={edgesAsideNode} /> : undefined
      }
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
