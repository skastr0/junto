// Every applied write to a canvas's tasks or artifacts, by any writer (a seat
// over the work socket, the operator over IPC), said once here by the store
// port that submitted it. ipc.ts turns each into `<domain>-changed` for the
// windows, so a pane reads again whoever wrote.
//
// A thread is its own notice: a comment on a file changes no file, so it says
// only that the threads of its kind moved (F7).

import type { ResourceIpcDomain, ThreadResourceSubject } from "@shared/resource-ipc";

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

/** A comment landed on a resource whose own rows did not change: the threads of its kind did. */
export type ThreadChangeListener = (kind: ThreadResourceSubject["kind"], canvasName: string) => void;

const threadListeners = new Set<ThreadChangeListener>();

export const noteThreadChanged = (kind: ThreadResourceSubject["kind"], canvasName: string): void => {
  for (const listener of threadListeners) listener(kind, canvasName);
};

/** Returns the unsubscribe. */
export const onThreadChanged = (listener: ThreadChangeListener): (() => void) => {
  threadListeners.add(listener);
  return () => {
    threadListeners.delete(listener);
  };
};
