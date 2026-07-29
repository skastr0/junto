import { observable } from "@legendapp/state";

// Cross-surface trigger for the work-plane detail overlays (task board,
// request inbox, artifact library) that live inside TextNode. Mirrors the
// state$.editNodeId pattern: a surface sets the target node id, the owning
// node opens its overlay and clears the trigger.
//
// Optional itemId pre-selects a request/task row when the surface opens
// (jump-to-blocker-cause lands on the holding input item).
export const workDetailOpen$ = observable({
  nodeId: "",
  itemId: "" as string,
});

export type OpenWorkDetailOptions = {
  /** Pre-select this request/task id in the opened surface. */
  readonly itemId?: string;
};

/** Ask the node's card to open its work-plane detail surface. */
export const openWorkDetail = (
  nodeId: string,
  options?: OpenWorkDetailOptions,
): void => {
  workDetailOpen$.itemId.set(options?.itemId ?? "");
  workDetailOpen$.nodeId.set(nodeId);
};

/** Consume the open trigger (call from the owning node). Returns itemId if any. */
export const consumeWorkDetailOpen = (
  nodeId: string,
): { readonly itemId: string } | null => {
  if (workDetailOpen$.nodeId.peek() !== nodeId) return null;
  const itemId = workDetailOpen$.itemId.peek();
  workDetailOpen$.nodeId.set("");
  workDetailOpen$.itemId.set("");
  return { itemId };
};
