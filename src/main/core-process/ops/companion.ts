import { Effect } from "effect";
import type { CompanionDeviceRecord, CompanionKeyRestore, CompanionPairStart, CompanionStatus } from "@shared/companion-devices";
import type { NotifyReport } from "@shared/desktop-notifications";
import { companionService, type CompanionClipboard } from "../../junto/companion/service";
import { noteDesktopReport } from "../../junto/companion/desktop-report";
import { companionSettingsOn, type CompanionSettings } from "../../junto/companion/settings";
import type { CoreClient } from "../client";
import { host, hostOps, type HostOp } from "../host-ops";
import { coreOps, type CoreOp } from "../ops";

/**
 * Settings, Companion, against the companion in the core. The clipboard is
 * main's: Copy link writes it by host operation, and a pairing that ends takes
 * its link off again only if the clipboard still holds it, which main checks.
 */

type Device = { readonly deviceId: string };

declare module "../ops" {
  interface CoreOps {
    "companion.status": CoreOp<Record<string, never>, CompanionStatus>;
    "companion.startPairing": CoreOp<Record<string, never>, CompanionPairStart>;
    "companion.cancelPairing": CoreOp<Device, void>;
    "companion.copyLink": CoreOp<Device, boolean>;
    "companion.devices": CoreOp<Record<string, never>, ReadonlyArray<CompanionDeviceRecord>>;
    "companion.remove": CoreOp<Device, { readonly ok: boolean; readonly message?: string }>;
    "companion.restore": CoreOp<{ readonly target: string }, CompanionKeyRestore>;
    /** What the desktop last told its window: the phone companion reads it here, beside it. */
    "companion.desktopReport": CoreOp<{ readonly report: NotifyReport }, void>;
  }
}

declare module "../host-ops" {
  interface HostOps {
    "clipboard.write": HostOp<{ readonly text: string }, void>;
    /** Clears the clipboard only while it still holds `text`. */
    "clipboard.clearIf": HostOp<{ readonly text: string }, void>;
  }
}

let written: string | undefined;
const sent = (call: Promise<void>): void => {
  void call.catch((error: unknown) => console.error("[companion] clipboard not reached:", error));
};

/** The clipboard as the core holds it: what it last wrote, and main's own check before a clear. */
const hostClipboard: CompanionClipboard = {
  readText: () => written ?? "",
  writeText: (text) => {
    written = text;
    sent(host.call("clipboard.write", { text }));
  },
  clear: () => {
    if (written === undefined) return;
    const text = written;
    written = undefined;
    sent(host.call("clipboard.clearIf", { text }));
  },
};

const settings = companionSettingsOn(companionService, hostClipboard);

coreOps({
  "companion.status": () => Effect.promise(() => settings.status()),
  "companion.startPairing": () => Effect.promise(() => settings.startPairing()),
  "companion.cancelPairing": ({ deviceId }) => Effect.promise(() => settings.cancelPairing(deviceId)),
  "companion.copyLink": ({ deviceId }) => Effect.promise(() => settings.copyLink(deviceId)),
  "companion.devices": () => Effect.promise(() => settings.devices()),
  "companion.remove": ({ deviceId }) => Effect.promise(() => settings.remove(deviceId)),
  "companion.restore": ({ target }) => Effect.promise(() => settings.restore(target)),
  // The desktop's report is written here, where the companion reads it
  // (`desktop-report.ts`): main sends what its window reported.
  "companion.desktopReport": ({ report }) => Effect.sync(() => noteDesktopReport(report)),
});

/** Settings as main reaches the companion in the core process. */
export const coreCompanionSettings = (core: CoreClient): CompanionSettings => ({
  status: () => core.call("companion.status", {}),
  startPairing: () => core.call("companion.startPairing", {}),
  cancelPairing: (deviceId) => core.call("companion.cancelPairing", { deviceId }),
  copyLink: (deviceId) => core.call("companion.copyLink", { deviceId }),
  devices: () => core.call("companion.devices", {}),
  remove: (deviceId) => core.call("companion.remove", { deviceId }),
  restore: (target) => core.call("companion.restore", { target }),
});

/** Main's side: the system clipboard for the core's Copy link. Returns the removal. */
export const serveCompanionClipboard = (clipboard: CompanionClipboard): (() => void) =>
  hostOps({
    "clipboard.write": async ({ text }) => clipboard.writeText(text),
    "clipboard.clearIf": async ({ text }) => {
      if (clipboard.readText() === text) clipboard.clear();
    },
  });
