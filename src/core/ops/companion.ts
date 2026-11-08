/**
 * The core's handlers of the companion group (src/contract/core/companion.ts):
 * Settings, Companion, against the companion in the core. The clipboard is
 * main's: Copy link writes it by host operation, and a pairing that ends takes
 * its link off again only if the clipboard still holds it, which main checks.
 */
import { Effect, FiberSet } from "effect";
import { CompanionRpcs } from "../../contract/core/companion";
import { ClipboardHost } from "../../contract/host/clipboard";
import { companionService, type CompanionClipboard } from "../companion/service";
import { noteDesktopReport } from "../companion/desktop-report";
import { companionSettingsOn } from "../companion/settings";

export const CompanionHandlers = CompanionRpcs.toLayer(
  Effect.gen(function* () {
    // Main's clipboard is reached by host call; a Copy link does not wait on
    // it, so each call runs on its own in this server's scope, and one that
    // fails is logged.
    const clipboardHost = yield* ClipboardHost;
    const run = yield* FiberSet.makeRuntime<never>();
    const sent = <E>(call: Effect.Effect<void, E>): void => {
      run(call.pipe(Effect.catch((error) => Effect.sync(() => console.error("[companion] clipboard not reached:", error)))));
    };
    // What this server last wrote to main's clipboard: the clipboard as the
    // core holds it, and the text main checks before it clears.
    let written: string | undefined;
    const clipboard: CompanionClipboard = {
      readText: () => written ?? "",
      writeText: (text) => {
        written = text;
        sent(clipboardHost.ClipboardWrite({ text }));
      },
      clear: () => {
        if (written === undefined) return;
        const text = written;
        written = undefined;
        sent(clipboardHost.ClipboardClearIf({ text }));
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
