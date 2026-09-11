import type { IpcMain } from "electron";
import { Schema } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  ObservabilityQuery,
  type ObservabilityLogEntry,
  type ObservabilitySnapshot,
} from "@shared/observability";
import { observabilityRing } from "./ring";

const decodeQuery = Schema.decodeUnknownResult(ObservabilityQuery);

/** Drop present-but-undefined keys (IPC / object literals break exact optionals). */
const stripUndefinedKeys = (raw: unknown): unknown => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

/**
 * Interest count for live IPC push. Ring always captures; we only
 * webContents.send when ≥1 explorer panel is watching — avoids log-storm
 * IPC when the UI is closed.
 */
let watchInterest = 0;
let ringUnsub: (() => void) | undefined;

const ensureRingPush = (
  broadcast: (channel: string, payload: unknown) => void,
): void => {
  if (ringUnsub) return;
  ringUnsub = observabilityRing.subscribe((entry: ObservabilityLogEntry) => {
    if (watchInterest <= 0) return;
    broadcast(IPC_CHANNELS.observabilityLog, entry);
  });
};

export const registerObservabilityIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
): void => {
  ensureRingPush(broadcast);

  ipcMain.handle(
    IPC_CHANNELS.observabilityQuery,
    (_event, raw: unknown): ObservabilitySnapshot => {
      if (raw === undefined || raw === null) {
        return observabilityRing.query();
      }
      // Soft-fail: never throw — IPC handler errors hit console → ring spam.
      const decoded = decodeQuery(stripUndefinedKeys(raw));
      if (decoded._tag === "Failure") {
        return observabilityRing.query();
      }
      return observabilityRing.query(decoded.success);
    },
  );

  ipcMain.handle(IPC_CHANNELS.observabilityClear, (): ObservabilitySnapshot => {
    observabilityRing.clear();
    const snap = observabilityRing.query({ limit: 1 });
    if (watchInterest > 0) {
      broadcast(IPC_CHANNELS.observabilityCleared, {
        newestId: 0,
        total: 0,
        dropped: 0,
      });
    }
    return snap;
  });

  ipcMain.handle(IPC_CHANNELS.observabilityWatch, (): ObservabilitySnapshot => {
    watchInterest += 1;
    return observabilityRing.query({ limit: 500 });
  });

  ipcMain.handle(IPC_CHANNELS.observabilityUnwatch, (): { ok: true } => {
    watchInterest = Math.max(0, watchInterest - 1);
    return { ok: true };
  });
};
