import type { Worker } from "node:worker_threads";
import createIndexWorker from "./index-worker?nodeWorker";
import { spawnGit } from "./git-spawn";
import type { RootEvent, RootIndex } from "./root-index";
import { portRootIndex } from "./root-index-port";

/**
 * The root index as a worker thread, started on the first call and ended
 * when no root is held and nothing is pending, which hands back everything
 * its builds allocated. If the worker stops, pending calls reject and the
 * next call starts a fresh one, holding again every root main still holds.
 */
export const workerRootIndex = (emit: (root: string, event: RootEvent) => void): RootIndex => {
  /** Sessions main holds, per root: replayed into a fresh worker. */
  const holds = new Map<string, Set<string>>();
  let current: { readonly worker: Worker; readonly index: ReturnType<typeof portRootIndex> } | undefined;

  const end = (): void => {
    if (current === undefined || holds.size > 0 || !current.index.idle()) return;
    const { worker } = current;
    current = undefined;
    void worker.terminate();
  };

  const live = (): RootIndex => {
    if (current !== undefined) return current.index;
    const worker = createIndexWorker({ name: "junto-files-index" });
    const index = portRootIndex(worker, { git: spawnGit, emit, onIdle: () => queueMicrotask(end) });
    const held = { worker, index };
    const stop = (cause: Error): void => {
      if (current === held) current = undefined;
      index.lost(cause);
    };
    worker.on("error", (cause: unknown) => {
      console.error("[files] index worker failed", cause);
      stop(cause instanceof Error ? cause : new Error(String(cause)));
    });
    worker.on("exit", (code) => stop(new Error(`files index worker exited ${String(code)}`)));
    worker.unref();
    current = held;
    for (const [root, sessions] of holds) {
      for (const session of sessions) {
        index.hold(root, session).catch((cause: unknown) => console.error("[files] index hold failed", cause));
      }
    }
    return index;
  };

  const note = (root: string, session: string): void => {
    let sessions = holds.get(root);
    if (sessions === undefined) {
      sessions = new Set();
      holds.set(root, sessions);
    }
    sessions.add(session);
  };

  return {
    hold: (root, session) => {
      note(root, session);
      return live().hold(root, session);
    },
    release: async (root, session) => {
      const sessions = holds.get(root);
      if (sessions === undefined || !sessions.delete(session)) return undefined;
      if (sessions.size === 0) holds.delete(root);
      if (current === undefined) return undefined;
      return current.index.release(root, session);
    },
    // A search holds the root in the worker too.
    search: (root, session, query) => {
      note(root, session);
      return live().search(root, session, query);
    },
    count: (root) => live().count(root),
  };
};
