/**
 * The window's settings channels. Every answer is a core operation
 * (`core-process/ops/ipc-settings.ts`), already masked for the renderer; main
 * keeps what is Electron's: the interface size, which is the window's zoom
 * factor, the login item, the save dialog of a backup export, and the OS
 * appearance reading, which this process alone can see.
 *
 * The stored settings reach this process's own runtime through the core:
 * `settings.apply` sets the theme preference and the tool directories where
 * seats are spawned (`core-process/ops/settings-apply.ts`), so main holds no
 * copy that could disagree.
 */
import type { IpcMain, SaveDialogOptions } from "electron";
import { app, BrowserWindow, dialog, nativeTheme } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import { interfaceScaleOf, redactProvidersForIpc, type Settings } from "@shared/settings";
import { askOnEveryCore } from "../../core-process/every-core";
import { core } from "../../core-process/main-client";
import { SETTINGS_CHANGED } from "../../core-process/channels";
import { subscribe as subscribeCore } from "../../core-process/push";
import { setInterfaceScale } from "../interface-scale";
import { createStartupProvider } from "../login-item";
import {
  createStateRecoveryIpcHandlers,
  type StateRecoveryDestinationChoice,
} from "../state/recovery-ipc";

export const registerSettingsIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
): void => {
  const startupProvider = createStartupProvider(app);
  /** The interface size is main's to apply: it is the window's zoom factor. */
  const publishInterfaceScale = (settings: Settings): void => {
    setInterfaceScale(interfaceScaleOf(settings));
  };
  /** What this process's runtime needs, applied where it runs, with the OS reading only main sees. */
  const applyToCore = (): Promise<void> =>
    core.call("settings.apply", { systemPrefersDark: nativeTheme.shouldUseDarkColors }).catch(() => undefined);

  const stateRecovery = createStateRecoveryIpcHandlers({
    listBackups: () => core.call("settings.backups", {}),
    exportBackup: (id, destination) => core.call("settings.backupExport", { id, destination }),
  });
  // Every answer comes from the core already masked for the renderer; main
  // publishes its own part of it on the way out.
  ipcMain.handle(IPC_CHANNELS.settingsGet, () => core.call("settings.get", {}));
  ipcMain.handle(IPC_CHANNELS.settingsPatch, (_event, patch: unknown) => core.call("settings.patch", { patch }));
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
    core.call("settings.reset", { section }));

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
  askOnEveryCore("settings.watch", () => core.call("settings.watch", {}));
  // A core that just started has applied no settings yet: this process's
  // runtime reads them before any seat is woken.
  askOnEveryCore("settings.apply", () => applyToCore());
};
