import { observable } from "@legendapp/state";
import type { PreambleEvent } from "@shared/preamble";

/** App-local, non-durable preambles keyed by their agent node. */
export const preambleByNodeId$ = observable<Record<string, PreambleEvent>>({});

const timers = new Map<string, ReturnType<typeof setTimeout>>();

const clearTimer = (nodeId: string): void => {
  const timer = timers.get(nodeId);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(nodeId);
};

/** Dismiss one preamble, ignoring stale timers from a newer replacement. */
export const dismissPreamble = (nodeId: string, preambleId?: string): void => {
  const current = preambleByNodeId$[nodeId].peek();
  if (current === undefined) return;
  if (preambleId !== undefined && current.preambleId !== preambleId) return;
  clearTimer(nodeId);
  preambleByNodeId$[nodeId].delete();
};

/** Paint an event and arm the server-provided expiry, with a local guard. */
export const showPreamble = (event: PreambleEvent): void => {
  const remaining = event.expiresAt - Date.now();
  const current = preambleByNodeId$[event.nodeId].peek();
  if (remaining <= 0) {
    if (current?.preambleId === event.preambleId) {
      dismissPreamble(event.nodeId, event.preambleId);
    }
    return;
  }
  clearTimer(event.nodeId);
  preambleByNodeId$[event.nodeId].set(event);
  const timer = setTimeout(() => {
    timers.delete(event.nodeId);
    dismissPreamble(event.nodeId, event.preambleId);
  }, remaining);
  timers.set(event.nodeId, timer);
};

/** Clear all app-local preambles when the active canvas changes. */
export const clearPreambles = (): void => {
  for (const nodeId of timers.keys()) clearTimer(nodeId);
  preambleByNodeId$.set({});
};
