import { Schema } from "effect";
import { Seq } from "./model/events";
import { ActorSeatId } from "./actor-seat";
import { InstallationId } from "./installation-id";
import { PadPatch } from "./pad";
import {
  Artifact,
  BoardAuthor,
  BoardPost,
  BoardTopic,
  Message,
  Task,
} from "./work-model";
import {
  ActorRef,
  BoundedWorkId,
  WorkCanvasName,
  WorkItemRef,
} from "./work-reference";

export { ActorSeatId };
export {
  ActorRef,
  SinkRef,
  TaskRef,
  WorkItemKind,
  WorkItemRef,
  WorkNodeRef,
  WORK_PROTOCOL_MAX_CANVAS_NAME_CHARS,
  WORK_PROTOCOL_MAX_ID_CHARS,
  WORK_PROTOCOL_MAX_NODE_ID_CHARS,
} from "./work-reference";

/**
 * Canonical work-event contract.
 *
 * This module is the pristine seam between the local work domain, Station
 * reports, and SQLite repositories. It deliberately contains no ReportBatch,
 * SSH, socket, database, or wall-clock coordination concerns.
 */
/**
 * The Junto work-event envelope at version 1. Station protocol 1 admits
 * ContentRef parts inside that envelope but never rewrites prior Work history
 * or its durable representation. Media bytes stay off the wire; only bounded
 * reference metadata is carried.
 */
export const WORK_PROTOCOL = "junto/work/v1" as const;

/** Intrinsic limits for one work record, independent of report batching. */
export const WORK_PROTOCOL_MAX_RECORD_BYTES = 256 * 1024;
export const WORK_PROTOCOL_MAX_DIAGNOSTIC_CHARS = 2_048;
export const WORK_PROTOCOL_MAX_TIMESTAMP_CHARS = 64;

/**
 * Canonical positive decimal sequence.
 *
 * Sequences remain strings across the wire and repository boundary so values
 * larger than Number.MAX_SAFE_INTEGER cannot lose precision.
 */
export const LogicalSequence = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  Schema.check(Schema.isMaxLength(32)),
  Schema.brand("WorkLogicalSequence"),
);
export type LogicalSequence = typeof LogicalSequence.Type;

export const WorkSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  Schema.brand("WorkSha256"),
);
export type WorkSha256 = typeof WorkSha256.Type;

/**
 * Display metadata only. No policy helper accepts this value as ordering or
 * authority input.
 */
export const DisplayTimestamp = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(WORK_PROTOCOL_MAX_TIMESTAMP_CHARS)),
);
export type DisplayTimestamp = typeof DisplayTimestamp.Type;

export const BoundedDiagnostic = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(WORK_PROTOCOL_MAX_DIAGNOSTIC_CHARS)),
);
export type BoundedDiagnostic = typeof BoundedDiagnostic.Type;

export const WorkRoute = Schema.Struct({
  eventHome: InstallationId,
  entityHome: InstallationId,
});
export type WorkRoute = typeof WorkRoute.Type;

export const WorkRecordId = Schema.Struct({
  route: WorkRoute,
  seq: LogicalSequence,
});
export type WorkRecordId = typeof WorkRecordId.Type;

export const CanvasFactBasis = Schema.Struct({
  kind: Schema.Literal("canvas"),
  canvasName: WorkCanvasName,
  seq: Seq,
});
export type CanvasFactBasis = typeof CanvasFactBasis.Type;

/** A fact older than the canvas basis: no authority claim, and a hash kept as written. */
export const HistoricalFactBasis = Schema.Struct({ kind: Schema.Literal("historical") });
export type HistoricalFactBasis = typeof HistoricalFactBasis.Type;

/**
 * What a fact rests on, fixed when it is written: the canvas and the sequence
 * its writer saw. Nobody re-checks it afterwards.
 */
export const FactBasis = Schema.Union([HistoricalFactBasis, CanvasFactBasis]);
export type FactBasis = typeof FactBasis.Type;

export const IntentFactBasis = CanvasFactBasis;
export type IntentFactBasis = typeof IntentFactBasis.Type;

export const RouteCursor = Schema.Struct({
  eventHome: InstallationId,
  entityHome: InstallationId,
  through: LogicalSequence,
});
export type RouteCursor = typeof RouteCursor.Type;

export const WorkOperation = Schema.Literals(["task.create",
"task.describe",
"task.transition",
"task.claim",
"request.create",
"request.resolve",
"message.append",
"artifact.publish",
"delivery.accepted",
"board.topic.create",
"board.post.append",
"pad.patch",]);
export type WorkOperation = typeof WorkOperation.Type;

export const DeliveryReceipt = Schema.Struct({
  deliveryId: BoundedWorkId,
  deliveredItem: WorkItemRef,
  actor: ActorRef,
  acceptedAt: DisplayTimestamp,
});
export type DeliveryReceipt = typeof DeliveryReceipt.Type;

