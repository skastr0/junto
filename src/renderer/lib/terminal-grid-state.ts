import { observable } from "@legendapp/state";
import { nodeAt } from "./use-model";
import { nodeToDocument } from "@shared/model/from-document";
import { state$ } from "./state";
import { openAgentGridTerminals } from "./terminal-actions";
import { closeGridTerminalSurfaces } from "./terminal-state";
import type { GridChoice } from "./terminal-grid";

/**
 * The grid focus modal: which agent seats it shows, the operator's shape
 * choice, and the current page. Empty `nodeIds` means closed.
 */
export const terminalGrid$ = observable({
  nodeIds: [] as string[],
  choice: "auto" as GridChoice,
  page: 0,
});

/** Open the grid on these agent seats, in selection order. */
export const openTerminalGrid = (
  nodeIds: ReadonlyArray<string>,
  choice: GridChoice = "auto",
): void => {
  const canvas = state$.canvasName.peek();
  const ordered = nodeIds.flatMap((id) => {
    const node = nodeAt(canvas, id);
    return node ? [node] : [];
  });
  // canvas-nodes owns this last inner boundary until the grid opener takes native nodes.
  const opened = openAgentGridTerminals(ordered.map(nodeToDocument));
  if (opened.length === 0) return;
  terminalGrid$.set({ nodeIds: [...opened], choice, page: 0 });
};

export const setTerminalGridChoice = (choice: GridChoice): void => {
  terminalGrid$.choice.set(choice);
  terminalGrid$.page.set(0);
};

export const setTerminalGridPage = (page: number): void => {
  terminalGrid$.page.set(Math.max(0, page));
};

/** Close the grid. Views the grid opened close; processes keep running. */
export const closeTerminalGrid = (): void => {
  terminalGrid$.nodeIds.set([]);
  closeGridTerminalSurfaces();
};
