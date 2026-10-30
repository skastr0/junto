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
import { companionService, type CompanionClipboard } from "./service";
import { companionSettingsOn, type CompanionSettings } from "./settings";

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

/** The system clipboard, for Copy link in this process. */
export const electronCompanionClipboard: CompanionClipboard = {
  readText: () => clipboard.readText(),
  writeText: (text) => clipboard.writeText(text),
  clear: () => clipboard.clear(),
};

/** `settings` is the companion as Settings reaches it: in this process by default, or the core's. */
export const registerCompanionIpc = (
  settings: CompanionSettings = companionSettingsOn(companionService, electronCompanionClipboard),
): void => {
  const privilegedIpc = trustedRendererIpc(ipcMain);

  privilegedIpc.handle(IPC_CHANNELS.companionStatus, (): Promise<CompanionStatus> => settings.status());

  privilegedIpc.handle(IPC_CHANNELS.companionPairStart, (): Promise<CompanionPairStart> => settings.startPairing());

  privilegedIpc.handle(IPC_CHANNELS.companionPairCancel, async (_event, raw: unknown) => {
    const deviceId = deviceIdOf(raw);
    if (!deviceId) return { ok: false };
    await settings.cancelPairing(deviceId);
    return { ok: true };
  });

  privilegedIpc.handle(IPC_CHANNELS.companionPairCopyLink, async (_event, raw: unknown) => {
    const deviceId = deviceIdOf(raw);
    if (!deviceId) return { ok: false };
    return { ok: await settings.copyLink(deviceId) };
  });

  privilegedIpc.handle(IPC_CHANNELS.companionDevices, () => settings.devices());

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
    if (!deviceId) return { ok: false, message: "No such phone." };
    return settings.remove(deviceId);
  });

  privilegedIpc.handle(IPC_CHANNELS.companionDeviceRestore, async (_event, raw: unknown): Promise<CompanionKeyRestore> => {
    const target = raw === "all" ? "all" : deviceIdOf(raw);
    if (!target) return { ok: false, restored: [], failed: [], message: "No such phone." };
    return settings.restore(target);
  });
};
