/**
 * View-state removals (0.11, 04): a node or canvas delete took rows in the
 * core's transaction, and every open window must read the snapshot again. The
 * delete seam publishes after its transaction commits, on the core push bus,
 * which main relays to every window (ipc.ts); with the core in its own
 * process the in-process listeners never fire, so the bus is what carries it.
 */
import { IPC_CHANNELS } from "@shared/ipc";
import { publish } from "../../core-process/push";

export type ViewStateChangeListener = () => void;

const listeners = new Set<ViewStateChangeListener>();

/** Hear that rows went; returns the unsubscribe. */
export const subscribeViewStateChanges = (listener: ViewStateChangeListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Called after the delete's transaction committed, never inside it. */
export const publishViewStateChange = (): void => {
  for (const listener of [...listeners]) listener();
  // The window reads again through the core push, in process or over the port.
  publish(IPC_CHANNELS.viewStateChanged, { area: "reload" });
};
