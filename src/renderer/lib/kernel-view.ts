// The kernel is now a headless loop in the MAIN process (src/main/vellum/kernel/)
// — this module is a pure PROJECTION of it over IPC. This file is the FROZEN
// interface the UI lane builds against — WatcherRuntimeState, PulseRecord,
// kernel$, startKernelBridge, armRegion, and pulseRegion below must keep their
// exact shapes (same contract lib/kernel-state.ts used to serve). Everything
// else here is this lane's own implementation detail.
//
// LAWS (src/shared/canvas.ts): watcher runtime state is derived, never
// written to the document. ARMING lives only in the running app (main-process
// typed kernel state repository, kernel-design.md §3), never an export. A disarmed pulse is a
// DRY pulse — logged, no agent turns.

import { observable, observe } from "@legendapp/state";
import type {
  ArmRegionResult,
  ExecutionSnapshot,
  KernelSnapshot,
  PulseRecord,
  WatcherRuntimeState,
} from "@shared/ipc";
import { getVellumApi } from "./vellum-api";
import { state$ } from "./state";

// --- frozen interface --------------------------------------------------------

export type { WatcherRuntimeState, PulseRecord, ExecutionSnapshot };

// fault + orphaned are snapshot-GLOBAL (not per-canvas): a persisted-arming
// load failure, and the armed `canvas::region` keys whose canvas/region no
// longer exists in any hydrated document. Both are durable-intent surfacing —
// the kernel refuses to silently disarm, so the renderer must show them.
//
// `execution` is the open canvas's live edge phase + blocked closure from the
// kernel cycle (glyph-aware). Canvas toFlow consumes it so criteria edges
// paint blocks/depends without the renderer re-fetching glyph browse.
export const kernel$ = observable<{
  watchers: Record<string, WatcherRuntimeState>;
  armed: Record<string, boolean>;
  nextFire: Record<string, number>;
  execution: ExecutionSnapshot | null;
  // Monotonic stamp so React effects can depend on execution changes without
  // deep-comparing the snapshot object.
  executionRev: number;
  pulseLog: PulseRecord[];
  fault: string;
  orphaned: string[];
}>({
  watchers: {},
  armed: {},
  nextFire: {},
  execution: null,
  executionRev: 0,
  pulseLog: [],
  fault: "",
  orphaned: [],
});

// composePulseMessage does NOT live here: the renderer no longer composes
// pulse messages at all — delivery moved to main (src/main/vellum/kernel/
// cycle.ts, which owns and exports it). It was never part of the frozen UI
// interface (kernel-state.ts's own header comment scoped that to
// WatcherRuntimeState/PulseRecord/kernel$/startKernel/armRegion/pulseRegion);
// it was just co-located pure logic for the renderer's own deliverPulse,
// which no longer exists here.

// --- projection: KernelSnapshot (all canvases) -> kernel$ (open canvas only) --

const EMPTY_CANVAS_ENTRY: {
  readonly watchers: Record<string, WatcherRuntimeState>;
  readonly armed: Record<string, boolean>;
  readonly nextFire: Record<string, number>;
  readonly execution?: ExecutionSnapshot;
} = { watchers: {}, armed: {}, nextFire: {} };

// The last snapshot pushed/hydrated from main, kept so a canvasName switch
// can re-project without waiting for the next kernelChanged push.
let latestSnapshot: KernelSnapshot = { canvases: {}, pulseLog: [] };

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

const pulseLogEqual = (
  prev: ReadonlyArray<PulseRecord> | undefined,
  next: ReadonlyArray<PulseRecord>,
): boolean => {
  if (!prev) return next.length === 0;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (prev[i] !== next[i] && prev[i]?.id !== next[i]?.id) return false;
  }
  // Same length + same ids in order is enough for the tray; content rarely mutates in place.
  for (let i = 0; i < next.length; i += 1) {
    if (prev[i]?.id !== next[i]?.id) return false;
  }
  return true;
};

const stringArrayEqual = (
  prev: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string>,
): boolean => {
  if (!prev) return next.length === 0;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
};

