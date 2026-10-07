import type { SqlClient } from "effect/unstable/sql";

type Listener = (canvasName: string, nodeId: string) => void;

// Work and crew repositories share one projection stream per installation.
// Callers publish only after their SQL transaction has committed.
const streams = new WeakMap<SqlClient.SqlClient, Set<Listener>>();

export const workProjectionChanges = (sql: SqlClient.SqlClient) => {
  let listeners = streams.get(sql);
  if (listeners === undefined) {
    listeners = new Set();
    streams.set(sql, listeners);
  }
  const current = listeners;
  return {
    subscribe: (listener: Listener) => {
      current.add(listener);
      return () => {
        current.delete(listener);
      };
    },
    notify: (sink: { canvasName: string; nodeId: string }) => {
      // Dispatch only to the listeners present when this commit was announced.
      // Re-subscribing during a callback must not replay this same change.
      for (const listener of [...current]) {
        try {
          listener(sink.canvasName, sink.nodeId);
        } catch (error) {
          // A consumer cannot turn a committed write into a failed attempt.
          console.error(
            `[work] change listener failed for ${sink.canvasName}/${sink.nodeId}:`,
            error,
          );
        }
      }
    },
  };
};
