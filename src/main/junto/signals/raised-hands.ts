import type { AgentSignal } from "@shared/agent-signals";

/**
 * Raised hands: agent seats with an open `blocked` or `escalate` signal, held
 * in memory per canvas so the kernel's relay watch reads them synchronously.
 * An agent's `announces` wire into a relay fires when its seat raises a hand.
 *
 * Every signal change passes through `note` (raise and withdraw from the work
 * control socket, answer and dismiss from the operator). `hydrate` loads the
 * hands already open at boot and never undoes a change `note` saw first.
 */
export const raisesHand = (signal: AgentSignal): boolean =>
  signal.state === "open" && (signal.kind === "blocked" || signal.kind === "escalate");

export type RaisedHands = {
  readonly note: (signal: AgentSignal) => void;
  readonly hydrate: (signals: ReadonlyArray<AgentSignal>) => void;
  /** Node ids with a raised hand on one canvas. */
  readonly snapshot: (canvasName: string) => ReadonlySet<string>;
  /** Called after a change to the raised set. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Called with every signal `note` sees, whoever changed it (an agent raising
   * or withdrawing, the operator answering or dismissing). The phone
   * companion's signal events read this. Returns the unsubscribe.
   */
  readonly onSignal: (listener: (signal: AgentSignal) => void) => () => void;
};

export const makeRaisedHands = (): RaisedHands => {
  // canvas -> signalId -> nodeId
  const byCanvas = new Map<string, Map<string, string>>();
  const seen = new Set<string>();
  const listeners = new Set<() => void>();
  const signalListeners = new Set<(signal: AgentSignal) => void>();

  const apply = (signal: AgentSignal): boolean => {
    const hands = byCanvas.get(signal.canvasName);
    if (raisesHand(signal)) {
      if (hands?.get(signal.signalId) === signal.nodeId) return false;
      const next = hands ?? new Map<string, string>();
      next.set(signal.signalId, signal.nodeId);
      byCanvas.set(signal.canvasName, next);
      return true;
    }
    if (hands === undefined || !hands.delete(signal.signalId)) return false;
    if (hands.size === 0) byCanvas.delete(signal.canvasName);
    return true;
  };

  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    note: (signal) => {
      seen.add(signal.signalId);
      if (apply(signal)) changed();
      for (const listener of signalListeners) {
        try {
          listener(signal);
        } catch {
          // An observer never breaks a signal write path.
        }
      }
    },
    hydrate: (signals) => {
      let any = false;
      for (const signal of signals) {
        if (seen.has(signal.signalId)) continue;
        any = apply(signal) || any;
      }
      if (any) changed();
    },
    snapshot: (canvasName) => new Set(byCanvas.get(canvasName)?.values() ?? []),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSignal: (listener) => {
      signalListeners.add(listener);
      return () => signalListeners.delete(listener);
    },
  };
};

/** The process's one index, noted from every signal write path. */
export const raisedHands = makeRaisedHands();
