import { observe } from "@legendapp/state";
import { closeTerminalView, closeWorkbenchSurface, dock$, nodeIdForSurface } from "./dock-state";
import { state$ } from "./state";
import { closeTerminalGrid, terminalGrid$ } from "./terminal-grid-state";
import { terminalNodeIds } from "./terminal-state";
import { modelStore } from "./use-model";

/**
 * A view never outlives its node. When a node leaves the canvas, by the
 * operator's own delete or by a write from anywhere else (the CLI, an
 * overseer, another window), every view of it closes: its workbench surface
 * of whatever kind, and its cell in the terminal grid. The close is an
 * ordinary close, so the keyboard goes where it goes on any close.
 *
 * Views deliberately survive canvas navigation, so only a node that leaves
 * the canvas being shown counts: opening another canvas closes nothing.
 */

/** Close every view of these nodes. */
export const closeViewsOfNodes = (gone: ReadonlySet<string>): void => {
  for (const surface of dock$.registry.peek().surfaces) {
    const nodeId = nodeIdForSurface(surface);
    if (nodeId !== null && gone.has(nodeId)) closeWorkbenchSurface(surface.id);
  }
  // The grid lets go of the cell, and closes with its last one.
  const cells = terminalGrid$.nodeIds.peek();
  const kept = cells.filter((nodeId) => !gone.has(nodeId));
  if (kept.length === 0 && cells.length > 0) closeTerminalGrid();
  else if (kept.length !== cells.length) terminalGrid$.nodeIds.set(kept);
  // Terminal views the grid opened itself never joined the workbench.
  for (const nodeId of terminalNodeIds()) {
    if (gone.has(nodeId)) closeTerminalView(nodeId);
  }
};

/** The nodes that were on the canvas and no longer are. */
export const removedNodeIds = (
  before: ReadonlySet<string>,
  after: ReadonlyArray<string>,
): Set<string> => {
  const gone = new Set(before);
  for (const id of after) gone.delete(id);
  return gone;
};

/**
 * Watch the canvas being shown and close the views of nodes that leave it.
 * Only a canvas the store holds open says what is on it: while it is being
 * read, or was not read, nothing is known to have left.
 */
export const installRemovedNodeViews = (): (() => void) => {
  let canvas = "";
  let known: ReadonlySet<string> = new Set();
  return observe(
    () => {
      const name = state$.canvasName.get();
      if (name === "") return undefined;
      const open$ = modelStore.canvas$(name);
      return open$.status.get() === "open" ? { name, ids: open$.nodeIds.get() } : undefined;
    },
    ({ value: shown }) => {
      if (shown === undefined) return;
      // Another canvas was opened: its nodes are a new set, nothing was removed.
      const gone = shown.name === canvas ? removedNodeIds(known, shown.ids) : new Set<string>();
      canvas = shown.name;
      known = new Set(shown.ids);
      if (gone.size > 0) closeViewsOfNodes(gone);
    },
  );
};
