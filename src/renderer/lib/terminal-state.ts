import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import { DEFAULT_ACTOR_RAILS_OPEN, type ActorRailsOpen } from "./focus-measure";
import type { WorkZone } from "./surface-registry";

/**
 * Pane slot handles live outside Legend. The store only carries a generation
 * so PersistentTerminalHost re-adopts when WorkbenchPanes mounts a slot.
 * Putting an HTMLElement into an observable walks the live DOM (parent,
 * children, document) and overflows.
 */
const terminalSlotElements = new Map<string, HTMLElement>();

export const terminalSlots$ = observable({
  generationByNodeId: {} as Record<string, number>,
});

export const registerTerminalSlot = (
  nodeId: string | null,
  element: HTMLElement | null,
): void => {
  if (!nodeId) return;
  if (element) {
    terminalSlotElements.set(nodeId, element);
    terminalSlots$.generationByNodeId[nodeId].set(
      (terminalSlots$.generationByNodeId[nodeId].peek() ?? 0) + 1,
    );
  } else {
    terminalSlotElements.delete(nodeId);
    terminalSlots$.generationByNodeId[nodeId].delete();
  }
};

/**
 * Grid focus cells outrank workbench slots while the grid is open. They live
 * in their own map so a grid cell releasing its terminal hands it back to the
 * pinned or focus pane that still holds a slot, instead of orphaning it.
 */
const gridSlotElements = new Map<string, HTMLElement>();

const bumpSlotGeneration = (nodeId: string): void => {
  terminalSlots$.generationByNodeId[nodeId].set(
    (terminalSlots$.generationByNodeId[nodeId].peek() ?? 0) + 1,
  );
};

export const registerGridTerminalSlot = (
  nodeId: string,
  element: HTMLElement | null,
): void => {
  if (element) {
    if (gridSlotElements.get(nodeId) === element) return;
    gridSlotElements.set(nodeId, element);
  } else {
    if (!gridSlotElements.has(nodeId)) return;
    gridSlotElements.delete(nodeId);
  }
  bumpSlotGeneration(nodeId);
};

export const terminalSlotElement = (nodeId: string): HTMLElement | null =>
  gridSlotElements.get(nodeId) ?? terminalSlotElements.get(nodeId) ?? null;

export const terminal$ = observable({
  openByNodeId: {} as Record<string, CanvasNode>,
  /**
   * Canvas each surface was opened from. Node-keyed surfaces survive canvas
   * navigation; canvas-scoped consumers (the actor ledger) must not project
   * or mutate a different ambient canvas onto a surviving surface.
   */
  canvasByNodeId: {} as Record<string, string | undefined>,
  /**
   * Zone preferred on the next open/reconcile for that node.
   * Consumed by dock-state when registering the workbench surface so open can
   * land in pinned without a focus flash.
   */
  preferredZoneByNodeId: {} as Record<string, WorkZone>,
  /** Bumps on every open so dock observe re-runs even for re-open-with-zone. */
  openSeq: 0,
  /**
   * Node of the most recent open request. The dock observe promotes exactly
   * this surface to MRU front — promoting every open surface in insertion
   * order meant re-opening an earlier terminal could never reach the front.
   */
  lastOpenNodeId: null as string | null,
  sessionByBindingId: {} as Record<string, TerminalSessionSummary | undefined>,
  /**
   * Actor side rails (ledger / connections) per node, expanded or collapsed.
   *
   * Shared rather than pane-local because the focus panel budgets their width:
   * the panel must grow and shrink with the rails so the xterm keeps its target
   * columns either way. Node-keyed, so a collapsed rail survives a re-open.
   */
  railsOpenByNodeId: {} as Record<string, Partial<ActorRailsOpen> | undefined>,
  inventoryOpen: false,
  /**
   * Grid focus view options per node, present only while a grid cell holds
   * that terminal. View-only: never written to durable terminal settings, and
   * dropping the entry restores the operator's own options.
   */
  gridCellByNodeId: {} as Record<string, { readonly fontSize: number } | undefined>,
  /**
   * Nodes the grid opened itself. They never enter the workbench dock and
   * their views close with the grid; their processes keep running.
   */
  gridOwnedByNodeId: {} as Record<string, true | undefined>,
});

