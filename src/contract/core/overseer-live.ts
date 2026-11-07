/**
 * The live overseer runs in the core; the window's live controls reach it
 * here (`src/core/ops/overseer-live.ts`), through main's IPC
 * (`src/app/overseer/live/ipc.ts`), which decodes what the window sends at
 * its own edge. Each snapshot change comes back on the `LIVE_CHANGED` push.
 *
 * A control the live overseer refused, or one asked of a core that runs no
 * live overseer, fails with `OverseerLiveFailed`, and the window's call
 * rejects with its message.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { LiveAttention, LiveSnapshot, LiveStartInput, LiveStartResult } from "../../shared/overseer-live";
import { coreClient } from "./link";

/** The live overseer refused the control, or this core runs none. */
export class OverseerLiveFailed extends Schema.TaggedError<OverseerLiveFailed>()("OverseerLiveFailed", {
  message: Schema.String,
}) {}

const Session = { sessionId: Schema.String };

export const OverseerLiveRpcs = RpcGroup.make(
  Rpc.make("OverseerLiveStart", { payload: { input: LiveStartInput }, success: LiveStartResult, error: OverseerLiveFailed }),
  Rpc.make("OverseerLiveEnd", { payload: Session, success: LiveSnapshot, error: OverseerLiveFailed }),
  Rpc.make("OverseerLiveSnapshot", { success: LiveSnapshot, error: OverseerLiveFailed }),
  Rpc.make("OverseerLiveReady", { payload: { ...Session, connectionEpoch: Schema.Number }, error: OverseerLiveFailed }),
  /** The provider's own event, opaque here; main bounds its size before it crosses. */
  Rpc.make("OverseerLiveProviderEvent", {
    payload: { ...Session, connectionEpoch: Schema.Number, event: Schema.Unknown },
    error: OverseerLiveFailed,
  }),
  Rpc.make("OverseerLiveAttention", { payload: { ...Session, attention: LiveAttention }, error: OverseerLiveFailed }),
  Rpc.make("OverseerLiveCancel", { payload: { ...Session, requestId: Schema.String }, success: LiveSnapshot, error: OverseerLiveFailed }),
  Rpc.make("OverseerLiveSteer", {
    payload: { ...Session, requestId: Schema.String, text: Schema.String, attention: LiveAttention },
    success: LiveSnapshot,
    error: OverseerLiveFailed,
  }),
  Rpc.make("OverseerLiveStopActions", { payload: Session, success: LiveSnapshot, error: OverseerLiveFailed }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the live overseer group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class OverseerLiveCore extends Context.Service<
  OverseerLiveCore,
  RpcClient.FromGroup<typeof OverseerLiveRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/OverseerLiveCore") {
  static readonly layer = Layer.effect(OverseerLiveCore, coreClient(OverseerLiveRpcs));
}
