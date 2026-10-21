// Every applied write to a canvas's tasks or artifacts, by any writer (a seat
// over the work socket, the operator over IPC), said once here by the store
// port that submitted it. ipc.ts turns each into `<domain>-changed` for the
// windows, so a pane reads again whoever wrote.

import type { ResourceIpcDomain } from "@shared/resource-ipc";

export type ResourceChangeListener = (domain: ResourceIpcDomain, canvasName: string) => void;

const listeners = new Set<ResourceChangeListener>();

export const noteResourceChanged = (domain: ResourceIpcDomain, canvasName: string): void => {
  for (const listener of listeners) listener(domain, canvasName);
};

/** Returns the unsubscribe. */
export const onResourceChanged = (listener: ResourceChangeListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
