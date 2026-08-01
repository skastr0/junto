import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import { InstallationId } from "./installation-id";
import {
  Artifact,
  BoardAuthor,
  BoardPost,
  BoardTopic,
  CompletionEvidence,
  Message,
  Task,
  TaskProposal,
  TaskState,
} from "./work-model";
import {
  ActorRef,
  BoundedWorkId,
  SinkRef,
  WorkCanvasName,
  WorkItemKind,
  WorkItemRef,
  WorkNodeId,
  WorkNodeRef,
  WORK_PROTOCOL_MAX_CANVAS_NAME_CHARS,
  WORK_PROTOCOL_MAX_ID_CHARS,
  WORK_PROTOCOL_MAX_NODE_ID_CHARS,
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
 * SSH, socket, database, or wall-clock orchestration concerns.
 */
/**
 * Existing task/request/message records retain their frozen v2 envelope.
 * Station protocol 4 admits ContentRef parts inside that envelope but never
 * rewrites prior Work history or its durable representation. Media bytes stay
 * off the wire; only bounded reference metadata is carried.
 */
export const WORK_PROTOCOL = "vellum/work/v2" as const;

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
  Schema.pattern(/^[1-9][0-9]*$/),
  Schema.maxLength(32),
  Schema.brand("WorkLogicalSequence"),
);
export type LogicalSequence = typeof LogicalSequence.Type;

export const WorkSha256 = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("WorkSha256"),
);
export type WorkSha256 = typeof WorkSha256.Type;

/**
 * Display metadata only. No policy helper accepts this value as ordering or
 * authority input.
 */
export const DisplayTimestamp = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(WORK_PROTOCOL_MAX_TIMESTAMP_CHARS),
);
export type DisplayTimestamp = typeof DisplayTimestamp.Type;

export const BoundedDiagnostic = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(WORK_PROTOCOL_MAX_DIAGNOSTIC_CHARS),
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

/**
 * Canonical non-negative intent generation.
 *
 * Intent generations are independent from positive-only Work route
 * sequences. A fresh projection may legitimately identify generation zero.
 */
export const FactBasisGeneration = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9][0-9]*)$/),
  Schema.maxLength(32),
  Schema.brand("FactBasisGeneration"),
);
export type FactBasisGeneration = typeof FactBasisGeneration.Type;

export const AuthorialIntentFactBasis = Schema.Struct({
  kind: Schema.Literal("authorial-intent"),
  generation: FactBasisGeneration,
  contentSha256: WorkSha256,
});
export type AuthorialIntentFactBasis =
  typeof AuthorialIntentFactBasis.Type;

export const ProjectedIntentFactBasis = Schema.Struct({
  kind: Schema.Literal("projected-intent"),
  generation: FactBasisGeneration,
  contentSha256: WorkSha256,
});
export type ProjectedIntentFactBasis =
  typeof ProjectedIntentFactBasis.Type;

export const CommandFactBasis = Schema.Struct({
  kind: Schema.Literal("command"),
  command: WorkRecordId,
  commandSha256: WorkSha256,
});
export type CommandFactBasis = typeof CommandFactBasis.Type;

/**
 * Immutable proof of the authority context under which a fact was emitted.
 *
 * Local operator/actor mutations name the exact authorial or projected intent
 * snapshot that admitted them. Applying a remote command names that exact
 * command instead, so later topology changes cannot retroactively invalidate
 * its correlated result.
 */
export const FactBasis = Schema.Union(
  AuthorialIntentFactBasis,
  ProjectedIntentFactBasis,
  CommandFactBasis,
);
export type FactBasis = typeof FactBasis.Type;

export const IntentFactBasis = Schema.Union(
  AuthorialIntentFactBasis,
  ProjectedIntentFactBasis,
);
export type IntentFactBasis = typeof IntentFactBasis.Type;

export const RouteCursor = Schema.Struct({
  eventHome: InstallationId,
  entityHome: InstallationId,
  through: LogicalSequence,
});
export type RouteCursor = typeof RouteCursor.Type;

export const WorkOperation = Schema.Literal(
  "proposal.create",
  "proposal.approve",
  "task.create",
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
);
export type WorkOperation = typeof WorkOperation.Type;

export const ProposalCreateAction = Schema.Struct({
  operation: Schema.Literal("proposal.create"),
  proposal: TaskProposal,
}).pipe(
  Schema.filter(
    ({ proposal }) =>
      proposal.state === "pending" ||
      "proposal.create requires a pending proposal",
  ),
);
export type ProposalCreateAction = typeof ProposalCreateAction.Type;

