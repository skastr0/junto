import type { Worker } from "node:worker_threads";
import createBackupWorker from "./backup-worker?nodeWorker";
import { runStateBackupHere } from "./backup";
import type { StateBackupReceipt } from "./service";

/**
 * Main's side of the state backup worker (`backup-worker.ts`). A backup is the
 * VACUUM INTO of the whole database, a second VACUUM to strip provider
 * secrets, a quick_check, a foreign_key_check and a row count of every table,
 * several seconds of synchronous SQLite on the 567 MB live file. It runs on a
 * worker thread while main awaits, so input, IPC and the other seats keep
 * going.
 *
 * Backups run one at a time: each one first removes the pending files an
 * earlier one left, and two at once would remove each other's.
 *
 * A runtime with no worker entry (vitest, the machine core bundle) backs up
 * on the calling thread, through the same function.
 */

export type BackupWorkerData = { readonly path: string; readonly stateDirectory: string };
export type BackupWorkerAnswer =
  | { readonly ok: true; readonly receipt: StateBackupReceipt }
  | { readonly ok: false; readonly error: string };

const runOnWorker = (data: BackupWorkerData, signal?: AbortSignal): Promise<StateBackupReceipt> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("state backup was interrupted"));
    const worker: Worker = createBackupWorker({ name: "junto-state-backup", workerData: data });
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      settle();
    };
    const onAbort = (): void => finish(() => reject(new Error("state backup was interrupted")));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (answer: BackupWorkerAnswer) =>
      finish(() => (answer.ok ? resolve(answer.receipt) : reject(new Error(answer.error)))));
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", () => finish(() => reject(new Error("state backup worker stopped before it answered"))));
  });

let queue: Promise<unknown> = Promise.resolve();

/** A verified backup of the state database at `path`, off the calling thread where the runtime has a worker. */
export const runStateBackup = (
  path: string,
  stateDirectory: string,
  signal?: AbortSignal,
): Promise<StateBackupReceipt> => {
  const run = (): Promise<StateBackupReceipt> =>
    typeof createBackupWorker === "function"
      ? runOnWorker({ path, stateDirectory }, signal)
      : new Promise((resolve, reject) => {
        try {
          resolve(runStateBackupHere(path, stateDirectory));
        } catch (error) {
          reject(error);
        }
      });
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
};
