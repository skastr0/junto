/**
 * Append-only JSONL failure tape for SSH, sockets, and seat table hops.
 * Sync and fail-closed: a log miss must never break a seat.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import {
  formatTransportFailure,
  transportLogDirectory,
  transportLogPath,
  type TransportTraceEvent,
} from "@shared/transport-trace";

const MAX_BYTES = 8 * 1024 * 1024;

let started = false;
let dirReady = false;

export const startTransportJournal = (): void => {
  started = true;
  try {
    mkdirSync(transportLogDirectory(), { recursive: true });
    dirReady = true;
  } catch {
    dirReady = false;
  }
};

const rotateIfNeeded = (): void => {
  try {
    if (statSync(transportLogPath()).size < MAX_BYTES) return;
    renameSync(transportLogPath(), `${transportLogPath()}.1`);
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
      mkdirSync(transportLogDirectory(), { recursive: true });
      dirReady = true;
    }
    rotateIfNeeded();
    const row: TransportTraceEvent = {
      ts: new Date().toISOString(),
      ...event,
    };
    appendFileSync(transportLogPath(), `${JSON.stringify(row)}\n`, "utf8");
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