export const ProposalApproveAction = Schema.Struct({
  operation: Schema.Literal("proposal.approve"),
  proposalId: BoundedWorkId,
  task: Task,
}).pipe(
  Schema.filter(
    ({ task }) =>
      (task.state === "submitted" && task.claimedBy === undefined) ||
      "proposal.approve requires a submitted unclaimed task",
  ),
);
export type ProposalApproveAction = typeof ProposalApproveAction.Type;

export const DeliveryReceipt = Schema.Struct({
  deliveryId: BoundedWorkId,
  deliveredItem: WorkItemRef,
  actor: ActorRef,
  acceptedAt: DisplayTimestamp,
});
export type DeliveryReceipt = typeof DeliveryReceipt.Type;

export const TaskCreateAction = Schema.Struct({
  operation: Schema.Literal("task.create"),
  task: Task,
}).pipe(
  Schema.filter(
    ({ task }) =>
      (task.state === "submitted" && task.claimedBy === undefined) ||
      "task.create requires a submitted task snapshot",
  ),
);
export type TaskCreateAction = typeof TaskCreateAction.Type;

export const TaskDescribeAction = Schema.Struct({
  operation: Schema.Literal("task.describe"),
  taskId: BoundedWorkId,
  message: Message,
});
export type TaskDescribeAction = typeof TaskDescribeAction.Type;

export const TaskTransitionAction = Schema.Struct({
  operation: Schema.Literal("task.transition"),
  taskId: BoundedWorkId,
  state: TaskState,
  message: Schema.optionalWith(Message, { exact: true }),
  /** Set on → completed when finish criteria require proof. */
  completionEvidence: Schema.optionalWith(CompletionEvidence, { exact: true }),
}).pipe(
  Schema.filter(
    ({ state, completionEvidence }) =>
      completionEvidence === undefined ||
      state === "completed" ||
      "completionEvidence is only allowed when state is completed",
  ),
);
export type TaskTransitionAction = typeof TaskTransitionAction.Type;

/**
 * The first-adoption command is self-contained because projections do not
 * replicate work rows. Its source predecessor belongs wholly to the source
 * queue authority lane; the prospective target lane has no predecessor yet.
 */
export const TaskClaimAction = Schema.Struct({
  operation: Schema.Literal("task.claim"),
  sourceQueueHome: InstallationId,
  sourcePredecessor: Schema.NullOr(WorkRecordId),
  sourceTask: Task,
  sink: SinkRef,
  actor: ActorRef,
  targetHome: InstallationId,
}).pipe(
  Schema.filter((action) => {
    if (action.sourceTask.state !== "submitted") {
      return "task.claim requires a submitted source task snapshot";
    }
    if (action.sourceTask.claimedBy !== undefined) {
      return "task.claim requires an unclaimed source task snapshot";
    }
    if (action.sourceQueueHome === action.targetHome) {
      return "task.claim command must cross authority installations";
    }
    if (
      action.sourcePredecessor !== null &&
      (action.sourcePredecessor.route.eventHome !== action.sourceQueueHome ||
        action.sourcePredecessor.route.entityHome !== action.sourceQueueHome)
    ) {
      return "task.claim source predecessor must belong to the source queue authority lane";
    }
    return true;
  }),
);
export type TaskClaimAction = typeof TaskClaimAction.Type;

export const RequestCreateAction = Schema.Struct({
  operation: Schema.Literal("request.create"),
  request: Task,
  raisedBy: ActorRef,
}).pipe(
  Schema.filter(
    ({ request, raisedBy }) =>
      (request.state === "input-required" &&
        request.claimedBy === raisedBy.seatId) ||
      "request.create requires an input-required request claimed by its raiser",
  ),
);
export type RequestCreateAction = typeof RequestCreateAction.Type;

export const RequestResolveAction = Schema.Struct({
  operation: Schema.Literal("request.resolve"),
  requestId: BoundedWorkId,
  response: Schema.String,
  disposition: Schema.Literal("completed", "rejected"),
  message: Schema.optionalWith(Message, { exact: true }),
});
export type RequestResolveAction = typeof RequestResolveAction.Type;

/**
 * `Message.taskId` is an A2A cross-reference, not a storage-lane tag. The
 * destination is therefore explicit on every append record so a receiver can
 * materialize it without consulting transport context or guessing from
 * optional message fields.
 */
