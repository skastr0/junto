import type { IpcMain } from "electron";
import { Context } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type { ShellEnvironmentChange } from "@shared/shell-environment";
import { SHELL_ENVIRONMENT_CHANGED } from "../../contract/core/channels";
import { ShellEnvironmentCore } from "../../contract/core/shell-environment";
import { subscribe as onCorePush } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";

/**
 * Onboarding and Settings read what the core took from the shell, and ask for a
 * fresh read there (the shell environment group,
 * src/contract/core/shell-environment.ts): the core's copy is the one that
 * writes the environment its spawns use. Names, directories and typed causes
 * only: no value crosses. Returns the unsubscribe from the core push.
 */
export const registerShellEnvironmentIpc = (
  ipcMain: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
  core: Context.Context<ShellEnvironmentCore>,
): (() => void) => {
  const shellEnvironment = Context.get(core, ShellEnvironmentCore);
  ipcMain.handle(IPC_CHANNELS.shellEnvironmentStatus, () => AppRuntime.runPromise(shellEnvironment.ShellEnvironmentStatus()));
  ipcMain.handle(IPC_CHANNELS.shellEnvironmentRefresh, () => AppRuntime.runPromise(shellEnvironment.ShellEnvironmentRefresh()));
  return onCorePush(SHELL_ENVIRONMENT_CHANGED, (change) =>
    broadcast(IPC_CHANNELS.shellEnvironmentChanged, change as ShellEnvironmentChange),
  );
};
