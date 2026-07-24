import { observable } from "@legendapp/state";

// Cross-surface trigger for the work-plane detail overlays (task board,
// request inbox, artifact library) that live inside TextNode. Mirrors the
// state$.editNodeId pattern: a surface sets the target node id, the owning
// node opens its overlay and clears the trigger.
export const workDetailOpen$ = observable({ nodeId: "" });

/** Ask the node's card to open its work-plane detail surface. */
export const openWorkDetail = (nodeId: string): void => {
  workDetailOpen$.nodeId.set(nodeId);
};