export const MessageAppendDestination = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("mailbox"),
  }),
  Schema.Struct({
    kind: Schema.Literal("task"),
    itemId: BoundedWorkId,
  }),
  Schema.Struct({
    kind: Schema.Literal("request"),
    itemId: BoundedWorkId,
  }),
);
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

export const MessageAppendAction = Schema.Struct({
  operation: Schema.Literal("message.append"),
  ...MessageAppendPayload,
}).pipe(Schema.filter(destinationMatchesMessage));
export type MessageAppendAction = typeof MessageAppendAction.Type;

export const ArtifactPublishAction = Schema.Struct({
  operation: Schema.Literal("artifact.publish"),
  artifact: Artifact,
  publishedBy: ActorRef,
});
export type ArtifactPublishAction = typeof ArtifactPublishAction.Type;

export const DeliveryAcceptedAction = Schema.Struct({
  operation: Schema.Literal("delivery.accepted"),
  receipt: DeliveryReceipt,
});
export type DeliveryAcceptedAction = typeof DeliveryAcceptedAction.Type;

/** CC-homed multi-reader bulletin topic create (OP + optional seed posts). */
export const BoardTopicCreateAction = Schema.Struct({
  operation: Schema.Literal("board.topic.create"),
  topic: BoardTopic,
  createdBy: BoardAuthor,
});
export type BoardTopicCreateAction = typeof BoardTopicCreateAction.Type;

export const BoardPostAppendAction = Schema.Struct({
  operation: Schema.Literal("board.post.append"),
  post: BoardPost,
  createdBy: BoardAuthor,
});
export type BoardPostAppendAction = typeof BoardPostAppendAction.Type;

export const WorkAction = Schema.Union(
  ProposalCreateAction,
  ProposalApproveAction,
  TaskCreateAction,
  TaskDescribeAction,
  TaskTransitionAction,
  TaskClaimAction,
  RequestCreateAction,
  RequestResolveAction,
  MessageAppendAction,
  ArtifactPublishAction,
  DeliveryAcceptedAction,
  BoardTopicCreateAction,
  BoardPostAppendAction,
);
export type WorkAction = typeof WorkAction.Type;

export const ProposalCreateResult = Schema.Struct({
  operation: Schema.Literal("proposal.create"),
  proposal: TaskProposal,
}).pipe(
  Schema.filter(
    ({ proposal }) =>
      proposal.state === "pending" ||
      "proposal.create result requires a pending proposal",
  ),
);
export type ProposalCreateResult = typeof ProposalCreateResult.Type;

export const ProposalApproveResult = Schema.Struct({
  operation: Schema.Literal("proposal.approve"),
  proposal: TaskProposal,
  task: Task,
}).pipe(
  Schema.filter(
    ({ proposal, task }) =>
      (proposal.state === "approved" &&
        proposal.approvedTaskId === task.id &&
        task.state === "submitted" &&
        task.claimedBy === undefined) ||
      "proposal.approve result must bind the approved proposal to its submitted task",
  ),
);
export type ProposalApproveResult = typeof ProposalApproveResult.Type;

export const TaskCreateResult = Schema.Struct({
  operation: Schema.Literal("task.create"),
  task: Task,
}).pipe(
  Schema.filter(
    ({ task }) =>
      (task.state === "submitted" && task.claimedBy === undefined) ||
      "task.create result requires a submitted unclaimed task",
  ),
);
export type TaskCreateResult = typeof TaskCreateResult.Type;

export const TaskMutationResult = Schema.Struct({
  operation: Schema.Literal(
    "task.describe",
    "task.transition",
  ),
  task: Task,
});
export type TaskMutationResult = typeof TaskMutationResult.Type;

export const TaskClaimResult = Schema.Struct({
  operation: Schema.Literal("task.claim"),
  task: Task,
  claimedBy: ActorRef,
  previousHome: InstallationId,
}).pipe(
  Schema.filter(
    ({ task, claimedBy }) =>
      (task.state === "working" &&
        task.claimedBy === claimedBy.seatId) ||
      "task.claim result requires a working task claimed by the exact actor seat",
  ),
);
export type TaskClaimResult = typeof TaskClaimResult.Type;

export const RequestResult = Schema.Struct({
  operation: Schema.Literal("request.create", "request.resolve"),
  request: Task,
}).pipe(
  Schema.filter((result) => {
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
  }),
);
export type RequestResult = typeof RequestResult.Type;

export const MessageAppendResult = Schema.Struct({
  operation: Schema.Literal("message.append"),
  ...MessageAppendPayload,
}).pipe(Schema.filter(destinationMatchesMessage));
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

