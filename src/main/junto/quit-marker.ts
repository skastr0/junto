/**
 * The relaunch wait. A quitting Junto can sit in native teardown for seconds
 * after its quit event while it still holds the single-instance lock, and a
 * relaunch in that window used to quit at once. The quitting app leaves a
 * marker naming itself, pid plus start time, in its own Junto home. A new
 * instance waits only while that marker names a live process with the same
 * start time, and then asks for the lock once. A healthy holder leaves no
 * marker, so a second launch beside it hands off and exits on the first try.
 *
 * The wait comes before the one request, never as retries after a refusal:
 * on Electron 43 an instance that takes the lock after a refused request never
 * reaches ready, and each refused request is a second-instance in the holder.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const QUIT_MARKER_WAIT_MS = 15_000;
const QUIT_MARKER_POLL_MS = 100;

export interface QuitMarker {
  readonly pid: number;
  readonly startKey: string;
}

export const quitMarkerPath = (juntoHome: string): string => join(juntoHome, "quitting-app.json");

/** Best effort: a missing marker only means a relaunch does not wait. */
export const writeQuitMarker = (path: string, marker: QuitMarker): void => {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Rename replaces whatever sits at the path, a symlink included, without following it.
    // The staged name is predictable: remove whatever sits there and create it fresh, never through a link.
    const staged = `${path}.${process.pid}.tmp`;
    rmSync(staged, { force: true });
    writeFileSync(staged, JSON.stringify({ pid: marker.pid, startKey: marker.startKey }), { mode: 0o600, flag: "wx" });
    renameSync(staged, path);
  } catch {
    // The quit goes on without it.
  }
};

const readQuitMarker = (path: string): QuitMarker | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const { pid, startKey } = value as Record<string, unknown>;
    return Number.isSafeInteger(pid) && (pid as number) > 1 && typeof startKey === "string" && startKey.length > 0
      ? { pid: pid as number, startKey }
      : undefined;
  } catch {
    return undefined;
  }
};

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Runs before the app is ready, so blocking here holds up nothing. Asks for
 * the lock exactly once; true when this instance now holds it.
 */
export const requestLockAfterQuittingHolder = (input: {
  readonly markerPath: string;
  readonly requestLock: () => boolean;
  /** One fresh read of a pid's start time, or undefined when it is gone. */
  readonly startKeyOf: (pid: number) => string | undefined;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => void;
  readonly waitMs?: number;
}): boolean => {
  const marker = readQuitMarker(input.markerPath);
  if (marker !== undefined) {
    const now = input.now ?? Date.now;
    const sleep = input.sleep ?? sleepSync;
    const deadline = now() + (input.waitMs ?? QUIT_MARKER_WAIT_MS);
    while (input.startKeyOf(marker.pid) === marker.startKey && now() < deadline) sleep(QUIT_MARKER_POLL_MS);
  }
  const got = input.requestLock();
  if (got && marker !== undefined) rmSync(input.markerPath, { force: true });
  return got;
};
