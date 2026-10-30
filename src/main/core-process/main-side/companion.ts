/**
 * Main's side of the phone companion: Settings reaches the companion in the
 * core by name, and the system clipboard, which is main's, is served to the
 * core by host operation. A pairing that ends takes its link off the
 * clipboard only if the clipboard still holds it, which main checks.
 */
import type { CompanionClipboard } from "../../junto/companion/service";
import type { CompanionSettings } from "../../junto/companion/settings";
import type { CoreClient } from "../client";
import { hostOps, type HostOp } from "../host-ops";

declare module "../host-ops" {
  interface HostOps {
    "clipboard.write": HostOp<{ readonly text: string }, void>;
    /** Clears the clipboard only while it still holds `text`. */
    "clipboard.clearIf": HostOp<{ readonly text: string }, void>;
  }
}

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
