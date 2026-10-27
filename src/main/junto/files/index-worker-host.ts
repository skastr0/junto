import type { Worker } from "node:worker_threads";
import createIndexWorker from "./index-worker?nodeWorker";
import { portEngine, type IndexEngine } from "./index-engine";

/**
 * The index engine as a worker thread, started on the first build and
 * ended when it holds no index, which hands back everything a build
 * allocated. If the worker stops, every pending call rejects (the service
 * rebuilds on its next search) and the next call starts a fresh one.
 */
export const workerIndexEngine = (): IndexEngine => {
  let current: { readonly worker: Worker; readonly engine: ReturnType<typeof portEngine> } | undefined;
  const live = (): IndexEngine => {
    if (current !== undefined) return current.engine;
    const worker = createIndexWorker({ name: "junto-files-index" });
    const engine = portEngine(worker);
    const held = { worker, engine };
    const stop = (cause: Error): void => {
      if (current === held) current = undefined;
      engine.lost(cause);
    };
    worker.on("error", (cause: unknown) => {
      console.error("[files] index worker failed", cause);
      stop(cause instanceof Error ? cause : new Error(String(cause)));
    });
    worker.on("exit", (code) => stop(new Error(`files index worker exited ${String(code)}`)));
    worker.unref();
    current = held;
    return engine;
  };
  const slots = new Set<number>();
  return {
    begin: (slot) => {
      slots.add(slot);
      live().begin(slot);
    },
    names: (slot, names) => live().names(slot, names),
    finish: (slot) => live().finish(slot),
    apply: (slot, delta) => live().apply(slot, delta),
    search: (slot, session, query) => live().search(slot, session, query),
    forget: (slot, session) => current?.engine.forget(slot, session),
    drop: (slot) => {
      slots.delete(slot);
      if (current === undefined) return;
      if (slots.size > 0) {
        current.engine.drop(slot);
        return;
      }
      const { worker } = current;
      current = undefined;
      void worker.terminate();
    },
  };
};