/**
 * `Message.taskId` is an A2A cross-reference, not a storage-lane tag. The
 * destination is therefore explicit on every append record so a receiver can
 * materialize it without consulting transport context or guessing from
 * optional message fields.
 */
export const MessageAppendDestination = Schema.Union([Schema.Struct({
  kind: Schema.Literal("mailbox"),
}),
Schema.Struct({
  kind: Schema.Literal("task"),
  itemId: BoundedWorkId,
}),
Schema.Struct({
  kind: Schema.Literal("request"),
  itemId: BoundedWorkId,
}),]);
export type MessageAppendDestination =
  typeof MessageAppendDestination.Type;

const MessageAppendPayload = {
  message: Message,
  sentBy: ActorRef,
  destination: MessageAppendDestination,
} as const;

const destinationMatchesMessage = (
  input: {
    readonly message: Message;
    readonly destination: MessageAppendDestination;
  },
): boolean | string =>
  input.destination.kind === "mailbox" ||
    input.message.taskId === input.destination.itemId
    ? true
    : "task/request message destination must equal Message.taskId";

export const TaskCreateResult = Schema.Struct({
  operation: Schema.Literal("task.create"),
  task: Task,
}).pipe(
  Schema.check(Schema.makeFilter(({ task }) =>
    (task.state === "submitted" && task.claimedBy === undefined) ||
    "task.create result requires a submitted unclaimed task",)),
);
export type TaskCreateResult = typeof TaskCreateResult.Type;

export const TaskMutationResult = Schema.Struct({
  operation: Schema.Literals(["task.describe", "task.transition",]),
  task: Task,
});
export type TaskMutationResult = typeof TaskMutationResult.Type;

export const TaskClaimResult = Schema.Struct({
  operation: Schema.Literal("task.claim"),
  task: Task,
  claimedBy: ActorRef,
  previousHome: InstallationId,
}).pipe(
  Schema.check(Schema.makeFilter(({ task, claimedBy }) =>
    (task.state === "working" &&
      task.claimedBy === claimedBy.seatId) ||
    "task.claim result requires a working task claimed by the exact actor seat",)),
);
export type TaskClaimResult = typeof TaskClaimResult.Type;

export const RequestResult = Schema.Struct({
  operation: Schema.Literals(["request.create", "request.resolve"]),
  request: Task,
}).pipe(
  Schema.check(Schema.makeFilter((result) => {
    if (result.operation === "request.create") {
      return (
        (result.request.state === "input-required" &&
          result.request.claimedBy !== undefined) ||
        "request.create result requires an input-required request with a claimant"
      );
    }
    return (
      ((result.request.state === "completed" ||
        result.request.state === "rejected") &&
        result.request.claimedBy !== undefined) ||
      "request.resolve result requires a completed or rejected request with its original claimant"
    );
  })),
);
export type RequestResult = typeof RequestResult.Type;

export const MessageAppendResult = Schema.Struct({
  operation: Schema.Literal("message.append"),
  ...MessageAppendPayload,
}).pipe(Schema.check(Schema.makeFilter(destinationMatchesMessage)));
export type MessageAppendResult = typeof MessageAppendResult.Type;

export const ArtifactPublishResult = Schema.Struct({
  operation: Schema.Literal("artifact.publish"),
  artifact: Artifact,
  publishedBy: ActorRef,
});
export type ArtifactPublishResult = typeof ArtifactPublishResult.Type;

export const DeliveryAcceptedResult = Schema.Struct({
  operation: Schema.Literal("delivery.accepted"),
  receipt: DeliveryReceipt,
});
export type DeliveryAcceptedResult = typeof DeliveryAcceptedResult.Type;

export const BoardTopicCreateResult = Schema.Struct({
  operation: Schema.Literal("board.topic.create"),
  topic: BoardTopic,
  createdBy: BoardAuthor,
});
export type BoardTopicCreateResult = typeof BoardTopicCreateResult.Type;

export const BoardPostAppendResult = Schema.Struct({
  operation: Schema.Literal("board.post.append"),
  post: BoardPost,
  createdBy: BoardAuthor,
});
export type BoardPostAppendResult = typeof BoardPostAppendResult.Type;

