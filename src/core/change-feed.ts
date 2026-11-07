/**
 * A change feed: who hears that something committed. A store builds one in its
 * Layer's construction and exposes `subscribe` on its service, so the listeners
 * live and die with the service that announces to them, and two runtimes in one
 * process never share an audience.
 *
 * The announcement goes to the listeners present when it is made, so a listener
 * that subscribes during a callback does not hear the change that woke it, and
 * one listener's failure is not the writer's.
 */
export type ChangeFeed<A> = {
  /** Hear every later change; returns the unsubscribe. */
  readonly subscribe: (listener: (change: A) => void) => () => void;
  /** Called after the write committed, never inside it. */
  readonly emit: (change: A) => void;
};

export const makeChangeFeed = <A>(): ChangeFeed<A> => {
  const listeners = new Set<(change: A) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (change) => {
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch {
          // One listener's failure is not the writer's.
        }
      }
    },
  };
};
