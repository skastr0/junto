import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";

/**
 * Canonical work identity references shared by the durable domain model and
 * the Work event protocol. This module deliberately has no dependency on
 * either layer, so domain values may carry exact references without creating
 * a model/protocol import cycle.
 */
export const WORK_PROTOCOL_MAX_ID_CHARS = 256;
export const WORK_PROTOCOL_MAX_CANVAS_NAME_CHARS = 256;
export const WORK_PROTOCOL_MAX_NODE_ID_CHARS = 256;

export const BoundedWorkId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(WORK_PROTOCOL_MAX_ID_CHARS)),
);

export const WorkCanvasName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(WORK_PROTOCOL_MAX_CANVAS_NAME_CHARS)),
);

export const WorkNodeId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(WORK_PROTOCOL_MAX_NODE_ID_CHARS)),
);

export const SinkRef = Schema.Struct({
  canvasName: WorkCanvasName,
  nodeId: WorkNodeId,
});
export type SinkRef = typeof SinkRef.Type;

export const WorkNodeRef = SinkRef;
export type WorkNodeRef = typeof WorkNodeRef.Type;

export const ActorRef = Schema.Struct({
  seatId: ActorSeatId,
  canvasName: WorkCanvasName,
  nodeId: WorkNodeId,
});
export type ActorRef = typeof ActorRef.Type;

/**
 * Stable non-executable identity for Command Center operator actions. It is
 * not an actor principal and can never claim work.
 */
export const OPERATOR_SEAT_ID = Schema.decodeUnknownSync(ActorSeatId)(
  `seat_${"c".repeat(64)}`,
);

export const operatorActorRef = (canvasName: string): ActorRef => ({
  seatId: OPERATOR_SEAT_ID,
  canvasName,
  nodeId: "operator",
});

export const WorkItemKind = Schema.Literals([
  "task",
  "request",
  "message",
  "artifact",
  "delivery",
  "topic",
  "post",
  "pad",
]);
export type WorkItemKind = typeof WorkItemKind.Type;

const WorkItemIdentityFields = {
  itemId: BoundedWorkId,
  sink: SinkRef,
} as const;

export const WorkItemRef = Schema.Struct({
  kind: WorkItemKind,
  ...WorkItemIdentityFields,
});
export type WorkItemRef = typeof WorkItemRef.Type;

/**
 * Exact optional artifact provenance. A task ID alone is not an identity:
 * task rows are addressed by canvas, sink node, and item ID.
 */
export const TaskRef = Schema.Struct({
  kind: Schema.Literal("task"),
  ...WorkItemIdentityFields,
});
export type TaskRef = typeof TaskRef.Type;