export const PadPatchResult = Schema.Struct({
  operation: Schema.Literal("pad.patch"),
  patchId: BoundedWorkId,
  patches: Schema.Array(PadPatch).pipe(Schema.check(Schema.isMinLength(1))),
  author: BoardAuthor,
  revision: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type PadPatchResult = typeof PadPatchResult.Type;

export const WorkResult = Schema.Union([TaskCreateResult,
TaskMutationResult,
TaskClaimResult,
RequestResult,
MessageAppendResult,
ArtifactPublishResult,
DeliveryAcceptedResult,
BoardTopicCreateResult,
BoardPostAppendResult,
PadPatchResult,]);
export type WorkResult = typeof WorkResult.Type;

/** Why a work write was refused. */
export const WorkRejectionReason = Schema.Literals(["authority-mismatch", "capability-denied",
"causal-conflict",
"claim-contention",
"identity-conflict",
"invalid-transition",
"locality-mismatch",
"missing-entity",
"projection-conflict",
"target-mismatch",]);
export type WorkRejectionReason = typeof WorkRejectionReason.Type;

export const WorkRecordCommon = Schema.Struct({
  protocol: Schema.Literal(WORK_PROTOCOL),
  id: WorkRecordId,
  recordType: Schema.Literals(["command", "fact", "disposition"]),
  item: WorkItemRef,
  operation: WorkOperation,
  contentSha256: WorkSha256,
  originAt: DisplayTimestamp,
});
export type WorkRecordCommon = typeof WorkRecordCommon.Type;

const artifactMatchesRecord = (
  item: WorkItemRef,
  artifact: Artifact,
  _publishedBy: ActorRef,
): boolean =>
  item.kind === "artifact" &&
  item.itemId === artifact.artifactId &&
  (artifact.task === undefined ||
    artifact.task.sink.canvasName === item.sink.canvasName);

const itemMatchesResult = (
  item: WorkItemRef,
  result: WorkResult,
): boolean => {
  switch (result.operation) {
    case "task.create":
    case "task.describe":
    case "task.transition":
    case "task.claim":
      return item.kind === "task" && item.itemId === result.task.id;
    case "request.create":
    case "request.resolve":
      return item.kind === "request" && item.itemId === result.request.id;
    case "message.append":
      return (
        item.kind === "message" && item.itemId === result.message.messageId
      );
    case "artifact.publish":
      return artifactMatchesRecord(
        item,
        result.artifact,
        result.publishedBy,
      );
    case "delivery.accepted":
      return (
        item.kind === "delivery" &&
        item.itemId === result.receipt.deliveryId
      );
    case "board.topic.create":
      return item.kind === "topic" && item.itemId === result.topic.topicId;
    case "board.post.append":
      return item.kind === "post" && item.itemId === result.post.postId;
    case "pad.patch":
      return item.kind === "pad" && item.itemId === result.patchId;
  }
};

const noPriorMaterialFact = (operation: WorkOperation): boolean =>
  operation === "task.create" ||
  operation === "task.claim" ||
  operation === "request.create" ||
  operation === "message.append" ||
  operation === "artifact.publish" ||
  operation === "delivery.accepted" ||
  operation === "board.topic.create" ||
  operation === "board.post.append" ||
  operation === "pad.patch";

const recordByteLength = (record: unknown): number | undefined => {
  try {
    const encoded = JSON.stringify(record);
    return encoded === undefined
      ? undefined
      : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return undefined;
  }
};

export const workRecordEncodedByteLength = (
  record: unknown,
): number | undefined => recordByteLength(record);

const withinRecordBound = (record: unknown): boolean | string => {
  const bytes = recordByteLength(record);
  if (bytes === undefined) {
    return "Work record must be JSON-serializable";
  }
  return (
    bytes <= WORK_PROTOCOL_MAX_RECORD_BYTES ||
    `Work record exceeds ${WORK_PROTOCOL_MAX_RECORD_BYTES} encoded bytes`
  );
};

const WorkFactShape = Schema.Struct({
  ...WorkRecordCommon.fields,
  recordType: Schema.Literal("fact"),
  basis: FactBasis,
  predecessor: Schema.NullOr(WorkRecordId),
  body: WorkResult,
});

export const WorkFact = WorkFactShape.pipe(
  Schema.check(Schema.makeFilter((record) => {
    if (record.id.route.eventHome !== record.id.route.entityHome) {
      return "Work fact must be emitted by its entity authority home";
    }
    if (record.operation !== record.body.operation) {
      return "Work fact operation must match its result";
    }
    if (!itemMatchesResult(record.item, record.body)) {
      return "Work fact item must match its result identity";
    }
    if (record.body.operation === "task.claim") {
      const crossesAuthority =
        record.body.previousHome !== record.id.route.entityHome;
      if (crossesAuthority) {
        return (
          record.predecessor === null ||
          "First cross-home task.claim fact predecessor must be null"
        );
      }
      return (
        record.predecessor !== null ||
        "Same-home task.claim fact must name its submitted predecessor"
      );
    }
    if (noPriorMaterialFact(record.operation)) {
      return (
        record.predecessor === null ||
        "Create fact predecessor must be null"
      );
    }
    return (
      record.predecessor !== null || "Mutation fact must name its predecessor"
    );
  })),
  Schema.check(Schema.makeFilter(withinRecordBound)),
);
export type WorkFact = typeof WorkFact.Type;

export const WorkRecord = WorkFact;
export type WorkRecord = typeof WorkRecord.Type;

const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

export const decodeWorkResult = Schema.decodeUnknownResult(
  WorkResult,
  STRICT_PARSE_OPTIONS,
);

export const decodeWorkRecord = Schema.decodeUnknownResult(
  WorkRecord,
  STRICT_PARSE_OPTIONS,
);
