import type { IpcMain } from "electron";
import { Schema } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  ObservabilityQuery,
  type ObservabilityLogEntry,
  type ObservabilitySnapshot,
} from "@shared/observability";
import { observabilityRing } from "./ring";

const decodeQuery = Schema.decodeUnknownEither(ObservabilityQuery);

export const registerObservabilityIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.observabilityQuery,
    (_event, raw: unknown): ObservabilitySnapshot => {
      if (raw === undefined || raw === null) {
        return observabilityRing.query();
      }
      const decoded = decodeQuery(raw);
      if (decoded._tag === "Left") {
        return observabilityRing.query();
      }
      return observabilityRing.query(decoded.right);
    },
  );

  ipcMain.handle(IPC_CHANNELS.observabilityClear, (): ObservabilitySnapshot => {
    observabilityRing.clear();
    return observabilityRing.query({ limit: 1 });
  });

  // Live push: every append fans out to renderers. The panel filters client-side
  // and only mounts the subscription while open — cheap empty-listener path.
  observabilityRing.subscribe((entry: ObservabilityLogEntry) => {
    broadcast(IPC_CHANNELS.observabilityLog, entry);
  });
};
