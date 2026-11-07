import { watch, type FSWatcher } from "node:fs";
import { inSkippedDir } from "./sources";

/**
 * One recursive watch per Files root (FSEvents on macOS): never a watcher
 * per folder, never polling, about no CPU while idle. Events under `.git`
 * and `node_modules` are dropped. Paths coalesce for `COALESCE_MS` and go out
 * as one batch.
 *
 * A busy window (at least `BUSY` paths) starts or continues a streak; about
 * `END_MS` of quiet windows, or of no window at all, ends it, so an install
 * that jitters around any rate stays one streak. A streak past `BURST` paths (a checkout or an
 * install, even one spread over seconds) sends no more paths: the index
 * keeps answering with the names it has, and one `burst` (one rebuild, one
 * renderer reset) goes out when the streak ends. A streak that never ends
 * sends one at most every `BURST_EVERY_MS`, and only if something changed.
 * A file written many times a second (a log) is a path or two a window,
 * never busy, so it never holds a burst open.
 */

export const COALESCE_MS = 100;
export const BURST = 1000;
export const BUSY = 10;
/** Quiet that ends a streak: this many quiet windows, or this long with none. */
export const END_WINDOWS = 5;
export const END_MS = COALESCE_MS * END_WINDOWS;
export const BURST_EVERY_MS = 10_000;

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
  /** This window's paths; past BURST only the count matters, so it stops growing. */
  let pending = new Set<string>();
  /** A name FSEvents dropped this window: as good as a burst. */
  let unnamed = false;
  /** Paths in this streak's earlier windows. */
  let streak = 0;
  /** Quiet windows in a row within the streak. */
  let quietWindows = 0;
  let burst = false;
  /** Something changed since the last burst went out. */
  let changed = false;
  /** While a burst holds: the next time it may send one. */
  let every: unknown;
  let window: unknown;
  /** Armed after a window while a streak is open: no window within it ends the streak. */
  let quiet: unknown;
  let closed = false;

  const sendBurst = (): void => {
    changed = false;
    onBatch({ kind: "burst" });
  };

  const armEvery = (): void => {
    every = timers.set(() => {
      every = undefined;
      if (closed || !burst) return;
      if (changed) sendBurst();
      armEvery();
    }, BURST_EVERY_MS);
  };

  const endStreak = (): void => {
    if (burst && changed) sendBurst();
    if (every !== undefined) timers.clear(every);
    every = undefined;
    streak = 0;
    quietWindows = 0;
    burst = false;
    changed = false;
  };

  const armQuiet = (): void => {
    if (burst || streak > 0) {
      quiet = timers.set(() => {
        quiet = undefined;
        if (!closed && window === undefined) endStreak();
      }, END_MS);
    }
  };

  const flush = (): void => {
    window = undefined;
    if (closed) return;
    flushWindow();
    armQuiet();
  };

  const flushWindow = (): void => {
    const count = pending.size;
    const paths = [...pending];
    pending = new Set();
    const lostNames = unnamed;
    unnamed = false;
    const busy = count >= BUSY || lostNames;
    if (burst) {
      if (count > 0 || lostNames) changed = true;
    } else if (lostNames || streak + count > BURST) {
      burst = true;
      changed = true;
      quietWindows = 0;
      armEvery();
      return;
    } else {
      if (busy || streak > 0) streak += count;
      if (count > 0) onBatch({ kind: "paths", paths });
    }
    if (busy) quietWindows = 0;
    else if (burst || streak > 0) {
      quietWindows += 1;
      if (quietWindows >= END_WINDOWS) endStreak();
    }
  };

  const handle = factory(
    root,
    (_event, filename) => {
      if (closed) return;
      if (filename === null || filename === "") unnamed = true;
      else {
        const path = filename.split("\\").join("/");
        if (inSkippedDir(path)) return;
        if (pending.size <= BURST) pending.add(path);
      }
      if (quiet !== undefined) {
        timers.clear(quiet);
        quiet = undefined;
      }
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
    if (every !== undefined) timers.clear(every);
    handle.close();
  };
  return { close };
};
