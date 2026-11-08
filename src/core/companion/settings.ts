import type { CompanionDeviceRecord, CompanionKeyRestore, CompanionPairStart, CompanionStatus } from "@shared/companion-devices";
import type { CompanionClipboard, CompanionService } from "./service";

/**
 * What Settings asks of the phone companion, wherever the companion runs:
 * every answer is data, so the window's IPC reads it from the core in this
 * process or from the core process alike.
 */
export type CompanionSettings = {
  readonly status: () => Promise<CompanionStatus>;
  readonly startPairing: () => Promise<CompanionPairStart>;
  readonly cancelPairing: (deviceId: string) => Promise<void>;
  /** Copy link: the pending pairing's link goes on the clipboard. */
  readonly copyLink: (deviceId: string) => Promise<boolean>;
  readonly devices: () => Promise<ReadonlyArray<CompanionDeviceRecord>>;
  readonly remove: (deviceId: string) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  readonly restore: (target: string) => Promise<CompanionKeyRestore>;
};

export const UNAVAILABLE_COMPANION: CompanionStatus = {
  available: false,
  remoteLogin: "off",
  hosts: [],
  juntoCommand: false,
  hostKey: false,
  station: "",
};

/** Settings on the companion service this process holds now; `clipboard` is the system one. */
export const companionSettingsOn = (serviceOf: () => CompanionService | undefined, clipboard: CompanionClipboard): CompanionSettings => ({
  status: async () => {
    const service = serviceOf();
    if (!service) return UNAVAILABLE_COMPANION;
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
  },
  startPairing: async () => {
    const service = serviceOf();
    if (!service) return { ok: false, message: "Phones pair with the Command Center." };
    try {
      const started = await service.startPairing();
      if (!started.ok) return started;
      return { ok: true, deviceId: started.deviceId, expiresAt: started.expiresAt, qrSvg: started.qrSvg, hosts: started.hosts };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Pairing could not start." };
    }
  },
  cancelPairing: async (deviceId) => {
    await serviceOf()?.cancelPairing(deviceId).catch(() => undefined);
  },
  copyLink: async (deviceId) => serviceOf()?.copyLink(deviceId, clipboard) ?? false,
  devices: async () => (await serviceOf()?.devices()) ?? [],
  remove: async (deviceId) => {
    const service = serviceOf();
    if (!service) return { ok: false, message: "No such phone." };
    try {
      return { ok: await service.remove(deviceId) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "The phone could not be removed." };
    }
  },
  restore: async (target) => {
    const service = serviceOf();
    if (!service) return { ok: false, restored: [], failed: [], message: "No such phone." };
    try {
      return await service.restore(target);
    } catch {
      return { ok: false, restored: [], failed: [], message: "The phone could not be restored." };
    }
  },
});
