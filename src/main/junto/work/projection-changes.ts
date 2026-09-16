import type { StateEngineShape } from "../state/service";

type Listener = (canvasName: string, nodeId: string) => void;

// Work and crew repositories share one projection stream per installation.
// Callers publish only after their StateEngine transaction has committed.
const streams = new WeakMap<StateEngineShape, Set<Listener>>();

export const workProjectionChanges = (state: StateEngineShape) => {
  let listeners = streams.get(state);
  if (listeners === undefined) {
    listeners = new Set();
    streams.set(state, listeners);
  }
  const current = listeners;
  return {
    subscribe: (listener: Listener) => {
      current.add(listener);
      return () => { current.delete(listener); };
    },
    notify: (sink: { canvasName: string; nodeId: string }) => {
      for (const listener of current) {
        try {
          listener(sink.canvasName, sink.nodeId);
        } catch (error) {
          // A consumer cannot turn a committed write into a failed attempt.
          console.error(`[work] change listener failed for ${sink.canvasName}/${sink.nodeId}:`, error);
        }
      }
    },
  };
};
