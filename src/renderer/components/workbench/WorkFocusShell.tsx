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
  type ActorRailsOpen,
  type FocusMeasure,
} from "../../lib/focus-measure";
import { scheduleFocusPrimaryControl } from "../../lib/focus-ownership";
import { parseTerminalSurfaceId } from "../../lib/dock-state";
import { actorRailsOpen, terminal$ } from "../../lib/terminal-state";
import { isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import { FocusSurface } from "../FocusSurface";
import { WorkbenchChrome } from "./WorkbenchChrome";
import { WorkbenchPanes } from "./WorkbenchPanes";

/**
 * Actor terminals carry in-panel side rails (ledger + connections); the panel
 * budgets their CURRENT width so the xterm keeps its target columns. Collapsing
 * a rail narrows the panel by what the rail gave up — it does not hand those
 * pixels to the terminal, and expanding one grows the panel outwards instead of
 * eating columns. Raw shells and herdr panes stay at the bare terminal measure.
 */
const railsForFrontSurface = (
  frontId: string | undefined,
  railsOpen: Record<string, Partial<ActorRailsOpen> | undefined>,
): number => {
  if (!frontId) return 0;
  const nodeId = parseTerminalSurfaceId(frontId);
  if (!nodeId) return 0;
  const node = terminal$.openByNodeId[nodeId].peek();
  if (!node) return 0;
  const role = roleOf(
    resolveSpec({ isGroup: isGroup(node), kind: node.ether?.entity?.kind }),
  );
  return role === "actor"
    ? actorTerminalRailsPx(actorRailsOpen(nodeId, railsOpen))
    : 0;
};

/** Map shell size family → FocusSurface measure token. */
const measureForSizeKey = (key: WorkFocusSizeKey): FocusMeasure => {
  switch (key) {
    case "terminal":
      return "terminal";
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
 * Herdr slots are registered synchronously via dock-state observe.
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
  const measure = measureForSizeKey(sizeKey);
  // Dock chrome (tabs / split / pin-all) is for multi-surface browser work.
  // Pure terminal/herdr focus uses surface-local Pin + Close — reusing the
  // side-dock strip here was noise (fake single tab + split toggle).
  const showDockChrome = focusDockChromeVisible(registry);

  const paneCount = panesForLayout(focusLayout);
  const pane0 = focusMru[0];
  // Tracked: collapsing or expanding a rail must re-budget the panel.
  const railsOpen = use$(terminal$.railsOpenByNodeId);
  const terminalRailsPx =
    sizeKey === "terminal" ? railsForFrontSurface(pane0, railsOpen) : 0;
  const pane1 = paneCount === 2 ? focusMru[1] : undefined;
  const tabs = focusMru.slice(paneCount);
  const activeId = pane0;
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
      // Width only, and only when memory matches this surface family.
      // Mismatched keys clear inline width so CSS measure (terminal / workspace
      // / task-create) owns the box after pin/unpin or kind switches.
      // Remembered width is the CONTENT width — the panel minus whatever the
      // side rails occupy right now. Storing the whole panel box instead froze
      // the rails budget into the dial: re-opening applied a width measured
      // while the rails were expanded, the rails then collapsed inside it, and
      // the xterm quietly grew by the slack.
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
    // terminalRailsPx: a rail toggle must re-apply the inline width, or the
    // panel stays at the box it was mounted with and the stage absorbs the
    // difference.
  }, [hasFocus, sizeKey, terminalRailsPx]);

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

  // contain=parent: fill .vellum-stage-main only. Body portal would cover the
  // pinned dock sibling and break wheel/pointer on pinned PTYs whenever any
  // focus surface is still open (multi-stream pin + focus).
  return (
    <FocusSurface
      measure={measure}
      height="immersive"
      layer="work"
      contain="parent"
      terminalRailsPx={terminalRailsPx}
      label={active ? `Workbench - ${active.kind}` : "Workbench focus"}
      onClose={closeAllFocus}
      closeOnEscape={false}
      closeOnBackdrop
      panelClassName={`work-focus-shell__panel${onlyChats ? " work-focus-shell__panel--chat" : ""}${onlyTaskCreate ? " work-focus-shell__panel--task-create" : ""}`}
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
