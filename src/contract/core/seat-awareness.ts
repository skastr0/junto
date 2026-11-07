/**
 * The window's seat-awareness reads, answered by the core (junto/ipc.ts).
 *
 * The plane and the seats it reads live in the core process, so main asks for
 * the snapshot and for the collaboration gate rather than owning a plane it
 * cannot feed. One call answers both: the enabled check is the same snapshot
 * the renderer hydrates from, so the two cannot disagree. Its events are the
 * wire shape of `src/shared/seat-awareness-contract.ts`, which the renderer
 * decodes strictly again at its own edge.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { SeatAwarenessEvent } from "../../shared/seat-awareness-contract";
import { coreClient } from "./link";

/** The live gate, and the latest event per binding for the window's hydration. */
export const SeatAwarenessSnapshot = Schema.Struct({
  enabled: Schema.Boolean,
  events: Schema.Array(SeatAwarenessEvent),
});

export const SeatAwarenessRpcs = RpcGroup.make(
  Rpc.make("SeatAwarenessSnapshot", { success: SeatAwarenessSnapshot }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the awareness reads. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class SeatAwarenessCore extends Context.Service<
  SeatAwarenessCore,
  RpcClient.FromGroup<typeof SeatAwarenessRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/SeatAwarenessCore") {
  static readonly layer = Layer.effect(SeatAwarenessCore, coreClient(SeatAwarenessRpcs));
}
