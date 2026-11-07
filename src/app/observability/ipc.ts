/**
 * The Observability panel's channels. The ring lives in the core, where every
 * service row is written (the observability group,
 * src/contract/core/observability.ts); main's own logger lines are sent there
 * on `ObservabilityAppend`, so the panel shows one log, not main's half of it.
 * A new row reaches a window only while a panel watches. A panel's query is
 * decoded at main's edge; one this build does not read asks for the ring
 * unfiltered.
 */
import { app, type IpcMain } from "electron";
import { Context, Effect, Queue } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { observabilityQueryFromWindow, type ObservabilityLogEntry, type ObservabilitySnapshot } from "@shared/observability";
import { OBSERVABILITY_CLEARED, OBSERVABILITY_LOG, type ObservabilityCleared } from "../../contract/core/channels";
import { ObservabilityCore } from "../../contract/core/observability";
import { subscribe as onCorePush } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";
import { mainLog, mainRows } from "./main-log";

export const registerObservabilityIpc = (
  ipcMain: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
  core: Context.Context<ObservabilityCore>,
): void => {
  const observability = Context.get(core, ObservabilityCore);
  // Main's own lines belong in the core's ring: each is sent as it is
  // written, in order, and a row the core does not take is main's log file's
  // alone. Not one row after the quit begins: the core stops before main
  // does, so a late row goes to main's log file only, never into a call
  // nobody answers.
  AppRuntime.runFork(
    Queue.take(mainRows).pipe(
      Effect.flatMap((entry) => Effect.forkChild(Effect.ignore(observability.ObservabilityAppend({ entry })))),
      Effect.forever,
    ),
  );
  app.once("before-quit", () => mainLog.stopRows());

  onCorePush(OBSERVABILITY_LOG, (entry) => broadcast(IPC_CHANNELS.observabilityLog, entry as ObservabilityLogEntry));
  onCorePush(OBSERVABILITY_CLEARED, (cleared) =>
    broadcast(IPC_CHANNELS.observabilityCleared, cleared as ObservabilityCleared),
  );

  ipcMain.handle(IPC_CHANNELS.observabilityQuery, (_event, raw: unknown): Promise<ObservabilitySnapshot> => {
    const query = observabilityQueryFromWindow(raw);
    return AppRuntime.runPromise(observability.ObservabilityQuery(query === undefined ? {} : { query }));
  });
  ipcMain.handle(IPC_CHANNELS.observabilityClear, (): Promise<ObservabilitySnapshot> =>
    AppRuntime.runPromise(observability.ObservabilityClear()),
  );
  ipcMain.handle(IPC_CHANNELS.observabilityWatch, (): Promise<ObservabilitySnapshot> =>
    AppRuntime.runPromise(observability.ObservabilityWatch()),
  );
  ipcMain.handle(IPC_CHANNELS.observabilityUnwatch, () =>
    AppRuntime.runPromise(observability.ObservabilityUnwatch()).then(() => ({ ok: true as const })),
  );
};
