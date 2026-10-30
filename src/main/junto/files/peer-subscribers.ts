import type { FilesChanged } from "@shared/files";

/**
 * Subscribers for Files sessions a peer machine opened over the link (0.12,
 * X1c). The service tells a session's changes to a number: a window's
 * webContents id. A peer's number comes from here, above any window id, and
 * its sink writes the change to the link instead of a window.
 */

/** Window ids are small integers; a peer's number starts well above them. */
export const PEER_SUBSCRIBER_BASE = 1_000_000_000;

export const makePeerSubscribers = () => {
  let next = PEER_SUBSCRIBER_BASE;
  const sinks = new Map<number, (event: FilesChanged) => void>();
  return {
    allocate: (sink: (event: FilesChanged) => void): number => {
      const id = next++;
      sinks.set(id, sink);
      return id;
    },
    release: (id: number): void => {
      sinks.delete(id);
    },
    /** True when `id` is a peer's, whether or not its sink is still held. */
    deliver: (id: number, event: FilesChanged): boolean => {
      if (id < PEER_SUBSCRIBER_BASE) return false;
      sinks.get(id)?.(event);
      return true;
    },
  };
};

/** The one set both the app's service and a windowless core's route events through. */
export const peerSubscribers = makePeerSubscribers();
