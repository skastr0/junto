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
 * A worker that stops while roots are held is started again at once (then
 * after 1 s, doubling to 30 s, if it keeps stopping), and those roots'
 * sessions get a reset so their trees list again.
 */

const RESTART_FIRST_MS = 1_000;
const RESTART_MAX_MS = 30_000;
/** A worker that lived this long resets the backoff. */
const RESTART_SETTLED_MS = 60_000;
export const workerRootIndex = (emit: (root: string, event: RootEvent) => void): RootIndex => {
  /** Sessions main holds, per root: replayed into a fresh worker. */
  const holds = new Map<string, Set<string>>();
  let current: { readonly worker: Worker; readonly index: ReturnType<typeof portRootIndex> } | undefined;
  /** Restarts in a row without a worker living RESTART_SETTLED_MS. */
  let restarts = 0;
  let restart: ReturnType<typeof setTimeout> | undefined;

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
    const started = Date.now();
    const stop = (cause: Error): void => {
      if (current !== held) {
        index.lost(cause);
        return;
      }
      current = undefined;
      index.lost(cause);
      if (holds.size === 0 || restart !== undefined) return;
      // Held roots lost their watch: restart, and have their trees list again.
      if (Date.now() - started > RESTART_SETTLED_MS) restarts = 0;
      const delay = restarts === 0 ? 0 : Math.min(RESTART_MAX_MS, RESTART_FIRST_MS * 2 ** (restarts - 1));
      restarts += 1;
      restart = setTimeout(() => {
        restart = undefined;
        if (holds.size > 0) live();
      }, delay);
      restart.unref();
      for (const root of holds.keys()) emit(root, { kind: "reset" });
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
