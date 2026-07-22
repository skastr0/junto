import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";

export const terminal$ = observable({
  openByNodeId: {} as Record<string, CanvasNode>,
  sessionByBindingId: {} as Record<string, TerminalSessionSummary | undefined>,
  inventoryOpen: false,
});

export const openTerminalSurface = (node: CanvasNode): void => {
  if (resolveTerminalBinding(node)?.kind !== "native") return;
  terminal$.openByNodeId[node.id].set(node);
};

export const closeTerminalSurface = (nodeId: string): void => {
  terminal$.openByNodeId[nodeId].delete();
};

export const terminalNodeIds = (): readonly string[] =>
  Object.keys(terminal$.openByNodeId.peek());
