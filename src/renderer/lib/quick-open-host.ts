/**
 * Quick open's host: the node modal that is open, and the palette it owns.
 *
 * The chord is one app shortcut (`quickOpen.open`, Cmd+P) with one action, so
 * a node modal does not listen for it itself: it registers what its palette
 * does while it shows, and the last one registered is the node in front (the
 * page-chrome pattern, `lib/page-chrome-keys.ts`). With no modal open, or a
 * node with nothing to search, the key passes untouched.
 */

export type QuickOpenHost = {
  readonly nodeId: string;
  readonly open: () => void;
  readonly close: () => void;
  readonly isOpen: () => boolean;
  /** A node holding nothing to search keeps the chord for whatever has focus. */
  readonly enabled: boolean;
};

const hosts = new Map<string, QuickOpenHost>();

/** Register a showing modal's palette; call the returned function when it closes or changes node. */
export const registerQuickOpenHost = (host: QuickOpenHost): (() => void) => {
  hosts.set(host.nodeId, host);
  return () => {
    // A newer host for the same node (a remount) keeps its own registration.
    if (hosts.get(host.nodeId) === host) hosts.delete(host.nodeId);
  };
};

/** The quick-open chord's action: true when it opened or closed a palette. */
export const toggleQuickOpenFor = (nodeId: string): boolean => {
  const host = hosts.get(nodeId);
  if (host === undefined || !host.enabled) return false;
  if (host.isOpen()) host.close();
  else host.open();
  return true;
};
