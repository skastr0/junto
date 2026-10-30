/**
 * The state backup worker: one request, one backup, then it ends. It reads the
 * state database through its own read-only connection (it can change no row)
 * and writes only the backup file, owner-only, in the state directory's
 * `backups` folder (operator ruling 2026-10-30: work that is not the business
 * writer's runs off main). Every verification step and the publish order are
 * `createVerifiedStateBackup`'s, unchanged.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runStateBackupHere } from "./backup";
import type { BackupWorkerAnswer, BackupWorkerData } from "./backup-host";

/** The answer to one request: the receipt, or the failure's message. */
export const answerBackup = (data: BackupWorkerData): BackupWorkerAnswer => {
  try {
    return { ok: true, receipt: runStateBackupHere(data.path, data.stateDirectory) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// Loaded on a thread that is not a worker (vitest resolves `?nodeWorker` to
// this module), it serves nothing, and the host backs up on its own thread.
if (parentPort !== null) parentPort.postMessage(answerBackup(workerData as BackupWorkerData));