const projectSnapshot = (snapshot: KernelSnapshot, canvasName: string): void => {
  const entry = snapshot.canvases[canvasName] ?? EMPTY_CANVAS_ENTRY;

  // Keep existing leaves for unchanged entries so WatcherCards / PulseTray
  // do not re-render on every ~3s kernel push with identical data.
  const prevWatchers = kernel$.watchers.peek() as Record<string, WatcherRuntimeState>;
  if (!shallowRecordEqual(prevWatchers, entry.watchers)) {
    const merged: Record<string, WatcherRuntimeState> = {};
    for (const [id, next] of Object.entries(entry.watchers)) {
      const prev = prevWatchers[id];
      merged[id] = prev && shallowWatcherEqual(prev, next) ? prev : next;
    }
    kernel$.watchers.set(merged);
  }

  if (!shallowRecordEqual(kernel$.armed.peek() as Record<string, boolean>, entry.armed)) {
    kernel$.armed.set(entry.armed);
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

  const nextPulseLog = snapshot.pulseLog.filter((record) => record.canvasName === canvasName);
  if (!pulseLogEqual(kernel$.pulseLog.peek() as PulseRecord[] | undefined, nextPulseLog)) {
    kernel$.pulseLog.set(nextPulseLog);
  }

  // Global surfaces — independent of the open canvas.
  const nextFault = snapshot.fault ?? "";
  if (kernel$.fault.peek() !== nextFault) kernel$.fault.set(nextFault);
  const nextOrphans = [...(snapshot.orphanedArming ?? [])];
  if (!stringArrayEqual(kernel$.orphaned.peek() as string[] | undefined, nextOrphans)) {
    kernel$.orphaned.set(nextOrphans);
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

// --- arming + manual pulse (IPC invokes, closing over the open canvas) -------

// Returns the transactional result so the caller can surface a failed persist
// inline instead of the old fire-and-forget that discarded the rejection.
export function armRegion(regionId: string, armed: boolean): Promise<ArmRegionResult> {
  const api = getVellumApi();
  const canvasName = state$.canvasName.peek();
  if (!api || !canvasName) return Promise.resolve({ ok: false, error: "no canvas is open" });
  return api.armRegion(canvasName, regionId, armed);
}

// Disarm an orphaned arm-intent, addressed by its full `canvas::region` key —
// its canvas may not be the open one (it can be a deleted canvas). Disarm stays
// an explicit operator act; this is that act for an orphan.
export function disarmOrphan(key: string): Promise<ArmRegionResult> {
  const api = getVellumApi();
  const idx = key.indexOf("::");
  if (!api || idx < 0) return Promise.resolve({ ok: false, error: "malformed key" });
  return api.armRegion(key.slice(0, idx), key.slice(idx + 2), false);
}

export async function pulseRegion(regionId: string, opts?: { dry?: boolean; summary?: string }): Promise<void> {
  const api = getVellumApi();
  const canvasName = state$.canvasName.peek();
  if (!api || !canvasName) return;
  await api.pulseRegion(canvasName, regionId, opts);
}

// --- bridge lifecycle ----------------------------------------------------------

let started = false;
let teardown: ReadonlyArray<() => void> = [];

const stopKernelBridge = (): void => {
  for (const off of teardown) off();
  teardown = [];
  started = false;
};

// Idempotent singleton, matching the old startKernel()'s contract: repeated
// calls (StrictMode remount, a second mounting consumer) return the same
// stop handle rather than re-subscribing.
export function startKernelBridge(): () => void {
  if (started) return stopKernelBridge;
  started = true;

  const api = getVellumApi();
  if (!api) return stopKernelBridge;

  const offKernelChanged = api.onKernelChanged((snapshot) => {
    latestSnapshot = snapshot;
    projectSnapshot(snapshot, state$.canvasName.peek());
  });

  // Initial hydrate — don't wait on the first kernelChanged push, which may
  // be seconds away (cycle end or the 3s pulse-log poll).
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
