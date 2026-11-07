/**
 * The window's pixels, as the core asks main for them: the overseer shows a
 * seat the application window, and the window is Electron's
 * (`src/app/core-process/main-side/overseer-pages.ts`).
 *
 * No window to capture is an answer (`unavailable`), never an error of the call.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { hostClient } from "./link";

export const ApplicationCaptureResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), png: Schema.Uint8Array }),
  Schema.Struct({ ok: Schema.Literal(false), unavailable: Schema.Literal(true), reason: Schema.String }),
]);

export const WindowHostRpcs = RpcGroup.make(
  Rpc.make("WindowCapturePage", { success: ApplicationCaptureResult }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The core's client of the window group. */
export class WindowHost extends Context.Service<
  WindowHost,
  RpcClient.FromGroup<typeof WindowHostRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/WindowHost") {
  static readonly layer = Layer.effect(WindowHost, hostClient(WindowHostRpcs));
}
