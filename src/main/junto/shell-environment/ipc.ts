import type { IpcMain } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import type { ShellEnvironment } from "./environment";

/**
 * Onboarding and Settings read what Junto took from the shell, and ask for a
 * fresh read. Names, directories and typed causes only: no value crosses.
 */
export const registerShellEnvironmentIpc = (
  ipcMain: IpcMain,
  environment: ShellEnvironment,
  broadcast: (channel: string, payload: unknown) => void,
): (() => void) => {
  ipcMain.handle(IPC_CHANNELS.shellEnvironmentStatus, () => environment.status());
  ipcMain.handle(IPC_CHANNELS.shellEnvironmentRefresh, () => environment.refresh("operator"));
  return environment.onChange((change) => broadcast(IPC_CHANNELS.shellEnvironmentChanged, change));
};
