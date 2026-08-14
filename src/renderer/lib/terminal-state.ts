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

export const terminalSlotElement = (nodeId: string): HTMLElement | null =>
  terminalSlotElements.get(nodeId) ?? null;

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

/** Drop every open terminal surface so a crashed view can remount clean. */
export const closeAllTerminalSurfaces = (): void => {
  for (const nodeId of Object.keys(terminal$.openByNodeId.peek())) {
    closeTerminalSurface(nodeId);
  }
  terminal$.lastOpenNodeId.set(null);
};

export const terminalNodeIds = (): readonly string[] =>
  Object.keys(terminal$.openByNodeId.peek());
