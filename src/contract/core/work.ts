/**
 * What the window reads through the work core: one task, the attention
 * snapshot, a page of a node's mail, a seat's recent operations, and the
 * artifacts whose body links one artifact. Main decodes the renderer's
 * queries at its edge, so the core is handed only what it reads. A store
 * that cannot be read fails with its words; a seat's recent operations keep
 * the work plane's own `{ ok }` answer, which the window reads as data.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { ArtifactLinksInput } from "../../shared/artifact-links-ipc";
import { LinkedFromBody } from "../../shared/artifact-links";
import { WorkAttentionSnapshot } from "../../shared/work-attention";
import { WorkErrorDetails } from "../../shared/work-control";
import { WorkMailPage, WorkMailQuery } from "../../shared/work-mail";
import { Task } from "../../shared/work-model";
import { WorkSeatRecentOpsFeed } from "../../shared/work-recent-ops";
import { WorkAttentionQuery, WorkItemQuery } from "../../shared/work-sinks";
import { coreClient } from "./link";

/** The closed codes a work operation refuses with (`WorkServiceErrorCode` in the core). */
export const WorkErrorCode = Schema.Literals([
  "canvas_not_found",
  "node_not_found",
  "task_not_found",
  "illegal_kind",
  "illegal_transition",
  "claim_contention",
  "invalid",
  "not_ready",
  "unadmitted",
  "fork_choice",
  "wrong_home",
  "operator_owned",
  "reviewer_is_author",
  "scope_error",
]);
export type WorkErrorCode = typeof WorkErrorCode.Type;

/** One seat's recent operations, at most `limit` of them. */
export const WorkSeatRecentOpsQuery = Schema.Struct({
  canvas: Schema.String,
  nodeId: Schema.String,
  limit: Schema.optionalKey(Schema.Number),
});
export type WorkSeatRecentOpsQuery = typeof WorkSeatRecentOpsQuery.Type;

/** A seat's recent operations as the work plane answers them: the feed, or its refusal. */
export const WorkSeatRecentOpsResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: WorkSeatRecentOpsFeed,
    disposition: Schema.Literals(["applied", "queued"]),
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: WorkErrorCode,
    message: Schema.String,
    details: Schema.optionalKey(WorkErrorDetails),
  }),
]);
export type WorkSeatRecentOpsResult = typeof WorkSeatRecentOpsResult.Type;

/** The work store, or the canvas it reads against, could not be read. */
export class WorkReadFailed extends Schema.TaggedError<WorkReadFailed>()("WorkReadFailed", {
  message: Schema.String,
}) {}

export const WorkRpcs = RpcGroup.make(
  /** One exact task row; none when it is not there. */
  Rpc.make("WorkItem", { payload: WorkItemQuery, success: Schema.UndefinedOr(Task), error: WorkReadFailed }),
  Rpc.make("WorkAttention", { payload: WorkAttentionQuery, success: WorkAttentionSnapshot, error: WorkReadFailed }),
  Rpc.make("WorkMailPage", { payload: WorkMailQuery, success: WorkMailPage, error: WorkReadFailed }),
  Rpc.make("WorkSeatRecentOps", { payload: WorkSeatRecentOpsQuery, success: WorkSeatRecentOpsResult }),
  /** The artifacts whose body links one artifact (`work/body-links.ts`), read where the store is. */
  Rpc.make("WorkArtifactLinks", { payload: ArtifactLinksInput, success: Schema.Array(LinkedFromBody), error: WorkReadFailed }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the work group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class WorkCore extends Context.Service<WorkCore, RpcClient.FromGroup<typeof WorkRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/WorkCore",
) {
  static readonly layer = Layer.effect(WorkCore, coreClient(WorkRpcs));
}
