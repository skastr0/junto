/**
 * What main asks of the core's own reads: this machine's name, for local
 * browser admission. The canvas and the vault scope that `coreReads` also
 * answers are asked only by core code, in this process, and never cross the
 * link. The handler is `src/core/ops/core-reads.ts`.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { coreClient } from "./link";

export const CoreReadsRpcs = RpcGroup.make(
  /** The name this machine holds. */
  Rpc.make("CoreReadsMachineName", { success: Schema.String }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the core-reads group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class CoreReadsCore extends Context.Service<CoreReadsCore, RpcClient.FromGroup<typeof CoreReadsRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/CoreReadsCore",
) {
  static readonly layer = Layer.effect(CoreReadsCore, coreClient(CoreReadsRpcs));
}
