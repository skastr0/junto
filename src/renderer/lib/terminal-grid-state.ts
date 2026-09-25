import { observable } from "@legendapp/state";
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
  const wanted = new Set(nodeIds);
  const nodes = state$.doc.peek().nodes.filter((node) => wanted.has(node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered = nodeIds.flatMap((id) => {
    const node = byId.get(id);
    return node ? [node] : [];
  });
  const opened = openAgentGridTerminals(ordered);
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
