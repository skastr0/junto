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
/** Every showing modal's palette, oldest first: the last one is the modal in front. */
const order: QuickOpenHost[] = [];

/** Register a showing modal's palette; call the returned function when it closes or changes node. */
export const registerQuickOpenHost = (host: QuickOpenHost): (() => void) => {
  hosts.set(host.nodeId, host);
  const at = order.findIndex((held) => held.nodeId === host.nodeId);
  if (at >= 0) order.splice(at, 1);
  order.push(host);
  return () => {
    // A newer host for the same node (a remount) keeps its own registration.
    if (hosts.get(host.nodeId) === host) hosts.delete(host.nodeId);
    const index = order.indexOf(host);
    if (index >= 0) order.splice(index, 1);
  };
};

/**
 * The quick-open chord's action: true when it opened or closed a palette.
 *
 * The node the action names is the one the workbench knows — a terminal, a
 * note, a browser. A node's card overlay (Artifacts, Tasks, Automations,
 * Files) is not a workbench surface, so with no host under that id the last
 * modal registered answers: the one showing, as the page chrome's keys do.
 */
export const toggleQuickOpenFor = (nodeId: string): boolean => {
  const host = hosts.get(nodeId) ?? order.at(-1);
  if (host === undefined || !host.enabled) return false;
  if (host.isOpen()) host.close();
  else host.open();
  return true;
};
