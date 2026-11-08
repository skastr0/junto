/**
 * View state (0.11, 04): how the operator arranged Junto, read once per
 * window load and written one row at a time. The core holds the rows; main
 * asks for them here on the window's behalf.
 *
 * The template every core group follows:
 * - the contract is an `RpcGroup` whose payloads, successes and errors are
 *   Schemas, decoded closed on both ends;
 * - the core serves it with handlers from `toLayer`, a required record, so a
 *   missing or mistyped handler fails the compile (`src/core/ops/ipc-view-state.ts`);
 * - main reaches it through the client service below, so every caller states
 *   the requirement in its type.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { ViewStateApplyResult, ViewStateSnapshot, ViewStateWrite } from "../../shared/view-state";
import { coreClient } from "./link";

/** The rows could not be read; the window opens with its defaults and says so. */
export class ViewStateUnavailable extends Schema.TaggedError<ViewStateUnavailable>()("ViewStateUnavailable", {
  message: Schema.String,
}) {}

export const ViewStateRpcs = RpcGroup.make(
  Rpc.make("ViewStateSnapshot", { success: ViewStateSnapshot, error: ViewStateUnavailable }),
  /** One changed row, already decoded at main's edge. A refusal by the store is an answer, not a failure. */
  Rpc.make("ViewStateApply", { payload: { write: ViewStateWrite }, success: ViewStateApplyResult }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the view-state group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class ViewStateCore extends Context.Service<ViewStateCore, RpcClient.FromGroup<typeof ViewStateRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/ViewStateCore",
) {
  static readonly layer = Layer.effect(ViewStateCore, coreClient(ViewStateRpcs));
}
