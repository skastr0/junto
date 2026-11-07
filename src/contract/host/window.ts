/**
 * The window's pixels, as the core asks main for them: the overseer shows a
 * seat the application window, and the window is Electron's
 * (`src/app/core-process/main-side/overseer-pages.ts`).
 *
 * No window to capture is an answer (`unavailable`), never an error of the call.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const ApplicationCaptureResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), png: Schema.Uint8Array }),
  Schema.Struct({ ok: Schema.Literal(false), unavailable: Schema.Literal(true), reason: Schema.String }),
]);

export const WindowHostRpcs = RpcGroup.make(
  Rpc.make("WindowCapturePage", { success: ApplicationCaptureResult }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });
