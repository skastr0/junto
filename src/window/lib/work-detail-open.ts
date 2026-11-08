import { useEffect } from "react";
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
/** An Automations open's firing, beside the trigger like `pendingPage`. */
let pendingFiring = "";

// Every open is its own, numbered: the same item or page asked for twice
// (a link followed again after the operator moved on inside the modal) is
// two opens, and the surface lands on it both times.
let opens = 0;
let pendingOpen = 0;

export type OpenWorkDetailOptions = {
  /** Pre-select this request/task id in the opened surface. */
  readonly itemId?: string;
  /** Open a Files node's file on this page, 1 and up. */
  readonly page?: number;
  /**
   * An Automations node opens on this firing (0.11.1): `itemId` names the
   * automation, `firingId` the run its history highlights. The feed's card
   * uses this; a signal names both, since the signal id cannot be reversed.
   */
  readonly automationId?: string;
  readonly firingId?: string;
};

export type ConsumedWorkDetailOpen = {
  readonly itemId: string;
  readonly page?: number;
  /** An Automations node's firing to highlight, when one was named. */
  readonly firingId?: string;
  /** This open's number, new on every open. */
  readonly open: number;
};

/** Ask the node's card to open its work-plane detail surface. */
export const openWorkDetail = (
  nodeId: string,
  options?: OpenWorkDetailOptions,
): void => {
  workDetailOpen$.itemId.set(options?.automationId ?? options?.itemId ?? "");
  pendingPage = options?.page !== undefined && options.page >= 1 ? options.page : 0;
  pendingFiring = options?.firingId ?? "";
  pendingOpen = ++opens;
  workDetailOpen$.nodeId.set(nodeId);
};

/** Consume the open trigger (call from the owning node). Returns itemId, the page when one was asked for, and the open's number. */
export const consumeWorkDetailOpen = (
  nodeId: string,
): ConsumedWorkDetailOpen | null => {
  if (workDetailOpen$.nodeId.peek() !== nodeId) return null;
  const itemId = workDetailOpen$.itemId.peek();
  const page = pendingPage;
  const firingId = pendingFiring;
  const open = pendingOpen;
  pendingPage = 0;
  pendingFiring = "";
  pendingOpen = 0;
  workDetailOpen$.nodeId.set("");
  workDetailOpen$.itemId.set("");
  return {
    itemId,
    open,
    ...(page >= 1 ? { page } : {}),
    ...(firingId === "" ? {} : { firingId }),
  };
};

/** What a detail surface opens on, from a consumed trigger: the item, its page when one was named, and which open it is. */
export const filesDetailOpening = (
  consumed: ConsumedWorkDetailOpen,
): { readonly initialItemId?: string; readonly initialPage?: number; readonly openKey: number } => ({
  ...(consumed.itemId ? { initialItemId: consumed.itemId } : {}),
  ...(consumed.page === undefined ? {} : { initialPage: consumed.page }),
  openKey: consumed.open,
});

/**
 * A detail surface follows each open while it is up: `apply` runs with the
 * item an open named, on the first render and again on every later open,
 * even one that names the item it already had. Picking another item inside
 * the surface changes neither, so it is left alone until the next open.
 */
export const useFollowOpen = <T>(item: T | undefined, openKey: number | undefined, apply: (item: T) => void): void => {
  useEffect(() => {
    if (item !== undefined) apply(item);
    // `apply` is a state setter or a stable wrapper; the open is what moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, openKey]);
};
