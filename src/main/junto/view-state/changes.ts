/**
 * View-state removals (0.11, 04): a node or canvas delete took rows in main's
 * transaction, and every open window must read the snapshot again. One
 * process, one bus: the model delete seam publishes after its transaction
 * commits, and the IPC forwards a reload to every window.
 */
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
};
