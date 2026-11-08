/**
 * The window's settings channels. Every answer comes from the core's settings
 * group (src/contract/core/settings.ts), already masked for the renderer; main
 * keeps what is Electron's: the interface size, which is the window's zoom
 * factor, the login item, the save dialog of a backup export, and the OS
 * appearance reading, which this process alone can see.
 *
 * What the window sends is decoded closed here, at main's edge
 * (`shared/settings.ts`, `shared/machine-settings.ts`), so the core is handed
 * typed values only; a value this build does not read is answered as the
 * window reads every refusal, and never sent.
 *
 * The stored settings reach this process's own runtime through the core:
 * `SettingsApply` sets the theme preference and the tool directories where
 * seats are spawned (`core/ops/settings-apply.ts`), so main holds no copy that
 * could disagree.
 */
import type { IpcMain, SaveDialogOptions } from "electron";
import { app, BrowserWindow, dialog, nativeTheme } from "electron";
import { Context, Result, type Effect } from "effect";
import type { RpcClientError } from "effect/rpc";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  machineCacheWindowsWriteFromWindow,
  machineFromWindow,
  machineProvidersWriteFromWindow,
  machineRecordWriteFromWindow,
} from "@shared/machine-settings";
import {
  interfaceScaleOf,
  machinePreferencesFromWindow,
  redactProvidersForIpc,
  settingsPatchFromWindow,
  settingsResetSectionFromWindow,
  type Settings,
} from "@shared/settings";
import { SettingsCore } from "../../contract/core/settings";
import { askOnEveryCore } from "../core-process/every-core";
import { SETTINGS_CHANGED } from "../../contract/core/channels";
import { subscribe as subscribeCore } from "../core-process/main-side/core-pushes";
import { setInterfaceScale } from "../interface-scale";
import { createStartupProvider } from "../login-item";
import { AppRuntime } from "../runtime";
import {
  createStateRecoveryIpcHandlers,
  type StateRecoveryDestinationChoice,
} from "../state/recovery-ipc";

/** The core's answer to what the window sent, or main's own answer when it could not be read. */
const decodedThen = <W, Refused, A>(
  decoded: Result.Result<W, Refused>,
  ask: (value: W) => Effect.Effect<A, RpcClientError.RpcClientError>,
): Promise<A | Refused> =>
  Result.isFailure(decoded) ? Promise.resolve(decoded.failure) : AppRuntime.runPromise(ask(decoded.success));

export const registerSettingsIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
  core: Context.Context<SettingsCore>,
): void => {
  const settings = Context.get(core, SettingsCore);
  const startupProvider = createStartupProvider(app);
  /** The interface size is main's to apply: it is the window's zoom factor. */
  const publishInterfaceScale = (next: Settings): void => {
    setInterfaceScale(interfaceScaleOf(next));
  };
  /** What this process's runtime needs, applied where it runs, with the OS reading only main sees. */
  const applyToCore = (): Promise<void> =>
    AppRuntime.runPromise(settings.SettingsApply({ systemPrefersDark: nativeTheme.shouldUseDarkColors })).catch(() => undefined);

  const stateRecovery = createStateRecoveryIpcHandlers({
    listBackups: () => AppRuntime.runPromise(settings.SettingsBackups()),
    exportBackup: (id, destination) => AppRuntime.runPromise(settings.SettingsBackupExport({ id, destination })),
  });
  // Every answer comes from the core already masked for the renderer; main
  // publishes its own part of it on the way out.
  ipcMain.handle(IPC_CHANNELS.settingsGet, () => AppRuntime.runPromise(settings.SettingsGet()));
  ipcMain.handle(IPC_CHANNELS.settingsPatch, (_event, raw: unknown) =>
    decodedThen(settingsPatchFromWindow(raw), (patch) => settings.SettingsPatch({ patch })));
  // Supervision has its own protected preference command.
  ipcMain.handle(IPC_CHANNELS.settingsSetMachinePreferences, (_event, raw: unknown) =>
    decodedThen(machinePreferencesFromWindow(raw), (machine) => settings.SettingsSetMachinePreferences({ machine })));

  // Machine-scoped pages ask a machine by name: the core answers for its own
  // machine, and another machine over the link (docs/machines.md).
  ipcMain.handle(IPC_CHANNELS.machineProviders, (_event, raw: unknown) =>
    decodedThen(machineFromWindow(raw), (machine) => settings.SettingsMachineProviders({ machine })));
  ipcMain.handle(IPC_CHANNELS.machineProvidersWrite, (_event, raw: unknown) =>
    decodedThen(machineProvidersWriteFromWindow(raw), (write) => settings.SettingsMachineProvidersWrite(write)));
  ipcMain.handle(IPC_CHANNELS.machineRecord, (_event, raw: unknown) =>
    decodedThen(machineFromWindow(raw), (machine) => settings.SettingsMachineRecord({ machine })));
  ipcMain.handle(IPC_CHANNELS.machineRecordWrite, (_event, raw: unknown) =>
    decodedThen(machineRecordWriteFromWindow(raw), (write) => settings.SettingsMachineRecordWrite(write)));
  ipcMain.handle(IPC_CHANNELS.machineCacheWindows, (_event, raw: unknown) =>
    decodedThen(machineFromWindow(raw), (machine) => settings.SettingsMachineCacheWindows({ machine })));
  ipcMain.handle(IPC_CHANNELS.machineCacheWindowsWrite, (_event, raw: unknown) =>
    decodedThen(machineCacheWindowsWriteFromWindow(raw), (write) => settings.SettingsMachineCacheWindowsWrite(write)));

  ipcMain.handle(IPC_CHANNELS.settingsReset, (_event, raw?: unknown) =>
    decodedThen(settingsResetSectionFromWindow(raw), (section) =>
      settings.SettingsReset(section === undefined ? {} : { section })));

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

  // Only matters while the preference is "system"; harmless otherwise.
  nativeTheme.on("updated", () => void applyToCore());

  // The settings as they stand, then every change, arrive in order on one
  // push. The first gives the window its interface size before any renderer
  // exists, so a seat woken early is not spawned against the pre-settings
  // default.
  subscribeCore(SETTINGS_CHANGED, (payload) => {
    const next = payload as Settings;
    publishInterfaceScale(next);
    broadcast(IPC_CHANNELS.settingsChanged, redactProvidersForIpc(next));
    void applyToCore();
  });
  askOnEveryCore("settings.watch", () => AppRuntime.runPromise(settings.SettingsWatch()));
  // A core that just started has applied no settings yet: this process's
  // runtime reads them before any seat is woken.
  askOnEveryCore("settings.apply", () => applyToCore());
};
