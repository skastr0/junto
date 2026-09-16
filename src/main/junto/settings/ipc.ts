import type { IpcMain, SaveDialogOptions } from "electron";
import { app, BrowserWindow, dialog, nativeTheme } from "electron";
import { Effect, Result } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { refreshThemeFromSystem, setThemePreference } from "../theme-state";
import { themePublishDecision } from "./theme-publish";
import {
  SettingsSectionKey,
  redactProvidersForIpc,
  settingsOpFail,
  settingsOpOk,
  type Settings,
  type SettingsOpResult,
} from "@shared/settings";
import { setConfiguredToolDirectories } from "../adapters/exec";
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

/**
 * Renderer-facing projection: provider secrets leave main only as
 * MASKED_SECRET. Raw values stay inside main (SettingsService and the
 * usage-plane accessor); they never ride IPC results or broadcasts.
 */
const toRendererOpResult = (op: SettingsOpResult): SettingsOpResult =>
  op.settings === undefined ? op : { ...op, settings: redactProvidersForIpc(op.settings) };

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
  /**
   * Feed main's theme state. Main owns the resolved theme for the whole app —
   * every canvas, rendered or not, and every seat spawned with no surface — so
   * the stored preference has to reach it whenever it loads or changes.
   */
  const publishThemePreference = (settings: Settings): void => {
    setThemePreference(settings.appearance.theme);
  };
  const publishToolDirectories = (settings: Settings): void => {
    setConfiguredToolDirectories(settings.advanced.toolDirectories ?? []);
  };
  /** Same publish, from an IPC result. See `themePublishDecision`. */
  const publishThemeFromOp = (op: SettingsOpResult): void => {
    const decision = themePublishDecision(op);
    if (decision.kind === "leave") return;
    setThemePreference(decision.preference);
  };
  const publishToolDirectoriesFromOp = (op: SettingsOpResult): void => {
    if (op.settings === undefined) return;
    publishToolDirectories(op.settings);
  };
  // Only matters while the preference is "system"; harmless otherwise.
  nativeTheme.on("updated", () => refreshThemeFromSystem());

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
        const op = toOpResult(result);
        publishThemeFromOp(op);
        publishToolDirectoriesFromOp(op);
        return toRendererOpResult(op);
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
        const op = toOpResult(result);
        publishThemeFromOp(op);
        publishToolDirectoriesFromOp(op);
        return toRendererOpResult(op);
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
        return toRendererOpResult(toOpResult(result));
      }),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.settingsReset, (_event, section?: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        if (section === undefined || section === null || section === "") {
          const result = yield* Effect.result(settings.reset());
          const op = toOpResult(result);
          publishToolDirectoriesFromOp(op);
          return toRendererOpResult(op);
        }
        const decoded = decodeSection(section);
        if (Result.isFailure(decoded)) {
          return settingsOpFail("validation", "settings reset section is invalid");
        }
        const result = yield* Effect.result(settings.reset(decoded.success));
        const op = toOpResult(result);
        publishToolDirectoriesFromOp(op);
        return toRendererOpResult(op);
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
          title: "Export verified Junto state backup",
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
      settings.subscribe((next) => {
        publishThemePreference(next);
        publishToolDirectories(next);
        broadcast(IPC_CHANNELS.settingsChanged, redactProvidersForIpc(next));
      });
      // Prime cache so first UI open is warm and doctor is honest. This also
      // gives main the theme before any renderer exists, so a seat woken early
      // is not spawned against the pre-settings default.
      const primed = yield* settings.get.pipe(Effect.result);
      if (Result.isSuccess(primed)) {
        publishThemePreference(primed.success);
        publishToolDirectories(primed.success);
      }
    }),
  );
};
