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

// Optional page opens a Files node's PDF on that page (an extracted artifact's
// link back). It rides beside the trigger, read only when the trigger is
// consumed, so nothing subscribes to it; 0 is none.
let pendingPage = 0;

export type OpenWorkDetailOptions = {
  /** Pre-select this request/task id in the opened surface. */
  readonly itemId?: string;
  /** Open a Files node's file on this page, 1 and up. */
  readonly page?: number;
};

export type ConsumedWorkDetailOpen = { readonly itemId: string; readonly page?: number };

/** Ask the node's card to open its work-plane detail surface. */
export const openWorkDetail = (
  nodeId: string,
  options?: OpenWorkDetailOptions,
): void => {
  workDetailOpen$.itemId.set(options?.itemId ?? "");
  pendingPage = options?.page !== undefined && options.page >= 1 ? options.page : 0;
  workDetailOpen$.nodeId.set(nodeId);
};

/** Consume the open trigger (call from the owning node). Returns itemId, and the page when one was asked for. */
export const consumeWorkDetailOpen = (
  nodeId: string,
): ConsumedWorkDetailOpen | null => {
  if (workDetailOpen$.nodeId.peek() !== nodeId) return null;
  const itemId = workDetailOpen$.itemId.peek();
  const page = pendingPage;
  pendingPage = 0;
  workDetailOpen$.nodeId.set("");
  workDetailOpen$.itemId.set("");
  return page >= 1 ? { itemId, page } : { itemId };
};

/** What a Files node's modal opens on, from a consumed trigger: the file, and its page when one was named. */
export const filesDetailOpening = (
  consumed: ConsumedWorkDetailOpen,
): { readonly initialItemId?: string; readonly initialPage?: number } => ({
  ...(consumed.itemId ? { initialItemId: consumed.itemId } : {}),
  ...(consumed.page === undefined ? {} : { initialPage: consumed.page }),
});
