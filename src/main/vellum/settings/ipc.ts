import type { IpcMain, SaveDialogOptions } from "electron";
import { app, BrowserWindow, dialog } from "electron";
import { Effect, Result } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  SettingsSectionKey,
  settingsOpFail,
  settingsOpOk,
  type SettingsOpResult,
} from "@shared/settings";
import { Schema } from "effect";
import { AppRuntime } from "../../runtime";
import {
  createStartupProvider,
} from "../login-item";
import { SettingsService } from "./service";
import {
  createStateRecoveryIpcHandlers,
  type StateRecoveryDestinationChoice,
} from "../state/recovery-ipc";
import {
  exportStateBackup,
  listStateBackups,
} from "../state/recovery";

const decodeSection = Schema.decodeUnknownResult(SettingsSectionKey);

const toOpResult = (
  either: Result.Result<
    import("@shared/settings").Settings,
    import("@shared/settings").SettingsError
  >,
): SettingsOpResult => {
  if (Result.isSuccess(either)) return settingsOpOk(either.success);
  return settingsOpFail(either.failure.code, either.failure.message);
};

export const registerSettingsIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
): void => {
  const startupProvider = createStartupProvider(app);
  const stateRecovery = createStateRecoveryIpcHandlers({
    listBackups: () => AppRuntime.runPromise(listStateBackups()),
    exportBackup: (id, destination) =>
      AppRuntime.runPromise(exportStateBackup(id, destination)),
  });
  ipcMain.handle(IPC_CHANNELS.settingsGet, () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        const result = yield* Effect.result(settings.get);
        return toOpResult(result);
      }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.settingsPatch, (_event, patch: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        // Reject non-objects early so IPC cannot pass arrays/primitives that
        // would otherwise produce opaque schema trees.
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
          return settingsOpFail("validation", "settings patch must be a plain object");
        }
        const result = yield* Effect.result(settings.patch(patch));
        return toOpResult(result);
      }),
    ),
  );

  // Topology (station role / host / CC ref / supervised) — dedicated channel.
  // Generic settingsPatch refuses station keys; this path persists the
  // normalized protected topology.
  ipcMain.handle(IPC_CHANNELS.settingsSetStationTopology, (_event, station: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        if (station === null || typeof station !== "object" || Array.isArray(station)) {
          return settingsOpFail(
            "validation",
            "station topology patch must be a plain object",
          );
        }
        const result = yield* Effect.result(settings.setStationTopology(station));
        return toOpResult(result);
      }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.settingsReset, (_event, section?: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        if (section === undefined || section === null || section === "") {
          const result = yield* Effect.result(settings.reset());
          return toOpResult(result);
        }
        const decoded = decodeSection(section);
        if (Result.isFailure(decoded)) {
          return settingsOpFail("validation", "settings reset section is invalid");
        }
        const result = yield* Effect.result(settings.reset(decoded.success));
        return toOpResult(result);
      }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.loginItemGet, () => startupProvider.get());
  ipcMain.handle(IPC_CHANNELS.loginItemSet, (_event, openAtLogin: unknown) =>
    startupProvider.set(openAtLogin),
  );

  ipcMain.handle(IPC_CHANNELS.stateBackupsList, () =>
    stateRecovery.list(),
  );
  ipcMain.handle(
    IPC_CHANNELS.stateBackupExport,
    async (event, id: unknown) => {
      const chooseDestination = async (
        suggestedFileName: string,
      ): Promise<StateRecoveryDestinationChoice> => {
        const options: SaveDialogOptions = {
          title: "Export verified Vellum Command state backup",
          buttonLabel: "Export backup",
          defaultPath: suggestedFileName,
          filters: [
            {
              name: "SQLite database",
              extensions: ["db"],
            },
          ],
          properties: ["createDirectory"],
        };
        const owner = BrowserWindow.fromWebContents(event.sender);
        const selected =
          owner === null
            ? await dialog.showSaveDialog(options)
            : await dialog.showSaveDialog(owner, options);
        if (selected.canceled) {
          return { outcome: "canceled" };
        }
        if (selected.filePath.length === 0) {
          throw new Error("save dialog returned no destination");
        }
        return {
          outcome: "selected",
          path: selected.filePath,
        };
      };
      return stateRecovery.export(id, chooseDestination);
    },
  );

  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      settings.subscribe((next) => broadcast(IPC_CHANNELS.settingsChanged, next));
      // Prime cache so first UI open is warm and doctor is honest.
      yield* settings.get.pipe(Effect.catch(() => Effect.void));
    }),
  );
};
