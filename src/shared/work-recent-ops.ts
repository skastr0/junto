import { Schema } from "effect";
import { DisplayTimestamp, WorkOperation } from "./work-protocol";
import { BoundedWorkId, WorkItemKind, WorkNodeId } from "./work-reference";

export const WORK_SEAT_RECENT_OP_DEFAULT_LIMIT = 20;
export const WORK_SEAT_RECENT_OP_MAX_LIMIT = 50;
export const WORK_SEAT_RECENT_OP_MAX_LABEL_CHARS = 160;

export const WorkSeatRecentOpOperation = Schema.Literals([
  "task.claim",
  "request.create",
  "message.append",
  "artifact.publish",
  "delivery.accepted",
  "board.topic.create",
  "board.post.append",
]);
export type WorkSeatRecentOpOperation =
  typeof WorkSeatRecentOpOperation.Type;

const SummaryLabel = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(WORK_SEAT_RECENT_OP_MAX_LABEL_CHARS)),
);

export const WorkSeatRecentOpSummary = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("message"),
    messageId: BoundedWorkId,
  }),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    artifactId: BoundedWorkId,
    name: Schema.optionalKey(SummaryLabel),
    taskId: Schema.optionalKey(BoundedWorkId),
  }),
  Schema.Struct({
    kind: Schema.Literal("request"),
    requestId: BoundedWorkId,
  }),
  Schema.Struct({
    kind: Schema.Literal("task"),
    taskId: BoundedWorkId,
  }),
  Schema.Struct({
    kind: Schema.Literal("delivery"),
    deliveryId: BoundedWorkId,
    delivered: Schema.Struct({
      kind: WorkItemKind,
      itemId: BoundedWorkId,
      targetNodeId: WorkNodeId,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("topic"),
    topicId: BoundedWorkId,
    title: SummaryLabel,
  }),
  Schema.Struct({
    kind: Schema.Literal("post"),
    postId: BoundedWorkId,
    topicId: BoundedWorkId,
  }),
]);
export type WorkSeatRecentOpSummary = typeof WorkSeatRecentOpSummary.Type;

/**
 * Deliberately small renderer-facing receipt. Immutable record bodies stay in
 * main; message text, artifact parts, responses, and metadata never cross the
 * read boundary.
 */
export const WorkSeatRecentOp = Schema.Struct({
  operation: WorkSeatRecentOpOperation,
  originAt: DisplayTimestamp,
  appliedAt: DisplayTimestamp,
  targetNodeId: WorkNodeId,
  summary: WorkSeatRecentOpSummary,
});
export type WorkSeatRecentOp = typeof WorkSeatRecentOp.Type;

export const WORK_SEAT_RECENT_OP_INCLUDED_OPERATIONS = [
  "task.claim",
  "request.create",
  "message.append",
  "artifact.publish",
  "delivery.accepted",
  "board.topic.create",
  "board.post.append",
] as const satisfies ReadonlyArray<WorkSeatRecentOpOperation>;

export const WORK_SEAT_RECENT_OP_EXCLUDED_OPERATIONS = [
  "task.create",
  "task.describe",
  "task.transition",
  "request.resolve",
  "pad.patch",
] as const satisfies ReadonlyArray<WorkOperation>;

export const WorkSeatRecentOpsCoverage = Schema.Struct({
  kind: Schema.Literal("explicit-actor-only"),
  includes: Schema.Array(WorkSeatRecentOpOperation),
  excludes: Schema.Array(WorkOperation),
});
export type WorkSeatRecentOpsCoverage =
  typeof WorkSeatRecentOpsCoverage.Type;

export const WORK_SEAT_RECENT_OPS_COVERAGE: WorkSeatRecentOpsCoverage = {
  kind: "explicit-actor-only",
  includes: WORK_SEAT_RECENT_OP_INCLUDED_OPERATIONS,
  excludes: WORK_SEAT_RECENT_OP_EXCLUDED_OPERATIONS,
};

export const WorkSeatRecentOpsFeed = Schema.Struct({
  operations: Schema.Array(WorkSeatRecentOp),
  /** Derived from the same included subset; this is not task-progress time. */
  lastOpAt: Schema.NullOr(DisplayTimestamp),
  coverage: WorkSeatRecentOpsCoverage,
});
export type WorkSeatRecentOpsFeed = typeof WorkSeatRecentOpsFeed.Type;
