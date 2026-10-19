/**
 * Settings, Companion over IPC: this Mac's readiness to pair, pairing a phone
 * (the QR), the phone list, Remove, and Restore for a phone whose line is gone
 * from authorized_keys. Main owns every step; the renderer only asks and
 * shows. The device list is pushed after any change. Restore exists here and
 * nowhere else: the operator's click in the trusted window is its only way in.
 */
import { BrowserWindow, clipboard, ipcMain, shell } from "electron";
import type { CompanionDeviceRecord, CompanionKeyRestore, CompanionPairStart, CompanionStatus } from "@shared/companion-devices";
import { IPC_CHANNELS } from "@shared/ipc";
import { isTrustedMainWebContents, trustedRendererIpc } from "../trusted-main-webcontents";
import { probeRemoteLogin } from "./environment";
import { companionService } from "./service";

/** System Settings, General, Sharing, where Remote Login is switched on. */
export const MAC_REMOTE_LOGIN_SETTINGS_URL = "x-apple.systempreferences:com.apple.Sharing-Settings.extension";

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

  privilegedIpc.handle(IPC_CHANNELS.companionPairCopyLink, (_event, raw: unknown) => {
    const deviceId = deviceIdOf(raw);
    const service = companionService();
    if (!deviceId || !service) return { ok: false };
    return {
      ok: service.copyLink(deviceId, {
        readText: () => clipboard.readText(),
        writeText: (text) => clipboard.writeText(text),
        clear: () => clipboard.clear(),
      }),
    };
  });

  privilegedIpc.handle(IPC_CHANNELS.companionDevices, async () => (await companionService()?.devices()) ?? []);

  // The Needs you feed asks on every focus while a phone is paired: only the
  // port probe, never Tailscale or the host names.
  privilegedIpc.handle(IPC_CHANNELS.companionRemoteLogin, (): Promise<CompanionStatus["remoteLogin"]> => probeRemoteLogin());

  // A fixed system URL, never one the renderer supplies.
  privilegedIpc.handle(IPC_CHANNELS.companionOpenRemoteLoginSettings, async () => {
    if (process.platform !== "darwin") return { ok: false as const };
    await shell.openExternal(MAC_REMOTE_LOGIN_SETTINGS_URL);
    return { ok: true as const };
  });

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

  privilegedIpc.handle(IPC_CHANNELS.companionDeviceRestore, async (_event, raw: unknown): Promise<CompanionKeyRestore> => {
    const target = raw === "all" ? "all" : deviceIdOf(raw);
    const service = companionService();
    if (!target || !service) return { ok: false, restored: [], failed: [], message: "No such phone." };
    try {
      return await service.restore(target);
    } catch {
      return { ok: false, restored: [], failed: [], message: "The phone could not be restored." };
    }
  });
};
