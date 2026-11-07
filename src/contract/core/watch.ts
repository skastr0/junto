/**
 * The model watches: a canvas changed, the canvas list changed, the compiled
 * actor refs changed. Each starts once per core and publishes on its own
 * channel (`channels.ts`), which main forwards to the window. Asking twice
 * starts nothing new, so main asks every core that says ready, and a
 * reconnect cannot double a stream.
 */
import { Context, Layer } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { coreClient } from "./link";

export const WatchRpcs = RpcGroup.make(
  Rpc.make("WatchModel"),
  Rpc.make("WatchModelCanvases"),
  Rpc.make("WatchModelActorRefs"),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the watch group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class WatchCore extends Context.Service<WatchCore, RpcClient.FromGroup<typeof WatchRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/WatchCore",
) {
  static readonly layer = Layer.effect(WatchCore, coreClient(WatchRpcs));
}
