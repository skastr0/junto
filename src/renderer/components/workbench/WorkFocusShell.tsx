import { useCallback, useEffect, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import {
  closeWorkbenchSurface,
  dock$,
  setWorkbenchFocusSize,
} from "../../lib/dock-state";
import {
  focusDockChromeVisible,
  panesForLayout,
  surfaceById,
  workFocusSizeKeyForSurfaces,
  type WorkFocusSizeKey,
} from "../../lib/surface-registry";
import {
  actorTerminalRailsPx,
  type FocusMeasure,
} from "../../lib/focus-measure";
import { scheduleFocusPrimaryControl } from "../../lib/focus-ownership";
import { parseTerminalSurfaceId } from "../../lib/dock-state";
import { terminal$ } from "../../lib/terminal-state";
import { actorRailExpanded, actorRailMode } from "../../lib/actor-rail";
import { sidebarSections$ } from "../../lib/sidebar-sections";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { WorkbenchChrome } from "./WorkbenchChrome";
import { WorkbenchPanes } from "./WorkbenchPanes";
import { saveAndCloseNoteSurface } from "./NoteSurface";

/**
 * An actor terminal carries the connected agents rail beside the xterm:
 * expanded, collapsed to a strip, or absent when the seat has no connections.
 * The panel budgets that width so the xterm keeps its target columns. Read
 * through a selector that returns the mode, so the shell re-renders when the
 * mode changes, never on every doc write.
 */
const railsForFrontSurface = (frontId: string | undefined): number => {
  if (!frontId) return 0;
  const nodeId = parseTerminalSurfaceId(frontId);
  if (!nodeId || !terminal$.openByNodeId[nodeId].get()) return 0;
  return actorTerminalRailsPx(
    actorRailMode(state$.doc.get(), nodeId, actorRailExpanded(sidebarSections$.open.get())),
  );
};

/** Map shell size family → FocusSurface measure token. */
const measureForSizeKey = (key: WorkFocusSizeKey): FocusMeasure => {
  switch (key) {
    case "terminal":
      return "terminal";
    case "document":
      return "document";
    case "chat":
    case "task-create":
    case "workspace":
      return "workspace";
    default:
      return "workspace";
  }
};

/**
 * Centered focus-zone shell. Mounts when focus zone is non-empty.
 * Measure / remembered width is keyed by surface family so a resized
 * terminal cannot leave task-create (or other) modals stuck narrow.
 * Slots are registered synchronously via dock-state observe.
 */
export function WorkFocusShell() {
  // A primitive fingerprint lets Legend recompute on registry surface writes
  // without rerendering this shell for pinned-only churn.
  const focusSurfaceFingerprint = use$(() =>
    JSON.stringify(
      dock$.registry.surfaces
        .get()
        .filter((surface) => surface.zone === "focus")
        .map((surface) => [surface.id, surface.kind]),
    ),
  );
  const focusMru = use$(dock$.registry.focusMru);
  const focusLayout = use$(dock$.registry.focusLayout);

  const registry = dock$.registry.peek();
  const hasFocus = focusSurfaceFingerprint !== "[]";
  const focusSurfaces = registry.surfaces.filter((s) => s.zone === "focus");
  const sizeKey = workFocusSizeKeyForSurfaces(focusSurfaces);
  const onlyChats = sizeKey === "chat";
  const onlyTaskCreate = sizeKey === "task-create";
  const onlyNotes = sizeKey === "document";
  const measure = measureForSizeKey(sizeKey);
  // Dock chrome (tabs / split / pin-all) is for multi-surface browser work.
  // Pure terminal focus uses surface-local Pin + Close — reusing the
  // side-dock strip here was noise (fake single tab + split toggle).
  const showDockChrome = focusDockChromeVisible(registry);

  const paneCount = panesForLayout(focusLayout);
  const pane0 = focusMru[0];
  const terminalRailsPx = use$(() => (sizeKey === "terminal" ? railsForFrontSurface(pane0) : 0));
  const pane1 = paneCount === 2 ? focusMru[1] : undefined;
  const tabs = focusMru.slice(paneCount);
  const activeId = pane0;
  const active = activeId ? surfaceById(registry, activeId) : undefined;
  // Native-view placement reads this panel's rect every frame it changes; a
  // presenting browser pane must not inherit the panel entry animation or the
  // placed view wobbles through the 160ms settle.
  const onlyBrowser = active?.kind === "browser";

  const closeAllFocus = useCallback(() => {
    const surfaces = dock$.registry
      .peek()
      .surfaces.filter((surface) => surface.zone === "focus");
    for (const surface of surfaces) {
      if (surface.kind === "note") saveAndCloseNoteSurface(surface.id);
      else closeWorkbenchSurface(surface.id);
    }
  }, []);

  const panelObserverRef = useRef<ResizeObserver | null>(null);
  const lastWritten = useRef<number | null>(null);
  const lastRails = useRef<{ readonly front: string | undefined; readonly px: number } | null>(null);
  useEffect(() => {
    if (!hasFocus) return;
    // The rail changed width under the same terminal (collapsed or expanded):
    // the panel keeps its box and the terminal takes or gives the difference,
    // in one step. Moving to another agent keeps the terminal's width instead.
    const before = lastRails.current;
    lastRails.current = { front: pane0, px: terminalRailsPx };
    if (before && before.front === pane0 && before.px !== terminalRailsPx) {
      const remembered = dock$.registry.peek().focusSize;
      if (remembered && remembered.key === sizeKey) {
        setWorkbenchFocusSize({ ...remembered, width: remembered.width + before.px - terminalRailsPx });
      }
    }
    const id = requestAnimationFrame(() => {
      const panel = document.querySelector(
        ".focus-surface__panel.work-focus-shell__panel",
      ) as HTMLElement | null;
      if (!panel) return;
      // Width only, and only when memory matches this surface family.
      // Mismatched keys clear inline width so CSS measure (terminal / workspace
      // / task-create) owns the box after pin/unpin or kind switches.
      // Remembered width is the CONTENT width — the panel minus whatever the
      // right instrument pane occupies. Storing the whole panel box instead
      // freezes that pane into the user's terminal-width dial.
      const stored = dock$.registry.peek().focusSize;
      if (stored && stored.key === sizeKey) {
        const width = stored.width + terminalRailsPx;
        panel.style.width = `${width}px`;
        lastWritten.current = width;
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
          width: w - terminalRailsPx,
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
    // terminalRailsPx remains part of the dependency contract if a future
    // instrument-pane presentation changes width.
  }, [hasFocus, sizeKey, terminalRailsPx, pane0]);

  // Front-surface changes keep the same FocusSurface mounted — re-claim the
  // new terminal / composer so typing lands immediately.
  useEffect(() => {
    if (!hasFocus || !activeId) return;
    return scheduleFocusPrimaryControl(
      () =>
        document.querySelector(
          ".focus-surface__panel.work-focus-shell__panel",
        ) as HTMLElement | null,
    );
  }, [hasFocus, activeId]);

  if (!hasFocus) return null;

  // contain=parent: fill .junto-stage-main only. Body portal would cover the
  // pinned dock sibling and break wheel/pointer on pinned PTYs whenever any
  // focus surface is still open (multi-stream pin + focus).
  return (
    <FocusSurface
      measure={measure}
      height="immersive"
      contain="parent"
      terminalRailsPx={terminalRailsPx}
      label={active?.kind === "note" ? "Edit note" : active ? `Workbench - ${active.kind}` : "Workbench focus"}
      onClose={closeAllFocus}
      closeOnEscape={false}
      closeOnBackdrop
      panelClassName={`work-focus-shell__panel${onlyChats ? " work-focus-shell__panel--chat" : ""}${onlyTaskCreate ? " work-focus-shell__panel--task-create" : ""}${onlyNotes ? " work-focus-shell__panel--note" : ""}${onlyBrowser ? " work-focus-shell__panel--browser" : ""}`}
    >
      <div className="work-focus-shell">
        {showDockChrome ? (
          <WorkbenchChrome
            zone="focus"
            paneIds={[pane0, pane1]}
            tabs={tabs}
            activeId={activeId}
          />
        ) : null}
        <WorkbenchPanes zone="focus" />
      </div>
    </FocusSurface>
  );
}
