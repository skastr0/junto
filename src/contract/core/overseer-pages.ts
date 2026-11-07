/**
 * The overseer runs in the core, and main holds the browser: each page
 * operation is a host call to main, and an open keeps its recheck in the
 * core under a call id. Main asks that recheck back here before the page
 * commits (`src/core/ops/overseer-pages.ts`). A recheck is an answer, never a
 * failure: an open no longer in flight answers `failed`.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { PageTargetResult } from "./browser";
import { coreClient } from "./link";

export const OverseerPagesRpcs = RpcGroup.make(
  Rpc.make("OverseerPagesRecheck", { payload: { callId: Schema.Int }, success: PageTargetResult }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the overseer pages group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class OverseerPagesCore extends Context.Service<
  OverseerPagesCore,
  RpcClient.FromGroup<typeof OverseerPagesRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/OverseerPagesCore") {
  static readonly layer = Layer.effect(OverseerPagesCore, coreClient(OverseerPagesRpcs));
}
