import type { IpcMain, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { IPC_CHANNELS } from "@shared/ipc";
import type { HostsDiscoverPeersResult, HostsOpResult, HostsTestResult } from "@shared/ipc";
import { core } from "../../core-process/main-client";
import { MACHINE_PROGRESS, type MachineProgressPushed } from "../../core-process/channels";
import { subscribe as subscribeCore } from "../../core-process/push";
import {
  HOST_OPERATION_ADMISSIONS,
  HostOperationShutdownRefused,
  hostOperationGate,
  type HostOperationGate,
} from "./shutdown";

const surfaceShutdownRefusal = <A>(
  operation: Promise<A>,
  refusal: (error: HostOperationShutdownRefused) => A,
): Promise<A> =>
  operation.catch((error: unknown) => {
    if (error instanceof HostOperationShutdownRefused) return refusal(error);
    throw error;
  });

const DISCOVER_PEERS_EMPTY: HostsDiscoverPeersResult = { ok: true, peers: [] };

export const registerHostsIpc = (
  ipcMain: IpcMain,
  operations: HostOperationGate = hostOperationGate,
): void => {
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

  ipcMain.handle(IPC_CHANNELS.hostsList, () =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.list, () => core.call("ipc.hosts.list", {})),
      (error) =>
        ({ ok: false, code: error.code, message: error.message }) satisfies HostsOpResult,
    ),
  );

  // Tailscale mesh peers not yet enrolled. Read path — mirrors hostsList
  // gating (registry-read admission). Degrades to an empty peer list.
  ipcMain.handle(IPC_CHANNELS.hostsDiscoverPeers, () =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.list, () => core.call("ipc.hosts.discoverPeers", {})),
      () => DISCOVER_PEERS_EMPTY,
    ),
  );

  ipcMain.handle(IPC_CHANNELS.hostsUpsert, (_event, input: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.upsert, () => core.call("ipc.hosts.upsert", { input })),
      (error) =>
        ({ ok: false, code: error.code, message: error.message }) satisfies HostsOpResult,
    ),
  );

  ipcMain.handle(IPC_CHANNELS.hostsRemove, (_event, id: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.remove, () => core.call("ipc.hosts.remove", { id })),
      (error) =>
        ({ ok: false, code: error.code, message: error.message }) satisfies HostsOpResult,
    ),
  );

  ipcMain.handle(IPC_CHANNELS.hostsTest, (_event, id: unknown) =>
    surfaceShutdownRefusal(
      operations.run(HOST_OPERATION_ADMISSIONS.test, () => core.call("ipc.hosts.test", { id })),
      (error) =>
        ({
          ok: false,
          detail: error.message,
          code: error.code,
          message: error.message,
        }) satisfies HostsTestResult,
    ),
  );
};
