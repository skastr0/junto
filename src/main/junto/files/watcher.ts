import { watch, type FSWatcher } from "node:fs";
import { inSkippedDir } from "./sources";

/**
 * One recursive watch per Files root (FSEvents on macOS): never a watcher
 * per folder, never polling, about no CPU while idle. Events under `.git`
 * and `node_modules` are dropped. Paths coalesce for `COALESCE_MS` and go out
 * as one batch; more than `BURST` in a window (a checkout, an install) goes
 * out as one `burst`, for one rebuild instead of thousands of deltas.
 */

export const COALESCE_MS = 100;
export const BURST = 1000;

export type WatchBatch =
  | { readonly kind: "paths"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "burst" }
  /** The watch itself failed (the root went away, most often). */
  | { readonly kind: "lost" };

export type WatchFactory = (
  root: string,
  listener: (event: string, filename: string | null) => void,
  onError: () => void,
) => { readonly close: () => void };

export const nodeWatch: WatchFactory = (root, listener, onError) => {
  const watcher: FSWatcher = watch(root, { recursive: true, persistent: false, encoding: "utf8" }, listener);
  watcher.on("error", onError);
  return watcher;
};

export type Timers = {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const watchRoot = (
  root: string,
  onBatch: (batch: WatchBatch) => void,
  factory: WatchFactory = nodeWatch,
  timers: Timers = realTimers,
): { readonly close: () => void } => {
  let pending = new Set<string>();
  let burst = false;
  let timer: unknown;
  let closed = false;
  const flush = (): void => {
    timer = undefined;
    if (closed) return;
    const batch: WatchBatch = burst ? { kind: "burst" } : { kind: "paths", paths: [...pending] };
    pending = new Set();
    burst = false;
    onBatch(batch);
  };
  const handle = factory(
    root,
    (_event, filename) => {
      if (closed) return;
      // FSEvents may drop the name when it coalesces itself: treat it as a burst.
      if (filename === null || filename === "") burst = true;
      else {
        const path = filename.split("\\").join("/");
        if (inSkippedDir(path)) return;
        if (!burst) {
          pending.add(path);
          if (pending.size > BURST) {
            burst = true;
            pending = new Set();
          }
        }
      }
      timer ??= timers.set(flush, COALESCE_MS);
    },
    () => {
      if (closed) return;
      close();
      onBatch({ kind: "lost" });
    },
  );
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) timers.clear(timer);
    handle.close();
  };
  return { close };
};
