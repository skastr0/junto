import { watch, type FSWatcher } from "node:fs";
import { inSkippedDir } from "./sources";

/**
 * One recursive watch per Files root (FSEvents on macOS): never a watcher
 * per folder, never polling, about no CPU while idle. Events under `.git`
 * and `node_modules` are dropped. Paths coalesce for `COALESCE_MS` and go out
 * as one batch. Windows that follow each other with less than
 * `COALESCE_MS` of quiet between them are one streak; a streak past `BURST`
 * paths (a checkout, an install, even one spread over seconds) goes out as
 * one `burst`, for one rebuild instead of thousands of deltas, and once more
 * when the streak ends if anything changed after the first.
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
  /** Paths sent in this streak's earlier windows. */
  let streak = 0;
  /** The streak passed BURST: paths are no longer kept. */
  let burst = false;
  /** This streak's burst went out. */
  let burstSent = false;
  /** Something changed after it went out. */
  let changedSince = false;
  let window: unknown;
  let quiet: unknown;
  let closed = false;

  const endStreak = (): void => {
    quiet = undefined;
    if (closed) return;
    const again = burstSent && changedSince;
    streak = 0;
    burst = false;
    burstSent = false;
    changedSince = false;
    if (again) onBatch({ kind: "burst" });
  };

  const flush = (): void => {
    window = undefined;
    if (closed) return;
    if (burst) {
      if (!burstSent) {
        burstSent = true;
        changedSince = false;
        onBatch({ kind: "burst" });
      }
    } else if (pending.size > 0) {
      streak += pending.size;
      const paths = [...pending];
      pending = new Set();
      onBatch({ kind: "paths", paths });
    }
    quiet = timers.set(endStreak, COALESCE_MS);
  };

  const handle = factory(
    root,
    (_event, filename) => {
      if (closed) return;
      let path: string | undefined;
      // FSEvents may drop the name when it coalesces itself: treat it as a burst.
      if (filename !== null && filename !== "") {
        path = filename.split("\\").join("/");
        if (inSkippedDir(path)) return;
      }
      if (quiet !== undefined) {
        timers.clear(quiet);
        quiet = undefined;
      }
      if (path === undefined) {
        burst = true;
        pending = new Set();
      } else if (!burst) {
        pending.add(path);
        if (streak + pending.size > BURST) {
          burst = true;
          pending = new Set();
        }
      }
      if (burstSent) changedSince = true;
      window ??= timers.set(flush, COALESCE_MS);
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
    if (window !== undefined) timers.clear(window);
    if (quiet !== undefined) timers.clear(quiet);
    handle.close();
  };
  return { close };
};
