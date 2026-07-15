// The kernel is now a headless loop in the MAIN process (src/main/vellum/kernel/)
// — this module is a pure PROJECTION of it over IPC. This file is the FROZEN
// interface the UI lane builds against — WatcherRuntimeState, PulseRecord,
// kernel$, startKernelBridge, armRegion, and pulseRegion below must keep their
// exact shapes (same contract lib/kernel-state.ts used to serve). Everything
// else here is this lane's own implementation detail.
//
// LAWS (src/shared/canvas.ts): watcher runtime state is derived, never
// written to the document. ARMING lives only in the running app (main-process
// StoreService, kernel-design.md §3), never the file. A disarmed pulse is a
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
// paint blocks/depends without the renderer re-fetching tower browse.
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

const projectSnapshot = (snapshot: KernelSnapshot, canvasName: string): void => {
  const entry = snapshot.canvases[canvasName] ?? EMPTY_CANVAS_ENTRY;
  kernel$.watchers.set(entry.watchers);
  kernel$.armed.set(entry.armed);
  kernel$.nextFire.set(entry.nextFire);
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
  kernel$.pulseLog.set(snapshot.pulseLog.filter((record) => record.canvasName === canvasName));
  // Global surfaces — independent of the open canvas.
  kernel$.fault.set(snapshot.fault ?? "");
  kernel$.orphaned.set([...(snapshot.orphanedArming ?? [])]);
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