export const WorkResult = Schema.Union(
  ProposalCreateResult,
  ProposalApproveResult,
  TaskCreateResult,
  TaskMutationResult,
  TaskClaimResult,
  RequestResult,
  MessageAppendResult,
  ArtifactPublishResult,
  DeliveryAcceptedResult,
  BoardTopicCreateResult,
  BoardPostAppendResult,
);
export type WorkResult = typeof WorkResult.Type;

export const WorkRejectionReason = Schema.Literal(
  "authority-mismatch",
  "capability-denied",
  "causal-conflict",
  "claim-contention",
  "identity-conflict",
  "invalid-transition",
  "locality-mismatch",
  "missing-entity",
  "projection-conflict",
  "target-mismatch",
);
export type WorkRejectionReason = typeof WorkRejectionReason.Type;

export const AppliedDisposition = Schema.Struct({
  status: Schema.Literal("applied"),
  command: WorkRecordId,
  commandSha256: WorkSha256,
  fact: WorkRecordId,
  factSha256: WorkSha256,
});
export type AppliedDisposition = typeof AppliedDisposition.Type;

export const RejectedDisposition = Schema.Struct({
  status: Schema.Literal("rejected"),
  command: WorkRecordId,
  commandSha256: WorkSha256,
  reason: WorkRejectionReason,
  message: BoundedDiagnostic,
});
export type RejectedDisposition = typeof RejectedDisposition.Type;

export const WorkDispositionBody = Schema.Union(
  AppliedDisposition,
  RejectedDisposition,
);
export type WorkDispositionBody = typeof WorkDispositionBody.Type;

export const WorkRecordCommon = Schema.Struct({
  protocol: Schema.Literal(WORK_PROTOCOL),
  id: WorkRecordId,
  recordType: Schema.Literal("command", "fact", "disposition"),
  item: WorkItemRef,
  operation: WorkOperation,
  contentSha256: WorkSha256,
  originAt: DisplayTimestamp,
});
export type WorkRecordCommon = typeof WorkRecordCommon.Type;

const sameSink = (left: SinkRef, right: SinkRef): boolean =>
  left.canvasName === right.canvasName && left.nodeId === right.nodeId;

const artifactMatchesRecord = (
  item: WorkItemRef,
  artifact: Artifact,
  publishedBy: ActorRef,
): boolean =>
  item.kind === "artifact" &&
  item.itemId === artifact.artifactId &&
  publishedBy.canvasName === item.sink.canvasName &&
  (artifact.task === undefined ||
    artifact.task.sink.canvasName === item.sink.canvasName);

const itemMatchesAction = (
  item: WorkItemRef,
  action: WorkAction,
): boolean => {
  switch (action.operation) {
    case "proposal.create":
      return item.kind === "proposal" && item.itemId === action.proposal.id;
    case "proposal.approve":
      return item.kind === "proposal" && item.itemId === action.proposalId;
    case "task.create":
      return item.kind === "task" && item.itemId === action.task.id;
    case "task.describe":
    case "task.transition":
      return item.kind === "task" && item.itemId === action.taskId;
    case "task.claim":
      return (
        item.kind === "task" &&
        item.itemId === action.sourceTask.id &&
        sameSink(item.sink, action.sink)
      );
    case "request.create":
      return item.kind === "request" && item.itemId === action.request.id;
    case "request.resolve":
      return item.kind === "request" && item.itemId === action.requestId;
    case "message.append":
      return (
        item.kind === "message" && item.itemId === action.message.messageId
      );
    case "artifact.publish":
      return artifactMatchesRecord(
        item,
        action.artifact,
        action.publishedBy,
      );
    case "delivery.accepted":
      return (
        item.kind === "delivery" &&
        item.itemId === action.receipt.deliveryId
      );
    case "board.topic.create":
      return item.kind === "topic" && item.itemId === action.topic.topicId;
    case "board.post.append":
      return item.kind === "post" && item.itemId === action.post.postId;
  }
};

const itemMatchesResult = (
  item: WorkItemRef,
  result: WorkResult,
): boolean => {
  switch (result.operation) {
    case "proposal.create":
    case "proposal.approve":
      return item.kind === "proposal" && item.itemId === result.proposal.id;
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
  }
};

const noPriorMaterialFact = (operation: WorkOperation): boolean =>
  operation === "proposal.create" ||
  operation === "task.create" ||
  operation === "task.claim" ||
  operation === "request.create" ||
  operation === "message.append" ||
  operation === "artifact.publish" ||
  operation === "delivery.accepted" ||
  operation === "board.topic.create" ||
  operation === "board.post.append";

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

