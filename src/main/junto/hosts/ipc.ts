import type { IpcMain, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { IPC_CHANNELS } from "@shared/ipc";
import { core } from "../../core-process/main-client";
import { MACHINE_PROGRESS, type MachineProgressPushed } from "../../core-process/channels";
import { subscribe as subscribeCore } from "../../core-process/push";

export const registerHostsIpc = (ipcMain: IpcMain): void => {
  // A running command's progress goes only to the window whose call asked for it.
  const senders = new Map<string, WebContents>();
  subscribeCore(MACHINE_PROGRESS, (payload) => {
    const pushed = payload as MachineProgressPushed;
    const sender = senders.get(pushed.requestId);
    if (sender !== undefined && !sender.isDestroyed()) sender.send(IPC_CHANNELS.machineProgress, pushed.progress);
  });

  ipcMain.handle(IPC_CHANNELS.machineCommand, (event, input: unknown) => {
    const requestId = randomUUID();
    senders.set(requestId, event.sender);
    return core.call("ipc.hosts.command", { input, requestId }).finally(() => senders.delete(requestId));
  });
};
