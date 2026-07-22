import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { IPC_CHANNELS, type TerminalAttachInput } from "@shared/ipc";
import { messageDelivery } from "../work/message-delivery";
import type { ControlLease, LocalHostEvent } from "./local-host";
import type { TermPlane } from "./plane";

type LeaseOwner = {
  readonly lease: ControlLease;
  readonly sender: WebContents;
  readonly release: () => void;
};

/** Optional gate: only the trusted main renderer may call terminal authority APIs. */
export type TerminalIpcGate = {
  readonly isTrustedSender: (sender: WebContents) => boolean;
};

const deny = (message: string) => {
  throw new Error(message);
};

export const registerTerminalIpc = (
  ipcMain: IpcMain,
  plane: TermPlane,
  gate?: TerminalIpcGate,
): void => {
  const owners = new Map<string, LeaseOwner>();
  /** bindingId → control leaseId currently holding control (for takeover revoke). */
  const controlByBinding = new Map<string, string>();

  const assertTrusted = (event: IpcMainInvokeEvent): WebContents => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) deny("terminal ipc: sender gone");
    if (gate && !gate.isTrustedSender(sender)) deny("terminal ipc: untrusted sender");
    return sender;
  };

  const release = (leaseId: string): void => {
    const owner = owners.get(leaseId);
    if (!owner) return;
    owners.delete(leaseId);
    if (
      owner.lease.mode === "control" &&
      controlByBinding.get(owner.lease.bindingId) === leaseId
    ) {
      controlByBinding.delete(owner.lease.bindingId);
    }
    plane.host.release(owner.lease);
    try {
      if (!owner.sender.isDestroyed()) {
        owner.sender.removeListener("destroyed", owner.release);
        owner.sender.removeListener("render-process-gone", owner.release);
        owner.sender.removeListener("did-start-loading", owner.release);
      }
    } catch {
      /* renderer is already gone */
    }
  };

  const owned = (sender: WebContents, leaseId: string): LeaseOwner | undefined => {
    const owner = owners.get(leaseId);
    return owner?.sender === sender && !sender.isDestroyed() ? owner : undefined;
  };

  const sendSafe = (sender: WebContents, channel: string, payload: unknown): void => {
    try {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    } catch {
      // drop
    }
  };

  plane.host.on("event", (payload: LocalHostEvent) => {
    for (const [leaseId, owner] of owners) {
      if (owner.lease.bindingId !== payload.bindingId || owner.lease.epoch !== payload.epoch) {
        continue;
      }
      if (owner.sender.isDestroyed()) {
        release(leaseId);
        continue;
      }
      try {
        owner.sender.send(IPC_CHANNELS.terminalEvent, payload);
      } catch {
        release(leaseId);
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.terminalList, (event) => {
    assertTrusted(event);
    return plane.host.list();
  });
  ipcMain.handle(IPC_CHANNELS.terminalCreate, (event, input) => {
    assertTrusted(event);
    return plane.host.create(input);
  });
  ipcMain.handle(IPC_CHANNELS.terminalGet, (event, bindingId: string) => {
    assertTrusted(event);
    return plane.host.get(bindingId);
  });
  ipcMain.handle(IPC_CHANNELS.terminalKill, (event, bindingId: string) => {
    assertTrusted(event);
    return plane.host.kill(bindingId);
  });
  ipcMain.handle(IPC_CHANNELS.terminalBindCanvas, (event, bindingId: string, ref) => {
    assertTrusted(event);
    plane.host.bindCanvas(bindingId, ref);
  });
  ipcMain.handle(IPC_CHANNELS.terminalAttach, (event, input: TerminalAttachInput) => {
    const sender = assertTrusted(event);
    // Takeover: revoke prior control owner for this binding before granting.
    if (input.mode === "control" && input.takeover) {
      const priorLeaseId = controlByBinding.get(input.bindingId);
      if (priorLeaseId) release(priorLeaseId);
    }
    const result = plane.host.attach(input);
    if (!result.ok) return result;
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
    if (result.lease.mode === "control") {
      controlByBinding.set(result.lease.bindingId, leaseId);
    }
    // Message delivery retry when a native terminal becomes controllable.
    messageDelivery.onTerminalAttached(result.lease.bindingId);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.terminalRelease, (event, leaseId: string) => {
    assertTrusted(event);
    if (!owned(event.sender, leaseId)) return false;
    release(leaseId);
    return true;
  });
  ipcMain.handle(
    IPC_CHANNELS.terminalWrite,
    (event, leaseId: string, data: string, encoding = "utf8") => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      if (!owner) return false;
      const decoded =
        encoding === "base64" ? Buffer.from(data, "base64").toString("utf8") : data;
      return plane.host.write(owner.lease, decoded);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.terminalResize,
    (event, leaseId: string, cols: number, rows: number) => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      return owner ? plane.host.resize(owner.lease, cols, rows) : false;
    },
  );
  // terminalShutdown is intentionally NOT exposed over IPC — main quit only.
  void sendSafe;
};
