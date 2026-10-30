import type { IpcMain, SaveDialogOptions } from "electron";
import { app, BrowserWindow, dialog, nativeTheme } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import { refreshThemeFromSystem, setThemePreference } from "../theme-state";
import { themePublishDecision } from "./theme-publish";
import { setInterfaceScale } from "../interface-scale";
import {
  interfaceScaleOf,
  redactProvidersForIpc,
  type Settings,
  type SettingsOpResult,
} from "@shared/settings";
import { setConfiguredToolDirectories } from "../adapters/exec";
import { askOnEveryCore } from "../../core-process/every-core";
import { core } from "../../core-process/main-client";
import { SETTINGS_CHANGED } from "../../core-process/ops/main-index";
import { subscribe as subscribeCore } from "../../core-process/push";
import {
  createStartupProvider,
} from "../login-item";
import {
  createStateRecoveryIpcHandlers,
  type StateRecoveryDestinationChoice,
} from "../state/recovery-ipc";

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
  /** The interface size is main's to apply: it is the window's zoom factor. */
  const publishInterfaceScale = (settings: Settings): void => {
    setInterfaceScale(interfaceScaleOf(settings));
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
    listBackups: () => core.call("settings.backups", {}),
    exportBackup: (id, destination) => core.call("settings.backupExport", { id, destination }),
  });
  // Every answer comes from the core already masked for the renderer; main
  // publishes its own part of it (theme, tool directories) on the way out.
  const published = (op: SettingsOpResult): SettingsOpResult => {
    publishThemeFromOp(op);
    publishToolDirectoriesFromOp(op);
    return op;
  };
  ipcMain.handle(IPC_CHANNELS.settingsGet, () => core.call("settings.get", {}).then(published));
  ipcMain.handle(IPC_CHANNELS.settingsPatch, (_event, patch: unknown) =>
    core.call("settings.patch", { patch }).then(published));
  // Supervision has its own protected preference command.
  ipcMain.handle(IPC_CHANNELS.settingsSetMachinePreferences, (_event, machine: unknown) =>
    core.call("settings.setMachinePreferences", { machine }));

  // Machine-scoped pages ask a machine by name: the core answers for its own
  // machine, and another machine over the link (docs/machines.md).
  ipcMain.handle(IPC_CHANNELS.machineProviders, (_event, machine: unknown) => core.call("settings.machineProviders", { machine }));
  ipcMain.handle(IPC_CHANNELS.machineProvidersWrite, (_event, input: unknown) => core.call("settings.machineProvidersWrite", { input }));
  ipcMain.handle(IPC_CHANNELS.machineRecord, (_event, machine: unknown) => core.call("settings.machineRecord", { machine }));
  ipcMain.handle(IPC_CHANNELS.machineRecordWrite, (_event, input: unknown) => core.call("settings.machineRecordWrite", { input }));
  ipcMain.handle(IPC_CHANNELS.machineCacheWindows, (_event, machine: unknown) => core.call("settings.machineCacheWindows", { machine }));
  ipcMain.handle(IPC_CHANNELS.machineCacheWindowsWrite, (_event, input: unknown) =>
    core.call("settings.machineCacheWindowsWrite", { input }));

  ipcMain.handle(IPC_CHANNELS.settingsReset, (_event, section?: unknown) =>
    core.call("settings.reset", { section }).then((op) => {
      publishToolDirectoriesFromOp(op);
      return op;
    }));

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

  // The settings as they stand, then every change, arrive in order on one
  // push. The first gives main the theme before any renderer exists, so a seat
  // woken early is not spawned against the pre-settings default.
  subscribeCore(SETTINGS_CHANGED, (payload) => {
    const next = payload as Settings;
    publishThemePreference(next);
    publishInterfaceScale(next);
    publishToolDirectories(next);
    broadcast(IPC_CHANNELS.settingsChanged, redactProvidersForIpc(next));
  });
  askOnEveryCore("settings.watch", () => core.call("settings.watch", {}));
};
