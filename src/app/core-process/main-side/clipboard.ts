/**
 * Main's side of the clipboard group (`contract/host/clipboard.ts`): the
 * system clipboard is Electron's, so main writes and clears it for the phone
 * companion's Copy link, and reads the pasteboard's formats, and nothing of
 * its contents, for a guarded seat's paste preflight
 * (`term/drive/clipboard-safe.ts`).
 */
import { Context, Effect } from "effect";
import { ClipboardHostRpcs } from "../../../contract/host/clipboard";
import { clipboardFormatsAreSafeForGrok } from "../../term/drive/clipboard-safe";

/** The system clipboard as main serves it: Electron's `clipboard`, or a test's. */
export type SystemClipboardShape = {
  readonly readText: () => string;
  readonly writeText: (text: string) => void;
  readonly clear: () => void;
  /** The pasteboard's formats; reading them decodes nothing. */
  readonly availableFormats: () => ReadonlyArray<string>;
};

export class SystemClipboard extends Context.Service<SystemClipboard, SystemClipboardShape>()("@junto/app/SystemClipboard") {}

export const ClipboardHostHandlers = ClipboardHostRpcs.toLayer(
  Effect.gen(function* () {
    const clipboard = yield* SystemClipboard;
    return {
      ClipboardWrite: ({ text }) => Effect.sync(() => clipboard.writeText(text)),
      ClipboardClearIf: ({ text }) =>
        Effect.sync(() => {
          if (clipboard.readText() === text) clipboard.clear();
        }),
      ClipboardSafeForGrok: () => Effect.sync(() => clipboardFormatsAreSafeForGrok(clipboard.availableFormats())),
    };
  }),
);
