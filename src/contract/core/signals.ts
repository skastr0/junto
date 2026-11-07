/**
 * The operator's signals: a canvas's signals, an answer typed into its seat,
 * a handed-in reply, a dismissal, and the value a secret form asks for. Main
 * decodes the renderer's arguments at its edge. A refusal is an answer the
 * window reads (`{ ok: false }`); a store that cannot be read fails with its
 * words. The window hears of a change through the store's own push, so these
 * only answer the caller.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { AgentSignal } from "../../shared/agent-signals";
import { OperatorAttachments } from "../../shared/operator-attachments";
import { SignalReply } from "../../shared/signal-reply";
import { SignalSecretPutRequest, SignalSecretPutResult } from "../../shared/vault";
import { coreClient } from "./link";

/** What an answer, a reply or a dismissal did: the signal as it now stands, or why not. */
export const AgentSignalOperatorResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), signal: AgentSignal, messageId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);
export type AgentSignalOperatorResult = typeof AgentSignalOperatorResult.Type;

/** The signal store could not be read. */
export class SignalsUnavailable extends Schema.TaggedError<SignalsUnavailable>()("SignalsUnavailable", {
  message: Schema.String,
}) {}

export const SignalsRpcs = RpcGroup.make(
  Rpc.make("SignalsList", { payload: { canvasName: Schema.String }, success: Schema.Array(AgentSignal), error: SignalsUnavailable }),
  Rpc.make("SignalsAnswer", {
    payload: { signalId: Schema.String, text: Schema.String, silent: Schema.Boolean, attachments: OperatorAttachments },
    success: AgentSignalOperatorResult,
    error: SignalsUnavailable,
  }),
  Rpc.make("SignalsReply", {
    payload: { signalId: Schema.String, reply: SignalReply },
    success: AgentSignalOperatorResult,
    error: SignalsUnavailable,
  }),
  Rpc.make("SignalsDismiss", { payload: { signalId: Schema.String }, success: AgentSignalOperatorResult, error: SignalsUnavailable }),
  Rpc.make("SignalsSecretPut", { payload: { request: SignalSecretPutRequest }, success: SignalSecretPutResult, error: SignalsUnavailable }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the signals group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class SignalsCore extends Context.Service<SignalsCore, RpcClient.FromGroup<typeof SignalsRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/SignalsCore",
) {
  static readonly layer = Layer.effect(SignalsCore, coreClient(SignalsRpcs));
}
