import { observable } from "@legendapp/state";
import type { MailWaitingFact } from "@shared/mail-waiting";
import { knownMailHold, type FeedMailWait } from "@shared/operator-feed";

/**
 * Each seat's mail-waiting fact (`@shared/mail-waiting`) as main last told
 * it: held mail there has waited long enough that the operator should look.
 * The feed lists one item per seat from here (lib/operator-feed). Main keeps
 * the facts; this window reads the ones that stand when it loads and then
 * hears each start, change and clear (count 0).
 *
 * The bridge methods are optional: until main's channel is wired they are
 * absent and the store stays empty.
 */

export type MailWaitingBridge = {
  /** The facts that stand now, one per seat. */
  readonly mailWaiting?: () => Promise<ReadonlyArray<MailWaitingFact>>;
  /** Each fact as it is told, changes or clears. */
  readonly onMailWaiting?: (listener: (fact: MailWaitingFact) => void) => () => void;
};

/** By canvas, then node: the waits that stand. */
export const mailWaiting$ = observable<Record<string, Record<string, FeedMailWait>>>({});

const waitOf = (fact: MailWaitingFact): FeedMailWait | undefined =>
  // Undecoded off IPC: a reason this build has no words for keeps nothing.
  fact.count > 0 && fact.heldSince !== undefined && fact.hold !== undefined && knownMailHold(fact.hold)
    ? { count: fact.count, heldSince: fact.heldSince, hold: fact.hold }
    : undefined;

/** Keep one fact: a count of none, or one missing its time or reason, clears the seat. */
export const applyMailWaitingFact = (fact: MailWaitingFact): void => {
  const wait = waitOf(fact);
  if (wait) {
    mailWaiting$[fact.canvasName][fact.nodeId].set(wait);
    return;
  }
  if (mailWaiting$[fact.canvasName][fact.nodeId].peek() === undefined) return;
  mailWaiting$[fact.canvasName][fact.nodeId].delete();
};

/** One canvas's waits by node, for the feed. */
export const mailWaitsOn = (
  store: Readonly<Record<string, Readonly<Record<string, FeedMailWait>>>> | undefined,
  canvasName: string,
): ReadonlyMap<string, FeedMailWait> => new Map(Object.entries(store?.[canvasName] ?? {}));

/**
 * Hear the facts, then read the ones that stand, which replace what the
 * store held: a seat the read does not list no longer waits. A seat told
 * while the read was in flight keeps what it was told: the read may be
 * older. Returns the unsubscribe.
 */
export const startMailWaitingWatch = (api: object): (() => void) => {
  // Read structurally: the window's API declares these once main wires them.
  const bridge = api as MailWaitingBridge;
  let stopped = false;
  const told = new Set<string>();
  const off =
    bridge.onMailWaiting?.((fact) => {
      if (stopped) return;
      told.add(`${fact.canvasName}\n${fact.nodeId}`);
      applyMailWaitingFact(fact);
    }) ?? (() => undefined);
  void bridge.mailWaiting?.().then(
    (facts) => {
      if (stopped) return;
      const current = mailWaiting$.peek();
      const next: Record<string, Record<string, FeedMailWait>> = {};
      for (const [canvasName, byNode] of Object.entries(current)) {
        for (const [nodeId, wait] of Object.entries(byNode)) {
          if (told.has(`${canvasName}\n${nodeId}`)) (next[canvasName] ??= {})[nodeId] = wait;
        }
      }
      for (const fact of facts) {
        const wait = waitOf(fact);
        if (wait && !told.has(`${fact.canvasName}\n${fact.nodeId}`)) (next[fact.canvasName] ??= {})[fact.nodeId] = wait;
      }
      mailWaiting$.set(next);
    },
    () => undefined,
  );
  return () => {
    stopped = true;
    off();
  };
};
