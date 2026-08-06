import type { VellumCommandTerminalApi } from "@shared/ipc";
import { getVellumCommandApi } from "./vellum-api";

type TerminalEventListener = (event: unknown) => void;

const listeners = new Set<TerminalEventListener>();
let unsubscribeIpc: (() => void) | undefined;

const ensureIpcSubscription = (): void => {
  if (unsubscribeIpc || listeners.size === 0) return;
  const api = getVellumCommandApi() as VellumCommandTerminalApi | undefined;
  if (!api?.onTerminalEvent) return;
  unsubscribeIpc = api.onTerminalEvent((event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One card or surface must not interrupt delivery to the others.
      }
    }
  });
};

/**
 * Renderer-wide terminal event fan-out.
 *
 * Canvas cards and the open xterm surface all observe the same Electron IPC
 * channel. Keeping exactly one bridge subscription prevents a large factory
 * canvas from tripping EventEmitter's listener limit.
 */
export const onTerminalEvent = (listener: TerminalEventListener): (() => void) => {
  listeners.add(listener);
  ensureIpcSubscription();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribeIpc) {
      unsubscribeIpc();
      unsubscribeIpc = undefined;
    }
  };
};
