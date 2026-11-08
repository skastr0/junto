import type { IpcMain, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { Context } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { MACHINE_PROGRESS, type MachineProgressPushed } from "../../contract/core/channels";
import { HostsCore } from "../../contract/core/hosts-ipc";
import { CorePushesMain } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";

/**
 * The one machine command the window sends, asked of the core's hosts group
 * (src/contract/core/hosts-ipc.ts). The input stays as the window sent it:
 * the core decodes it closed against the owner's request union and refuses
 * what is not a machine command, and answers every refusal in the owner
 * envelope, so nothing here judges it.
 */
export const registerHostsIpc = (ipcMain: IpcMain, core: Context.Context<HostsCore | CorePushesMain>): void => {
  const hosts = Context.get(core, HostsCore);
  const pushes = Context.get(core, CorePushesMain);
  // A running command's progress goes only to the window whose call asked for it.
  const senders = new Map<string, WebContents>();
  pushes.subscribe(MACHINE_PROGRESS, (payload) => {
    const pushed = payload as MachineProgressPushed;
    const sender = senders.get(pushed.requestId);
    if (sender !== undefined && !sender.isDestroyed()) sender.send(IPC_CHANNELS.machineProgress, pushed.progress);
  });

  ipcMain.handle(IPC_CHANNELS.machineCommand, (event, input: unknown) => {
    const requestId = randomUUID();
    senders.set(requestId, event.sender);
    return AppRuntime.runPromise(hosts.HostsCommand({ input, requestId })).finally(() => senders.delete(requestId));
  });
};
