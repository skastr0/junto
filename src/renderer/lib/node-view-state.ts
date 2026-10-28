import { useSyncExternalStore } from "react";
import type { NodeViewStore } from "./view-state";
import { makeMemoryNodeViewStore } from "./view-state-stand-in";

/**
 * Where the node surfaces read and write how the operator left them (0.11,
 * 04, V3): each node's filters and open item, a collapsed sidebar, a resized
 * modal and the comments rail. This window's store is main's once V1 lands;
 * until then the stand-in, which holds the same rows in memory.
 */
let store: NodeViewStore = makeMemoryNodeViewStore();

export const nodeViewStore = (): NodeViewStore => store;

/** V1's switch and tests set the store. */
export const setNodeViewStore = (next: NodeViewStore): void => {
  store = next;
};

/**
 * One value read from the store, read again on every change. `read` must
 * return the store's own object (or a primitive), so an unchanged row is the
 * same snapshot.
 */
export const useNodeView = <T>(read: (store: NodeViewStore) => T): T =>
  useSyncExternalStore(
    (listener) => store.onChange(listener),
    () => read(store),
  );
