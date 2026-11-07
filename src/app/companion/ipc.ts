/**
 * Settings, Companion over IPC: this Mac's readiness to pair, pairing a phone
 * (the QR), the phone list, Remove, and Restore for a phone whose line is gone
 * from authorized_keys. Every answer comes from the core's companion group
 * (`contract/core/companion.ts`), where the paired phones live; main keeps
 * the system clipboard and the window fan-out, which are Electron's. The
 * device list is pushed after any change. Restore exists here and nowhere
 * else: the operator's click in the trusted window is its only way in.
 */
import { BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { Context, Effect } from "effect";
import type { CompanionDeviceRecord, CompanionKeyRestore, CompanionPairStart, CompanionStatus } from "@shared/companion-devices";
import { IPC_CHANNELS } from "@shared/ipc";
import { isTrustedMainWebContents, trustedRendererIpc } from "../trusted-main-webcontents";
import { probeRemoteLogin } from "../../node/companion/environment";
import type { CompanionClipboard } from "../../core/companion/service";
import { CompanionCore } from "../../contract/core/companion";
import { AppRuntime } from "../runtime";

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

export const registerCompanionIpc = (core: Context.Context<CompanionCore>): void => {
  const privilegedIpc = trustedRendererIpc(ipcMain);
  const companion = Context.get(core, CompanionCore);

  privilegedIpc.handle(IPC_CHANNELS.companionStatus, (): Promise<CompanionStatus> => AppRuntime.runPromise(companion.CompanionStatus()));

  privilegedIpc.handle(IPC_CHANNELS.companionPairStart, (): Promise<CompanionPairStart> =>
    AppRuntime.runPromise(companion.CompanionStartPairing()),
  );

  privilegedIpc.handle(IPC_CHANNELS.companionPairCancel, (_event, raw: unknown) => {
    const deviceId = deviceIdOf(raw);
    if (!deviceId) return { ok: false };
    return AppRuntime.runPromise(companion.CompanionCancelPairing({ deviceId }).pipe(Effect.as({ ok: true })));
  });

  privilegedIpc.handle(IPC_CHANNELS.companionPairCopyLink, (_event, raw: unknown) => {
    const deviceId = deviceIdOf(raw);
    if (!deviceId) return { ok: false };
    return AppRuntime.runPromise(companion.CompanionCopyLink({ deviceId }).pipe(Effect.map((ok) => ({ ok }))));
  });

  privilegedIpc.handle(IPC_CHANNELS.companionDevices, (): Promise<ReadonlyArray<CompanionDeviceRecord>> =>
    AppRuntime.runPromise(companion.CompanionDevices()),
  );

  // The Needs you feed asks on every focus while a phone is paired: only the
  // port probe, never Tailscale or the host names. It is main's own port check,
  // so it is answered here and nowhere else.
  privilegedIpc.handle(IPC_CHANNELS.companionRemoteLogin, (): Promise<CompanionStatus["remoteLogin"]> => probeRemoteLogin());

  // A fixed system URL, never one the renderer supplies.
  privilegedIpc.handle(IPC_CHANNELS.companionOpenRemoteLoginSettings, async () => {
    if (process.platform !== "darwin") return { ok: false as const };
    await shell.openExternal(MAC_REMOTE_LOGIN_SETTINGS_URL);
    return { ok: true as const };
  });

  privilegedIpc.handle(IPC_CHANNELS.companionDeviceRemove, (_event, raw: unknown) => {
    const deviceId = deviceIdOf(raw);
    if (!deviceId) return { ok: false, message: "No such phone." };
    return AppRuntime.runPromise(companion.CompanionRemove({ deviceId }));
  });

  privilegedIpc.handle(IPC_CHANNELS.companionDeviceRestore, (_event, raw: unknown): Promise<CompanionKeyRestore> => {
    const target = raw === "all" ? "all" : deviceIdOf(raw);
    if (!target) return Promise.resolve({ ok: false, restored: [], failed: [], message: "No such phone." });
    return AppRuntime.runPromise(companion.CompanionRestore({ target }));
  });
};
