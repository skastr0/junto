import type { IpcMain, WebContents } from "electron";
import { IPC_CHANNELS, type TerminalAttachInput } from "@shared/ipc";
import type { ControlLease, LocalHostEvent } from "./local-host";
import type { TermPlane } from "./plane";

type LeaseOwner = {
  readonly lease: ControlLease;
  readonly sender: WebContents;
  readonly release: () => void;
};

export const registerTerminalIpc = (ipcMain: IpcMain, plane: TermPlane): void => {
  const owners = new Map<string, LeaseOwner>();

  const release = (leaseId: string): void => {
    const owner = owners.get(leaseId);
    if (!owner) return;
    owners.delete(leaseId);
    plane.host.release(owner.lease);
    try {
      if (!owner.sender.isDestroyed()) {
        owner.sender.removeListener("destroyed", owner.release);
        owner.sender.removeListener("render-process-gone", owner.release);
        owner.sender.removeListener("did-start-loading", owner.release);
      }
    } catch { /* renderer is already gone */ }
  };

  const owned = (sender: WebContents, leaseId: string): LeaseOwner | undefined => {
    const owner = owners.get(leaseId);
    return owner?.sender === sender && !sender.isDestroyed() ? owner : undefined;
  };

  plane.host.on("event", (payload: LocalHostEvent) => {
    for (const owner of owners.values()) {
      if (owner.lease.bindingId !== payload.bindingId || owner.lease.epoch !== payload.epoch) continue;
      if (!owner.sender.isDestroyed()) owner.sender.send(IPC_CHANNELS.terminalEvent, payload);
    }
  });

  ipcMain.handle(IPC_CHANNELS.terminalList, () => plane.host.list());
  ipcMain.handle(IPC_CHANNELS.terminalCreate, (_event, input) => plane.host.create(input));
  ipcMain.handle(IPC_CHANNELS.terminalGet, (_event, bindingId: string) => plane.host.get(bindingId));
  ipcMain.handle(IPC_CHANNELS.terminalKill, (_event, bindingId: string) => plane.host.kill(bindingId));
  ipcMain.handle(IPC_CHANNELS.terminalBindCanvas, (_event, bindingId: string, ref) => {
    plane.host.bindCanvas(bindingId, ref);
  });
  ipcMain.handle(IPC_CHANNELS.terminalAttach, (event, input: TerminalAttachInput) => {
    const result = plane.host.attach(input);
    if (!result.ok) return result;
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) {
      plane.host.release(result.lease);
      return { ok: false as const, message: "renderer gone" };
    }
    const leaseId = result.lease.leaseId;
    const releaseOwner = () => release(leaseId);
    sender.once("destroyed", releaseOwner);
    sender.once("render-process-gone", releaseOwner);
    sender.once("did-start-loading", releaseOwner);
    owners.set(leaseId, { lease: result.lease, sender, release: releaseOwner });
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.terminalRelease, (event, leaseId: string) => {
    if (!owned(event.sender, leaseId)) return false;
    release(leaseId);
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.terminalWrite, (event, leaseId: string, data: string, encoding = "utf8") => {
    const owner = owned(event.sender, leaseId);
    if (!owner) return false;
    const decoded = encoding === "base64" ? Buffer.from(data, "base64").toString("utf8") : data;
    return plane.host.write(owner.lease, decoded);
  });
  ipcMain.handle(IPC_CHANNELS.terminalResize, (event, leaseId: string, cols: number, rows: number) => {
    const owner = owned(event.sender, leaseId);
    return owner ? plane.host.resize(owner.lease, cols, rows) : false;
  });
  ipcMain.handle(IPC_CHANNELS.terminalShutdown, () => plane.host.shutdownAll("ipc_shutdown"));
};
