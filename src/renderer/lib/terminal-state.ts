import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";

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
  sessionByBindingId: {} as Record<string, TerminalSessionSummary | undefined>,
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

/**
 * Forget one terminal's view state. The workbench (dock-state) calls this when
 * a terminal surface leaves the registry, and the grid when it lets go of a
 * view it owned. Nothing else decides that a terminal is closed.
 */
export const dropTerminalView = (nodeId: string): void => {
  terminal$.openByNodeId[nodeId].delete();
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
    dropTerminalView(nodeId);
  }
};

export const terminalNodeIds = (): readonly string[] =>
  Object.keys(terminal$.openByNodeId.peek());
