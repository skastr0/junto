import type { IpcMain } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import type { ShellEnvironmentChange } from "@shared/shell-environment";
import { core } from "../../core-process/main-client";
import { SHELL_ENVIRONMENT_CHANGED } from "../../core-process/channels";
import { subscribe as onCorePush } from "../../core-process/push";

/**
 * Onboarding and Settings read what the core took from the shell, and ask for a
 * fresh read there: the core's copy is the one that writes the environment its
 * spawns use. Names, directories and typed causes only: no value crosses.
 * Returns the unsubscribe from the core push.
 */
export const registerShellEnvironmentIpc = (
  ipcMain: IpcMain,
  broadcast: (channel: string, payload: unknown) => void,
): (() => void) => {
  ipcMain.handle(IPC_CHANNELS.shellEnvironmentStatus, () => core.call("ipc.shellEnvironment.status", {}));
  ipcMain.handle(IPC_CHANNELS.shellEnvironmentRefresh, () => core.call("ipc.shellEnvironment.refresh", {}));
  return onCorePush(SHELL_ENVIRONMENT_CHANGED, (change) =>
    broadcast(IPC_CHANNELS.shellEnvironmentChanged, change as ShellEnvironmentChange),
  );
};
