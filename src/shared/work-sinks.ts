import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import { Task, Artifact, BoardGlanceTopic, PadGlance } from "./work-model";

export const WORK_SINK_PAGE_SIZE = 50;
export const WorkSinkKind = Schema.Literals(["task", "requests", "artifacts", "board", "pad"]);
export type WorkSinkKind = typeof WorkSinkKind.Type;
export const WorkSinkQuery = Schema.Struct({
  canvasName: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  kind: WorkSinkKind,
  beforeId: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type WorkSinkQuery = typeof WorkSinkQuery.Type;
const cursor = { nextBeforeId: Schema.optionalKey(Schema.String) };
export const WorkSinkPage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("task"), items: Schema.Array(Task), ...cursor }),
  Schema.Struct({ kind: Schema.Literal("requests"), items: Schema.Array(Task), ...cursor }),
  Schema.Struct({ kind: Schema.Literal("artifacts"), items: Schema.Array(Artifact), ...cursor }),
  Schema.Struct({ kind: Schema.Literal("board"), items: Schema.Array(BoardGlanceTopic), ...cursor }),
  Schema.Struct({ kind: Schema.Literal("pad"), glance: Schema.optionalKey(PadGlance) }),
]);
export type WorkSinkPage = typeof WorkSinkPage.Type;
export const WorkSinkChanged = Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String });
export type WorkSinkChanged = typeof WorkSinkChanged.Type;

/** Compact human waits and active claims, independent of content-page depth. */
export const WorkAttentionQuery = Schema.Struct({
  canvasName: Schema.NonEmptyString,
  nodeId: Schema.optionalKey(Schema.NonEmptyString),
});
export type WorkAttentionQuery = typeof WorkAttentionQuery.Type;
export const WorkLaneRow = Schema.Struct({ nodeId: Schema.String, item: Task });
export type WorkLaneRow = typeof WorkLaneRow.Type;
export const WorkAttentionRow = Schema.Struct({ nodeId: Schema.String, kind: Schema.Literals(["task", "requests"]), item: Task });
export type WorkAttentionRow = typeof WorkAttentionRow.Type;


/** A detail read addresses one exact row; it never loads its board. */
export const WorkItemQuery = Schema.Struct({
  canvasName: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  kind: Schema.Literals(["task", "requests"]),
  itemId: Schema.NonEmptyString,
});
export type WorkItemQuery = typeof WorkItemQuery.Type;

export const WorkActorQuery = Schema.Struct({
  canvasName: Schema.NonEmptyString,
  seatId: ActorSeatId,
  kind: Schema.Literals(["task", "requests", "artifacts"]),
  beforeId: Schema.optionalKey(Schema.String),
  beforeNodeId: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type WorkActorQuery = typeof WorkActorQuery.Type;
export const WorkActorPage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("task"), items: Schema.Array(WorkLaneRow), nextBeforeId: Schema.optionalKey(Schema.String), nextBeforeNodeId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("requests"), items: Schema.Array(WorkLaneRow), nextBeforeId: Schema.optionalKey(Schema.String), nextBeforeNodeId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("artifacts"), items: Schema.Array(Schema.Struct({ nodeId: Schema.String, item: Artifact })), nextBeforeId: Schema.optionalKey(Schema.String), nextBeforeNodeId: Schema.optionalKey(Schema.String) }),
]);
export type WorkActorPage = typeof WorkActorPage.Type;