const WorkCommandShape = Schema.Struct({
  ...WorkRecordCommon.fields,
  recordType: Schema.Literal("command"),
  predecessor: Schema.NullOr(WorkRecordId),
  body: WorkAction,
});

export const WorkCommand = WorkCommandShape.pipe(
  Schema.filter((record) => {
    if (record.id.route.eventHome === record.id.route.entityHome) {
      return "Work command event and entity homes must be different";
    }
    if (record.operation !== record.body.operation) {
      return "Work command operation must match its action";
    }
    if (!itemMatchesAction(record.item, record.body)) {
      return "Work command item must match its action identity";
    }
    if (record.body.operation === "task.claim") {
      if (record.predecessor !== null) {
        return "Cross-home task.claim command predecessor must be null";
      }
      if (record.id.route.entityHome !== record.body.targetHome) {
        return "task.claim targetHome must match command entityHome";
      }
      return true;
    }
    if (noPriorMaterialFact(record.operation)) {
      return (
        record.predecessor === null ||
        "Create command predecessor must be null"
      );
    }
    return (
      record.predecessor !== null ||
      "Mutation command must name its predecessor"
    );
  }),
  Schema.filter(withinRecordBound),
);
export type WorkCommand = typeof WorkCommand.Type;

const WorkFactShape = Schema.Struct({
  ...WorkRecordCommon.fields,
  recordType: Schema.Literal("fact"),
  basis: FactBasis,
  predecessor: Schema.NullOr(WorkRecordId),
  body: WorkResult,
});

export const WorkFact = WorkFactShape.pipe(
  Schema.filter((record) => {
    if (record.id.route.eventHome !== record.id.route.entityHome) {
      return "Work fact must be emitted by its entity authority home";
    }
    if (record.operation !== record.body.operation) {
      return "Work fact operation must match its result";
    }
    if (!itemMatchesResult(record.item, record.body)) {
      return "Work fact item must match its result identity";
    }
    if (
      record.basis.kind === "command" &&
      record.basis.command.route.entityHome !== record.id.route.entityHome
    ) {
      return "Command fact basis must address the fact authority lane";
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
  }),
  Schema.filter(withinRecordBound),
);
export type WorkFact = typeof WorkFact.Type;

const WorkDispositionShape = Schema.Struct({
  ...WorkRecordCommon.fields,
  recordType: Schema.Literal("disposition"),
  body: WorkDispositionBody,
});

/**
 * Structural disposition admission lives here. Repository acceptance must
 * additionally load the referenced command/fact and prove operation, item,
 * and recorded hash coherence; those facts are intentionally not duplicated
 * into this wire body.
 */
export const WorkDisposition = WorkDispositionShape.pipe(
  Schema.filter((record) => {
    if (record.id.route.eventHome !== record.id.route.entityHome) {
      return "Work disposition must be emitted by its entity authority home";
    }
    if (record.body.command.route.entityHome !== record.id.route.entityHome) {
      return "Work disposition must address the command entity authority lane";
    }
    if (
      record.body.status === "applied" &&
      (record.body.fact.route.eventHome !== record.id.route.eventHome ||
        record.body.fact.route.entityHome !== record.id.route.entityHome)
    ) {
      return "Applied disposition fact must belong to the disposition authority lane";
    }
    return true;
  }),
  Schema.filter(withinRecordBound),
);
export type WorkDisposition = typeof WorkDisposition.Type;

export const WorkRecord = Schema.Union(
  WorkCommand,
  WorkFact,
  WorkDisposition,
);
export type WorkRecord = typeof WorkRecord.Type;

/**
 * Repository-only wrapper. `receivedAt` is local observation metadata and is
 * deliberately absent from every wire WorkRecord variant.
 */
export const StoredWorkRecord = Schema.Struct({
  record: WorkRecord,
  receivedAt: DisplayTimestamp,
});
export type StoredWorkRecord = typeof StoredWorkRecord.Type;

const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

export const decodeWorkAction = Schema.decodeUnknownEither(
  WorkAction,
  STRICT_PARSE_OPTIONS,
);

export const decodeWorkResult = Schema.decodeUnknownEither(
  WorkResult,
  STRICT_PARSE_OPTIONS,
);

export const decodeWorkRecord = Schema.decodeUnknownEither(
  WorkRecord,
  STRICT_PARSE_OPTIONS,
);

export const decodeStoredWorkRecord = Schema.decodeUnknownEither(
  StoredWorkRecord,
  STRICT_PARSE_OPTIONS,
);
