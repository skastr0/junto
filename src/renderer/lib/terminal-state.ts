import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import type { WorkZone } from "./surface-registry";

export const terminal$ = observable({
  openByNodeId: {} as Record<string, CanvasNode>,
  /**
   * Zone preferred on the next open/reconcile for that node.
   * Consumed by dock-state when registering the workbench surface so open can
   * land in pinned without a focus flash.
   */
  preferredZoneByNodeId: {} as Record<string, WorkZone>,
  /** Bumps on every open so dock observe re-runs even for re-open-with-zone. */
  openSeq: 0,
  sessionByBindingId: {} as Record<string, TerminalSessionSummary | undefined>,
  inventoryOpen: false,
});

export const openTerminalSurface = (
  node: CanvasNode,
  zone: WorkZone = "focus",
): void => {
  if (resolveTerminalBinding(node)?.kind !== "native") return;
  // One-shot zone for the next dock reconcile (consumed there).
  terminal$.preferredZoneByNodeId[node.id].set(zone);
  terminal$.openByNodeId[node.id].set(node);
  terminal$.openSeq.set(terminal$.openSeq.peek() + 1);
};

export const closeTerminalSurface = (nodeId: string): void => {
  terminal$.openByNodeId[nodeId].delete();
  terminal$.preferredZoneByNodeId[nodeId].delete();
};

export const terminalNodeIds = (): readonly string[] =>
  Object.keys(terminal$.openByNodeId.peek());
