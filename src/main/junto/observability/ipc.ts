/**
 * The Observability panel's channels. The ring lives in the core, where every
 * service row is written (ops/observability.ts); main's own logger lines are
 * forwarded there on `observability.append`, so the panel shows one log, not
 * main's half of it. A new row reaches a window only while a panel watches.
 */
import type { IpcMain } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import type { ObservabilityLogEntry, ObservabilitySnapshot } from "@shared/observability";
import { core } from "../../core-process/main-client";
import { subscribe as onCorePush } from "../../core-process/push";
import { OBSERVABILITY_CLEARED, OBSERVABILITY_LOG, type ObservabilityCleared } from "../../core-process/channels";
import { setObservabilityForwarder } from "./logger";

export const registerObservabilityIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
): void => {
  // Main's own lines belong in the core's ring: send each as it is written.
  setObservabilityForwarder((entry) => {
    void core.call("observability.append", { entry }).catch(() => undefined);
  });

  onCorePush(OBSERVABILITY_LOG, (entry) => broadcast(IPC_CHANNELS.observabilityLog, entry as ObservabilityLogEntry));
  onCorePush(OBSERVABILITY_CLEARED, (cleared) =>
    broadcast(IPC_CHANNELS.observabilityCleared, cleared as ObservabilityCleared),
  );

  ipcMain.handle(IPC_CHANNELS.observabilityQuery, (_event, raw: unknown): Promise<ObservabilitySnapshot> =>
    core.call("observability.query", { query: raw }),
  );
  ipcMain.handle(IPC_CHANNELS.observabilityClear, (): Promise<ObservabilitySnapshot> =>
    core.call("observability.clear", {}),
  );
  ipcMain.handle(IPC_CHANNELS.observabilityWatch, (): Promise<ObservabilitySnapshot> =>
    core.call("observability.watch", {}),
  );
  ipcMain.handle(IPC_CHANNELS.observabilityUnwatch, () => core.call("observability.unwatch", {}));
};
