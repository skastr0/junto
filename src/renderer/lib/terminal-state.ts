import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import type { WorkZone } from "./surface-registry";

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
  inventoryOpen: false,
});

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
  // One-shot promote target — must be set BEFORE openByNodeId: that set
  // triggers the dock observe synchronously, which consumes this value.
  terminal$.lastOpenNodeId.set(node.id);
  terminal$.openByNodeId[node.id].set(node);
  terminal$.openSeq.set(terminal$.openSeq.peek() + 1);
};

export const closeTerminalSurface = (nodeId: string): void => {
  terminal$.openByNodeId[nodeId].delete();
  terminal$.preferredZoneByNodeId[nodeId].delete();
};

export const terminalNodeIds = (): readonly string[] =>
  Object.keys(terminal$.openByNodeId.peek());
