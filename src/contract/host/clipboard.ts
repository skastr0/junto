/**
 * The system clipboard, which is Electron main's, as the core asks for it:
 * the phone companion's Copy link writes a pairing link and takes it off again
 * only while the clipboard still holds it, and a guarded seat's paste
 * preflight asks whether the pasteboard holds only formats it can take. The
 * preflight reads formats alone (`app/term/drive/clipboard-safe.ts`): reading
 * the contents, on macOS, asks ImageIO to decode them.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { hostClient } from "./link";

export const ClipboardHostRpcs = RpcGroup.make(
  Rpc.make("ClipboardWrite", { payload: { text: Schema.String } }),
  /** Clears the clipboard only while it still holds `text`. */
  Rpc.make("ClipboardClearIf", { payload: { text: Schema.String } }),
  /** Whether the pasteboard holds only formats a guarded seat can paste. */
  Rpc.make("ClipboardSafeForGrok", { success: Schema.Boolean }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** The core's client of the clipboard group. */
export class ClipboardHost extends Context.Service<
  ClipboardHost,
  RpcClient.FromGroup<typeof ClipboardHostRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/ClipboardHost") {
  static readonly layer = Layer.effect(ClipboardHost, hostClient(ClipboardHostRpcs));
}
