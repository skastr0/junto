/**
 * The operator's holds, sent to the core that keeps them
 * (term/operator-holds.ts): which terminals a window shows, when the operator
 * typed into one, and a window that let go of all of them. Main keeps no map;
 * the cache cut, the clock a key warms and a peer's Hold frame all read the
 * core's. A report is recorded as it comes, so none of these has an error to
 * act on beyond the core leaving.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { coreClient } from "./link";

export const SeatHoldsRpcs = RpcGroup.make(
  /** The bindings one window shows now, replacing what it said before. */
  Rpc.make("SeatHoldsSurfaces", { payload: { windowId: Schema.Number, bindingIds: Schema.Array(Schema.String) } }),
  /** The operator typed into a binding's terminal in one window. */
  Rpc.make("SeatHoldsTyped", { payload: { windowId: Schema.Number, bindingId: Schema.String } }),
  /** The window closed or reloaded: every hold it had goes. */
  Rpc.make("SeatHoldsDropWindow", { payload: { windowId: Schema.Number } }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the holds. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class SeatHoldsCore extends Context.Service<
  SeatHoldsCore,
  RpcClient.FromGroup<typeof SeatHoldsRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/SeatHoldsCore") {
  static readonly layer = Layer.effect(SeatHoldsCore, coreClient(SeatHoldsRpcs));
}
