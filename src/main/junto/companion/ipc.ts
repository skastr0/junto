/**
 * Settings, Companion over IPC: this Mac's readiness to pair, pairing a phone
 * (the QR), the phone list, and Remove. Main owns every step; the renderer
 * only asks and shows. The device list is pushed after any change.
 */
import { BrowserWindow, ipcMain } from "electron";
import type { CompanionDeviceRecord, CompanionPairStart, CompanionStatus } from "@shared/companion-devices";
import { IPC_CHANNELS } from "@shared/ipc";
import { isTrustedMainWebContents, trustedRendererIpc } from "../trusted-main-webcontents";
import { companionService } from "./service";

const deviceIdOf = (value: unknown): string | undefined =>
  typeof value === "string" && /^dev_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value) ? value : undefined;

export const broadcastCompanionDevices = (devices: ReadonlyArray<CompanionDeviceRecord>): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed() || !isTrustedMainWebContents(window.webContents)) continue;
    window.webContents.send(IPC_CHANNELS.companionDevicesChanged, devices);
  }
};

const UNAVAILABLE: CompanionStatus = {
  available: false,
  remoteLogin: "off",
  hosts: [],
  juntoCommand: false,
  hostKey: false,
  station: "",
};

export const registerCompanionIpc = (): void => {
  const privilegedIpc = trustedRendererIpc(ipcMain);

  privilegedIpc.handle(IPC_CHANNELS.companionStatus, async (): Promise<CompanionStatus> => {
    const service = companionService();
    if (!service) return UNAVAILABLE;
    const environment = await service.environment();
    return {
      available: true,
      remoteLogin: environment.remoteLogin,
      ...(environment.tailscale ? { tailscale: environment.tailscale } : {}),
      hosts: environment.hosts,
      juntoCommand: environment.juntoPath !== undefined,
      hostKey: environment.hostKey !== undefined,
      station: environment.station,
    };
  });

  privilegedIpc.handle(IPC_CHANNELS.companionPairStart, async (): Promise<CompanionPairStart> => {
    const service = companionService();
    if (!service) return { ok: false, message: "Phones pair with the Command Center." };
    try {
      const started = await service.startPairing();
      if (!started.ok) return started;
      return { ok: true, deviceId: started.deviceId, expiresAt: started.expiresAt, qrSvg: started.qrSvg, hosts: started.hosts };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Pairing could not start." };
    }
  });

  privilegedIpc.handle(IPC_CHANNELS.companionPairCancel, async (_event, raw: unknown) => {
    const deviceId = deviceIdOf(raw);
    const service = companionService();
    if (!deviceId || !service) return { ok: false };
    await service.cancelPairing(deviceId).catch(() => undefined);
    return { ok: true };
  });

  privilegedIpc.handle(IPC_CHANNELS.companionDevices, async () => (await companionService()?.devices()) ?? []);

  privilegedIpc.handle(IPC_CHANNELS.companionDeviceRemove, async (_event, raw: unknown) => {
    const deviceId = deviceIdOf(raw);
    const service = companionService();
    if (!deviceId || !service) return { ok: false, message: "No such phone." };
    try {
      return { ok: await service.remove(deviceId) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "The phone could not be removed." };
    }
  });
};
