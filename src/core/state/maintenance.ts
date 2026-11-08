import type { Worker } from "node:worker_threads";
import createMaintenanceWorker from "./maintenance-worker?nodeWorker";

/**
 * The state engine's side of the maintenance worker (`maintenance-worker.ts`).
 * While the worker runs, it checkpoints the WAL off main and the writer's own
 * auto-checkpoint is off, so no commit on main copies the log into the
 * database (14 to 18 ms each on the live file). The moment the worker stops,
 * the writer checkpoints for itself again, so the log never grows unchecked.
 * The worker also runs a bounded ANALYZE a minute after it starts and then
 * daily.
 *
 * A runtime with no worker entry (vitest, the machine core bundle) starts
 * nothing, and the writer keeps SQLite's default checkpoints.
 */

export type MaintenanceWorkerData = { readonly path: string };
export type MaintenanceRequest = { readonly kind: "analyze" };
export type MaintenanceNote =
  | { readonly kind: "ready" }
  | { readonly kind: "analyzed"; readonly analyzed: number; readonly skipped: number; readonly ms: number }
  | { readonly kind: "failed"; readonly error: string };

/** SQLite's default, which the writer returns to whenever the worker is not running. */
export const WRITER_AUTOCHECKPOINT_PAGES = 1_000;
const ANALYZE_FIRST_MS = 60_000;
const ANALYZE_EVERY_MS = 24 * 60 * 60_000;
const RESTART_FIRST_MS = 1_000;
const RESTART_MAX_MS = 60_000;
/** A worker that lived this long resets the backoff. */
const RESTART_SETTLED_MS = 60_000;

export type StateMaintenance = { readonly close: () => void };

/** `writerCheckpoints` sets the writer's auto-checkpoint in pages; 0 turns it off. */
export const startStateMaintenance = (
  path: string,
  writerCheckpoints: (pages: number) => void,
): StateMaintenance => {
  if (typeof createMaintenanceWorker !== "function" || path === ":memory:") return { close: () => {} };
  let closed = false;
  let current: Worker | undefined;
  let stops = 0;
  let startedAt = 0;
  let analyzedAt = 0;
  let restart: ReturnType<typeof setTimeout> | undefined;
  let analyze: ReturnType<typeof setTimeout> | undefined;

  const scheduleAnalyze = (worker: Worker): void => {
    clearTimeout(analyze);
    const due = analyzedAt === 0 ? ANALYZE_FIRST_MS : Math.max(0, analyzedAt + ANALYZE_EVERY_MS - Date.now());
    analyze = setTimeout(() => {
      if (current === worker) worker.postMessage({ kind: "analyze" } satisfies MaintenanceRequest);
    }, due);
    analyze.unref?.();
  };

  const stopped = (worker: Worker): void => {
    if (current !== worker) return;
    current = undefined;
    clearTimeout(analyze);
    writerCheckpoints(WRITER_AUTOCHECKPOINT_PAGES);
    if (closed) return;
    if (Date.now() - startedAt > RESTART_SETTLED_MS) stops = 0;
    restart = setTimeout(start, Math.min(RESTART_MAX_MS, RESTART_FIRST_MS * 2 ** stops));
    restart.unref?.();
    stops += 1;
  };

  const start = (): void => {
    if (closed) return;
    const workerData: MaintenanceWorkerData = { path };
    const worker = createMaintenanceWorker({ name: "junto-state-maintenance", workerData });
    worker.unref();
    current = worker;
    startedAt = Date.now();
    worker.on("message", (note: MaintenanceNote) => {
      if (current !== worker) return;
      if (note.kind === "ready") {
        writerCheckpoints(0);
        scheduleAnalyze(worker);
      } else if (note.kind === "analyzed") {
        analyzedAt = Date.now();
        scheduleAnalyze(worker);
      }
    });
    worker.on("error", () => stopped(worker));
    worker.on("exit", () => stopped(worker));
  };

  start();
  return {
    close: () => {
      closed = true;
      clearTimeout(restart);
      clearTimeout(analyze);
      if (current !== undefined) writerCheckpoints(WRITER_AUTOCHECKPOINT_PAGES);
      const worker = current;
      current = undefined;
      void worker?.terminate();
    },
  };
};
