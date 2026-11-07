/**
 * The core's handlers of the companion group (src/contract/core/companion.ts):
 * Settings, Companion, against the companion in the core. The clipboard is
 * main's: Copy link writes it by host operation, and a pairing that ends takes
 * its link off again only if the clipboard still holds it, which main checks.
 */
import { Effect } from "effect";
import { CompanionRpcs } from "../../contract/core/companion";
import { companionService, type CompanionClipboard } from "../companion/service";
import { noteDesktopReport } from "../companion/desktop-report";
import { companionSettingsOn } from "../companion/settings";
import type { HostOp } from "../host-ops";
import { host } from "../core-host";

declare module "../host-ops" {
  interface HostOps {
    "clipboard.write": HostOp<{ readonly text: string }, void>;
    /** Clears the clipboard only while it still holds `text`. */
    "clipboard.clearIf": HostOp<{ readonly text: string }, void>;
  }
}

const sent = (call: Promise<void>): void => {
  void call.catch((error: unknown) => console.error("[companion] clipboard not reached:", error));
};

export const CompanionHandlers = CompanionRpcs.toLayer(
  Effect.sync(() => {
    // What this server last wrote to main's clipboard: the clipboard as the
    // core holds it, and the text main checks before it clears.
    let written: string | undefined;
    const clipboard: CompanionClipboard = {
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
    const settings = companionSettingsOn(companionService, clipboard);
    return {
      CompanionStatus: () => Effect.promise(() => settings.status()),
      CompanionStartPairing: () => Effect.promise(() => settings.startPairing()),
      CompanionCancelPairing: ({ deviceId }) => Effect.promise(() => settings.cancelPairing(deviceId)),
      CompanionCopyLink: ({ deviceId }) => Effect.promise(() => settings.copyLink(deviceId)),
      CompanionDevices: () => Effect.promise(() => settings.devices()),
      CompanionRemove: ({ deviceId }) => Effect.promise(() => settings.remove(deviceId)),
      CompanionRestore: ({ target }) => Effect.promise(() => settings.restore(target)),
      // The desktop's report is written here, where the companion reads it
      // (`desktop-report.ts`): main sends what its window reported.
      CompanionDesktopReport: ({ report }) => Effect.sync(() => noteDesktopReport(report)),
    };
  }),
);
