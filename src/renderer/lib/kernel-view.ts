// The kernel is now a headless loop in the MAIN process (src/main/junto/kernel/)
// — this module is a pure PROJECTION of it over IPC. Renderer surface for the
// execution phase only.

import { observable, observe } from "@legendapp/state";
import type { ExecutionSnapshot, KernelSnapshot } from "@shared/ipc";
import { getJuntoApi } from "./junto-api";
import { state$ } from "./state";

// --- frozen interface --------------------------------------------------------

export type { ExecutionSnapshot };

// `execution` is the open canvas's live edge phase + blocked closure from the
// kernel cycle. Canvas toFlow consumes it so criteria edges use the same
// derived snapshot as phase mirroring.
export const kernel$ = observable<{
  execution: ExecutionSnapshot | null;
  // Monotonic stamp so React effects can depend on execution changes without
  // deep-comparing the snapshot object.
  executionRev: number;
}>({
  execution: null,
  executionRev: 0,
});

// --- projection: KernelSnapshot (all canvases) -> kernel$ (open canvas only) --

const EMPTY_CANVAS_ENTRY: { readonly execution?: ExecutionSnapshot } = {};

// The last snapshot pushed/hydrated from main, kept so a canvasName switch
// can re-project without waiting for the next kernelChanged push.
let latestSnapshot: KernelSnapshot = { canvases: {} };

const projectSnapshot = (snapshot: KernelSnapshot, canvasName: string): void => {
  const entry = snapshot.canvases[canvasName] ?? EMPTY_CANVAS_ENTRY;

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
