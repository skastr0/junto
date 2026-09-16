/**
 * Append-only JSONL failure tape for SSH, sockets, and seat table hops.
 * Sync and fail-closed: a log miss must never break a seat.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  formatTransportFailure,
  transportLogDirectory,
  transportLogPath,
  type TransportTraceEvent,
} from "@shared/transport-trace";

const MAX_BYTES = 8 * 1024 * 1024;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

const hardenFileIfPresent = (path: string): void => {
  try {
    chmodSync(path, OWNER_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Missing is expected before the first append.
  }
};

const prepareTransportDirectory = (): void => {
  const directory = transportLogDirectory();
  mkdirSync(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  // Recursive mkdir does not repair existing modes. The product root and log
  // directory must stay owner-only even under a permissive desktop umask.
  chmodSync(dirname(directory), OWNER_DIRECTORY_MODE);
  chmodSync(directory, OWNER_DIRECTORY_MODE);
  hardenFileIfPresent(transportLogPath());
  hardenFileIfPresent(`${transportLogPath()}.1`);
};

const appendOwnerOnly = (text: string): void => {
  const file = openSync(transportLogPath(), "a", OWNER_FILE_MODE);
  try {
    // open(2)'s mode only applies on creation; repair an existing permissive
    // journal before writing another potentially sensitive transport row.
    fchmodSync(file, OWNER_FILE_MODE);
    appendFileSync(file, text, "utf8");
  } finally {
    closeSync(file);
  }
};

let started = false;
let dirReady = false;

export const startTransportJournal = (): void => {
  started = true;
  try {
    prepareTransportDirectory();
    dirReady = true;
  } catch {
    dirReady = false;
  }
};

const rotateIfNeeded = (): void => {
  try {
    const current = transportLogPath();
    const rotated = `${current}.1`;
    hardenFileIfPresent(current);
    if (statSync(current).size < MAX_BYTES) return;
    renameSync(current, rotated);
    hardenFileIfPresent(rotated);
  } catch {
    // missing or cannot rotate — next append still tries
  }
};

export const appendTransportTrace = (
  event: Omit<TransportTraceEvent, "ts">,
): void => {
  if (!started) return;
  try {
    if (!dirReady) {
      prepareTransportDirectory();
      dirReady = true;
    }
    rotateIfNeeded();
    const row: TransportTraceEvent = {
      ts: new Date().toISOString(),
      ...event,
    };
    appendOwnerOnly(`${JSON.stringify(row)}\n`);
  } catch {
    // journal must never take down SSH or a seat
  }
};

export const recordTransportError = (
  event: Omit<TransportTraceEvent, "ts" | "ok" | "error">,
  cause: unknown,
): void => {
  appendTransportTrace({
    ...event,
    ok: false,
    ...formatTransportFailure(cause),
  });
};