/** Rail state for one node, with the mount default filled in. */
export const actorRailsOpen = (
  nodeId: string,
  stored?: Record<string, Partial<ActorRailsOpen> | undefined>,
): ActorRailsOpen => {
  const rails = stored
    ? stored[nodeId]
    : terminal$.railsOpenByNodeId[nodeId].peek();
  return { ...DEFAULT_ACTOR_RAILS_OPEN, ...(rails ?? {}) };
};

export const setActorRailOpen = (
  nodeId: string,
  rail: keyof ActorRailsOpen,
  open: boolean,
): void => {
  terminal$.railsOpenByNodeId[nodeId].set({
    ...actorRailsOpen(nodeId),
    [rail]: open,
  });
};

export const openTerminalSurface = (
  node: CanvasNode,
  zone: WorkZone = "focus",
  canvasName?: string,
): void => {
  if (resolveTerminalBinding(node)?.kind !== "native") return;
  if (canvasName !== undefined) {
    terminal$.canvasByNodeId[node.id].set(canvasName);
  }
  // One-shot zone for the next dock reconcile (consumed there).
  terminal$.preferredZoneByNodeId[node.id].set(zone);
  // A normal open adopts a grid-owned view into the dock for good.
  terminal$.gridOwnedByNodeId[node.id].delete();
  // One-shot promote target — must be set BEFORE openByNodeId: that set
  // triggers the dock observe synchronously, which consumes this value.
  terminal$.lastOpenNodeId.set(node.id);
  terminal$.openByNodeId[node.id].set(node);
  terminal$.openSeq.set(terminal$.openSeq.peek() + 1);
};

export const closeTerminalSurface = (nodeId: string): void => {
  terminal$.openByNodeId[nodeId].delete();
  terminal$.preferredZoneByNodeId[nodeId].delete();
  terminal$.gridOwnedByNodeId[nodeId].delete();
  terminal$.gridCellByNodeId[nodeId].delete();
};

/**
 * Mount a terminal for the grid view. An already-open terminal is reused as
 * is (the grid adopts its one live surface, never a second xterm on the same
 * PTY); a closed one opens grid-owned, outside the dock.
 */
export const openGridTerminalSurface = (
  node: CanvasNode,
  canvasName?: string,
): void => {
  if (resolveTerminalBinding(node)?.kind !== "native") return;
  if (terminal$.openByNodeId[node.id].peek()) return;
  if (canvasName !== undefined) {
    terminal$.canvasByNodeId[node.id].set(canvasName);
  }
  // Must precede openByNodeId: that set runs the dock observe synchronously.
  terminal$.gridOwnedByNodeId[node.id].set(true);
  terminal$.openByNodeId[node.id].set(node);
};

/** Show one grid cell's terminal with grid-only options, or release it. */
export const setGridTerminalCell = (
  nodeId: string,
  cell: { readonly fontSize: number } | null,
): void => {
  if (cell === null) {
    terminal$.gridCellByNodeId[nodeId].delete();
    return;
  }
  if (terminal$.gridCellByNodeId[nodeId].peek()?.fontSize === cell.fontSize) return;
  terminal$.gridCellByNodeId[nodeId].set(cell);
};

/**
 * Leave the grid: release every cell and close the views the grid opened.
 * Terminals that were pinned or focused before stay open in their panes.
 */
export const closeGridTerminalSurfaces = (): void => {
  for (const nodeId of Object.keys(terminal$.gridCellByNodeId.peek())) {
    terminal$.gridCellByNodeId[nodeId].delete();
  }
  for (const nodeId of Object.keys(terminal$.gridOwnedByNodeId.peek())) {
    closeTerminalSurface(nodeId);
  }
};

/** Drop every open terminal surface so a crashed view can remount clean. */
export const closeAllTerminalSurfaces = (): void => {
  for (const nodeId of Object.keys(terminal$.openByNodeId.peek())) {
    closeTerminalSurface(nodeId);
  }
  terminal$.lastOpenNodeId.set(null);
};

export const terminalNodeIds = (): readonly string[] =>
  Object.keys(terminal$.openByNodeId.peek());
