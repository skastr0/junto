// The kernel is now a headless loop in the MAIN process (src/main/junto/kernel/)
// — this module is a pure PROJECTION of it over IPC. Renderer surface for
// watcher status + execution phase only. Region pulse / arming product is gone.

import { observable, observe } from "@legendapp/state";
import type {
  ExecutionSnapshot,
  KernelSnapshot,
  WatcherRuntimeState,
} from "@shared/ipc";
import { getJuntoApi } from "./junto-api";
import { state$ } from "./state";

// --- frozen interface --------------------------------------------------------

export type { WatcherRuntimeState, ExecutionSnapshot };

// `execution` is the open canvas's live edge phase + blocked closure from the
// kernel cycle. Canvas toFlow consumes it so criteria edges use the same
// derived snapshot as phase mirroring.
export const kernel$ = observable<{
  watchers: Record<string, WatcherRuntimeState>;
  nextFire: Record<string, number>;
  execution: ExecutionSnapshot | null;
  // Monotonic stamp so React effects can depend on execution changes without
  // deep-comparing the snapshot object.
  executionRev: number;
}>({
  watchers: {},
  nextFire: {},
  execution: null,
  executionRev: 0,
});

// --- projection: KernelSnapshot (all canvases) -> kernel$ (open canvas only) --

const EMPTY_CANVAS_ENTRY: {
  readonly watchers: Record<string, WatcherRuntimeState>;
  readonly nextFire: Record<string, number>;
  readonly execution?: ExecutionSnapshot;
} = { watchers: {}, nextFire: {} };

// The last snapshot pushed/hydrated from main, kept so a canvasName switch
// can re-project without waiting for the next kernelChanged push.
let latestSnapshot: KernelSnapshot = { canvases: {} };

const shallowRecordEqual = <T>(
  prev: Record<string, T> | undefined,
  next: Record<string, T>,
): boolean => {
  const p = prev ?? {};
  const pKeys = Object.keys(p);
  const nKeys = Object.keys(next);
  if (pKeys.length !== nKeys.length) return false;
  for (const key of nKeys) {
    if (p[key] !== next[key]) return false;
  }
  return true;
};

const projectSnapshot = (snapshot: KernelSnapshot, canvasName: string): void => {
  const entry = snapshot.canvases[canvasName] ?? EMPTY_CANVAS_ENTRY;

  // Keep existing leaves for unchanged entries so watcher cards do not
  // re-render on every ~3s kernel push with identical data.
  const prevWatchers = kernel$.watchers.peek() as Record<string, WatcherRuntimeState>;
  if (!shallowRecordEqual(prevWatchers, entry.watchers)) {
    const merged: Record<string, WatcherRuntimeState> = {};
    for (const [id, next] of Object.entries(entry.watchers)) {
      const prev = prevWatchers[id];
      merged[id] = prev && shallowWatcherEqual(prev, next) ? prev : next;
    }
    kernel$.watchers.set(merged);
  }

  if (!shallowRecordEqual(kernel$.nextFire.peek() as Record<string, number>, entry.nextFire)) {
    kernel$.nextFire.set(entry.nextFire);
  }

  const nextExecution = entry.execution ?? null;
  const prev = kernel$.execution.peek();
  // Stamp only when the serializable payload actually changes so canvas
  // rebuilds are not thrashing every kernel heartbeat with identical data.
  const prevKey = prev ? JSON.stringify(prev) : "";
  const nextKey = nextExecution ? JSON.stringify(nextExecution) : "";
  if (prevKey !== nextKey) {
    kernel$.execution.set(nextExecution);
    kernel$.executionRev.set(kernel$.executionRev.peek() + 1);
  }
};

const shallowWatcherEqual = (a: WatcherRuntimeState, b: WatcherRuntimeState): boolean => {
  if (a === b) return true;
  const aKeys = Object.keys(a) as Array<keyof WatcherRuntimeState>;
  const bKeys = Object.keys(b) as Array<keyof WatcherRuntimeState>;
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
};

// --- bridge lifecycle ----------------------------------------------------------

let started = false;
let teardown: ReadonlyArray<() => void> = [];

const stopKernelBridge = (): void => {
  for (const off of teardown) off();
  teardown = [];
  started = false;
};

// Idempotent singleton: repeated calls (StrictMode remount, a second mounting
// consumer) return the same stop handle rather than re-subscribing.
export function startKernelBridge(): () => void {
  if (started) return stopKernelBridge;
  started = true;

  const api = getJuntoApi();
  if (!api) return stopKernelBridge;

  const offKernelChanged = api.onKernelChanged((snapshot) => {
    latestSnapshot = snapshot;
    projectSnapshot(snapshot, state$.canvasName.peek());
  });

  // Initial hydrate — don't wait on the first kernelChanged push.
  void api.getKernelState().then((snapshot) => {
    latestSnapshot = snapshot;
    projectSnapshot(snapshot, state$.canvasName.peek());
  });

  // Re-project (no new IPC round-trip) whenever the open canvas changes —
  // main already streams every hydrated canvas, so switching documents is a
  // pure local re-slice of the last snapshot.
  const offCanvasName = observe(() => {
    const canvasName = state$.canvasName.get();
    projectSnapshot(latestSnapshot, canvasName);
  });

  teardown = [offKernelChanged, offCanvasName];
  return stopKernelBridge;
}
