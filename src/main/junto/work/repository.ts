import { readWorkGlances } from "./glance";
import type { KernelWork } from "@shared/work-kernel";
import type { WorkAttentionSnapshot } from "@shared/work-attention";
import { WorkItemQuery, WorkActorQuery, type WorkActorPage, type WorkLaneRow, WorkAttentionQuery, type WorkAttentionRow, WorkSinkQuery, type WorkSinkPage, WORK_SINK_PAGE_SIZE } from "@shared/work-sinks";
import { WorkMailQuery, type WorkMailPage, WORK_MAIL_PAGE_SIZE } from "@shared/work-mail";
import { workProjectionChanges } from "./projection-changes";
import {
  ExchangeFact,
  compareSequence,
  entitledTo,
  peerMayPassOn,
  writtenByItsAuthor,
  type CanvasPlacement,
  type RowsFrame,
} from "@shared/work-exchange";
import { createHash } from "node:crypto";
import { Cause, Context, Effect, Option, Result, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import { withSqlRead } from "../state/sql-read";
import { afterSqlCommit } from "../state/sql-commit";
import { ModelRecords, ModelError } from "../model/records";
import { deriveActorSeatId } from "../actor-seat-id";
import { Node, Wire, asCanvasName, asNodeId, regionStack as modelRegionStack, wireKinds, wireGrant, type Canvas } from "@shared/model";
import {
  ActorSeatId as ActorSeatIdSchema,
  type ActorSeatId,
} from "@shared/actor-seat";
import { InstallationId } from "@shared/installation-id";
import {
  Artifact,
  CheckResult,
  CompletionEvidence,
  FinishCriteria,
  Message,
  Task,
  resolveTaskAdmission,
  type Artifact as ArtifactValue,
  type Message as MessageValue,
  type Task as TaskValue,
  type TaskAdmission,
  type TaskState,
  type BoardTopic as BoardTopicValue,
  type BoardTopicView as BoardTopicViewValue,
  type BoardPost as BoardPostValue,
  type BoardAuthor as BoardAuthorValue,
  type PadGlance as PadGlanceValue,
  BoardTopic,
  BoardPost,
} from "@shared/work-model";
import {
  applyPatches,
  decodePad,
  emptyPad,
  type Pad,
  type PadEdge,
  type PadImage,
  type PadInk,
  type PadPin,
  type PadPost,
  type PadShape,
} from "@shared/pad";
import {
  WORK_SEAT_RECENT_OPS_COVERAGE,
  WORK_SEAT_RECENT_OP_DEFAULT_LIMIT,
  WORK_SEAT_RECENT_OP_MAX_LABEL_CHARS,
  WORK_SEAT_RECENT_OP_MAX_LIMIT,
  WorkSeatRecentOp,
  type WorkSeatRecentOp as WorkSeatRecentOpValue,
  type WorkSeatRecentOpsFeed,
} from "@shared/work-recent-ops";
import {
  ActorRef as ActorRefSchema,
  DisplayTimestamp,
  LogicalSequence,
  MessageAppendDestination as MessageAppendDestinationSchema,
  SinkRef,
  WORK_PROTOCOL,
  IntentFactBasis,
  WorkFact,
  WorkSha256,
  type ActorRef,
  type DeliveryReceipt,
  type DisplayTimestamp as DisplayTimestampValue,
  type FactBasis as FactBasisValue,
  type IntentFactBasis as IntentFactBasisValue,
  type LogicalSequence as LogicalSequenceValue,
  type MessageAppendDestination,
  type SinkRef as SinkRefValue,
  type WorkFact as WorkFactValue,
  type WorkItemRef,
  type WorkOperation,
  type WorkRecordId,
  type WorkRejectionReason,
  type WorkResult,
  type WorkSha256 as WorkSha256Value,
} from "@shared/work-protocol";
import {
  canTransitionTaskState,
  isTerminalTaskState,
  taskWithTransitionState,
} from "@shared/task";
import {
  collectContentRefsFromTask,
  taskContentPendingMessage,
  taskContentReadiness,
} from "@shared/content";
import {
  taskIndexById,
  taskIsClaimReady,
  validateTaskDependsOn,
} from "@shared/task-deps";
import {
  bodySha256Of,
} from "./body-sha256";
import {
  evaluateFinishCriteria,
  normalizeCompletionEvidence,
} from "@shared/finish-criteria";
import {
  normalizeRuleEvidence,
  TASK_APPROVED_METADATA_KEY,
  taskAdmissionState,
} from "@shared/rules";
import { StateTransactionOperation } from "../state/service";
import {
  inboundActorNodeIds,
  padAuthorRuleError,
  stampPadPatchAuthors,
} from "./pad-rules";
import { ContentManifest, ContentManifestError } from "../content/manifest";
import {
  mailboxMessageDeliveryId,
  mailboxMessageReactId,
  mailboxMessageReadId,
} from "./mailbox-receipts";
import {
  CrewRepository,
  CrewRepositoryLive,
  CrewRepositoryError,
  type ReviewReceiptInput,
} from "./crew-repository";
import { unjournaledWorkMutationEffect } from "./mutation-seam";
import {
  agentNodeForSeat,
  planCheckoutReceiptMail,
  planReceiptMail,
  receiptDedupeKey,
  receiptSourceForRecord,
  receiptSourceId,
  reviewAuthorSeat,
  reviewSubjectProjection,
  reviewsEdgeExists,
  reviewersOfAuthor,
} from "./reviews";
import {
  readMailExtension,
  type MailSenderStamp,
  type ReviewVerdict,
} from "../../../shared/crew";
import { ulid } from "ulid";

/** A receipt-mail record produced in a task-transition transaction. */
export type ReviewReceiptRecord = {
  readonly canvas: string;
  readonly nodeId: string;
  readonly message: MessageValue;
};

/**
 * Result of a live-validated verdict post: the stored verdict, or a typed
 * refusal the service maps without parsing a message.
 */
export type PostReviewVerdictResult =
  | { readonly verdict: ReviewVerdict; readonly created: boolean }
  | {
      readonly rejected:
        "reviewer-is-author" | "stale-subject" | "reviews-edge-missing";
    };
import { canonicalJson } from "./canonical-json";
import { taskReviewSubjectHash } from "./review-subject-hash";
import { WorkJournal, WorkJournalLive } from "./journal";

type WorkSqlFailure =
  | Error
  | SqlError.SqlError
  | Schema.SchemaError
  | Cause.UnknownError
  | WorkRepositoryError
  | WorkAuthorityError
  | WorkReplicationError
  | CrewRepositoryError
  | ContentManifestError
  | ModelError;

const LocalAuthorityRow = Schema.Struct({
  installation_id: Schema.String,
});
const ExistsRow = Schema.Struct({ "1": Schema.Number });
const ScopedTaskRow = Schema.Struct({
  node_id: Schema.String,
  task_id: Schema.String,
  state: Schema.Union([
    Schema.Literal("submitted"),
    Schema.Literal("working"),
    Schema.Literal("input-required"),
    Schema.Literal("completed"),
    Schema.Literal("canceled"),
    Schema.Literal("failed"),
    Schema.Literal("rejected"),
    Schema.Literal("auth-required"),
    Schema.Literal("archived"),
  ]),
  created_at: Schema.String,
  depends_on_task_id: Schema.Union([Schema.Null, Schema.String]),
  position: Schema.Union([Schema.Null, Schema.Number]),
});
const MessageRowSchema = Schema.Struct({
  message_id: Schema.String,
  role: Schema.Union([Schema.Literal("user"), Schema.Literal("agent")]),
  parts_json: Schema.String,
  task_id: Schema.Union([Schema.Null, Schema.String]),
  context_id: Schema.Union([Schema.Null, Schema.String]),
  reference_task_ids_json: Schema.Union([Schema.Null, Schema.String]),
  metadata_json: Schema.Union([Schema.Null, Schema.String]),
});
const ThreadMessageRow = Schema.Struct({
  message_id: Schema.String,
  role: Schema.Union([Schema.Literal("user"), Schema.Literal("agent")]),
  parts_json: Schema.String,
  task_id: Schema.Union([Schema.Null, Schema.String]),
  context_id: Schema.Union([Schema.Null, Schema.String]),
  reference_task_ids_json: Schema.Union([Schema.Null, Schema.String]),
  metadata_json: Schema.Union([Schema.Null, Schema.String]),
  item_id: Schema.String,
});
const TaskDependencyRow = Schema.Struct({
  task_id: Schema.String,
  depends_on_task_id: Schema.String,
});
const DependencyIdRow = Schema.Struct({ depends_on_task_id: Schema.String });
const TaskFinishRow = Schema.Struct({
  finish_criteria_json: Schema.Union([Schema.Null, Schema.String]),
  completion_evidence_json: Schema.Union([Schema.Null, Schema.String]),
});
const TaskFinishByIdRow = Schema.Struct({
  task_id: Schema.String,
  finish_criteria_json: Schema.Union([Schema.Null, Schema.String]),
  completion_evidence_json: Schema.Union([Schema.Null, Schema.String]),
});
const CanvasArtifactRow = Schema.Struct({
  node_id: Schema.String,
  artifact_id: Schema.String,
  actor_seat_id: Schema.Union([Schema.Null, Schema.String]),
  name: Schema.Union([Schema.Null, Schema.String]),
  parts_json: Schema.String,
  task_canvas_name: Schema.Union([Schema.Null, Schema.String]),
  task_node_id: Schema.Union([Schema.Null, Schema.String]),
  task_id: Schema.Union([Schema.Null, Schema.String]),
  metadata_json: Schema.Union([Schema.Null, Schema.String]),
});
const TaskVerdictRow = Schema.Struct({
  verdict_id: Schema.String,
  kind: Schema.Union([Schema.Literal("green"), Schema.Literal("blocking")]),
  reviewer_seat_id: ActorSeatIdSchema,
  reviewer_node_id: Schema.Union([Schema.Null, Schema.String]),
  author_seat_id: ActorSeatIdSchema,
  subject_task_installation: Schema.String,
  subject_task_item: Schema.String,
  subject_epoch: Schema.Number,
  subject_hash: Schema.String,
  epoch: Schema.Number,
  findings_json: Schema.String,
  refs_json: Schema.String,
  posted_at_ms: Schema.Number,
});
const TaskRowSchema = Schema.Struct({
  canvas_name: Schema.String,
  node_id: Schema.String,
  item_id: Schema.String,
  entity_home: Schema.String,
  actor_seat_id: Schema.Union([Schema.Null, Schema.String]),
  fact_event_home: Schema.String,
  fact_entity_home: Schema.String,
  fact_seq: Schema.String,
  state: Schema.Union([
    Schema.Literal("submitted"),
    Schema.Literal("working"),
    Schema.Literal("input-required"),
    Schema.Literal("completed"),
    Schema.Literal("canceled"),
    Schema.Literal("failed"),
    Schema.Literal("rejected"),
    Schema.Literal("auth-required"),
    Schema.Literal("archived"),
  ]),
  artifact_ids_json: Schema.Union([Schema.Null, Schema.String]),
  metadata_json: Schema.Union([Schema.Null, Schema.String]),
  reason: Schema.Union([Schema.Null, Schema.String]),
  response: Schema.Union([Schema.Null, Schema.String]),
  created_at: Schema.String,
  // Selected by the lane projection only; the single-task read leaves it out.
  origin_at: Schema.optionalKey(Schema.String),
});
const MessageReceiptRow = Schema.Struct({
  delivery_id: Schema.String,
  accepted_at: Schema.String,
});
const BoardPostRow = Schema.Struct({
  post_id: Schema.String,
  topic_id: Schema.String,
  position: Schema.Number,
  author_kind: Schema.String,
  author_seat_id: Schema.Union([Schema.Null, Schema.String]),
  author_node_id: Schema.Union([Schema.Null, Schema.String]),
  author_label: Schema.Union([Schema.Null, Schema.String]),
  parts_json: Schema.String,
  tags_json: Schema.Union([Schema.Null, Schema.String]),
  created_at: Schema.String,
});
const BoardCursorRow = Schema.Struct({
  topic_id: Schema.String,
  last_read_position: Schema.Number,
});
const BoardTopicRow = Schema.Struct({
  topic_id: Schema.String,
  title: Schema.String,
  state: Schema.String,
  author_kind: Schema.String,
  author_seat_id: Schema.Union([Schema.Null, Schema.String]),
  author_node_id: Schema.Union([Schema.Null, Schema.String]),
  author_label: Schema.Union([Schema.Null, Schema.String]),
  parts_json: Schema.String,
  post_count: Schema.Number,
  last_activity_at: Schema.String,
  created_at: Schema.String,
});
const ArtifactProjectionRow = Schema.Struct({
  artifact_id: Schema.String,
  name: Schema.Union([Schema.Null, Schema.String]),
  parts_json: Schema.String,
  task_canvas_name: Schema.Union([Schema.Null, Schema.String]),
  task_node_id: Schema.Union([Schema.Null, Schema.String]),
  task_id: Schema.Union([Schema.Null, Schema.String]),
  task_entity_home: Schema.Union([Schema.Null, Schema.String]),
  metadata_json: Schema.Union([Schema.Null, Schema.String]),
  actor_seat_id: Schema.Union([Schema.Null, Schema.String]),
});
const PadRevisionRow = Schema.Struct({ revision: Schema.Number });
const PadImageRow = Schema.Struct({
  element_id: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
  z: Schema.Number,
  ref_json: Schema.String,
});
const PadShapeRow = Schema.Struct({
  element_id: Schema.String,
  type: Schema.Union([
    Schema.Literal("box"),
    Schema.Literal("ellipse"),
    Schema.Literal("triangle"),
    Schema.Literal("label"),
  ]),
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
  z: Schema.Number,
  fill: Schema.Union([Schema.Null, Schema.String]),
  stroke: Schema.Union([Schema.Null, Schema.String]),
  text: Schema.Union([Schema.Null, Schema.String]),
  status: Schema.Union([
    Schema.Undefined,
    Schema.Null,
    Schema.Literal("none"),
    Schema.Literal("active"),
    Schema.Literal("done"),
    Schema.Literal("blocked"),
  ]),
});
const PadEdgeRow = Schema.Struct({
  element_id: Schema.String,
  from_id: Schema.String,
  to_id: Schema.String,
  from_side: Schema.Union([
    Schema.Undefined,
    Schema.Null,
    Schema.Literal("top"),
    Schema.Literal("right"),
    Schema.Literal("bottom"),
    Schema.Literal("left"),
  ]),
  to_side: Schema.Union([
    Schema.Undefined,
    Schema.Null,
    Schema.Literal("top"),
    Schema.Literal("right"),
    Schema.Literal("bottom"),
    Schema.Literal("left"),
  ]),
  label: Schema.Union([Schema.Null, Schema.String]),
});
const PadInkRow = Schema.Struct({
  element_id: Schema.String,
  z: Schema.Number,
  color: Schema.String,
  width: Schema.Number,
  points_json: Schema.String,
});
const PadPinRow = Schema.Struct({
  element_id: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  bounds_json: Schema.Union([Schema.Null, Schema.String]),
  mentions_json: Schema.String,
});
const PadPostRow = Schema.Struct({
  pin_id: Schema.String,
  post_id: Schema.String,
  position: Schema.Number,
  author_kind: Schema.Union([
    Schema.Literal("operator"),
    Schema.Literal("actor"),
  ]),
  author_seat_id: Schema.Union([Schema.Null, Schema.String]),
  author_node_id: Schema.Union([Schema.Null, Schema.String]),
  author_label: Schema.Union([Schema.Null, Schema.String]),
  parts_json: Schema.String,
});
const CountRow = Schema.Struct({ n: Schema.Number });
const PadElementIdRow = Schema.Struct({ element_id: Schema.String });
const PadPostIdRow = Schema.Struct({
  pin_id: Schema.String,
  post_id: Schema.String,
});
const RecentSeatOpRowSchema = Schema.Struct({
  operation: Schema.Union([
    Schema.Literal("task.claim"),
    Schema.Literal("request.create"),
    Schema.Literal("message.append"),
    Schema.Literal("artifact.publish"),
    Schema.Literal("delivery.accepted"),
    Schema.Literal("board.topic.create"),
    Schema.Literal("board.post.append"),
  ]),
  origin_at: Schema.String,
  applied_at: Schema.String,
  target_node_id: Schema.String,
  item_kind: Schema.Union([
    Schema.Literal("message"),
    Schema.Literal("task"),
    Schema.Literal("artifact"),
    Schema.Literal("request"),
    Schema.Literal("delivery"),
    Schema.Literal("topic"),
    Schema.Literal("post"),
    Schema.Literal("pad"),
  ]),
  item_id: Schema.String,
  summary_label: Schema.Union([Schema.Null, Schema.String]),
  related_kind: Schema.Union([
    Schema.Null,
    Schema.Literal("message"),
    Schema.Literal("task"),
    Schema.Literal("artifact"),
    Schema.Literal("request"),
    Schema.Literal("delivery"),
    Schema.Literal("topic"),
    Schema.Literal("post"),
    Schema.Literal("pad"),
  ]),
  related_id: Schema.Union([Schema.Null, Schema.String]),
  related_node_id: Schema.Union([Schema.Null, Schema.String]),
});
const WorkRevisionRow = Schema.Struct({ work_revision: Schema.String });
const IdentityRowSchema = Schema.Struct({
  entity_home: Schema.String,
  actor_seat_id: Schema.Union([Schema.Null, Schema.String]),
  fact_event_home: Schema.String,
  fact_entity_home: Schema.String,
  fact_seq: Schema.String,
  state: Schema.Union([
    Schema.Literal("submitted"),
    Schema.Literal("working"),
    Schema.Literal("input-required"),
    Schema.Literal("completed"),
    Schema.Literal("canceled"),
    Schema.Literal("failed"),
    Schema.Literal("rejected"),
    Schema.Literal("auth-required"),
    Schema.Literal("archived"),
  ]),
});
const NextOrdinalRow = Schema.Struct({ next_ordinal: Schema.Number });
const StoredTaskStateRow = Schema.Struct({
  created_at: Schema.String,
  state: Schema.String,
  metadata_json: Schema.Union([Schema.Null, Schema.String]),
  origin_at: Schema.String,
});
const NextPositionRow = Schema.Struct({ next_position: Schema.Number });
const TaskIdRow = Schema.Struct({ task_id: Schema.String });
const BoardStateRow = Schema.Struct({ state: Schema.String });
const MaxPositionRow = Schema.Struct({
  m: Schema.Union([Schema.Null, Schema.Number]),
});
const TaskClaimFactRowSchema = Schema.Struct({
  operation: Schema.Union([
    Schema.Literal("task.claim"),
    Schema.Literal("request.create"),
    Schema.Literal("message.append"),
    Schema.Literal("artifact.publish"),
    Schema.Literal("delivery.accepted"),
    Schema.Literal("board.topic.create"),
    Schema.Literal("board.post.append"),
    Schema.Literal("task.create"),
    Schema.Literal("task.describe"),
    Schema.Literal("task.transition"),
    Schema.Literal("request.resolve"),
    Schema.Literal("pad.patch"),
  ]),
  predecessor_event_home: Schema.Union([Schema.Null, Schema.String]),
  predecessor_entity_home: Schema.Union([Schema.Null, Schema.String]),
  predecessor_seq: Schema.Union([Schema.Null, Schema.String]),
  boundary_message_id: Schema.Union([Schema.Null, Schema.String]),
  boundary_index: Schema.Union([Schema.Null, Schema.Number]),
  replaced_brief_message_id: Schema.Union([Schema.Null, Schema.String]),
  claimed_actor_seat_id: Schema.Union([Schema.Null, Schema.String]),
});
const AcceptedAtRow = Schema.Struct({ accepted_at: Schema.String });
const TotalChangesRow = Schema.Struct({
  total_changes: Schema.Union([Schema.Number, Schema.BigInt]),
});
const ReviewReceiptKeyRow = Schema.Struct({
  ref_sha: Schema.String,
  reviewer_seat_id: Schema.String,
});
const ReviewAuthorRow = Schema.Struct({ author_seat_id: Schema.String });
const VerdictIdRow = Schema.Struct({ verdict_id: Schema.String });
const ArtifactRowSchema = Schema.Struct({
  artifact_id: Schema.String,
  name: Schema.Union([Schema.Null, Schema.String]),
  parts_json: Schema.String,
  task_canvas_name: Schema.Union([Schema.Null, Schema.String]),
  task_node_id: Schema.Union([Schema.Null, Schema.String]),
  task_id: Schema.Union([Schema.Null, Schema.String]),
  task_entity_home: Schema.Union([Schema.Null, Schema.String]),
  metadata_json: Schema.Union([Schema.Null, Schema.String]),
});

const WorkSqlBindings = Schema.Array(
  Schema.Union([Schema.String, Schema.Number, Schema.BigInt, Schema.Null]),
);
const WorkRunResult = Schema.Struct({
  changes: Schema.Union([Schema.Number, Schema.BigInt]),
  lastInsertRowid: Schema.Union([Schema.Number, Schema.BigInt]),
});

const strictDecode = { onExcessProperty: "error" } as const;

const MAX_TASK_DEPENDENCY_SCOPE_NODE_IDS = 256;

declare const TaskDependencyScopeCapabilityTypeId: unique symbol;

/**
 * Frozen process-local authority for one exact authenticated intent topology.
 * The handle has no fields. Runtime authority is only the private WeakMap.
 */
export type TaskDependencyScopeCapability = {
  readonly [TaskDependencyScopeCapabilityTypeId]: true;
};

type TaskTopologyAuthorityMode =
  "canvas-current";

type TaskActorGrant = {
  readonly actorNodeId: string;
  readonly grants: ReadonlyArray<"tasks.create" | "tasks.claim">;
};

type TaskDependencyScopeCapabilityData = {
  readonly mode: TaskTopologyAuthorityMode;
  readonly basis: IntentFactBasisValue;
  readonly authoringSink: SinkRefValue;
  /** Hash of the exact raw canvas body containing the authoring sink. */
  readonly canvasBodySha256: string;
  readonly allowedTaskSinkNodeIds: ReadonlyArray<string>;
  readonly sinkAdmissionFloor: TaskAdmission;
  readonly sinkHostId: string;
  readonly actorGrants: ReadonlyArray<TaskActorGrant>;
};

const taskDependencyScopeCapabilities = new WeakMap<
  object,
  TaskDependencyScopeCapabilityData
>();

const freezeCapabilityInput = <A>(
  value: A,
  seen = new WeakSet<object>(),
): A => {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) {
    freezeCapabilityInput(child, seen);
  }
  return Object.freeze(value);
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const topologyTypeError = (message: string): never => {
  throw new TypeError(`Task topology authority is invalid: ${message}`);
};

const canonicalTaskTopologyIndex = (canvas: Canvas, authoringSink: SinkRefValue) => {
  if (canvas.name !== authoringSink.canvasName) return topologyTypeError("sink names a different canvas");
  const nodes = new Map([...canvas.nodes].map(([id, input]) => {
    const node = Schema.decodeUnknownSync(Node, strictDecode)(structuredClone(input));
    if (id !== node.id) return topologyTypeError("node map key differs from its id");
    return [id, node] as const;
  }));
  const wires = [...canvas.wires].map(([id, input]) => {
    const wire = Schema.decodeUnknownSync(Wire, strictDecode)(structuredClone(input));
    if (id !== wire.id || !nodes.has(wire.from) || !nodes.has(wire.to)) return topologyTypeError("wire identity or endpoint is missing");
    return wire;
  });
  const sink = nodes.get(asNodeId(authoringSink.nodeId));
  if (sink?.kind !== "task") return topologyTypeError("authoring sink is not a task board");
  const regions = modelRegionStack({ ...canvas, nodes }, sink.id);
  const contains = (outer: { x: number; y: number; width: number; height: number }, inner: typeof outer) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  for (let index = 1; index < regions.length; index++) if (!contains(regions[index - 1]!, regions[index]!) || contains(regions[index]!, regions[index - 1]!))
    return topologyTypeError("task board is inside ambiguous overlapping regions");
  const region = regions.at(-1);
  const allowedTaskSinkNodeIds = [...nodes.values()].filter((node) => node.kind === "task" && (region === undefined || contains(region, node))).map((node) => node.id).sort(compareCodeUnits);
  if (allowedTaskSinkNodeIds.length > MAX_TASK_DEPENDENCY_SCOPE_NODE_IDS) throw new RangeError("Task topology contains too many task boards");
  const kinds = wireKinds(nodes.values());
  const grants = new Map<string, Set<"tasks.create" | "tasks.claim">>();
  for (const wire of wires) {
    const actor = wire.from === sink.id ? wire.to : wire.to === sink.id ? wire.from : undefined;
    if (actor === undefined || nodes.get(actor)?.kind !== "agent") continue;
    const grant = wireGrant(wire, kinds);
    if (!grant) continue;
    const held = grants.get(actor) ?? new Set<"tasks.create" | "tasks.claim">();
    for (const port of ["tasks.create", "tasks.claim"] as const) if (grant.ports.includes(port)) held.add(port);
    if (held.size) grants.set(actor, held);
  }
  return {
    allowedTaskSinkNodeIds: Object.freeze(allowedTaskSinkNodeIds),
    sinkAdmissionFloor: resolveTaskAdmission(sink.contract),
    sinkHostId: "local",
    actorGrants: Object.freeze([...grants].sort(([a], [b]) => compareCodeUnits(a, b)).map(([actorNodeId, held]) => Object.freeze({ actorNodeId, grants: Object.freeze([...held].sort(compareCodeUnits)) }))),
  };
};

const mintTaskDependencyScopeCapability = (input: {
  readonly mode: TaskTopologyAuthorityMode;
  readonly basis: IntentFactBasisValue;
  readonly authoringSink: SinkRefValue;
  readonly canvas: Canvas;
  readonly rawCanvasBody?: string;
}): TaskDependencyScopeCapability => {
  const basis = freezeCapabilityInput(
    Schema.decodeUnknownSync(
      IntentFactBasis,
      strictDecode,
    )(structuredClone(input.basis)),
  );
  const authoringSink = freezeCapabilityInput(
    Schema.decodeUnknownSync(
      SinkRef,
      strictDecode,
    )(structuredClone(input.authoringSink)),
  );
  const index = canonicalTaskTopologyIndex(input.canvas, authoringSink);
  const capability = Object.freeze(
    Object.create(null) as object,
  ) as TaskDependencyScopeCapability;
  taskDependencyScopeCapabilities.set(
    capability,
    Object.freeze({
      mode: input.mode,
      basis,
      authoringSink,
      canvasBodySha256: input.rawCanvasBody === undefined ? "" : bodySha256Of(input.rawCanvasBody),
      ...index,
    }),
  );
  return capability;
};

/** Mint task admission from the exact model sequence the policy read. */
export const createCanvasTaskDependencyScopeCapability = (input: {
  readonly canvas: Canvas;
  readonly authoringSink: SinkRefValue;
}): TaskDependencyScopeCapability => mintTaskDependencyScopeCapability({
  mode: "canvas-current",
  basis: { kind: "canvas", canvasName: input.canvas.name, seq: input.canvas.seq },
  authoringSink: input.authoringSink,
  canvas: input.canvas,
});

const inspectTaskDependencyScopeCapability = (
  sink: SinkRefValue,
  capability: TaskDependencyScopeCapability | undefined,
): TaskDependencyScopeCapabilityData | undefined => {
  const inspected =
    capability === undefined
      ? undefined
      : taskDependencyScopeCapabilities.get(capability as object);
  return inspected !== undefined &&
    inspected.authoringSink.canvasName === sink.canvasName &&
    inspected.authoringSink.nodeId === sink.nodeId
    ? inspected
    : undefined;
};

const now = (): DisplayTimestampValue =>
  Schema.decodeUnknownSync(DisplayTimestamp)(new Date().toISOString());

const timestamp = (value: string | undefined): DisplayTimestampValue =>
  Schema.decodeUnknownSync(DisplayTimestamp)(value ?? now());

const sequence = (value: string): LogicalSequenceValue =>
  Schema.decodeUnknownSync(LogicalSequence)(value);

const sha256 = (value: string): WorkSha256Value =>
  Schema.decodeUnknownSync(WorkSha256)(
    createHash("sha256").update(value, "utf8").digest("hex"),
  );

/**
 * Hash only the semantic record. `originAt` is display metadata and
 * `contentSha256` is the resulting digest, so neither participates.
 */
export const workRecordContentSha256 = (
  record: WorkRecordSemantic,
): WorkSha256Value => {
  if (record.basis.kind === "historical") {
    throw new Error("historical Work hashes are retained provenance and cannot be recomputed");
  }
  return sha256(canonicalJson(record));
};

type WorkRecordSemantic = Omit<WorkFactValue, "contentSha256" | "originAt">;

const recordWithHash = (
  semantic: WorkRecordSemantic,
  originAt: DisplayTimestampValue,
): WorkFactValue => {
  const candidate = {
    ...semantic,
    contentSha256: workRecordContentSha256(semantic),
    originAt,
  };
  return Schema.decodeUnknownSync(WorkFact, strictDecode)(candidate);
};

/** Force every seed post author to the admitted writer (anti-forgery). */
const topicWithBoundAuthors = (
  topic: BoardTopicValue,
  createdBy: BoardAuthorValue,
): BoardTopicValue => {
  const posts = topic.posts?.map((post) => ({
    ...post,
    author: createdBy,
  }));
  return {
    ...topic,
    openedBy: createdBy,
    ...(posts === undefined ? {} : { posts }),
  };
};

const item = (
  kind: WorkItemRef["kind"],
  itemId: string,
  sink: SinkRefValue,
): WorkItemRef => ({ kind, itemId, sink });

const recordId = (
  eventHome: InstallationId,
  entityHome: InstallationId,
  seq: string,
): WorkRecordId => ({
  route: { eventHome, entityHome },
  seq: sequence(seq),
});

export class WorkRepositoryError extends Schema.TaggedError<WorkRepositoryError>()(
  "WorkRepositoryError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class WorkAuthorityError extends Schema.TaggedError<WorkAuthorityError>()(
  "WorkAuthorityError",
  {
    reason: Schema.Literals([
      "authority-mismatch",
      "causal-conflict",
      "claim-contention",
      "identity-conflict",
      "invalid-transition",
      "missing-entity",
      "target-mismatch",
    ]),
    message: Schema.String,
  },
) {}

export class WorkReplicationError extends Schema.TaggedError<WorkReplicationError>()(
  "WorkReplicationError",
  {
    reason: Schema.Literals([
      "direction-mismatch",
      "integrity",
      "identity-conflict",
      "causal-conflict",
      "cursor-regression",
      "sequence-gap",
      "response-capacity",
    ]),
    senderInstallationId: Schema.String,
    sequence: Schema.optionalKey(LogicalSequence),
    message: Schema.String,
  },
) {}

type RepositoryFailure = WorkRepositoryError | WorkAuthorityError;

export type WorkRepositoryInput = {
  readonly sink: SinkRefValue;
  readonly originAt?: string;
  readonly receivedAt?: string;
};

export type LocalWorkInput = WorkRepositoryInput & {
  readonly basis: IntentFactBasisValue;
  readonly dependencyScope?: TaskDependencyScopeCapability;
};

export type CreateTaskInput = Omit<LocalWorkInput, "dependencyScope"> & {
  readonly dependencyScope: TaskDependencyScopeCapability;
  readonly task: TaskValue;
};

export type DescribeTaskInput = LocalWorkInput & {
  readonly taskId: string;
  readonly message: MessageValue;
};

export type TransitionTaskInput = LocalWorkInput & {
  readonly taskId: string;
  readonly state: TaskState;
  readonly message?: MessageValue;
  readonly completionEvidence?: TaskValue["completionEvidence"];
  /**
   * Task-record patch computed by the pure policy (visit exits, epoch bumps).
   * Omitted fields keep the durable row's bag; null clears a field.
   */
  readonly taskPatch?: TaskRecordPatch;
  /**
   * Writer-time review gate for a completion. When present and the transition
   * is to `completed`, the transaction refuses unless a distinct eligible
   * reviewer's latest verdict on this exact epoch + subject hash is green.
   */
  readonly reviewGate?: ReviewGateWithin;
  /**
   * Author stamp for the receipt feed. When present, receipt mail for the
   * committed task's commit refs is minted to the author's current reviewers in
   * the same transaction; the created records come back in
   * `LocalFactResult.reviewReceipts`.
   */
  readonly receiptAuthor?: MailSenderStamp;
};

/** The exact identity a writer-time review gate is evaluated against. */
export type ReviewGateWithin = {
  readonly installationId: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly epoch: number;
  readonly subjectHash: string;
  readonly excludingSeatId: string;
};

export type TaskRecordPatch = {
  readonly epoch?: number;
  readonly visits?: TaskValue["visits"];
  readonly defects?: TaskValue["defects"];
  readonly waitUntil?: string | null;
  readonly checkResults?: TaskValue["checkResults"] | null;
  /** Operator approval marker for the given epoch (metadata bag key). */
  readonly approvedEpoch?: number | null;
  /**
   * Omitted: keep the durable row's admission / raisedBy (passthrough).
   * Set: write through. admission null clears (re-home). raisedBy is
   * identity — no null clear.
   */
  readonly admission?: TaskValue["admission"] | null;
  readonly raisedBy?: TaskValue["raisedBy"];
};

export type SendOnTaskInput = LocalWorkInput & {
  readonly taskId: string;
  /** Handoff note appended at the source before completion. */
  readonly message?: MessageValue;
  readonly completionEvidence?: TaskValue["completionEvidence"];
  /** Closed visits including the source visit exit (policy-computed). */
  readonly visits: NonNullable<TaskValue["visits"]>;
  readonly next: SinkRefValue;
  /** Policy-built submitted successor at the next board (same task id). */
  readonly nextTask: TaskValue;
  /**
   * Writer-time review gate for the complete-here step of a send-on. Same
   * contract as {@link TransitionTaskInput.reviewGate}: refuses in-transaction
   * unless a distinct eligible reviewer's latest verdict on this exact epoch and
   * subject hash is green.
   */
  readonly reviewGate?: ReviewGateWithin;
  /** Author stamp for the receipt feed (see {@link TransitionTaskInput.receiptAuthor}). */
  readonly receiptAuthor?: MailSenderStamp;
};

export type SendBackTaskInput = LocalWorkInput & {
  readonly taskId: string;
  /** Defect note appended at the rejecting board. */
  readonly message?: MessageValue;
  /** Closed visits including the sent-back exit (policy-computed). */
  readonly visits: NonNullable<TaskValue["visits"]>;
  /** Append-only defect log including this defect (policy-computed). */
  readonly defects?: NonNullable<TaskValue["defects"]>;
  /** The visited board the defect re-opens (any prior visit, not only the last). */
  readonly target: SinkRefValue;
  /** Policy-built submitted epoch-bumped task re-homed at `target`. */
  readonly sentBackTask: TaskValue;
  /**
   * Blocking review, written in the SAME transaction as the send-back so the
   * rejection and the immutable verdict (and its optional receipt) commit
   * atomically. The verdict is bound to the epoch it judged; the send-back
   * bumps the epoch, so a stale concurrent verdict cannot bless the new one.
   */
  readonly review?: {
    readonly verdict: ReviewVerdict;
    readonly receipt?: ReviewReceiptInput;
  };
};

/** Operator approval of a task waiting at an `approval`-admission board. */
export type PromoteTaskInput = LocalWorkInput & {
  readonly taskId: string;
  /** Operator context appended to the task thread before the admission stamp. */
  readonly message?: MessageValue;
};

/** Agent-submitted check runs stamped as current-epoch CheckResults. */
export type RecordCheckResultsInput = LocalWorkInput & {
  readonly taskId: string;
  /**
   * Newly recorded results from this call only. Merged against the live row
   * inside recordCheckResults's own transaction — never a caller-held
   * snapshot — so two concurrent check runs (e.g. for two different
   * destinations) can't silently drop one set of results.
   */
  readonly results: NonNullable<TaskValue["checkResults"]>;
};

export type SendOnTaskValue = {
  readonly completed: TaskValue;
  readonly next: TaskValue;
};

export type SendBackTaskValue = {
  readonly rejected: TaskValue;
  readonly sentBack: TaskValue;
};

export type ClaimLocalTaskInput = Omit<LocalWorkInput, "dependencyScope"> & {
  readonly dependencyScope: TaskDependencyScopeCapability;
  readonly taskId: string;
  readonly actor: ActorRef;
};

export type CreateRequestInput = LocalWorkInput & {
  readonly request: TaskValue;
  readonly raisedBy: ActorRef;
};

export type ResolveRequestInput = LocalWorkInput & {
  readonly requestId: string;
  readonly response: string;
  readonly disposition: "completed" | "rejected";
  readonly message?: MessageValue;
};

export type AppendMessageInput = LocalWorkInput & {
  readonly message: MessageValue;
  readonly sentBy: ActorRef;
  readonly destination: MessageAppendDestination;
};

export type PublishArtifactInput = LocalWorkInput & {
  readonly artifact: ArtifactValue;
  readonly publishedBy: ActorRef;
};

export type AcceptDeliveryInput = LocalWorkInput & {
  readonly receipt: DeliveryReceipt;
};

export type CreateBoardTopicInput = LocalWorkInput & {
  readonly topic: BoardTopicValue;
  readonly createdBy: BoardAuthorValue;
};

export type AppendBoardPostInput = LocalWorkInput & {
  readonly post: BoardPostValue;
  readonly createdBy: BoardAuthorValue;
};

export type ApplyPadPatchInput = LocalWorkInput & {
  readonly patchId: string;
  readonly patches: ReadonlyArray<import("@shared/pad").PadPatch>;
  readonly author: BoardAuthorValue;
  /** Live overseer: ink/image admitted without operator impersonation. */
  readonly overseer?: boolean;
};

export type LocalFactResult<A> = {
  readonly value: A;
  readonly record: WorkFactValue;
  /**
   * Receipt mail minted in the same transaction as a task transition (see
   * `receiptAuthor`). The caller notifies delivery for each record AFTER the
   * commit succeeds; a rolled-back transaction returns none.
   */
  readonly reviewReceipts?: ReadonlyArray<ReviewReceiptRecord>;
};

export type WorkCommandAuthorization =
  | {
      readonly _tag: "admitted";
      /** Captured current/retained server scope; process-local, never wire data. */
      readonly taskDependencyScope?: TaskDependencyScopeCapability;
    }
  | {
      readonly _tag: "rejected";
      readonly reason: WorkRejectionReason;
      readonly message: string;
    };

type RecentSeatOpRow = {
  readonly operation: WorkSeatRecentOpValue["operation"];
  readonly origin_at: string;
  readonly applied_at: string;
  readonly target_node_id: string;
  readonly item_kind: WorkItemRef["kind"];
  readonly item_id: string;
  readonly summary_label: string | null;
  readonly related_kind: WorkItemRef["kind"] | null;
  readonly related_id: string | null;
  readonly related_node_id: string | null;
};

type TaskRow = {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly item_id: string;
  readonly entity_home: string;
  readonly actor_seat_id: string | null;
  readonly fact_event_home: string;
  readonly fact_entity_home: string;
  readonly fact_seq: string;
  readonly state: TaskState;
  readonly artifact_ids_json: string | null;
  readonly metadata_json: string | null;
  readonly reason: string | null;
  readonly response: string | null;
  readonly created_at: string;
  /** Selected by the lane loaders only: the projection's stateSince fallback. */
  readonly origin_at?: string;
};

type MessageRow = {
  readonly message_id: string;
  readonly role: MessageValue["role"];
  readonly parts_json: string;
  readonly task_id: string | null;
  readonly context_id: string | null;
  readonly reference_task_ids_json: string | null;
  readonly metadata_json: string | null;
};

type IdentityRow = {
  readonly entity_home: string;
  readonly actor_seat_id: string | null;
  readonly fact_event_home: string;
  readonly fact_entity_home: string;
  readonly fact_seq: string;
  readonly state: TaskState;
};

type LocalWorkAuthority = {
  readonly installationId: InstallationId;
};

/**
 * Resolve the identity every locally initiated Work mutation is minted under,
 * inside its transaction.
 */
const canonicalLocalWorkAuthority = Effect.fn(
  "work.canonicalLocalWorkAuthority",
)(function* (
  reader: SqlClient.SqlClient,
): Effect.fn.Return<LocalWorkAuthority, WorkSqlFailure> {
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: LocalAuthorityRow,
    execute: () =>
      reader.unsafe(`
      SELECT installation_id
      FROM station_installation
      WHERE singleton = 1
    `),
  })(undefined).pipe(Effect.map(Option.getOrUndefined));
  if (row === undefined) {
    return yield* Effect.fail(
      WorkAuthorityError.make({
        reason: "authority-mismatch",
        message: "this installation has no identity yet",
      }),
    );
  }
  return {
    installationId: yield* Schema.decodeUnknownEffect(InstallationId)(
      row.installation_id,
    ),
  };
});

/**
 * Reassert the exact intent snapshot captured by WorkService inside the same
 * SQLite transaction that will materialize the fact. This closes the
 * read/policy/write race without turning current intent into a retroactive
 * validator for already committed historical facts.
 */
const assertCurrentIntentBasis = Effect.fn("work.assertCurrentIntentBasis")(
  function* (
    reader: SqlClient.SqlClient,
    sink: SinkRefValue,
    basis: IntentFactBasisValue,
  ): Effect.fn.Return<void, WorkSqlFailure> {
    if (basis.kind !== "canvas" || basis.canvasName !== sink.canvasName) return yield* Effect.fail(authorityError("authority-mismatch", "local Work requires this canvas basis"));
    const current = yield* reader.unsafe<{ seq: number }>("SELECT seq FROM canvases WHERE canvas_name = ?", [basis.canvasName]);
    if (current[0]?.seq !== basis.seq) return yield* Effect.fail(authorityError("causal-conflict", "canvas changed before the Work mutation committed"));
  },
);

const MAX_TASK_DEPENDENCY_IDS = 256;

const sameIntentBasis = (left: IntentFactBasisValue, right: IntentFactBasisValue): boolean =>
  left.canvasName === right.canvasName && left.seq === right.seq;

const assertCanonicalDependsOn = (
  dependsOn: ReadonlyArray<string> | undefined,
): void => {
  if (dependsOn === undefined) return;
  if (!Array.isArray(dependsOn)) {
    throw authorityError(
      "invalid-transition",
      "dependsOn must be an array of canonical Task ids",
    );
  }
  if (dependsOn.length > MAX_TASK_DEPENDENCY_IDS) {
    throw authorityError(
      "invalid-transition",
      `dependsOn contains ${dependsOn.length} Task ids; maximum is ${MAX_TASK_DEPENDENCY_IDS}`,
    );
  }
  const seen = new Set<string>();
  for (const value of dependsOn as ReadonlyArray<unknown>) {
    if (typeof value !== "string" || value.length === 0) {
      throw authorityError(
        "invalid-transition",
        "dependsOn entries must be non-empty canonical Task ids",
      );
    }
    if (value !== value.trim()) {
      throw authorityError(
        "invalid-transition",
        `dependsOn task id ${JSON.stringify(value)} is not canonical`,
      );
    }
    if (value.length > 256) {
      throw authorityError(
        "invalid-transition",
        `dependsOn task id ${JSON.stringify(value.slice(0, 32))} is too long`,
      );
    }
    if (seen.has(value)) {
      throw authorityError(
        "invalid-transition",
        `dependsOn contains duplicate task ${JSON.stringify(value)}`,
      );
    }
    seen.add(value);
  }
};

const requireDependencyCapability = (
  sink: SinkRefValue,
  capability: TaskDependencyScopeCapability | undefined,
): TaskDependencyScopeCapabilityData => {
  const inspected = inspectTaskDependencyScopeCapability(sink, capability);
  if (inspected === undefined) {
    throw authorityError(
      "authority-mismatch",
      "Task topology requires an authentic process-local capability for the exact canvas and sink",
    );
  }
  return inspected;
};

const assertCanvasCapabilityCurrent = Effect.fn("work.assertCanvasCapabilityCurrent")(function* (
  reader: SqlClient.SqlClient, data: TaskDependencyScopeCapabilityData,
): Effect.fn.Return<void, WorkSqlFailure> {
  if (data.mode !== "canvas-current" || data.basis.kind !== "canvas") return yield* Effect.fail(authorityError("authority-mismatch", "task topology needs a current canvas"));
  const current = yield* reader.unsafe<{ seq: number }>("SELECT seq FROM canvases WHERE canvas_name = ?", [data.authoringSink.canvasName]);
  if (data.basis.canvasName !== data.authoringSink.canvasName || current[0]?.seq !== data.basis.seq) return yield* Effect.fail(authorityError("causal-conflict", "task topology changed before commit"));
});

const localDependencyCapability = Effect.fn("work.localDependencyCapability")(
  function* (
    reader: SqlClient.SqlClient,
    sink: SinkRefValue,
    basis: IntentFactBasisValue,
    dependsOn: ReadonlyArray<string> | undefined,
    capability: TaskDependencyScopeCapability | undefined,
  ): Effect.fn.Return<
    TaskDependencyScopeCapabilityData,
    WorkSqlFailure,
    ModelRecords
  > {
    yield* Effect.try(assertCanonicalDependsOn.bind(undefined, dependsOn));
    yield* assertCurrentIntentBasis(reader, sink, basis);
    const inspected = yield* Effect.try(
      requireDependencyCapability.bind(undefined, sink, capability),
    );
    if (!sameIntentBasis(inspected.basis, basis)) {
      return yield* Effect.fail(
        authorityError(
          "authority-mismatch",
          "Task topology capability does not name the exact local intent basis",
        ),
      );
    }
    yield* assertCanvasCapabilityCurrent(reader, inspected);
    return inspected;
  },
);

/** Minimal dependency graph read: no Task history, finish, media, or metadata. */
const scopedTaskIndex = Effect.fn("work.scopedTaskIndex")(function* (
  reader: SqlClient.SqlClient,
  canvasName: string,
  allowedTaskSinkNodeIds: ReadonlyArray<string>,
): Effect.fn.Return<Map<string, TaskValue>, WorkSqlFailure> {
  if (allowedTaskSinkNodeIds.length === 0) return new Map();
  const placeholders = allowedTaskSinkNodeIds.map(() => "?").join(", ");
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: ScopedTaskRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT
        task.node_id,
        task.task_id,
        task.state,
        task.created_at,
        dependency.depends_on_task_id,
        dependency.position
      FROM work_tasks AS task
      LEFT JOIN work_task_dependencies AS dependency
        ON dependency.canvas_name = task.canvas_name
        AND dependency.node_id = task.node_id
        AND dependency.task_id = task.task_id
      WHERE task.canvas_name = ?
        AND task.node_id IN (${placeholders})
      ORDER BY
        task.node_id,
        task.created_at,
        task.task_id,
        dependency.position,
        dependency.depends_on_task_id
    `,
        bindings,
      ),
  })([canvasName, ...allowedTaskSinkNodeIds]);
  const tasks: TaskValue[] = [];
  let currentKey: string | undefined;
  let current:
    | {
        readonly id: string;
        readonly state: TaskState;
        readonly history: [];
        readonly dependsOn: string[];
      }
    | undefined;
  for (const row of rows) {
    const key = `${row.node_id}\u0000${row.task_id}`;
    if (key !== currentKey) {
      if (current !== undefined) {
        tasks.push({
          id: current.id,
          state: current.state,
          history: current.history,
          ...(current.dependsOn.length === 0
            ? {}
            : { dependsOn: current.dependsOn }),
        });
      }
      currentKey = key;
      current = {
        id: row.task_id,
        state: row.state,
        history: [],
        dependsOn: [],
      };
    }
    if (row.depends_on_task_id !== null) {
      current!.dependsOn.push(row.depends_on_task_id);
    }
  }
  if (current !== undefined) {
    tasks.push({
      id: current.id,
      state: current.state,
      history: current.history,
      ...(current.dependsOn.length === 0
        ? {}
        : { dependsOn: current.dependsOn }),
    });
  }
  return taskIndexById(tasks);
});

const assertTaskDependenciesInLocalScope = Effect.fn(
  "work.assertTaskDependenciesInLocalScope",
)(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  basis: IntentFactBasisValue,
  taskId: string,
  dependsOn: ReadonlyArray<string> | undefined,
  capability: TaskDependencyScopeCapability | undefined,
): Effect.fn.Return<void, WorkSqlFailure, ModelRecords> {
  const inspected = yield* localDependencyCapability(
    reader,
    sink,
    basis,
    dependsOn,
    capability,
  );
  const error = validateTaskDependsOn({
    taskId,
    dependsOn,
    byId: yield* scopedTaskIndex(
      reader,
      sink.canvasName,
      inspected?.allowedTaskSinkNodeIds ?? [],
    ),
  });
  if (error !== undefined) {
    return yield* Effect.fail(authorityError("invalid-transition", error));
  }
});

const assertTaskClaimReady = Effect.fn("work.assertTaskClaimReady")(function* (
  reader: SqlClient.SqlClient,
  task: TaskValue,
  sink: SinkRefValue,
  basis: IntentFactBasisValue,
  capability: TaskDependencyScopeCapability,
): Effect.fn.Return<void, WorkSqlFailure, ModelRecords | ContentManifest> {
  const inspected = yield* localDependencyCapability(
    reader,
    sink,
    basis,
    task.dependsOn,
    capability,
  );
  if (
    !taskIsClaimReady(
      task,
      yield* scopedTaskIndex(
        reader,
        sink.canvasName,
        inspected.allowedTaskSinkNodeIds,
      ),
    )
  ) {
    return yield* Effect.fail(
      authorityError(
        "invalid-transition",
        `task "${task.id}" is not claim-ready (unsatisfied dependsOn)`,
      ),
    );
  }
  const manifest = yield* ContentManifest;
  const availability = new Map<
    string,
    import("@shared/content").ContentAvailability
  >();
  for (const ref of collectContentRefsFromTask(task)) {
    availability.set(
      `${ref.sha256}:${ref.byteLength}`,
      yield* manifest.manifestAvailability(ref),
    );
  }
  const content = taskContentReadiness(task, (ref) =>
    availability.get(`${ref.sha256}:${ref.byteLength}`)!,
  );
  if (content.kind === "pending") {
    return yield* Effect.fail(
      authorityError(
        "invalid-transition",
        taskContentPendingMessage(task.id, content),
      ),
    );
  }
});

const assertCanonicalWaitUntil = (
  task: Pick<TaskValue, "id" | "waitUntil">,
): void => {
  if (task.waitUntil === undefined) return;
  const milliseconds = Date.parse(task.waitUntil);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== task.waitUntil
  ) {
    throw authorityError(
      "invalid-transition",
      `task ${JSON.stringify(task.id)} has a noncanonical waitUntil`,
    );
  }
};

/** Recheck admission and wait against the exact capability topology. */
const assertTaskAdmissionReady = (
  task: TaskValue,
  sink: SinkRefValue,
  capability: TaskDependencyScopeCapability,
): void => {
  assertCanonicalWaitUntil(task);
  const inspected = requireDependencyCapability(sink, capability);
  const contract =
    inspected.sinkAdmissionFloor === "auto"
      ? undefined
      : { incoming: { admission: inspected.sinkAdmissionFloor } };
  const admission = taskAdmissionState(task, contract, Date.now());
  switch (admission) {
    case "claimable":
      return;
    case "operator":
      throw authorityError(
        "claim-contention",
        `board ${JSON.stringify(sink.nodeId)} is set to Me; no agent may claim its Tasks`,
      );
    case "approval":
      throw authorityError(
        "invalid-transition",
        `task ${JSON.stringify(task.id)} awaits operator approval at sink ${JSON.stringify(sink.nodeId)}`,
      );
    case "waiting":
      throw authorityError(
        "invalid-transition",
        `task ${JSON.stringify(task.id)} is not claimable before ${task.waitUntil ?? "its durable wait expires"}`,
      );
  }
};

/** Factory-card glance is the operator's unread pins. */
const PAD_GLANCE_PRINCIPAL_KEY = "operator";

/**
 * Inbound-actor roster for the sinks of ONE version of ONE canvas document.
 *
 * `byNode` is filled lazily — a sink nobody patches never costs a lookup —
 * and `doc` is retained so the second sink in the same document version is a
 * Map hit rather than a second decode.
 */
const readModelCanvas = Effect.fn("work.readModelCanvas")(function* (canvasName: string): Effect.fn.Return<Canvas | undefined, WorkSqlFailure, ModelRecords> {
  const records = yield* ModelRecords;
  const header = yield* records.getCanvas(canvasName);
  if (!header) return undefined;
  const nodes = yield* records.listNodes(canvasName);
  const wires = yield* records.listWires(canvasName);
  return { name: asCanvasName(canvasName), seq: header.seq, nodes: new Map(nodes.map((node) => [node.id, node])), wires: new Map(wires.map((wire) => [wire.id, wire])) };
});

const readReviewCanvas = Effect.fn("work.readReviewCanvas")(function* (reader: SqlClient.SqlClient, canvasName: string): Effect.fn.Return<{ doc: Canvas | undefined; actorRefs: ReadonlyArray<ActorRef> }, WorkSqlFailure, ModelRecords> {
  const doc = yield* readModelCanvas(canvasName);
  if (!doc) return { doc, actorRefs: [] };
  const authority = yield* canonicalLocalWorkAuthority(reader);
  const local = yield* reader.unsafe<{ host_id: string }>("SELECT host_id FROM station_configuration WHERE singleton = 1");
  const placements = yield* reader.unsafe<{ host_id: string; station_installation_id: string }>("SELECT host_id,station_installation_id FROM station_fleet_targets WHERE retired_at IS NULL");
  const installations = new Map(placements.map((row) => [row.host_id, row.station_installation_id as InstallationId]));
  installations.set("local", authority.installationId);
  if (local[0]) installations.set(local[0].host_id, authority.installationId);
  const actorRefs: ActorRef[] = [];
  for (const node of doc.nodes.values()) {
    if (node.kind !== "agent") continue;
    const home = installations.get(node.host);
    if (home === undefined) return yield* Effect.fail(authorityError("authority-mismatch", `seat host ${node.host} has no installation`));
    actorRefs.push({ canvasName, nodeId: node.id, seatId: deriveActorSeatId(home, node.bindingId) });
  }
  return { doc, actorRefs };
});

const inboundActorsForPad = Effect.fn("work.inboundActorsForPad")(function* (
  _reader: SqlClient.SqlClient, sink: SinkRefValue,
): Effect.fn.Return<ReadonlySet<string>, WorkSqlFailure, ModelRecords> {
  const canvas = yield* readModelCanvas(sink.canvasName);
  return canvas === undefined ? new Set<string>() : inboundActorNodeIds(canvas, sink.nodeId);
});

const assertPadPatchRules = Effect.fn("work.assertPadPatchRules")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  author: BoardAuthorValue,
  patches: ReadonlyArray<import("@shared/pad").PadPatch>,
  overseer?: boolean,
): Effect.fn.Return<void, WorkSqlFailure, ModelRecords> {
  const rule = padAuthorRuleError(
    author,
    patches,
    yield* inboundActorsForPad(reader, sink),
    overseer === true ? { overseer: true } : undefined,
  );
  if (rule !== undefined) {
    return yield* Effect.fail(authorityError("invalid-transition", rule));
  }
});

const parseJson = (value: string): unknown => JSON.parse(value);

/**
 * Narrow coercion for the whole-object JSON columns.
 *
 * Durable JSON is written with `canonicalJson`, which sorts keys, so parsing a
 * column back yields sorted key order while a projected value's order is the
 * schema's declaration order. For the columns that store a whole schema object
 * — finish criteria, completion evidence, a task's brief — that difference
 * is visible in the projection, so these three restore the schema's order.
 *
 * They are per-task, never per-part and never per-message, so
 * they do not grow with the message volume the retired read-path decode walked.
 */
const finishCriteriaFromJson = (value: string): TaskValue["finishCriteria"] =>
  Schema.decodeUnknownSync(FinishCriteria, strictDecode)(parseJson(value));

const completionEvidenceFromJson = (
  value: string,
): TaskValue["completionEvidence"] =>
  Schema.decodeUnknownSync(CompletionEvidence, strictDecode)(parseJson(value));

/**
 * Build one projected message from its durable row.
 *
 * Deliberately constructed, not decoded. `work_messages` / `work_task_messages`
 * only ever receive a `Message` that `appendMessage` (and the fact-ingress
 * path) already ran through `Schema.decodeUnknownSync(Message, strictDecode)`,
 * and the columns carry that decision forward as SQL CHECK domains — `role IN
 * ('user', 'agent')`, `json_valid(parts_json)`, `json_valid(metadata_json)`.
 * Re-deciding it here costs a full walk of every part of every message on every
 * read of the world, which at factory scale is the dominant read cost.
 *
 * Key order matches the `Message` schema field order, because that is the order
 * a decode emitted and the projected document is compared and witnessed by
 * value.
 */
const messageFromRow = (
  row: MessageRow,
  parentTaskId?: string,
): MessageValue => {
  const taskId = row.task_id ?? parentTaskId;
  return {
    messageId: row.message_id,
    role: row.role as MessageValue["role"],
    parts: parseJson(row.parts_json) as MessageValue["parts"],
    ...(taskId === null || taskId === undefined ? {} : { taskId }),
    ...(row.context_id === null ? {} : { contextId: row.context_id }),
    ...(row.reference_task_ids_json === null
      ? {}
      : {
          referenceTaskIds: parseJson(
            row.reference_task_ids_json,
          ) as MessageValue["referenceTaskIds"],
        }),
    ...(row.metadata_json === null
      ? {}
      : {
          metadata: parseJson(row.metadata_json) as MessageValue["metadata"],
        }),
  };
};

const loadThread = Effect.fn("work.loadThread")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  lane: "task" | "request",
  itemId: string,
): Effect.fn.Return<ReadonlyArray<MessageValue>, WorkSqlFailure> {
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: MessageRowSchema,
    execute: (bindings) =>
      reader.unsafe(
        `
        SELECT
          message_id,
          role,
          parts_json,
          NULL AS task_id,
          context_id,
          reference_task_ids_json,
          metadata_json
        FROM work_task_messages
        WHERE canvas_name = ?
          AND node_id = ?
          AND parent_lane = ?
          AND item_id = ?
        ORDER BY position
      `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, lane, itemId]);
  return yield* Effect.try(() =>
    rows.map((row) => messageFromRow(row, itemId)),
  );
});

/**
 * Every thread on one sink lane, grouped by item, in one statement.
 *
 * `loadThread` is the single-item form the write path still uses when it holds
 * one task. The lane projection must not pay it per task:
 * `work_task_messages_thread` indexes (canvas_name, node_id, parent_lane,
 * item_id, position), so the lane-wide ORDER BY item_id, position walks that
 * index in order and every group comes out in exactly the per-item order the
 * single-item query produced.
 */
const loadThreadsByItem = Effect.fn("work.loadThreadsByItem")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  lane: "task" | "request",
  itemIds?: ReadonlyArray<string>,
): Effect.fn.Return<
  ReadonlyMap<string, ReadonlyArray<MessageValue>>,
  WorkSqlFailure
> {
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: ThreadMessageRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT
        item_id,
        message_id,
        role,
        parts_json,
        NULL AS task_id,
        context_id,
        reference_task_ids_json,
        metadata_json
      FROM work_task_messages
      WHERE canvas_name = ?
        AND node_id = ?
        AND parent_lane = ?
        ${itemIds === undefined ? "" : `AND item_id IN (${itemIds.map(() => "?").join(",")})`}
      ORDER BY item_id, position
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, lane, ...(itemIds ?? [])]);
  const byItem = new Map<string, MessageValue[]>();
  for (const row of rows) {
    const message = yield* Effect.try(
      messageFromRow.bind(undefined, row, row.item_id),
    );
    const thread = byItem.get(row.item_id);
    if (thread === undefined) byItem.set(row.item_id, [message]);
    else thread.push(message);
  }
  return byItem;
});

const loadTaskDependsOnMap = Effect.fn("work.loadTaskDependsOnMap")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  itemIds?: ReadonlyArray<string>,
): Effect.fn.Return<Map<string, string[]>, WorkSqlFailure> {
  const map = new Map<string, string[]>();
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: TaskDependencyRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT task_id, depends_on_task_id
      FROM work_task_dependencies
      WHERE canvas_name = ? AND node_id = ?
        ${itemIds === undefined ? "" : `AND task_id IN (${itemIds.map(() => "?").join(",")})`}
      ORDER BY task_id, position, depends_on_task_id
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, ...(itemIds ?? [])]);
  for (const row of rows) {
    const list = map.get(row.task_id);
    if (list === undefined) map.set(row.task_id, [row.depends_on_task_id]);
    else list.push(row.depends_on_task_id);
  }
  return map;
});

const loadTaskDependsOn = Effect.fn("work.loadTaskDependsOn")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  taskId: string,
): Effect.fn.Return<string[] | undefined, WorkSqlFailure> {
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: DependencyIdRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT depends_on_task_id
      FROM work_task_dependencies
      WHERE canvas_name = ? AND node_id = ? AND task_id = ?
      ORDER BY position, depends_on_task_id
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, taskId]);
  if (rows.length === 0) return undefined;
  return rows.map((row) => row.depends_on_task_id);
});

const loadTaskFinish = Effect.fn("work.loadTaskFinish")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  taskId: string,
): Effect.fn.Return<
  {
    readonly finishCriteria?: TaskValue["finishCriteria"];
    readonly completionEvidence?: TaskValue["completionEvidence"];
  },
  WorkSqlFailure
> {
  const row = yield* SqlSchema.findOneOption({
    Request: WorkSqlBindings,
    Result: TaskFinishRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT finish_criteria_json, completion_evidence_json
      FROM work_task_finish
      WHERE canvas_name = ? AND node_id = ? AND task_id = ?
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, taskId]).pipe(
    Effect.map(Option.getOrUndefined),
  );
  if (row === undefined) return {};
  return {
    ...(row.finish_criteria_json === null
      ? {}
      : {
          finishCriteria: yield* Effect.try(
            finishCriteriaFromJson.bind(undefined, row.finish_criteria_json),
          ),
        }),
    ...(row.completion_evidence_json === null
      ? {}
      : {
          completionEvidence: yield* Effect.try(
            completionEvidenceFromJson.bind(
              undefined,
              row.completion_evidence_json,
            ),
          ),
        }),
  };
});

const loadTaskFinishMap = Effect.fn("work.loadTaskFinishMap")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  itemIds?: ReadonlyArray<string>,
): Effect.fn.Return<
  Map<
    string,
    {
      readonly finishCriteria?: TaskValue["finishCriteria"];
      readonly completionEvidence?: TaskValue["completionEvidence"];
    }
  >,
  WorkSqlFailure
> {
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: TaskFinishByIdRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT task_id, finish_criteria_json, completion_evidence_json
      FROM work_task_finish
      WHERE canvas_name = ? AND node_id = ?
        ${itemIds === undefined ? "" : `AND task_id IN (${itemIds.map(() => "?").join(",")})`}
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, ...(itemIds ?? [])]);
  const map = new Map<
    string,
    {
      readonly finishCriteria?: TaskValue["finishCriteria"];
      readonly completionEvidence?: TaskValue["completionEvidence"];
    }
  >();
  for (const row of rows) {
    map.set(row.task_id, {
      ...(row.finish_criteria_json === null
        ? {}
        : {
            finishCriteria: yield* Effect.try(
              finishCriteriaFromJson.bind(undefined, row.finish_criteria_json),
            ),
          }),
      ...(row.completion_evidence_json === null
        ? {}
        : {
            completionEvidence: yield* Effect.try(
              completionEvidenceFromJson.bind(
                undefined,
                row.completion_evidence_json,
              ),
            ),
          }),
    });
  }
  return map;
});

/**
 * Projection-only publisher stamp. Mirrors the mailbox receipt-fact pattern
 * (loadInbox's deliveredAt/readAt spread): stamped after the strict decode of
 * the durable row, never written back to work_artifacts.
 */
const stampPublishedBySeat = (
  artifact: ArtifactValue,
  actorSeatId: string | null,
): ArtifactValue =>
  actorSeatId === null || actorSeatId === ""
    ? artifact
    : {
        ...artifact,
        metadata: {
          ...(artifact.metadata ?? {}),
          publishedBySeatId: actorSeatId,
        },
      };

/** All artifacts on a canvas, keyed by sink node id (for finish-criteria gate). */
const loadAllArtifactsByNode = Effect.fn("work.loadAllArtifactsByNode")(
  function* (
    reader: SqlClient.SqlClient,
    canvasName: string,
  ): Effect.fn.Return<
    Map<string, ReadonlyArray<ArtifactValue>>,
    WorkSqlFailure
  > {
    const rows = yield* SqlSchema.findAll({
      Request: WorkSqlBindings,
      Result: CanvasArtifactRow,
      execute: (bindings) =>
        reader.unsafe(
          `
      SELECT
        node_id,
        artifact_id,
        actor_seat_id,
        name,
        parts_json,
        task_canvas_name,
        task_node_id,
        task_id,
        metadata_json
      FROM work_artifacts
      WHERE canvas_name = ?
      ORDER BY node_id, artifact_id
    `,
          bindings,
        ),
    })([canvasName]);
    const map = new Map<string, ArtifactValue[]>();
    for (const row of rows) {
      const decoded = yield* Schema.decodeUnknownEffect(
        Artifact,
        strictDecode,
      )({
        artifactId: row.artifact_id,
        parts: yield* Effect.try(() => parseJson(row.parts_json)),
        ...(row.name === null ? {} : { name: row.name }),
        ...(row.task_id === null
          ? {}
          : {
              task: {
                kind: "task",
                itemId: row.task_id,
                sink: {
                  canvasName: row.task_canvas_name!,
                  nodeId: row.task_node_id!,
                },
              },
            }),
        ...(row.metadata_json === null
          ? {}
          : {
              metadata: yield* Effect.try(() => parseJson(row.metadata_json!)),
            }),
      });
      const artifact = stampPublishedBySeat(decoded, row.actor_seat_id);
      const list = map.get(row.node_id);
      if (list === undefined) map.set(row.node_id, [artifact]);
      else list.push(artifact);
    }
    return map;
  },
);

const writeTaskFinish = Effect.fn("work.writeTaskFinish")(function* (
  writer: SqlClient.SqlClient,
  sink: SinkRefValue,
  task: TaskValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  // State decides whether evidence may persist; the snapshot cannot override it.
  // work-model.ts:218 holds that completionEvidence is only valid on completed
  // tasks, and transitionTask STRIPS it on every non-completed transition — so a
  // deliberate clear and an omitted field arrive here identically. Merge-keeping
  // on a non-completed task resurrects stale evidence into a Task that violates
  // the model filter (a QA rejection, completed -> submitted, is exactly this).
  const evidenceAllowed =
    task.state === "completed" || task.state === "working";
  const existing = yield* loadTaskFinish(writer, sink, task.id);
  if (
    task.finishCriteria === undefined &&
    task.completionEvidence === undefined &&
    // undefined on both = snapshot omitted finish fields; keep the durable row
    // (mirrors dependsOn preserve semantics) — unless the durable row holds
    // evidence this state forbids, which must be cleared rather than kept.
    (evidenceAllowed || existing.completionEvidence === undefined)
  ) {
    return;
  }
  // When one field is present, merge: keep the other from existing row if
  // the snapshot omitted it.
  const criteria =
    task.finishCriteria !== undefined
      ? task.finishCriteria
      : existing.finishCriteria;
  const evidence = !evidenceAllowed
    ? undefined
    : task.completionEvidence !== undefined
      ? task.completionEvidence
      : existing.completionEvidence;
  yield* writer.unsafe(
    `
      INSERT INTO work_task_finish(
        canvas_name,
        node_id,
        task_id,
        finish_criteria_json,
        completion_evidence_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(canvas_name, node_id, task_id) DO UPDATE SET
        finish_criteria_json = excluded.finish_criteria_json,
        completion_evidence_json = excluded.completion_evidence_json
    `,
    [
      sink.canvasName,
      sink.nodeId,
      task.id,
      criteria === undefined ? null : canonicalJson(criteria),
      evidence === undefined ? null : canonicalJson(evidence),
    ],
  );
});

const writeTaskDependsOn = Effect.fn("work.writeTaskDependsOn")(function* (
  writer: SqlClient.SqlClient,
  sink: SinkRefValue,
  taskId: string,
  dependsOn: ReadonlyArray<string> | undefined,
): Effect.fn.Return<void, WorkSqlFailure> {
  // undefined means "field omitted on this snapshot" — do not wipe durable edges.
  // Explicit [] clears; non-empty replaces.
  if (dependsOn === undefined) return;
  yield* writer.unsafe(
    `
      DELETE FROM work_task_dependencies
      WHERE canvas_name = ? AND node_id = ? AND task_id = ?
    `,
    [sink.canvasName, sink.nodeId, taskId],
  );
  for (let position = 0; position < dependsOn.length; position += 1) {
    yield* writer.unsafe(
      `
        INSERT INTO work_task_dependencies(
          canvas_name,
          node_id,
          task_id,
          depends_on_task_id,
          position
        ) VALUES (?, ?, ?, ?, ?)
      `,
      [sink.canvasName, sink.nodeId, taskId, dependsOn[position]!, position],
    );
  }
});

/**
 * Task path persistence — the representation choice (documented per spec §4).
 *
 * Re-homing keeps the (canvas_name, node_id, task_id) key untouched: a
 * send-on inserts a SUCCESSOR row sharing task_id at the next board while the
 * earlier row stays behind as the completed visit record (visit exit
 * "sent-on"). Send-back transitions the current row to rejected and re-opens
 * the previous board's existing row
 * (completed → submitted, epoch++). Both moves are expressed purely with the
 * existing immutable-log vocabulary ('task.transition' / 'task.create'), so
 * no schema migration, no row moves, no orphaned child rows (messages,
 * finish, dependencies all stay keyed to their board's row).
 *
 * Task-specific fields (rules / epoch / visits / waitUntil / checkResults
 * / defects / admission / raisedBy) persist as one reserved bag under
 * metadata_json["junto.tasks"]:
 * shipped migrations are immutable and work_tasks gains no column, while
 * metadata_json is an existing open JSON column (CHECK: json_valid, no
 * $.claimedBy). writeTask folds the first-class Task fields into the bag on
 * write; taskFromRow lifts them back out, so the bag never leaks into the
 * exposed Task.metadata. Old rows have no bag and decode exactly as before
 * (decode-admits-history). Authoring paths reject the reserved keys so seats
 * cannot forge visits, check results, or approvals.
 *
 * The requirements this satisfies: stable task id across the whole path
 * (same task_id at every board row); `tasks show` reconstructs the visits
 * from the live row's append-only visits field; ClaimConflict stays
 * per-board (claimedBy is a per-row column); same-sink dependsOn is
 * satisfied by local visit completion (the source row completes on
 * send-on); no orphan facts (nothing is deleted or renumbered).
 */
const TASK_METADATA_BAG_KEY = "junto.tasks";

/** Operator approval marker — also reserved (see @shared/rules). */
const TASK_APPROVAL_KEY = TASK_APPROVED_METADATA_KEY;

/** Authoring input must never smuggle system-stamped task state. */
const assertNoReservedTaskMetadata = (
  metadata: TaskValue["metadata"] | undefined,
): void => {
  if (metadata === undefined) return;
  if (
    Object.prototype.hasOwnProperty.call(metadata, TASK_METADATA_BAG_KEY) ||
    Object.prototype.hasOwnProperty.call(metadata, TASK_APPROVAL_KEY)
  ) {
    throw authorityError(
      "invalid-transition",
      "metadata keys under junto.tasks are reserved for the work service",
    );
  }
};

type TaskMetadataBag = {
  readonly rules?: TaskValue["rules"];
  readonly epoch?: TaskValue["epoch"];
  readonly visits?: TaskValue["visits"];
  readonly defects?: TaskValue["defects"];
  readonly waitUntil?: TaskValue["waitUntil"];
  readonly checkResults?: TaskValue["checkResults"];
  readonly admission?: TaskValue["admission"];
  readonly raisedBy?: TaskValue["raisedBy"];
  /**
   * When the row entered its current state: the origin time of the fact that
   * changed it. Row bookkeeping written by `writeTask`, never read from the
   * task value, so it stays out of every fact body.
   */
  readonly stateSince?: string;
};

const foldTaskMetadata = (
  task: TaskValue,
  stateSince: string,
): TaskValue["metadata"] | undefined => {
  const bag: TaskMetadataBag = {
    stateSince,
    ...(task.rules !== undefined && task.rules.length > 0
      ? { rules: task.rules }
      : {}),
    ...(task.epoch !== undefined ? { epoch: task.epoch } : {}),
    ...(task.visits !== undefined && task.visits.length > 0
      ? { visits: task.visits }
      : {}),
    ...(task.defects !== undefined && task.defects.length > 0
      ? { defects: task.defects }
      : {}),
    ...(task.waitUntil !== undefined ? { waitUntil: task.waitUntil } : {}),
    ...(task.checkResults !== undefined && task.checkResults.length > 0
      ? { checkResults: task.checkResults }
      : {}),
    ...(task.admission !== undefined ? { admission: task.admission } : {}),
    ...(task.raisedBy !== undefined ? { raisedBy: task.raisedBy } : {}),
  };
  return { ...(task.metadata ?? {}), [TASK_METADATA_BAG_KEY]: bag };
};

/**
 * When a stored row entered its current state. Live code, not a safety net:
 * every install has task and request rows written before the stamp existed,
 * the operator's own included, and those rows carry none. Their last fact's
 * origin time is the best the journal's row knows; the row gets a real stamp
 * at its next state change.
 */
const rowStateSince = (row: {
  readonly metadata_json: string | null;
  readonly origin_at: string;
}): string => liftTaskMetadata(row.metadata_json).taskFields?.stateSince ?? row.origin_at;

const liftTaskMetadata = (
  metadataJson: string | null,
): {
  readonly metadata?: TaskValue["metadata"];
  readonly taskFields?: TaskMetadataBag;
} => {
  if (metadataJson === null) return {};
  const parsed = parseJson(metadataJson) as Record<string, unknown>;
  if (!(TASK_METADATA_BAG_KEY in parsed)) {
    return { metadata: parsed as TaskValue["metadata"] };
  }
  const { [TASK_METADATA_BAG_KEY]: bag, ...rest } = parsed;
  return {
    ...(Object.keys(rest).length > 0
      ? { metadata: rest as TaskValue["metadata"] }
      : {}),
    // Constructed, not decoded — the bag was folded from fields the write
    // path strict-decoded on the same row (see messageFromRow doctrine).
    taskFields: bag as TaskMetadataBag,
  };
};

/** Apply a policy-computed patch onto a durable task (see TransitionTaskInput). */
const applyTaskRecordPatch = (
  task: TaskValue,
  patch: TaskRecordPatch | undefined,
): TaskValue => {
  if (patch === undefined) return task;
  let next: TaskValue = { ...task };
  if (patch.epoch !== undefined) next = { ...next, epoch: patch.epoch };
  if (patch.visits !== undefined) next = { ...next, visits: patch.visits };
  if (patch.defects !== undefined) next = { ...next, defects: patch.defects };
  if (patch.raisedBy !== undefined)
    next = { ...next, raisedBy: patch.raisedBy };
  if (patch.admission !== undefined) {
    if (patch.admission === null) {
      const { admission: _admission, ...rest } = next;
      next = rest;
    } else {
      next = { ...next, admission: patch.admission };
    }
  }
  if (patch.waitUntil !== undefined) {
    if (patch.waitUntil === null) {
      const { waitUntil: _wait, ...rest } = next;
      next = rest;
    } else {
      next = { ...next, waitUntil: patch.waitUntil };
    }
  }
  if (patch.checkResults !== undefined) {
    if (patch.checkResults === null) {
      const { checkResults: _checkResults, ...rest } = next;
      next = rest;
    } else {
      next = { ...next, checkResults: patch.checkResults };
    }
  }
  if (patch.approvedEpoch !== undefined) {
    const metadata: Record<string, unknown> = { ...(next.metadata ?? {}) };
    if (patch.approvedEpoch === null) {
      delete metadata[TASK_APPROVAL_KEY];
    } else {
      metadata[TASK_APPROVAL_KEY] = patch.approvedEpoch;
    }
    if (Object.keys(metadata).length > 0) {
      next = { ...next, metadata: metadata as TaskValue["metadata"] };
    } else {
      const { metadata: _metadata, ...rest } = next;
      next = rest;
    }
  }
  return next;
};

const taskFromRow = Effect.fn("work.taskFromRow")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  lane: "task" | "request",
  row: TaskRow,
  dependsOn?: ReadonlyArray<string>,
  finish?: {
    readonly finishCriteria?: TaskValue["finishCriteria"];
    readonly completionEvidence?: TaskValue["completionEvidence"];
  },
  history?: ReadonlyArray<MessageValue>,
): Effect.fn.Return<TaskValue, WorkSqlFailure> {
  // Constructed, not decoded — see messageFromRow. Every `work_tasks` /
  // `work_requests` row is the materialization of a `Task` the write path
  // already strict-decoded (createTask / transitionTask / claimTask /
  // resolveRequest all decode before commitLocalFact), and state / seat id /
  // JSON columns carry SQL CHECK domains. Field order is the `Task` schema
  // order the decode used to emit.
  const lifted = yield* Effect.try(
    liftTaskMetadata.bind(undefined, row.metadata_json),
  );
  const taskFields = lane === "task" ? lifted.taskFields : undefined;
  return {
    id: row.item_id,
    state: row.state as TaskValue["state"],
    ...(row.actor_seat_id === null
      ? {}
      : { claimedBy: row.actor_seat_id as TaskValue["claimedBy"] }),
    history: history ?? (yield* loadThread(reader, sink, lane, row.item_id)),
    ...(row.artifact_ids_json === null
      ? {}
      : {
          artifactIds: (yield* Effect.try(
            parseJson.bind(undefined, row.artifact_ids_json),
          )) as TaskValue["artifactIds"],
        }),
    ...(lane === "task" && dependsOn !== undefined && dependsOn.length > 0
      ? { dependsOn: [...dependsOn] }
      : {}),
    ...(lane === "task" && finish?.finishCriteria !== undefined
      ? { finishCriteria: finish.finishCriteria }
      : {}),
    ...(taskFields?.rules !== undefined ? { rules: taskFields.rules } : {}),
    ...(lane === "task" && finish?.completionEvidence !== undefined
      ? { completionEvidence: finish.completionEvidence }
      : {}),
    ...(taskFields?.epoch !== undefined ? { epoch: taskFields.epoch } : {}),
    ...(taskFields?.visits !== undefined ? { visits: taskFields.visits } : {}),
    ...(taskFields?.defects !== undefined
      ? { defects: taskFields.defects }
      : {}),
    ...(taskFields?.waitUntil !== undefined
      ? { waitUntil: taskFields.waitUntil }
      : {}),
    ...(taskFields?.checkResults !== undefined
      ? { checkResults: taskFields.checkResults }
      : {}),
    ...(lifted.metadata !== undefined ? { metadata: lifted.metadata } : {}),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(taskFields?.admission !== undefined
      ? { admission: taskFields.admission }
      : {}),
    ...(taskFields?.raisedBy !== undefined
      ? { raisedBy: taskFields.raisedBy }
      : {}),
    ...(row.response === null ? {} : { response: row.response }),
  };
});

/** All epochs and subjects for this sink's exact task identities, in one query. */
const loadTaskVerdictsMap = Effect.fn("work.loadTaskVerdictsMap")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  itemIds?: ReadonlyArray<string>,
): Effect.fn.Return<
  ReadonlyMap<string, ReadonlyArray<ReviewVerdict>>,
  WorkSqlFailure
> {
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: TaskVerdictRow,
    execute: (bindings) =>
      reader.unsafe(
        `SELECT verdict.*
     FROM work_review_verdicts AS verdict
     JOIN work_tasks AS task
       ON task.canvas_name = verdict.subject_task_canvas
      AND task.node_id = verdict.subject_task_node
      AND task.task_id = verdict.subject_task_item
      AND task.entity_home = verdict.subject_task_installation
     WHERE verdict.subject_kind = 'task'
       AND verdict.subject_task_canvas = ? AND verdict.subject_task_node = ?
        ${itemIds === undefined ? "" : `AND verdict.subject_task_item IN (${itemIds.map(() => "?").join(",")})`}
     ORDER BY verdict.subject_task_item, verdict.posted_at_ms, verdict.verdict_id`,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, ...(itemIds ?? [])]);
  const map = new Map<string, ReviewVerdict[]>();
  for (const row of rows) {
    // Like the other lane loaders, construct the projection from rows whose
    // writer validated the canonical schema and whose columns have SQL domains.
    const verdict: ReviewVerdict = {
      verdictId: row.verdict_id,
      kind: row.kind,
      reviewerSeatId: row.reviewer_seat_id,
      ...(row.reviewer_node_id === null
        ? {}
        : { reviewerNodeId: row.reviewer_node_id }),
      authorSeatId: row.author_seat_id,
      subject: {
        kind: "task",
        installationId: row.subject_task_installation,
        canvasName: sink.canvasName,
        nodeId: sink.nodeId,
        taskId: row.subject_task_item,
        epoch: row.subject_epoch,
        subjectHash: row.subject_hash,
      },
      subjectHash: row.subject_hash,
      epoch: row.epoch,
      findings: (yield* Effect.try(
        parseJson.bind(undefined, row.findings_json),
      )) as ReviewVerdict["findings"],
      refs: (yield* Effect.try(
        parseJson.bind(undefined, row.refs_json),
      )) as ReviewVerdict["refs"],
      postedAtMs: row.posted_at_ms,
    };
    const chain = map.get(row.subject_task_item);
    if (chain === undefined) map.set(row.subject_task_item, [verdict]);
    else chain.push(verdict);
  }
  return map;
});

const loadLaneTasks = Effect.fn("work.loadLaneTasks")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  lane: "task" | "request",
  itemIds?: ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<TaskValue>, WorkSqlFailure> {
  const table = lane === "task" ? "work_tasks" : "work_requests";
  const id = lane === "task" ? "task_id" : "request_id";
  const dependsMap =
    lane === "task" ? yield* loadTaskDependsOnMap(reader, sink, itemIds) : undefined;
  const finishMap =
    lane === "task" ? yield* loadTaskFinishMap(reader, sink, itemIds) : undefined;
  const verdictsMap =
    lane === "task" ? yield* loadTaskVerdictsMap(reader, sink, itemIds) : undefined;
  const threads = yield* loadThreadsByItem(reader, sink, lane, itemIds);
  // Requests: newest first (operator triage). Tasks keep oldest-first claim order.
  const orderBy =
    lane === "request"
      ? `ORDER BY created_at DESC, ${id} DESC`
      : `ORDER BY created_at, ${id}`;
  return yield* Effect.forEach(
    yield* SqlSchema.findAll({
      Request: WorkSqlBindings,
      Result: TaskRowSchema,
      execute: (bindings) =>
        reader.unsafe(
          `
        SELECT
          canvas_name,
          node_id,
          ${id} AS item_id,
          entity_home,
          actor_seat_id,
          fact_event_home,
          fact_entity_home,
          fact_seq,
          state,
          artifact_ids_json,
          metadata_json,
          reason,
          response,
          created_at,
          origin_at
        FROM ${table}
        WHERE canvas_name = ? AND node_id = ?
        ${itemIds === undefined ? "" : `AND ${id} IN (${itemIds.map(() => "?").join(",")})`}
        ${orderBy}
      `,
          bindings,
        ),
    })([sink.canvasName, sink.nodeId, ...(itemIds ?? [])]),
    (row) =>
      Effect.gen(function* () {
        const task: TaskValue = {
          ...(yield* taskFromRow(
            reader,
            sink,
            lane,
            row,
            dependsMap?.get(row.item_id),
            finishMap?.get(row.item_id),
            threads.get(row.item_id) ?? [],
          )),
          // Projection only, like verdicts below: the write path's loadTask
          // never carries it, so no fact body does.
          stateSince: rowStateSince({
            metadata_json: row.metadata_json,
            origin_at: row.origin_at!,
          }),
        };
        return lane === "task"
          ? {
              ...task,
              verdicts: verdictsMap?.get(row.item_id) ?? [],
              subjectHash: taskReviewSubjectHash({
                installationId: row.entity_home,
                canvasName: sink.canvasName,
                nodeId: sink.nodeId,
                task,
              }),
            }
          : task;
      }),
  );
});

/**
 * Every mailbox receipt on one sink, indexed by delivery id, in one statement.
 *
 * `work_delivery_receipts` is `WITHOUT ROWID` with PRIMARY KEY
 * (delivered_canvas_name, delivered_node_id, delivery_id), so a sink is one
 * contiguous key-range scan. The rows this returns are a strict subset of what
 * the per-message point lookups could have matched: mailbox delivery / read /
 * react receipts are all minted against `delivered_item_kind = 'message'`
 * (recordDeliveryReceipt writes `receipt.deliveredItem.kind`), so the kind
 * filter cannot hide a receipt loadInbox would otherwise stamp, and it keeps
 * task-claim receipts on the same sink out of the projection's way.
 */
const loadMessageReceiptAcceptedAtMap = Effect.fn(
  "work.loadMessageReceiptAcceptedAtMap",
)(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
): Effect.fn.Return<ReadonlyMap<string, number>, WorkSqlFailure> {
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: MessageReceiptRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT delivery_id, accepted_at
      FROM work_delivery_receipts
      WHERE delivered_canvas_name = ?
        AND delivered_node_id = ?
        AND delivered_item_kind = 'message'
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId]);
  const map = new Map<string, number>();
  for (const row of rows) {
    const ms = Date.parse(row.accepted_at);
    if (Number.isFinite(ms)) map.set(row.delivery_id, ms);
  }
  return map;
});

const messageWithReceipts = (
  row: typeof MessageRowSchema.Type,
  sink: SinkRefValue,
  stamps: ReadonlyMap<string, number>,
): MessageValue => {
  const message = messageFromRow(row);
  const deliveredAt = stamps.get(mailboxMessageDeliveryId(sink.canvasName, sink.nodeId, row.message_id));
  const readAt = stamps.get(mailboxMessageReadId(sink.canvasName, sink.nodeId, row.message_id));
  const ackAt = stamps.get(mailboxMessageReactId(sink.canvasName, sink.nodeId, row.message_id, "ack"));
  if (deliveredAt === undefined && readAt === undefined && ackAt === undefined) return message;
  return { ...message, metadata: { ...message.metadata,
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    ...(readAt === undefined ? {} : { readAt }),
    ...(ackAt === undefined ? {} : { reactions: [{ kind: "ack", at: ackAt }] }),
  } };
};

const loadInbox = Effect.fn("work.loadInbox")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
): Effect.fn.Return<ReadonlyArray<MessageValue>, WorkSqlFailure> {
  const receipts = yield* loadMessageReceiptAcceptedAtMap(reader, sink);
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: MessageRowSchema,
    execute: (bindings) =>
      reader.unsafe(
        `
        SELECT
          message_id,
          role,
          parts_json,
          task_id,
          context_id,
          reference_task_ids_json,
          metadata_json
        FROM work_messages
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY position
      `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId]);
  return yield* Effect.try(() => rows.map((row) => messageWithReceipts(row, sink, receipts)));
});

/** Keyset pagination uses the existing inbox index; only this page's receipts are read. */
export const readWorkMailPage = Effect.fn("work.mail.page")(function* (
  reader: SqlClient.SqlClient,
  input: WorkMailQuery,
  messageId?: string,
): Effect.fn.Return<WorkMailPage, WorkSqlFailure> {
  const query = yield* Schema.decodeUnknownEffect(WorkMailQuery, strictDecode)(input);
  const limit = query.limit ?? WORK_MAIL_PAGE_SIZE;
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: Schema.Struct({ ...MessageRowSchema.fields, position: Schema.Number }),
    execute: (bindings) => reader.unsafe(`
      SELECT message_id, role, parts_json, task_id, context_id,
             reference_task_ids_json, metadata_json, position
      FROM work_messages
      WHERE canvas_name = ? AND node_id = ?
        ${query.beforePosition === undefined ? "" : "AND position < ?"}
        ${messageId === undefined ? "" : "AND message_id = ?"}
      ORDER BY position DESC LIMIT ?`, bindings),
  })([query.canvasName, query.nodeId,
    ...(query.beforePosition === undefined ? [] : [query.beforePosition]),
    ...(messageId === undefined ? [] : [messageId]), limit + 1]);
  const page = rows.slice(0, limit);
  const ids = page.flatMap((row) => [
    mailboxMessageDeliveryId(query.canvasName, query.nodeId, row.message_id),
    mailboxMessageReadId(query.canvasName, query.nodeId, row.message_id),
    mailboxMessageReactId(query.canvasName, query.nodeId, row.message_id, "ack"),
  ]);
  const receipts = ids.length === 0 ? [] : yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: MessageReceiptRow,
    execute: (bindings) => reader.unsafe(`
      SELECT delivery_id, accepted_at FROM work_delivery_receipts
      WHERE delivered_canvas_name = ? AND delivered_node_id = ?
        AND delivery_id IN (${ids.map(() => "?").join(",")})`, bindings),
  })([query.canvasName, query.nodeId, ...ids]);
  const stamps = new Map(receipts.map((row) => [row.delivery_id, Date.parse(row.accepted_at)]));
  const items = yield* Effect.try(() => page.map((row) => ({
    position: row.position, message: messageWithReceipts(row, query, stamps),
  })));
  return { items, ...(rows.length > limit ? { nextBeforePosition: page.at(-1)!.position } : {}) };
});

/** Companion history selects inbound and sent mail before decoding any payload. */
const readCompanionMail = Effect.fn("work.mail.companion")(function* (
  reader: SqlClient.SqlClient,
  canvasName: string,
  nodeId: string,
  requestedLimit: number,
): Effect.fn.Return<ReadonlyArray<{ readonly nodeId: string; readonly message: MessageValue }>, WorkSqlFailure> {
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.trunc(requestedLimit))) : WORK_MAIL_PAGE_SIZE;
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: Schema.Struct({ ...MessageRowSchema.fields, node_id: Schema.String }),
    execute: (bindings) => reader.unsafe(`SELECT mail.node_id,mail.message_id,mail.role,mail.parts_json,
      mail.task_id,mail.context_id,mail.reference_task_ids_json,mail.metadata_json
      FROM work_messages AS mail JOIN seats AS seat ON seat.canvas_name=mail.canvas_name AND seat.id=mail.node_id
      WHERE mail.canvas_name=? AND mail.role='user'
        AND (mail.node_id=? OR json_extract(mail.metadata_json,'$.senderNodeId')=?)
      ORDER BY (length(mail.message_id)=26 AND mail.message_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') DESC,
        mail.message_id DESC,mail.node_id LIMIT ?`, bindings),
  })([canvasName, nodeId, nodeId, limit]);
  const ids = rows.flatMap((row) => [
    mailboxMessageDeliveryId(canvasName, row.node_id, row.message_id),
    mailboxMessageReadId(canvasName, row.node_id, row.message_id),
    mailboxMessageReactId(canvasName, row.node_id, row.message_id, "ack"),
  ]);
  const receipts = ids.length === 0 ? [] : yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: MessageReceiptRow,
    execute: (bindings) => reader.unsafe(`SELECT delivery_id,accepted_at FROM work_delivery_receipts
      WHERE delivered_canvas_name=? AND delivered_item_kind='message'
        AND delivery_id IN (${ids.map(() => "?").join(",")})`, bindings),
  })([canvasName, ...ids]);
  const stamps = new Map(receipts.map((row) => [row.delivery_id, Date.parse(row.accepted_at)]));
  return yield* Effect.try(() => rows.map((row) => ({
    nodeId: row.node_id, message: messageWithReceipts(row, { canvasName, nodeId: row.node_id }, stamps),
  })));
});

const boardAuthorFromRow = (row: {
  readonly author_kind: string;
  readonly author_seat_id: string | null;
  readonly author_node_id: string | null;
  readonly author_label: string | null;
}): BoardAuthorValue => ({
  kind: row.author_kind === "operator" ? "operator" : "actor",
  ...(row.author_seat_id
    ? { seatId: row.author_seat_id as BoardAuthorValue["seatId"] }
    : {}),
  ...(row.author_node_id ? { nodeId: row.author_node_id } : {}),
  ...(row.author_label ? { label: row.author_label } : {}),
});

/**
 * Every board post on one sink, grouped by topic, in one statement.
 *
 * `work_board_posts_thread` indexes (canvas_name, node_id, topic_id, position),
 * so the sink-wide ORDER BY topic_id, position walks the index in order and
 * each group keeps exactly the per-topic ordering the per-topic query produced.
 */
const loadBoardPostsByTopic = Effect.fn("work.loadBoardPostsByTopic")(
  function* (
    reader: SqlClient.SqlClient,
    sink: SinkRefValue,
    topicId?: string,
  ): Effect.fn.Return<
    ReadonlyMap<string, ReadonlyArray<BoardPostValue>>,
    WorkSqlFailure
  > {
    const rows = yield* SqlSchema.findAll({
      Request: WorkSqlBindings,
      Result: BoardPostRow,
      execute: (bindings) =>
        reader.unsafe(
          `
      SELECT
        post_id,
        topic_id,
        position,
        author_kind,
        author_seat_id,
        author_node_id,
        author_label,
        parts_json,
        tags_json,
        created_at
      FROM work_board_posts
      WHERE canvas_name = ? AND node_id = ?
      ${topicId === undefined ? "" : "AND topic_id = ?"}
      ORDER BY topic_id, position
    `,
          bindings,
        ),
    })([sink.canvasName, sink.nodeId, ...(topicId === undefined ? [] : [topicId])]);
    const byTopic = new Map<string, BoardPostValue[]>();
    for (const row of rows) {
      const tagsRaw =
        typeof row.tags_json === "string"
          ? yield* Effect.try(parseJson.bind(undefined, row.tags_json))
          : undefined;
      const tags =
        Array.isArray(tagsRaw) && tagsRaw.every((t) => typeof t === "string")
          ? (tagsRaw as string[])
          : undefined;
      const post: BoardPostValue = {
        postId: row.post_id,
        topicId: row.topic_id,
        author: boardAuthorFromRow(row),
        parts: (yield* Effect.try(
          parseJson.bind(undefined, row.parts_json),
        )) as BoardPostValue["parts"],
        position: row.position,
        createdAt: row.created_at,
        ...(tags && tags.length > 0 ? { tags } : {}),
      };
      const group = byTopic.get(row.topic_id);
      if (group === undefined) byTopic.set(row.topic_id, [post]);
      else group.push(post);
    }
    return byTopic;
  },
);

/**
 * Operator read cursors for one board sink, keyed by topic id. Unread is the
 * pad-glance pattern: join the cursors table with the fixed "operator"
 * principal at the read boundary; a missing cursor reads every post.
 */
const loadOperatorReadCursors = Effect.fn("work.loadOperatorReadCursors")(
  function* (
    reader: SqlClient.SqlClient,
    sink: SinkRefValue,
  ): Effect.fn.Return<Map<string, number>, WorkSqlFailure> {
    const rows = yield* SqlSchema.findAll({
      Request: WorkSqlBindings,
      Result: BoardCursorRow,
      execute: (bindings) =>
        reader.unsafe(
          `
        SELECT topic_id, MAX(last_read_position) AS last_read_position
        FROM work_board_read_cursors
        WHERE canvas_name = ? AND node_id = ? AND principal_key = 'operator'
        GROUP BY topic_id
      `,
          bindings,
        ),
    })([sink.canvasName, sink.nodeId]);
    return new Map(rows.map((row) => [row.topic_id, row.last_read_position]));
  },
  Effect.catch(() => Effect.succeed(new Map<string, number>())),
);

const loadBoardTopics = Effect.fn("work.loadBoardTopics")(
  function* (
    reader: SqlClient.SqlClient,
    sink: SinkRefValue,
    topicId?: string,
  ): Effect.fn.Return<ReadonlyArray<BoardTopicViewValue>, WorkSqlFailure> {
    const postsByTopic = yield* loadBoardPostsByTopic(reader, sink, topicId);
    const readCursors = yield* loadOperatorReadCursors(reader, sink);
    const rows = yield* SqlSchema.findAll({
      Request: WorkSqlBindings,
      Result: BoardTopicRow,
      execute: (bindings) =>
        reader.unsafe(
          `
          SELECT
            topic_id,
            title,
            state,
            author_kind,
            author_seat_id,
            author_node_id,
            author_label,
            parts_json,
            post_count,
            last_activity_at,
            created_at
          FROM work_board_topics
          WHERE canvas_name = ? AND node_id = ?
          ${topicId === undefined ? "" : "AND topic_id = ?"}
          ORDER BY last_activity_at DESC, topic_id
        `,
          bindings,
        ),
    })([sink.canvasName, sink.nodeId, ...(topicId === undefined ? [] : [topicId])]);
    return yield* Effect.try(() =>
      rows.map((row): BoardTopicViewValue => {
        const parts = parseJson(row.parts_json);
        const posts = postsByTopic.get(row.topic_id) ?? [];
        const lastRead = readCursors.get(row.topic_id) ?? -1;
        const unreadPostCount = posts.filter(
          (post) => post.author.kind !== "operator" && post.position > lastRead,
        ).length;
        return {
          topicId: row.topic_id,
          title: row.title,
          state: row.state as BoardTopicViewValue["state"],
          openedBy: boardAuthorFromRow(row),
          openedAt: row.created_at,
          postCount: row.post_count,
          lastActivityAt: row.last_activity_at,
          unreadPostCount,
          ...(Array.isArray(parts) && parts.length > 0
            ? { parts: parts as BoardTopicViewValue["parts"] }
            : {}),
          ...(posts.length > 0 ? { posts } : {}),
        };
      }),
    );
  },
);

const loadArtifacts = Effect.fn("work.loadArtifacts")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  itemIds?: ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<ArtifactValue>, WorkSqlFailure> {
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: ArtifactProjectionRow,
    execute: (bindings) =>
      reader.unsafe(
        `
        SELECT
          artifact_id,
          actor_seat_id,
          name,
          parts_json,
          task_canvas_name,
          task_node_id,
          task_id,
          task_entity_home,
          metadata_json
        FROM work_artifacts
        WHERE canvas_name = ? AND node_id = ?
        ${itemIds === undefined ? "" : `AND artifact_id IN (${itemIds.map(() => "?").join(",")})`}
        ORDER BY origin_at DESC, artifact_id ASC
      `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, ...(itemIds ?? [])]);
  return yield* Effect.try(() =>
    rows.map((row) =>
      stampPublishedBySeat(
        Schema.decodeUnknownSync(
          Artifact,
          strictDecode,
        )({
          artifactId: row.artifact_id,
          ...(row.name === null ? {} : { name: row.name }),
          parts: parseJson(row.parts_json),
          ...(row.task_id === null
            ? {}
            : {
                task: {
                  kind: "task",
                  itemId: row.task_id,
                  sink: {
                    canvasName: row.task_canvas_name,
                    nodeId: row.task_node_id,
                  },
                },
              }),
          ...(row.metadata_json === null
            ? {}
            : { metadata: parseJson(row.metadata_json) }),
        }),
        row.actor_seat_id,
      ),
    ),
  );
});

const optionalString = (value: string | null): string | undefined =>
  value === null || value.length === 0 ? undefined : value;

const loadPad = Effect.fn("work.loadPad")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
): Effect.fn.Return<Pad, WorkSqlFailure> {
  const meta = yield* SqlSchema.findOneOption({
    Request: WorkSqlBindings,
    Result: PadRevisionRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT revision
      FROM work_pad_meta
      WHERE canvas_name = ? AND node_id = ?
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId]).pipe(Effect.map(Option.getOrUndefined));
  if (meta === undefined) return emptyPad();

  const imageRows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: PadImageRow,
    execute: (bindings) =>
      reader.unsafe(
        `
        SELECT element_id, x, y, w, h, z, ref_json
        FROM work_pad_images
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY z, element_id
      `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId]);
  const images = yield* Effect.try(() =>
    imageRows.map((row): PadImage => ({
      id: row.element_id as PadImage["id"],
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      z: row.z,
      ref: parseJson(row.ref_json) as PadImage["ref"],
    })),
  );

  const shapes = (yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: PadShapeRow,
    execute: (bindings) =>
      reader.unsafe(
        `
        SELECT element_id, type, x, y, w, h, z, fill, stroke, text, status
        FROM work_pad_shapes
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY z, element_id
      `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId])).map((row): PadShape => ({
    id: row.element_id as PadShape["id"],
    type: row.type,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    z: row.z,
    ...(optionalString(row.fill) === undefined
      ? {}
      : { fill: optionalString(row.fill) }),
    ...(optionalString(row.stroke) === undefined
      ? {}
      : { stroke: optionalString(row.stroke) }),
    ...(optionalString(row.text) === undefined
      ? {}
      : { text: optionalString(row.text) }),
    ...(row.status === null ? {} : { status: row.status }),
  }));

  const edges = (yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: PadEdgeRow,
    execute: (bindings) =>
      reader.unsafe(
        `
        SELECT element_id, from_id, to_id, from_side, to_side, label
        FROM work_pad_edges
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY element_id
      `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId])).map((row): PadEdge => ({
    id: row.element_id as PadEdge["id"],
    from: row.from_id as PadEdge["from"],
    to: row.to_id as PadEdge["to"],
    ...(row.from_side === null ? {} : { fromSide: row.from_side }),
    ...(row.to_side === null ? {} : { toSide: row.to_side }),
    ...(optionalString(row.label) === undefined
      ? {}
      : { label: optionalString(row.label) }),
  }));

  const inkRows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: PadInkRow,
    execute: (bindings) =>
      reader.unsafe(
        `
        SELECT element_id, z, color, width, points_json
        FROM work_pad_inks
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY z, element_id
      `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId]);
  const inks = yield* Effect.try(() =>
    inkRows.map((row): PadInk => ({
      id: row.element_id as PadInk["id"],
      z: row.z,
      color: row.color,
      width: row.width,
      points: parseJson(row.points_json) as PadInk["points"],
    })),
  );

  const pinRows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: PadPinRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT element_id, x, y, bounds_json, mentions_json
      FROM work_pad_pins
      WHERE canvas_name = ? AND node_id = ?
      ORDER BY element_id
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId]);
  const postRows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: PadPostRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT
        pin_id, post_id, position, author_kind,
        author_seat_id, author_node_id, author_label, parts_json
      FROM work_pad_posts
      WHERE canvas_name = ? AND node_id = ?
      ORDER BY pin_id, position
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId]);
  const postsByPin = new Map<string, PadPost[]>();
  for (const row of postRows) {
    const post: PadPost = {
      postId: row.post_id as PadPost["postId"],
      author: boardAuthorFromRow(row),
      parts: (yield* Effect.try(
        parseJson.bind(undefined, row.parts_json),
      )) as PadPost["parts"],
    };
    const list = postsByPin.get(row.pin_id) ?? [];
    list.push(post);
    postsByPin.set(row.pin_id, list);
  }
  const pins = yield* Effect.try(() =>
    pinRows.map((row): PadPin => ({
      id: row.element_id as PadPin["id"],
      x: row.x,
      y: row.y,
      ...(row.bounds_json === null
        ? {}
        : { bounds: parseJson(row.bounds_json) as PadPin["bounds"] }),
      mentions: parseJson(row.mentions_json) as PadPin["mentions"],
      posts: postsByPin.get(row.element_id) ?? [],
    })),
  );

  const decoded = decodePad({
    revision: meta.revision,
    images,
    shapes,
    edges,
    inks,
    pins,
  });
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(
      new Error(`stored pad is invalid: ${decoded.failure.message}`),
    );
  }
  return decoded.success;
});

const loadPadGlance = Effect.fn("work.loadPadGlance")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
): Effect.fn.Return<PadGlanceValue | undefined, WorkSqlFailure> {
  const meta = yield* SqlSchema.findOneOption({
    Request: WorkSqlBindings,
    Result: PadRevisionRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT revision
      FROM work_pad_meta
      WHERE canvas_name = ? AND node_id = ?
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId]).pipe(Effect.map(Option.getOrUndefined));
  if (meta === undefined) return undefined;
  const shapeCount =
    (yield* SqlSchema.findOneOption({
      Request: WorkSqlBindings,
      Result: CountRow,
      execute: (bindings) =>
        reader.unsafe(
          `
        SELECT count(*) AS n
        FROM work_pad_shapes
        WHERE canvas_name = ? AND node_id = ?
      `,
          bindings,
        ),
    })([sink.canvasName, sink.nodeId]).pipe(Effect.map(Option.getOrUndefined)))
      ?.n ?? 0;
  const unreadPinCount =
    (yield* SqlSchema.findOneOption({
      Request: WorkSqlBindings,
      Result: CountRow,
      execute: (bindings) =>
        reader.unsafe(
          `
        SELECT count(DISTINCT posts.pin_id) AS n
        FROM work_pad_posts AS posts
        LEFT JOIN work_pad_read_cursors AS cursors
          ON cursors.canvas_name = posts.canvas_name
          AND cursors.node_id = posts.node_id
          AND cursors.pin_id = posts.pin_id
          AND cursors.principal_key = ?
        WHERE posts.canvas_name = ? AND posts.node_id = ?
          AND posts.position > COALESCE(cursors.last_read_position, -1)
      `,
          bindings,
        ),
    })([PAD_GLANCE_PRINCIPAL_KEY, sink.canvasName, sink.nodeId]).pipe(
      Effect.map(Option.getOrUndefined),
    ))?.n ?? 0;
  return {
    revision: meta.revision,
    shapeCount,
    unreadPinCount,
  };
});

const idsOf = (items: ReadonlyArray<{ readonly id: string }>): Set<string> =>
  new Set(items.map((item) => item.id));

const persistPad = Effect.fn("work.persistPad")(function* (
  writer: SqlClient.SqlClient,
  sink: SinkRefValue,
  next: Pad,
  updatedAt: string,
): Effect.fn.Return<void, WorkSqlFailure> {
  yield* writer.unsafe(
    `
      INSERT INTO work_pad_meta(canvas_name, node_id, revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(canvas_name, node_id) DO UPDATE SET
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `,
    [sink.canvasName, sink.nodeId, next.revision, updatedAt],
  );

  const removeMissing = Effect.fn("work.removeMissing")(function* (
    table: string,
    keep: ReadonlySet<string>,
  ): Effect.fn.Return<void, WorkSqlFailure> {
    const existing = yield* SqlSchema.findAll({
      Request: WorkSqlBindings,
      Result: PadElementIdRow,
      execute: (bindings) =>
        writer.unsafe(
          `SELECT element_id FROM ${table} WHERE canvas_name = ? AND node_id = ?`,
          bindings,
        ),
    })([sink.canvasName, sink.nodeId]);
    for (const row of existing) {
      if (keep.has(row.element_id)) continue;
      yield* writer.unsafe(
        `DELETE FROM ${table} WHERE canvas_name = ? AND node_id = ? AND element_id = ?`,
        [sink.canvasName, sink.nodeId, row.element_id],
      );
    }
  });

  const existingPosts = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: PadPostIdRow,
    execute: (bindings) =>
      writer.unsafe(
        `
      SELECT pin_id, post_id
      FROM work_pad_posts
      WHERE canvas_name = ? AND node_id = ?
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId]);
  const nextPosts = new Set(
    next.pins.flatMap((pin) =>
      pin.posts.map((post) => `${pin.id}\0${post.postId}`),
    ),
  );
  for (const row of existingPosts) {
    if (nextPosts.has(`${row.pin_id}\0${row.post_id}`)) continue;
    yield* writer.unsafe(
      `
        DELETE FROM work_pad_posts
        WHERE canvas_name = ? AND node_id = ? AND pin_id = ? AND post_id = ?
      `,
      [sink.canvasName, sink.nodeId, row.pin_id, row.post_id],
    );
  }

  yield* removeMissing("work_pad_images", idsOf(next.images));
  yield* removeMissing("work_pad_shapes", idsOf(next.shapes));
  yield* removeMissing("work_pad_edges", idsOf(next.edges));
  yield* removeMissing("work_pad_inks", idsOf(next.inks));
  yield* removeMissing("work_pad_pins", idsOf(next.pins));

  for (const image of next.images) {
    yield* writer.unsafe(
      `
        INSERT INTO work_pad_images(
          canvas_name, node_id, element_id, x, y, w, h, z, ref_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canvas_name, node_id, element_id) DO UPDATE SET
          x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
          z = excluded.z, ref_json = excluded.ref_json
      `,
      [
        sink.canvasName,
        sink.nodeId,
        image.id,
        image.x,
        image.y,
        image.w,
        image.h,
        image.z,
        JSON.stringify(image.ref),
      ],
    );
  }
  for (const shape of next.shapes) {
    yield* writer.unsafe(
      `
        INSERT INTO work_pad_shapes(
          canvas_name, node_id, element_id, type, x, y, w, h, z,
          fill, stroke, text, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canvas_name, node_id, element_id) DO UPDATE SET
          type = excluded.type, x = excluded.x, y = excluded.y,
          w = excluded.w, h = excluded.h, z = excluded.z,
          fill = excluded.fill, stroke = excluded.stroke,
          text = excluded.text, status = excluded.status
      `,
      [
        sink.canvasName,
        sink.nodeId,
        shape.id,
        shape.type,
        shape.x,
        shape.y,
        shape.w,
        shape.h,
        shape.z,
        shape.fill ?? null,
        shape.stroke ?? null,
        shape.text ?? null,
        shape.status ?? null,
      ],
    );
  }
  for (const edge of next.edges) {
    yield* writer.unsafe(
      `
        INSERT INTO work_pad_edges(
          canvas_name, node_id, element_id, from_id, to_id,
          from_side, to_side, label
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canvas_name, node_id, element_id) DO UPDATE SET
          from_id = excluded.from_id, to_id = excluded.to_id,
          from_side = excluded.from_side, to_side = excluded.to_side,
          label = excluded.label
      `,
      [
        sink.canvasName,
        sink.nodeId,
        edge.id,
        edge.from,
        edge.to,
        edge.fromSide ?? null,
        edge.toSide ?? null,
        edge.label ?? null,
      ],
    );
  }
  for (const ink of next.inks) {
    yield* writer.unsafe(
      `
        INSERT INTO work_pad_inks(
          canvas_name, node_id, element_id, z, color, width, points_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canvas_name, node_id, element_id) DO UPDATE SET
          z = excluded.z, color = excluded.color, width = excluded.width,
          points_json = excluded.points_json
      `,
      [
        sink.canvasName,
        sink.nodeId,
        ink.id,
        ink.z,
        ink.color,
        ink.width,
        JSON.stringify(ink.points),
      ],
    );
  }
  for (const pin of next.pins) {
    yield* writer.unsafe(
      `
        INSERT INTO work_pad_pins(
          canvas_name, node_id, element_id, x, y, bounds_json, mentions_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canvas_name, node_id, element_id) DO UPDATE SET
          x = excluded.x, y = excluded.y,
          bounds_json = excluded.bounds_json,
          mentions_json = excluded.mentions_json
      `,
      [
        sink.canvasName,
        sink.nodeId,
        pin.id,
        pin.x,
        pin.y,
        pin.bounds === undefined ? null : JSON.stringify(pin.bounds),
        JSON.stringify(pin.mentions),
      ],
    );
    yield* Effect.forEach(pin.posts, (post, position) =>
      Effect.gen(function* () {
        yield* writer.unsafe(
          `
          INSERT INTO work_pad_posts(
            canvas_name, node_id, pin_id, post_id, position,
            author_kind, author_seat_id, author_node_id, author_label,
            parts_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(canvas_name, node_id, pin_id, post_id) DO UPDATE SET
            position = excluded.position,
            author_kind = excluded.author_kind,
            author_seat_id = excluded.author_seat_id,
            author_node_id = excluded.author_node_id,
            author_label = excluded.author_label,
            parts_json = excluded.parts_json
        `,
          [
            sink.canvasName,
            sink.nodeId,
            pin.id,
            post.postId,
            position,
            post.author.kind,
            post.author.seatId ?? null,
            post.author.nodeId ?? null,
            post.author.label ?? null,
            JSON.stringify(post.parts),
          ],
        );
      }),
    );
  }
});

/** Attention policy sees every claimant without loading threads or work contents. */
export const readWorkAttention = Effect.fn("work.attention")(function* (
  reader: SqlClient.SqlClient,
  input: WorkAttentionQuery,
): Effect.fn.Return<ReadonlyArray<WorkAttentionRow>, WorkSqlFailure> {
  const query = yield* Schema.decodeUnknownEffect(WorkAttentionQuery, strictDecode)(input);
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: Schema.Struct({ node_id: Schema.String, item_id: Schema.String, kind: Schema.Literals(["task", "requests"]),
      state: Schema.Literals(["working", "input-required", "auth-required"]),
      actor_seat_id: Schema.NullOr(ActorSeatIdSchema),
      metadata_json: Schema.NullOr(Schema.String), origin_at: Schema.String, brief: Schema.NullOr(Schema.String) }),
    execute: (bindings) => reader.unsafe(["work_tasks", "work_requests"].map((table) => `
      SELECT work.node_id, '${table === "work_tasks" ? "task" : "requests"}' AS kind, ${table === "work_tasks" ? "task_id" : "request_id"} AS item_id,
        work.state, work.actor_seat_id, work.metadata_json, work.origin_at,
        (SELECT json_extract(part.value, '$.text') FROM json_each(
          (SELECT message.parts_json FROM work_task_messages AS message
            WHERE message.canvas_name = work.canvas_name AND message.node_id = work.node_id
              AND message.parent_lane = '${table === "work_tasks" ? "task" : "request"}'
              AND message.item_id = work.${table === "work_tasks" ? "task_id" : "request_id"}
            ORDER BY message.position LIMIT 1)
        ) AS part WHERE json_extract(part.value, '$.kind') = 'text' ORDER BY part.key LIMIT 1) AS brief
      FROM ${table} AS work JOIN ${table === "work_tasks" ? "task_boards" : "request_boards"} AS node
        ON node.canvas_name = work.canvas_name AND node.id = work.node_id
      WHERE work.canvas_name = ?
        ${query.nodeId === undefined ? "" : "AND work.node_id = ?"}
        AND (state IN ('input-required','auth-required') OR (state = 'working' AND actor_seat_id IS NOT NULL))`).join(" UNION ALL "), bindings),
  })([0, 1].flatMap(() => [query.canvasName, ...(query.nodeId === undefined ? [] : [query.nodeId])]));
  return rows.map((row) => ({ nodeId: row.node_id, kind: row.kind, item: {
    id: row.item_id, state: row.state, history: [],
    ...(row.brief === null ? {} : { metadata: { title: row.brief.split(/\r?\n/, 1)[0] ?? row.item_id } }),
    ...(row.actor_seat_id === null ? {} : { claimedBy: row.actor_seat_id }),
    stateSince: rowStateSince(row),
  }}));
});

/** Complete task policy fields without messages, reviews or artifact bodies. */
const readWorkTaskPolicy = Effect.fn("work.task.policy")(function* (
  reader: SqlClient.SqlClient,
  input: WorkAttentionQuery,
): Effect.fn.Return<ReadonlyArray<WorkLaneRow>, WorkSqlFailure> {
  const query = yield* Schema.decodeUnknownEffect(WorkAttentionQuery, strictDecode)(input);
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: Schema.Struct({ ...TaskRowSchema.fields, depends_on_json: Schema.String }),
    execute: (bindings) => reader.unsafe(`SELECT work.*,work.task_id AS item_id,
      (SELECT json_group_array(depends_on_task_id) FROM (
        SELECT depends_on_task_id FROM work_task_dependencies AS dependency
        WHERE dependency.canvas_name=work.canvas_name AND dependency.node_id=work.node_id
          AND dependency.task_id=work.task_id ORDER BY position,depends_on_task_id
      )) AS depends_on_json
      FROM work_tasks AS work JOIN task_boards AS node
        ON node.canvas_name=work.canvas_name AND node.id=work.node_id
      WHERE work.canvas_name=? ${query.nodeId === undefined ? "" : "AND work.node_id=?"}
        AND work.state != 'archived'
      ORDER BY work.node_id,work.created_at,work.task_id`, bindings),
  })([query.canvasName, ...(query.nodeId === undefined ? [] : [query.nodeId])]);
  return yield* Effect.forEach(rows, (row) => Effect.gen(function* () {
    const dependsOn = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
      yield* Effect.try(() => JSON.parse(row.depends_on_json)),
    );
    const item = yield* taskFromRow(reader, { canvasName: query.canvasName, nodeId: row.node_id }, "task", row, dependsOn, undefined, []);
    return { nodeId: row.node_id, item };
  }));
});

/** Seat ledger pages hydrate only the selected rows, across live sinks. */
export const readWorkActorPage = Effect.fn("work.actor.page")(function* (
  reader: SqlClient.SqlClient, input: WorkActorQuery,
): Effect.fn.Return<WorkActorPage, WorkSqlFailure> {
  const query = yield* Schema.decodeUnknownEffect(WorkActorQuery, strictDecode)(input);
  const [table, nodes, id] = query.kind === "task" ? ["work_tasks", "task_boards", "task_id"]
    : query.kind === "requests" ? ["work_requests", "request_boards", "request_id"]
    : ["work_artifacts", "artifact_boards", "artifact_id"];
  const limit = query.limit ?? WORK_SINK_PAGE_SIZE;
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: Schema.Struct({ node_id: Schema.String, item_id: Schema.String }),
    execute: (bindings) => reader.unsafe(`
      SELECT work.node_id, work.${id} AS item_id
      FROM ${table} AS work JOIN ${nodes} AS node
        ON node.canvas_name = work.canvas_name AND node.id = work.node_id
      WHERE work.canvas_name = ? AND ${query.kind === "task"
        ? `json_extract(work.metadata_json, '$."junto.tasks".raisedBy.seatId') = ? AND work.state != 'archived'`
        : "work.actor_seat_id = ?"}
      ${query.beforeId === undefined ? "" : `AND (work.${id} < ? OR (work.${id} = ? AND work.node_id > ?))`}
      ORDER BY work.${id} DESC, work.node_id LIMIT ?`, bindings),
  })([query.canvasName, query.seatId, ...(query.beforeId === undefined ? [] : [query.beforeId, query.beforeId, query.beforeNodeId ?? ""]), limit + 1]);
  const selected = rows.slice(0, limit);
  const next = rows.length > limit ? { nextBeforeId: selected.at(-1)!.item_id, nextBeforeNodeId: selected.at(-1)!.node_id } : {};
  const grouped = new Map<string, string[]>();
  for (const row of selected) {
    const ids = grouped.get(row.node_id) ?? []; ids.push(row.item_id); grouped.set(row.node_id, ids);
  }
  if (query.kind === "artifacts") {
    const items = [];
    for (const [nodeId, ids] of grouped) {
      for (const item of yield* loadArtifacts(reader, { canvasName: query.canvasName, nodeId }, ids))
        items.push({ nodeId, item });
    }
    items.sort((a, b) => b.item.artifactId.localeCompare(a.item.artifactId));
    return { kind: "artifacts", items, ...next };
  }
  const items: WorkLaneRow[] = [];
  for (const [nodeId, ids] of grouped) {
    for (const item of yield* loadLaneTasks(reader, { canvasName: query.canvasName, nodeId }, query.kind === "task" ? "task" : "request", ids))
      items.push({ nodeId, item });
  }
  items.sort((a, b) => b.item.id.localeCompare(a.item.id) || a.nodeId.localeCompare(b.nodeId));
  return { kind: query.kind, items, ...next };
});

/** Read one kind's page without assembling a canvas or unrelated work lanes. */
export const readWorkSinkPage = Effect.fn("work.sink.page")(function* (
  reader: SqlClient.SqlClient,
  input: WorkSinkQuery,
): Effect.fn.Return<WorkSinkPage, WorkSqlFailure> {
  const query = yield* Schema.decodeUnknownEffect(WorkSinkQuery, strictDecode)(input);
  const sink = { canvasName: query.canvasName, nodeId: query.nodeId };
  if (query.kind === "pad") {
    const glance = yield* loadPadGlance(reader, sink);
    return { kind: "pad", ...(glance === undefined ? {} : { glance }) };
  }
  const [table, id] = query.kind === "task" ? ["work_tasks", "task_id"]
    : query.kind === "requests" ? ["work_requests", "request_id"]
    : query.kind === "artifacts" ? ["work_artifacts", "artifact_id"]
    : ["work_board_topics", "topic_id"];
  const limit = query.limit ?? WORK_SINK_PAGE_SIZE;
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings, Result: Schema.Struct({ id: Schema.String }),
    execute: (bindings) => reader.unsafe(`SELECT ${id} AS id FROM ${table}
      WHERE canvas_name = ? AND node_id = ?
      ${query.kind === "task" ? "AND state != 'archived'" : ""}
      ${query.beforeId === undefined ? "" : `AND ${id} < ?`}
      ORDER BY ${id} DESC LIMIT ?`, bindings),
  })([sink.canvasName, sink.nodeId, ...(query.beforeId === undefined ? [] : [query.beforeId]), limit + 1]);
  const ids = rows.slice(0, limit).map((row) => row.id);
  const next = rows.length > limit ? { nextBeforeId: ids.at(-1)! } : {};
  const byIdDescending = (a: string, b: string) => a < b ? 1 : a > b ? -1 : 0;
  if (query.kind === "task" || query.kind === "requests") return {
    kind: query.kind, items: ids.length === 0 ? [] : [...(yield* loadLaneTasks(reader, sink, query.kind === "task" ? "task" : "request", ids))].sort((a, b) => byIdDescending(a.id, b.id)), ...next,
  };
  if (query.kind === "artifacts") return {
    kind: "artifacts", items: ids.length === 0 ? [] : [...(yield* loadArtifacts(reader, sink, ids))].sort((a, b) => byIdDescending(a.artifactId, b.artifactId)), ...next,
  };
  const topics = ids.length === 0 ? [] : yield* reader.unsafe<{
    topic_id: string; title: string; state: "open" | "archived"; post_count: number;
    last_activity_at: string; author_label: string | null; unread: number;
  }>(`SELECT topic_id,title,state,post_count,last_activity_at,author_label,
    (SELECT count(*) FROM work_board_posts AS post
      LEFT JOIN work_board_read_cursors AS cursor
      ON cursor.canvas_name = post.canvas_name AND cursor.node_id = post.node_id
        AND cursor.topic_id = post.topic_id AND cursor.principal_key = 'operator'
      WHERE post.canvas_name = topic.canvas_name AND post.node_id = topic.node_id
        AND post.topic_id = topic.topic_id AND post.author_kind != 'operator'
        AND post.position > coalesce(cursor.last_read_position,-1)) AS unread
    FROM work_board_topics AS topic WHERE canvas_name = ? AND node_id = ?
      AND topic_id IN (${ids.map(() => "?").join(",")})`, [sink.canvasName, sink.nodeId, ...ids]);
  return { kind: "board", items: topics.map((row) => ({
    topicId: row.topic_id, title: row.title, state: row.state,
    postCount: row.post_count, lastActivityAt: row.last_activity_at,
    unreadPostCount: row.unread, ...(row.author_label === null ? {} : { authorLabel: row.author_label }),
  })), ...next };
});

const normalizeRecentOpsLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return WORK_SEAT_RECENT_OP_DEFAULT_LIMIT;
  }
  return Math.min(
    WORK_SEAT_RECENT_OP_MAX_LIMIT,
    Math.max(1, Math.trunc(limit)),
  );
};

const boundedRecentOpLabel = (value: string | null): string | undefined => {
  if (value === null || value.length === 0) return undefined;
  const clipped = value.slice(0, WORK_SEAT_RECENT_OP_MAX_LABEL_CHARS);
  const lastCodeUnit = clipped.charCodeAt(clipped.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ? clipped.slice(0, -1)
    : clipped;
};

const recentOpSummary = (
  row: RecentSeatOpRow,
): WorkSeatRecentOpValue["summary"] => {
  switch (row.operation) {
    case "task.claim":
      return { kind: "task", taskId: row.item_id };
    case "request.create":
      return { kind: "request", requestId: row.item_id };
    case "message.append":
      return { kind: "message", messageId: row.item_id };
    case "artifact.publish":
      const artifactName = boundedRecentOpLabel(row.summary_label);
      return {
        kind: "artifact",
        artifactId: row.item_id,
        ...(artifactName === undefined ? {} : { name: artifactName }),
        ...(row.related_id === null ? {} : { taskId: row.related_id }),
      };
    case "delivery.accepted":
      if (
        row.related_kind === null ||
        row.related_id === null ||
        row.related_node_id === null
      ) {
        throw new Error("delivery receipt summary is incomplete");
      }
      return {
        kind: "delivery",
        deliveryId: row.item_id,
        delivered: {
          kind: row.related_kind,
          itemId: row.related_id,
          targetNodeId: row.related_node_id,
        },
      };
    case "board.topic.create":
      const topicTitle = boundedRecentOpLabel(row.summary_label);
      if (topicTitle === undefined) {
        throw new Error("board topic summary is missing its title");
      }
      return {
        kind: "topic",
        topicId: row.item_id,
        title: topicTitle,
      };
    case "board.post.append":
      if (row.related_id === null) {
        throw new Error("board post summary is missing its topic id");
      }
      return {
        kind: "post",
        postId: row.item_id,
        topicId: row.related_id,
      };
    default:
      // The corrective startup conversion removes invalid operations before
      // this read path runs; a surviving row is corrupt and must not project.
      throw new Error(
        `recent seat operation ${JSON.stringify(row.operation)} is not projected`,
      );
  }
};

/**
 * Actor attribution comes only from the successful fact's explicit actor
 * field. A task claimant is deliberately not used for describe/transition:
 * operator IPC may issue the same mutation against that actor's task.
 */
const recentOpsForSeat = Effect.fn("work.recentOpsForSeat")(function* (
  reader: SqlClient.SqlClient,
  input: {
    readonly canvasName: string;
    readonly actorSeatId: ActorSeatId;
    readonly limit?: number;
  },
): Effect.fn.Return<WorkSeatRecentOpsFeed, WorkSqlFailure> {
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: RecentSeatOpRowSchema,
    execute: (bindings) =>
      reader.unsafe(
        `
      WITH fact_rows AS (
        SELECT
          fact_event.operation,
          fact_event.origin_at AS origin_at,
          fact_event.origin_at AS applied_at,
          fact_event.received_at AS observed_at,
          fact_event.item_node_id AS target_node_id,
          fact_event.item_kind AS item_kind,
          fact_event.item_id AS item_id,
          fact.result_json AS result_json,
          fact_event.event_home,
          fact_event.entity_home,
          fact_event.seq
        FROM work_events AS fact_event
        JOIN work_facts AS fact
          ON fact.event_home = fact_event.event_home
          AND fact.entity_home = fact_event.entity_home
          AND fact.seq = fact_event.seq
        WHERE fact_event.record_type = 'fact'
          AND fact_event.item_canvas_name = ?
          AND fact_event.operation IN (
            'task.claim',
            'request.create',
            'message.append',
            'artifact.publish',
            'delivery.accepted',
            'board.topic.create',
            'board.post.append'
          )
      ),
      attributed AS (
        SELECT
          *,
          CASE operation
            WHEN 'task.claim' THEN
              json_extract(result_json, '$.claimedBy.seatId')
            WHEN 'request.create' THEN
              json_extract(result_json, '$.request.claimedBy')
            WHEN 'message.append' THEN
              json_extract(result_json, '$.sentBy.seatId')
            WHEN 'artifact.publish' THEN
              json_extract(result_json, '$.publishedBy.seatId')
            WHEN 'delivery.accepted' THEN
              json_extract(result_json, '$.receipt.actor.seatId')
            WHEN 'board.topic.create' THEN
              CASE
                WHEN json_extract(result_json, '$.createdBy.kind') = 'actor'
                  THEN json_extract(result_json, '$.createdBy.seatId')
                ELSE NULL
              END
            WHEN 'board.post.append' THEN
              CASE
                WHEN json_extract(result_json, '$.createdBy.kind') = 'actor'
                  THEN json_extract(result_json, '$.createdBy.seatId')
                ELSE NULL
              END
            ELSE NULL
          END AS actor_seat_id
        FROM fact_rows
      )
      SELECT
        operation,
        origin_at,
        applied_at,
        target_node_id,
        item_kind,
        item_id,
        CASE operation
          WHEN 'artifact.publish' THEN substr(
            json_extract(result_json, '$.artifact.name'),
            1,
            ${WORK_SEAT_RECENT_OP_MAX_LABEL_CHARS}
          )
          WHEN 'board.topic.create' THEN substr(
            json_extract(result_json, '$.topic.title'),
            1,
            ${WORK_SEAT_RECENT_OP_MAX_LABEL_CHARS}
          )
          ELSE NULL
        END AS summary_label,
        CASE operation
          WHEN 'delivery.accepted' THEN
            json_extract(result_json, '$.receipt.deliveredItem.kind')
          ELSE NULL
        END AS related_kind,
        CASE operation
          WHEN 'artifact.publish' THEN
            json_extract(result_json, '$.artifact.task.itemId')
          WHEN 'delivery.accepted' THEN
            json_extract(result_json, '$.receipt.deliveredItem.itemId')
          WHEN 'board.post.append' THEN
            json_extract(result_json, '$.post.topicId')
          ELSE NULL
        END AS related_id,
        CASE operation
          WHEN 'delivery.accepted' THEN
            json_extract(result_json, '$.receipt.deliveredItem.sink.nodeId')
          ELSE NULL
        END AS related_node_id
      FROM attributed
      WHERE actor_seat_id = ?
      ORDER BY
        applied_at DESC,
        observed_at DESC,
        event_home DESC,
        entity_home DESC,
        length(seq) DESC,
        seq DESC
      LIMIT ?
    `,
        bindings,
      ),
  })([
    input.canvasName,
    input.actorSeatId,
    normalizeRecentOpsLimit(input.limit),
  ]);
  const operations = yield* Effect.try(() =>
    rows.map((row) =>
      Schema.decodeUnknownSync(
        WorkSeatRecentOp,
        strictDecode,
      )({
        operation: row.operation,
        originAt: row.origin_at,
        appliedAt: row.applied_at,
        targetNodeId: row.target_node_id,
        summary: recentOpSummary(row),
      }),
    ),
  );
  return {
    operations,
    lastOpAt: operations[0]?.appliedAt ?? null,
    coverage: WORK_SEAT_RECENT_OPS_COVERAGE,
  };
});

/** One primary-key lookup of the canvas's current Work mutation counter. */
export const readCanvasWorkRevision = Effect.fn("work.readCanvasWorkRevision")(
  function* (
    reader: SqlClient.SqlClient,
    canvasName: string,
  ): Effect.fn.Return<string, WorkSqlFailure> {
    return (
      (yield* SqlSchema.findOneOption({
        Request: WorkSqlBindings,
        Result: WorkRevisionRow,
        execute: (bindings) =>
          reader.unsafe(
            `
      SELECT CAST(revision AS TEXT) AS work_revision
      FROM work_canvas_revisions
      WHERE canvas_name = ?
    `,
            bindings,
          ),
      })([canvasName]).pipe(Effect.map(Option.getOrUndefined)))
        ?.work_revision ?? "0"
    );
  },
);

const currentIdentity = (
  row: Pick<IdentityRow, "fact_event_home" | "fact_entity_home" | "fact_seq">,
): WorkRecordId =>
  recordId(
    row.fact_event_home as InstallationId,
    row.fact_entity_home as InstallationId,
    row.fact_seq,
  );

const selectTaskIdentity = Effect.fn("work.selectTaskIdentity")(function* (
  reader: SqlClient.SqlClient,
  lane: "task" | "request",
  sink: SinkRefValue,
  itemId: string,
): Effect.fn.Return<IdentityRow | undefined, WorkSqlFailure> {
  const table = lane === "task" ? "work_tasks" : "work_requests";
  const id = lane === "task" ? "task_id" : "request_id";
  return yield* SqlSchema.findOneOption({
    Request: WorkSqlBindings,
    Result: IdentityRowSchema,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        state
      FROM ${table}
      WHERE canvas_name = ? AND node_id = ? AND ${id} = ?
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, itemId]).pipe(
    Effect.map(Option.getOrUndefined),
  );
});

const loadTask = Effect.fn("work.loadTask")(function* (
  reader: SqlClient.SqlClient,
  lane: "task" | "request",
  sink: SinkRefValue,
  itemId: string,
): Effect.fn.Return<
  { readonly row: IdentityRow; readonly task: TaskValue } | undefined,
  WorkSqlFailure
> {
  const row = yield* selectTaskIdentity(reader, lane, sink, itemId);
  if (row === undefined) return undefined;
  const table = lane === "task" ? "work_tasks" : "work_requests";
  const id = lane === "task" ? "task_id" : "request_id";
  const detail = yield* SqlSchema.findOneOption({
    Request: WorkSqlBindings,
    Result: TaskRowSchema,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT
        canvas_name,
        node_id,
        ${id} AS item_id,
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        state,
        artifact_ids_json,
        metadata_json,
        reason,
        response,
        created_at
      FROM ${table}
      WHERE canvas_name = ? AND node_id = ? AND ${id} = ?
    `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, itemId]).pipe(
    Effect.map(Option.getOrUndefined),
  );
  if (detail === undefined) return undefined;
  const dependsOn =
    lane === "task"
      ? yield* loadTaskDependsOn(reader, sink, itemId)
      : undefined;
  const finish =
    lane === "task" ? yield* loadTaskFinish(reader, sink, itemId) : undefined;
  return {
    row,
    task: yield* taskFromRow(reader, sink, lane, detail, dependsOn, finish),
  };
});

const authorityError = (
  reason: WorkAuthorityError["reason"],
  message: string,
): WorkAuthorityError => WorkAuthorityError.make({ reason, message });

const assertArtifactTaskReference = Effect.fn(
  "work.assertArtifactTaskReference",
)(function* (
  reader: SqlClient.SqlClient,
  artifactSink: SinkRefValue,
  artifact: ArtifactValue,
  entityHome: InstallationId,
): Effect.fn.Return<void, WorkSqlFailure> {
  const taskRef = artifact.task;
  if (taskRef === undefined) return;
  if (taskRef.sink.canvasName !== artifactSink.canvasName) {
    return yield* Effect.fail(
      authorityError(
        "target-mismatch",
        "artifact task reference must belong to the artifact canvas",
      ),
    );
  }
  const current = yield* loadTask(reader, "task", taskRef.sink, taskRef.itemId);
  if (current === undefined) {
    return yield* Effect.fail(
      authorityError(
        "missing-entity",
        `artifact task "${taskRef.itemId}" does not exist`,
      ),
    );
  }
  if (current.row.entity_home !== entityHome) {
    return yield* Effect.fail(
      authorityError(
        "authority-mismatch",
        `artifact task "${taskRef.itemId}" is homed on another installation`,
      ),
    );
  }
  if (current.task.claimedBy === undefined) {
    return yield* Effect.fail(
      authorityError(
        "invalid-transition",
        `artifact task "${taskRef.itemId}" must be claimed before linkage`,
      ),
    );
  }
});

type ThreadMessageDestination = Exclude<
  MessageAppendDestination,
  { readonly kind: "mailbox" }
>;

const requireThreadParent = Effect.fn("work.requireThreadParent")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  destination: ThreadMessageDestination,
  entityHome: InstallationId,
): Effect.fn.Return<IdentityRow, WorkSqlFailure> {
  const parent = yield* selectTaskIdentity(
    reader,
    destination.kind,
    sink,
    destination.itemId,
  );
  if (parent === undefined) {
    return yield* Effect.fail(
      authorityError(
        "missing-entity",
        `${destination.kind} "${destination.itemId}" does not exist at the message sink`,
      ),
    );
  }
  if (parent.entity_home !== entityHome) {
    return yield* Effect.fail(
      authorityError(
        "authority-mismatch",
        `${destination.kind} message history must share its parent entity home`,
      ),
    );
  }
  return parent;
});

const assertMessageIdentityAvailable = Effect.fn(
  "work.assertMessageIdentityAvailable",
)(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  messageId: string,
): Effect.fn.Return<void, WorkSqlFailure> {
  const existing = yield* SqlSchema.findOneOption({
    Request: WorkSqlBindings,
    Result: ExistsRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT 1
      FROM work_messages
      WHERE canvas_name = ? AND node_id = ? AND message_id = ?
      UNION ALL
      SELECT 1
      FROM work_task_messages
      WHERE canvas_name = ? AND node_id = ? AND message_id = ?
      LIMIT 1
    `,
        bindings,
      ),
  })([
    sink.canvasName,
    sink.nodeId,
    messageId,
    sink.canvasName,
    sink.nodeId,
    messageId,
  ]).pipe(Effect.map(Option.getOrUndefined));
  if (existing !== undefined) {
    return yield* Effect.fail(
      authorityError(
        "identity-conflict",
        `message "${messageId}" already exists at the sink`,
      ),
    );
  }
});

const toRepositoryError = (
  operation: string,
  error: unknown,
): WorkRepositoryError => {
  const cause = Cause.isUnknownError(error) ? error.cause : error;
  return cause instanceof WorkRepositoryError
    ? cause
    : WorkRepositoryError.make({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
};

const unwrapStateFailure = <E extends Error>(
  operation: string,
  error: unknown,
  DomainError: new (...args: never[]) => E,
): WorkRepositoryError | E => {
  if (error instanceof DomainError) return error;
  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { readonly cause: unknown }).cause
      : undefined;
  return cause instanceof DomainError
    ? cause
    : toRepositoryError(operation, error);
};

const writeTaskMessages = Effect.fn("work.writeTaskMessages")(function* (
  writer: SqlClient.SqlClient,
  lane: "task" | "request",
  sink: SinkRefValue,
  task: TaskValue,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  yield* writer.unsafe(
    `
      DELETE FROM work_task_messages
      WHERE canvas_name = ?
        AND node_id = ?
        AND parent_lane = ?
        AND item_id = ?
    `,
    [sink.canvasName, sink.nodeId, lane, task.id],
  );
  yield* Effect.forEach(task.history, (message, position) =>
    Effect.gen(function* () {
      yield* writer.unsafe(
        `
        INSERT INTO work_task_messages(
          canvas_name,
          node_id,
          parent_lane,
          item_id,
          message_id,
          position,
          message_kind,
          entity_home,
          fact_event_home,
          fact_entity_home,
          fact_seq,
          role,
          parts_json,
          context_id,
          reference_task_ids_json,
          metadata_json,
          origin_at,
          received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          sink.canvasName,
          sink.nodeId,
          lane,
          task.id,
          message.messageId,
          position,
          position === 0 ? "brief" : "history",
          fact.id.route.entityHome,
          fact.id.route.eventHome,
          fact.id.route.entityHome,
          fact.id.seq,
          message.role,
          canonicalJson(message.parts),
          message.contextId ?? null,
          message.referenceTaskIds === undefined
            ? null
            : canonicalJson(message.referenceTaskIds),
          message.metadata === undefined
            ? null
            : canonicalJson(message.metadata),
          fact.originAt,
          receivedAt,
        ],
      );
    }),
  );
});

const writeTransition = Effect.fn("work.writeTransition")(function* (
  writer: SqlClient.SqlClient,
  lane: "task" | "request",
  sink: SinkRefValue,
  task: TaskValue,
  fromState: TaskState | null,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  const ordinal = Number(
    (yield* SqlSchema.findOneOption({
      Request: WorkSqlBindings,
      Result: NextOrdinalRow,
      execute: (bindings) =>
        writer.unsafe(
          `
        SELECT coalesce(max(ordinal) + 1, 0) AS next_ordinal
        FROM work_task_transitions
        WHERE canvas_name = ?
          AND node_id = ?
          AND item_id = ?
          AND lane = ?
      `,
          bindings,
        ),
    })([sink.canvasName, sink.nodeId, task.id, lane]).pipe(
      Effect.map(Option.getOrUndefined),
    ))?.next_ordinal ?? 0,
  );
  yield* writer.unsafe(
    `
      INSERT INTO work_task_transitions(
        canvas_name,
        node_id,
        item_id,
        ordinal,
        lane,
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        operation,
        from_state,
        to_state,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      sink.canvasName,
      sink.nodeId,
      task.id,
      ordinal,
      lane,
      fact.id.route.entityHome,
      task.claimedBy ?? null,
      fact.id.route.eventHome,
      fact.id.route.entityHome,
      fact.id.seq,
      fact.operation,
      fromState,
      task.state,
      fact.originAt,
      receivedAt,
    ],
  );
});

const writeTask = Effect.fn("work.writeTask")(function* (
  writer: SqlClient.SqlClient,
  lane: "task" | "request",
  sink: SinkRefValue,
  task: TaskValue,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  const previous = yield* selectTaskIdentity(writer, lane, sink, task.id);
  const table = lane === "task" ? "work_tasks" : "work_requests";
  const id = lane === "task" ? "task_id" : "request_id";
  const stored = yield* SqlSchema.findOneOption({
    Request: WorkSqlBindings,
    Result: StoredTaskStateRow,
    execute: (bindings) =>
      writer.unsafe(
        `
        SELECT created_at, state, metadata_json, origin_at
        FROM ${table}
        WHERE canvas_name = ? AND node_id = ? AND ${id} = ?
      `,
        bindings,
      ),
  })([sink.canvasName, sink.nodeId, task.id]).pipe(
    Effect.map(Option.getOrUndefined),
  );
  const createdAt = stored?.created_at ?? fact.originAt;
  // The state's clock restarts only when the state changes: a fact that
  // leaves it alone (a note, a check result) keeps the time it began.
  const stateSince =
    stored !== undefined && stored.state === task.state
      ? rowStateSince(stored)
      : fact.originAt;
  // Task-specific fields fold into the metadata bag on write; taskFromRow
  // lifts them back into first-class Task fields (see TASK_METADATA_BAG_KEY).
  const metadata = foldTaskMetadata(task, stateSince);
  const common = [
    sink.canvasName,
    sink.nodeId,
    task.id,
    fact.id.route.entityHome,
    task.claimedBy ?? null,
    fact.id.route.eventHome,
    fact.id.route.entityHome,
    fact.id.seq,
    task.state,
    task.history[0]?.messageId ?? task.id,
    task.artifactIds === undefined ? null : canonicalJson(task.artifactIds),
    canonicalJson(metadata),
    task.reason ?? null,
    task.response ?? null,
    createdAt,
    fact.originAt,
    fact.originAt,
    receivedAt,
  ];
  yield* writer.unsafe(
    `
      INSERT INTO ${table}(
        canvas_name,
        node_id,
        ${id},
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        state,
        brief_message_id,
        artifact_ids_json,
        metadata_json,
        reason,
        response,
        created_at,
        updated_at,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canvas_name, node_id, ${id}) DO UPDATE SET
        entity_home = excluded.entity_home,
        actor_seat_id = excluded.actor_seat_id,
        fact_event_home = excluded.fact_event_home,
        fact_entity_home = excluded.fact_entity_home,
        fact_seq = excluded.fact_seq,
        state = excluded.state,
        brief_message_id = excluded.brief_message_id,
        artifact_ids_json = excluded.artifact_ids_json,
        metadata_json = excluded.metadata_json,
        reason = excluded.reason,
        response = excluded.response,
        updated_at = excluded.updated_at,
        origin_at = excluded.origin_at,
        received_at = excluded.received_at
    `,
    common,
  );
  if (lane === "task") {
    yield* writeTaskDependsOn(writer, sink, task.id, task.dependsOn);
    yield* writeTaskFinish(writer, sink, task);
  }
  yield* writeTaskMessages(writer, lane, sink, task, fact, receivedAt);
  yield* writeTransition(
    writer,
    lane,
    sink,
    task,
    previous?.state ?? null,
    fact,
    receivedAt,
  );
});

const writeThreadMessage = Effect.fn("work.writeThreadMessage")(function* (
  writer: SqlClient.SqlClient,
  sink: SinkRefValue,
  destination: ThreadMessageDestination,
  message: MessageValue,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  const position = Number(
    (yield* SqlSchema.findOneOption({
      Request: WorkSqlBindings,
      Result: NextPositionRow,
      execute: (bindings) =>
        writer.unsafe(
          `
        SELECT coalesce(max(position) + 1, 0) AS next_position
        FROM work_task_messages
        WHERE canvas_name = ?
          AND node_id = ?
          AND parent_lane = ?
          AND item_id = ?
      `,
          bindings,
        ),
    })([
      sink.canvasName,
      sink.nodeId,
      destination.kind,
      destination.itemId,
    ]).pipe(Effect.map(Option.getOrUndefined)))?.next_position ?? 0,
  );
  yield* writer.unsafe(
    `
      INSERT INTO work_task_messages(
        canvas_name,
        node_id,
        parent_lane,
        item_id,
        message_id,
        position,
        message_kind,
        entity_home,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        role,
        parts_json,
        context_id,
        reference_task_ids_json,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'history', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      sink.canvasName,
      sink.nodeId,
      destination.kind,
      destination.itemId,
      message.messageId,
      position,
      fact.id.route.entityHome,
      fact.id.route.eventHome,
      fact.id.route.entityHome,
      fact.id.seq,
      message.role,
      canonicalJson(message.parts),
      message.contextId ?? null,
      message.referenceTaskIds === undefined
        ? null
        : canonicalJson(message.referenceTaskIds),
      message.metadata === undefined ? null : canonicalJson(message.metadata),
      fact.originAt,
      receivedAt,
    ],
  );
});

/**
 * Mailbox admission gate for caller-supplied message metadata.
 *
 * `deliveredAt` / `readAt` / `reactions` are projection-only: loadInbox stamps
 * them from durable delivery receipts after decode, and the delivery service
 * plus the renderer ledger treat them as truth. A caller-supplied value is a
 * forgery vector — a forged `deliveredAt` reads as "already delivered" and
 * suppresses real delivery; a forged `readAt` or `reactions` lies about
 * observe state — so admission drops those keys before the row is written.
 * Ingest-only: existing rows are never rewritten.
 *
 * The canonical sender identity is server-derived from the admitted caller
 * (`sentBy`), never client-supplied: `fromSeat` is the stable actor seat id
 * (`sentBy.seatId`) and `senderNodeId` is the readable canvas node
 * (`sentBy.nodeId`). Admission overwrites both from `sentBy`, so a client
 * cannot spoof a sender, and a notice/ledger link resolves a real seat rather
 * than a truncated hash.
 *
 * The transport delivery facts (`queuedAt`, `attemptedAt`, `notifiedAt`,
 * `unresolvedAt`, `refusedAt`, `refusedReason`, `generation`) and the
 * independently projected ack facts (`deliveredAt`, `readAt`, `reactions`,
 * `repliedAt`, `reactedAt`) are projection-only: the delivery projection and
 * the crew attempt store stamp them after decode from durable receipts. A
 * caller-supplied value is a forgery vector — a forged `notifiedAt` reads as
 * "already delivered" and suppresses real delivery, a forged `readAt` or
 * `reactedAt` lies about acknowledgement — so admission drops them (including
 * the legacy `refuseReason` misspelling) before the row is written. Ingest-only: existing rows are never rewritten,
 * and installed messages whose `fromSeat` is a historical node id stay
 * readable (the projection tolerates both).
 */
const MAILBOX_PROJECTION_ONLY_KEYS = [
  "deliveredAt",
  "readAt",
  "reactions",
  "repliedAt",
  "reactedAt",
  "queuedAt",
  "attemptedAt",
  "notifiedAt",
  "unresolvedAt",
  "refusedAt",
  "refusedReason",
  // Legacy misspelling: never let a caller-authored reason survive under it.
  "refuseReason",
  "generation",
] as const;

const admitMailboxMessage = (
  message: MessageValue,
  sentBy: ActorRef,
): MessageValue => {
  const metadata = message.metadata;
  // No metadata means no crew mail extension to stamp; leave the row as is.
  if (metadata === undefined) return message;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      (MAILBOX_PROJECTION_ONLY_KEYS as ReadonlyArray<string>).includes(key) ||
      key === "fromSeat" ||
      key === "senderNodeId"
    ) {
      continue;
    }
    rest[key] = value;
  }
  const admitted = {
    ...rest,
    fromSeat: sentBy.seatId,
    senderNodeId: sentBy.nodeId,
  };
  return { ...message, metadata: admitted };
};

const writeInboxMessage = Effect.fn("work.writeInboxMessage")(function* (
  writer: SqlClient.SqlClient,
  sink: SinkRefValue,
  incoming: MessageValue,
  sentBy: ActorRef,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  const message = admitMailboxMessage(incoming, sentBy);
  const position = Number(
    (yield* SqlSchema.findOneOption({
      Request: WorkSqlBindings,
      Result: NextPositionRow,
      execute: (bindings) =>
        writer.unsafe(
          `
        SELECT coalesce(max(position) + 1, 0) AS next_position
        FROM work_messages
        WHERE canvas_name = ? AND node_id = ?
      `,
          bindings,
        ),
    })([sink.canvasName, sink.nodeId]).pipe(Effect.map(Option.getOrUndefined)))
      ?.next_position ?? 0,
  );
  yield* writer.unsafe(
    `
      INSERT INTO work_messages(
        canvas_name,
        node_id,
        message_id,
        position,
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        role,
        parts_json,
        task_id,
        context_id,
        reference_task_ids_json,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      sink.canvasName,
      sink.nodeId,
      message.messageId,
      position,
      fact.id.route.entityHome,
      sentBy.seatId,
      fact.id.route.eventHome,
      fact.id.route.entityHome,
      fact.id.seq,
      message.role,
      canonicalJson(message.parts),
      message.taskId ?? null,
      message.contextId ?? null,
      message.referenceTaskIds === undefined
        ? null
        : canonicalJson(message.referenceTaskIds),
      message.metadata === undefined ? null : canonicalJson(message.metadata),
      fact.originAt,
      receivedAt,
    ],
  );
  yield* afterSqlCommit(writer, () => workProjectionChanges(writer).notify(sink, "mail"));
});

const writeArtifact = Effect.fn("work.writeArtifact")(function* (
  writer: SqlClient.SqlClient,
  sink: SinkRefValue,
  artifact: ArtifactValue,
  actorSeatId: ActorSeatId,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  yield* writer.unsafe(
    `
      INSERT INTO work_artifacts(
        canvas_name,
        node_id,
        artifact_id,
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        name,
        parts_json,
        task_canvas_name,
        task_node_id,
        task_id,
        task_entity_home,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      sink.canvasName,
      sink.nodeId,
      artifact.artifactId,
      fact.id.route.entityHome,
      actorSeatId,
      fact.id.route.eventHome,
      fact.id.route.entityHome,
      fact.id.seq,
      artifact.name ?? null,
      canonicalJson(artifact.parts),
      artifact.task?.sink.canvasName ?? null,
      artifact.task?.sink.nodeId ?? null,
      artifact.task?.itemId ?? null,
      artifact.task === undefined ? null : fact.id.route.entityHome,
      artifact.metadata === undefined ? null : canonicalJson(artifact.metadata),
      fact.originAt,
      receivedAt,
    ],
  );
});

const writeDelivery = Effect.fn("work.writeDelivery")(function* (
  writer: SqlClient.SqlClient,
  receipt: DeliveryReceipt,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  yield* writer.unsafe(
    `
      INSERT INTO work_delivery_receipts(
        delivery_id,
        delivered_item_kind,
        delivered_item_id,
        delivered_canvas_name,
        delivered_node_id,
        actor_seat_id,
        actor_canvas_name,
        actor_node_id,
        entity_home,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        accepted_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      receipt.deliveryId,
      receipt.deliveredItem.kind,
      receipt.deliveredItem.itemId,
      receipt.deliveredItem.sink.canvasName,
      receipt.deliveredItem.sink.nodeId,
      receipt.actor.seatId,
      receipt.actor.canvasName,
      receipt.actor.nodeId,
      fact.id.route.entityHome,
      fact.id.route.eventHome,
      fact.id.route.entityHome,
      fact.id.seq,
      receipt.acceptedAt,
      receivedAt,
    ],
  );
  if (receipt.deliveredItem.kind === "message") yield* afterSqlCommit(writer, () => workProjectionChanges(writer).notify(receipt.deliveredItem.sink, "mail"));
});

const materializeFact = Effect.fn("work.materializeFact")(function* (
  writer: SqlClient.SqlClient,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  switch (fact.body.operation) {
    case "task.create":
    case "task.describe":
    case "task.transition":
    case "task.claim":
      yield* writeTask(
        writer,
        "task",
        fact.item.sink,
        fact.body.task,
        fact,
        receivedAt,
      );
      return;
    case "request.create":
    case "request.resolve":
      yield* writeTask(
        writer,
        "request",
        fact.item.sink,
        fact.body.request,
        fact,
        receivedAt,
      );
      return;
    case "message.append": {
      const destination = fact.body.destination;
      if (destination.kind === "mailbox") {
        yield* writeInboxMessage(
          writer,
          fact.item.sink,
          fact.body.message,
          fact.body.sentBy,
          fact,
          receivedAt,
        );
      } else {
        yield* writeThreadMessage(
          writer,
          fact.item.sink,
          destination,
          fact.body.message,
          fact,
          receivedAt,
        );
      }
      return;
    }
    case "artifact.publish":
      yield* writeArtifact(
        writer,
        fact.item.sink,
        fact.body.artifact,
        fact.body.publishedBy.seatId,
        fact,
        receivedAt,
      );
      return;
    case "delivery.accepted":
      yield* writeDelivery(writer, fact.body.receipt, fact, receivedAt);
      return;
    case "board.topic.create": {
      const createdBy = fact.body.createdBy;
      const topic = topicWithBoundAuthors(fact.body.topic, createdBy);
      yield* writer.unsafe(
        `
          INSERT INTO work_board_topics(
            canvas_name, node_id, topic_id, title, state,
            author_kind, author_seat_id, author_node_id, author_label,
            parts_json, post_count, last_activity_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          fact.item.sink.canvasName,
          fact.item.sink.nodeId,
          topic.topicId,
          topic.title,
          topic.state,
          createdBy.kind,
          createdBy.seatId ?? null,
          createdBy.nodeId ?? null,
          createdBy.label ?? null,
          JSON.stringify(topic.parts ?? []),
          topic.postCount,
          topic.lastActivityAt,
          topic.openedAt,
          topic.lastActivityAt,
        ],
      );
      for (const post of topic.posts ?? []) {
        const tags = post.tags && post.tags.length > 0 ? post.tags : undefined;
        yield* writer.unsafe(
          `
            INSERT INTO work_board_posts(
              canvas_name, node_id, topic_id, post_id, position,
              author_kind, author_seat_id, author_node_id, author_label,
              parts_json, tags_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            fact.item.sink.canvasName,
            fact.item.sink.nodeId,
            post.topicId,
            post.postId,
            post.position,
            createdBy.kind,
            createdBy.seatId ?? null,
            createdBy.nodeId ?? null,
            createdBy.label ?? null,
            JSON.stringify(post.parts),
            tags ? JSON.stringify(tags) : null,
            post.createdAt,
          ],
        );
      }
      return;
    }
    case "pad.patch": {
      const current = yield* loadPad(writer, fact.item.sink);
      const applied = applyPatches(current, fact.body.patches);
      if (Result.isFailure(applied)) {
        return yield* Effect.fail(
          authorityError("invalid-transition", applied.failure.message),
        );
      }
      yield* persistPad(writer, fact.item.sink, applied.success, receivedAt);
      return;
    }
    case "board.post.append": {
      // Position authority is the fact body (assigned at apply/mint time).
      const post = fact.body.post;
      const createdBy = fact.body.createdBy;
      const tags = post.tags && post.tags.length > 0 ? post.tags : undefined;
      const inserted = yield* writer
        .unsafe(
          `
          INSERT INTO work_board_posts(
            canvas_name, node_id, topic_id, post_id, position,
            author_kind, author_seat_id, author_node_id, author_label,
            parts_json, tags_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(canvas_name, node_id, topic_id, post_id) DO NOTHING
        `,
          [
            fact.item.sink.canvasName,
            fact.item.sink.nodeId,
            post.topicId,
            post.postId,
            post.position,
            createdBy.kind,
            createdBy.seatId ?? null,
            createdBy.nodeId ?? null,
            createdBy.label ?? null,
            JSON.stringify(post.parts),
            tags ? JSON.stringify(tags) : null,
            post.createdAt,
          ],
        )
        .raw.pipe(Effect.flatMap(Schema.decodeUnknownEffect(WorkRunResult)));
      if (Number(inserted.changes) > 0) {
        yield* writer.unsafe(
          `
            UPDATE work_board_topics
            SET post_count = post_count + 1,
                last_activity_at = ?,
                updated_at = ?
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
          `,
          [
            post.createdAt,
            post.createdAt,
            fact.item.sink.canvasName,
            fact.item.sink.nodeId,
            post.topicId,
          ],
        );
      }
      return;
    }
  }
});

const activeTaskForActor = Effect.fn("work.activeTaskForActor")(function* (
  reader: SqlClient.SqlClient,
  actorSeatId: ActorSeatId,
): Effect.fn.Return<string | undefined, WorkSqlFailure> {
  return (yield* SqlSchema.findOneOption({
    Request: WorkSqlBindings,
    Result: TaskIdRow,
    execute: (bindings) =>
      reader.unsafe(
        `
      SELECT task_id
      FROM work_tasks
      WHERE actor_seat_id = ?
        AND state IN ('working', 'input-required', 'auth-required')
      LIMIT 1
    `,
        bindings,
      ),
  })([actorSeatId]).pipe(Effect.map(Option.getOrUndefined)))?.task_id;
});

const assertActorAvailable = Effect.fn("work.assertActorAvailable")(function* (
  reader: SqlClient.SqlClient,
  actorSeatId: ActorSeatId,
  exceptTaskId?: string,
): Effect.fn.Return<void, WorkSqlFailure> {
  const active = yield* activeTaskForActor(reader, actorSeatId);
  if (active !== undefined && active !== exceptTaskId) {
    return yield* Effect.fail(
      authorityError(
        "claim-contention",
        `actor seat "${actorSeatId}" already owns active task "${active}"`,
      ),
    );
  }
});

const makeFact = Effect.fn("work.makeFact")(function* (
  writer: SqlClient.SqlClient,
  localInstallationId: InstallationId,
  itemRef: WorkItemRef,
  operation: WorkOperation,
  predecessor: WorkRecordId | null,
  basis: FactBasisValue,
  body: WorkResult,
  originAt: DisplayTimestampValue,
): Effect.fn.Return<WorkFactValue, WorkSqlFailure, WorkJournal> {
  const seq = yield* (yield* WorkJournal).allocateSequence(
    localInstallationId,
    localInstallationId,
  );
  return yield* Effect.try(
    recordWithHash.bind(
      undefined,
      {
        protocol: WORK_PROTOCOL,
        id: {
          route: {
            eventHome: localInstallationId,
            entityHome: localInstallationId,
          },
          seq,
        },
        recordType: "fact",
        item: itemRef,
        operation,
        predecessor,
        basis,
        body,
      },
      originAt,
    ),
  );
});

const commitLocalFact = Effect.fn("work.commitLocalFact")(function* <A>(
  writer: SqlClient.SqlClient,
  input: {
    readonly localInstallationId: InstallationId;
    readonly sink: SinkRefValue;
    readonly item: WorkItemRef;
    readonly operation: WorkOperation;
    readonly predecessor: WorkRecordId | null;
    readonly basis: IntentFactBasisValue;
    readonly body: WorkResult;
    readonly value: A;
    readonly originAt: DisplayTimestampValue;
    readonly receivedAt: DisplayTimestampValue;
  },
): Effect.fn.Return<LocalFactResult<A>, WorkSqlFailure, WorkJournal> {
  const authority = yield* canonicalLocalWorkAuthority(writer);
  if (authority.installationId !== input.localInstallationId) {
    return yield* Effect.fail(
      authorityError(
        "authority-mismatch",
        "local Work authority changed inside its transaction",
      ),
    );
  }
  // Every locally minted fact is a new durable write. This catches legacy
  // RawPart values copied forward by claim/transition/approval paths even
  // when the incoming command itself did not carry a new message payload.
  yield* assertCurrentIntentBasis(writer, input.sink, input.basis);
  switch (input.body.operation) {
    case "task.create":
    case "task.describe":
    case "task.transition":
    case "task.claim":
      yield* Effect.try(
        assertCanonicalWaitUntil.bind(undefined, input.body.task),
      );
      break;
    default:
      break;
  }
  const fact = yield* makeFact(
    writer,
    input.localInstallationId,
    input.item,
    input.operation,
    input.predecessor,
    input.basis,
    input.body,
    input.originAt,
  );
  yield* (yield* WorkJournal).appendWorkRecord(fact, input.receivedAt);
  yield* materializeFact(writer, fact, input.receivedAt);
  return {
    value: input.value,
    record: fact,
  };
});

const hasNonEmptyTaskTransitionMessage = (
  message: MessageValue | undefined,
): boolean =>
  message?.parts.some(
    (part) => part.kind === "text" && part.text.trim().length > 0,
  ) ?? false;

/**
 * Work repository service contract (effect v4).
 *
 * Identifier and shape stay separate so there is exactly one repository
 * service key — no dual definitions.
 */
export interface WorkRepositoryId {
  readonly _workRepository: unique symbol;
}

type TaskClaimFactRow = {
  readonly operation: WorkOperation;
  readonly predecessor_event_home: string | null;
  readonly predecessor_entity_home: string | null;
  readonly predecessor_seq: string | null;
  readonly boundary_message_id: string | null;
  readonly boundary_index: number | null;
  readonly replaced_brief_message_id: string | null;
  readonly claimed_actor_seat_id: string | null;
};

/** Identity of the active claim, anchored in immutable Work facts. */
export type CurrentTaskClaim = {
  readonly id: WorkRecordId;
  /** Start of this claim's history, for recognizing already stored delivery receipts. */
  readonly historyBoundaryMessageId: string | undefined;
  readonly historyBoundaryIndex: number;
  readonly replacedBriefMessageIds: ReadonlyArray<string>;
};

export type ExchangeCursor = {
  readonly writer: InstallationId;
  readonly through: string;
};

export type ExchangeRowsInput = {
  readonly canvasName: string;
  readonly writer: InstallationId;
  readonly after: string;
  readonly limit: number;
};

export type ExchangeRow = {
  readonly fact: ExchangeFact;
  /** For a receipt, the node that wrote the mail it answers, when held. */
  readonly mailAuthorNodeId: string | undefined;
};

export type ExchangeRowsPage = {
  readonly rows: ReadonlyArray<ExchangeRow>;
  /** Every row of that writer and canvas up to here was examined. */
  readonly through: string;
  readonly more: boolean;
};

export type ApplyExchangeRowsInput = {
  readonly peer: InstallationId;
  readonly frame: RowsFrame;
  /** The canvas as this machine holds it; absent when it does not hold it. */
  readonly placement: CanvasPlacement | undefined;
  readonly receivedAt?: string;
};

export type AppliedExchangeRows = {
  /** Rows that were new to this machine. */
  readonly taken: number;
  /** Mail that arrived, for the seat's machine to deliver. */
  readonly mail: ReadonlyArray<{
    readonly canvasName: string;
    readonly nodeId: string;
    readonly message: MessageValue;
  }>;
};

const ExchangeFactRow = Schema.Struct({
  event_home: Schema.String,
  seq: Schema.String,
  item_kind: Schema.String,
  item_id: Schema.String,
  item_canvas_name: Schema.String,
  item_node_id: Schema.String,
  operation: Schema.String,
  content_sha256: Schema.String,
  origin_at: Schema.String,
  basis_kind: Schema.String,
  basis_canvas_name: Schema.NullOr(Schema.String),
  basis_canvas_seq: Schema.NullOr(Schema.Number),
  result_json: Schema.String,
});

/** A stored fact as a row that may cross machines, or nothing when it may not. */
const exchangeFactOf = (
  row: typeof ExchangeFactRow.Type,
): ExchangeFact | undefined => {
  const decoded = Schema.decodeUnknownResult(ExchangeFact, strictDecode)({
    protocol: WORK_PROTOCOL,
    id: {
      route: { eventHome: row.event_home, entityHome: row.event_home },
      seq: row.seq,
    },
    recordType: "fact",
    basis:
      row.basis_kind === "canvas"
        ? { kind: "canvas", canvasName: row.basis_canvas_name, seq: row.basis_canvas_seq }
        : { kind: "historical" },
    item: {
      kind: row.item_kind,
      itemId: row.item_id,
      sink: { canvasName: row.item_canvas_name, nodeId: row.item_node_id },
    },
    operation: row.operation,
    contentSha256: row.content_sha256,
    originAt: row.origin_at,
    predecessor: null,
    body: JSON.parse(row.result_json),
  });
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

/** The node that wrote the mail a receipt answers, when this machine holds that mail. */
const exchangeMailAuthor = Effect.fn("work.exchangeMailAuthor")(function* (
  reader: SqlClient.SqlClient,
  fact: ExchangeFact,
): Effect.fn.Return<string | undefined, WorkSqlFailure> {
  if (fact.body.operation !== "delivery.accepted") return undefined;
  const { deliveredItem } = fact.body.receipt;
  const rows = yield* reader.unsafe<{ node_id: string | null }>(
    `
      SELECT json_extract(fact.result_json, '$.sentBy.nodeId') AS node_id
      FROM work_messages AS mail
      JOIN work_facts AS fact
        ON fact.event_home = mail.fact_event_home
        AND fact.entity_home = mail.fact_entity_home
        AND fact.seq = mail.fact_seq
      WHERE mail.canvas_name = ? AND mail.node_id = ? AND mail.message_id = ?
    `,
    [deliveredItem.sink.canvasName, deliveredItem.sink.nodeId, deliveredItem.itemId],
  );
  return rows[0]?.node_id ?? undefined;
});

const exchangeCursorOf = Effect.fn("work.exchangeCursorOf")(function* (
  reader: SqlClient.SqlClient,
  canvasName: string,
  writer: string,
): Effect.fn.Return<
  { readonly through: string; readonly lastBasisSeq: number },
  WorkSqlFailure
> {
  const rows = yield* reader.unsafe<{ through: string; last_basis_seq: number }>(
    "SELECT through, last_basis_seq FROM work_exchange_cursors WHERE canvas_name = ? AND writer = ?",
    [canvasName, writer],
  );
  return rows[0] === undefined
    ? { through: "0", lastBasisSeq: 0 }
    : { through: rows[0].through, lastBasisSeq: rows[0].last_basis_seq };
});

const refuseExchange = (message: string): WorkAuthorityError =>
  authorityError("authority-mismatch", message);

export interface WorkRepositoryShape {
  readonly kernelWork: (canvasName: string) => Effect.Effect<KernelWork, WorkRepositoryError>;
  /** Exact policy inputs across the task's visited boards and prerequisite ids. */
  readonly taskRowsByIds: (canvasName: string, ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<{ readonly nodeId: string; readonly item: TaskValue }>, WorkRepositoryError>;
  /** Explicit full lane read for agent list commands. */
  readonly taskLane: (canvasName: string, nodeId: string, kind: "task" | "requests") => Effect.Effect<ReadonlyArray<TaskValue>, WorkRepositoryError>;
  readonly boardTopics: (canvasName: string, nodeId: string, topicId?: string) => Effect.Effect<ReadonlyArray<BoardTopicViewValue>, WorkRepositoryError>;
  readonly artifactLane: (canvasName: string, nodeId: string) => Effect.Effect<ReadonlyArray<ArtifactValue>, WorkRepositoryError>;
  readonly artifactIds: (canvasName: string, nodeId: string) => Effect.Effect<ReadonlyArray<string>, WorkRepositoryError>;
  readonly artifactItem: (canvasName: string, nodeId: string, id: string) => Effect.Effect<ArtifactValue | undefined, WorkRepositoryError>;
  readonly taskItem: (query: WorkItemQuery) => Effect.Effect<TaskValue | undefined, WorkRepositoryError>;
  readonly actorPage: (query: WorkActorQuery) => Effect.Effect<WorkActorPage, WorkRepositoryError>;
  readonly attentionSnapshot: (query: WorkAttentionQuery) => Effect.Effect<WorkAttentionSnapshot, WorkRepositoryError>;
  readonly attentionItems: (query: WorkAttentionQuery) => Effect.Effect<ReadonlyArray<WorkAttentionRow>, WorkRepositoryError>;
  readonly taskPolicy: (query: WorkAttentionQuery) => Effect.Effect<ReadonlyArray<WorkLaneRow>, WorkRepositoryError>;
  readonly sinkPage: (query: WorkSinkQuery) => Effect.Effect<WorkSinkPage, WorkRepositoryError>;
  readonly mailPage: (query: WorkMailQuery) => Effect.Effect<WorkMailPage, WorkRepositoryError>;
  readonly mailbox: (canvasName: string, nodeId: string) => Effect.Effect<ReadonlyArray<MessageValue>, WorkRepositoryError>;
  readonly companionMail: (canvasName: string, nodeId: string, limit: number) => Effect.Effect<ReadonlyArray<{ readonly nodeId: string; readonly message: MessageValue }>, WorkRepositoryError>;
  readonly mailMessage: (canvasName: string, nodeId: string, messageId: string) => Effect.Effect<MessageValue | undefined, WorkRepositoryError>;
  readonly recentOpsForSeat: (input: {
    readonly canvasName: string;
    readonly actorSeatId: ActorSeatId;
    readonly limit?: number;
  }) => Effect.Effect<WorkSeatRecentOpsFeed, WorkRepositoryError>;
  readonly itemHome: (
    lane: "task" | "request",
    canvasName: string,
    nodeId: string,
    itemId: string,
  ) => Effect.Effect<InstallationId | undefined, WorkRepositoryError>;
  readonly currentTaskClaim: (
    sink: SinkRefValue,
    taskId: string,
    actorSeatId: ActorSeatId,
  ) => Effect.Effect<CurrentTaskClaim | undefined, WorkRepositoryError>;
  readonly hasAcceptedDelivery: (
    sink: SinkRefValue,
    deliveryId: string,
  ) => Effect.Effect<boolean, WorkRepositoryError>;
  /**
   * Durable receipt timestamp when present. Used for idempotent mark-read
   * so re-acks return the original acceptedAt, not a fabricated now().
   */
  readonly acceptedDeliveryAt: (
    sink: SinkRefValue,
    deliveryId: string,
  ) => Effect.Effect<string | undefined, WorkRepositoryError>;
  readonly createTask: (
    input: CreateTaskInput,
  ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
  readonly describeTask: (
    input: DescribeTaskInput,
  ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
  readonly transitionTask: (
    input: TransitionTaskInput,
  ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
  readonly claimLocalTask: (
    input: ClaimLocalTaskInput,
  ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
  /** Send on: complete here + re-home submitted at the next board. */
  readonly sendTaskOn: (
    input: SendOnTaskInput,
  ) => Effect.Effect<LocalFactResult<SendOnTaskValue>, RepositoryFailure>;
  /** Send back: reject here + re-open the previous visit row. */
  readonly sendTaskBack: (
    input: SendBackTaskInput,
  ) => Effect.Effect<LocalFactResult<SendBackTaskValue>, RepositoryFailure>;
  /**
   * Post a review verdict with live-task authority, validated and inserted in
   * one transaction: recompute the subject from the live task, refuse a
   * self-review, a moved epoch/hash/author, or a missing directed reviews
   * edge, then store the immutable verdict.
   */
  readonly postReviewVerdict: (
    verdict: ReviewVerdict,
    opts: {
      readonly basis: IntentFactBasisValue;
      readonly canvasName: string;
    },
  ) => Effect.Effect<PostReviewVerdictResult, RepositoryFailure>;
  /**
   * Atomic checkout-watch receipt writer: fresh-reads the task and its live
   * claimant (refusing a changed author), the current masked reviews edges,
   * and the intent basis, then composes commit-subject receipt mail for the
   * newly observed shas and their dedupe rows in one transaction. Returns the
   * created records for the caller to notify after commit.
   */
  readonly publishCheckoutReceipts: (input: {
    readonly basis: IntentFactBasisValue;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly taskId: string;
    readonly checkoutKey: string;
    readonly author: MailSenderStamp;
    readonly shas: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<ReviewReceiptRecord>, RepositoryFailure>;
  /**
   * Approve a task waiting at an `approval` board: epoch-scoped operator
   * stamp at metadata["junto.tasks.approvedEpoch"] (same-state
   * task.transition fact).
   */
  readonly promoteTask: (
    input: PromoteTaskInput,
  ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
  /** Record seat-submitted check runs as current-epoch CheckResults. */
  readonly recordCheckResults: (
    input: RecordCheckResultsInput,
  ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
  readonly createRequest: (
    input: CreateRequestInput,
  ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
  readonly resolveRequest: (
    input: ResolveRequestInput,
  ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
  readonly appendMessage: (
    input: AppendMessageInput,
  ) => Effect.Effect<LocalFactResult<MessageValue>, RepositoryFailure>;
  readonly publishArtifact: (
    input: PublishArtifactInput,
  ) => Effect.Effect<LocalFactResult<ArtifactValue>, RepositoryFailure>;
  readonly acceptDelivery: (
    input: AcceptDeliveryInput,
  ) => Effect.Effect<LocalFactResult<DeliveryReceipt>, RepositoryFailure>;
  /** Command Center-homed board mutations (global sink; work_events facts). */
  readonly createBoardTopic: (
    input: CreateBoardTopicInput,
  ) => Effect.Effect<LocalFactResult<BoardTopicValue>, RepositoryFailure>;
  readonly appendBoardPost: (
    input: AppendBoardPostInput,
  ) => Effect.Effect<LocalFactResult<BoardPostValue>, RepositoryFailure>;
  readonly readPad: (
    canvasName: string,
    nodeId: string,
  ) => Effect.Effect<Pad, WorkRepositoryError>;
  readonly applyPadPatch: (
    input: ApplyPadPatchInput,
  ) => Effect.Effect<LocalFactResult<Pad>, RepositoryFailure>;
  readonly markPadRead: (input: {
    readonly sink: SinkRefValue;
    readonly pinId: string;
    readonly principalKey: string;
    readonly lastReadPosition: number;
    readonly updatedAt?: string;
  }) => Effect.Effect<void, RepositoryFailure>;
  readonly markBoardRead: (input: {
    readonly sink: SinkRefValue;
    readonly topicId: string;
    readonly principalKey: string;
    readonly lastReadPosition: number;
    readonly updatedAt?: string;
  }) => Effect.Effect<void, RepositoryFailure>;
  /** Operator soft-archive / restore via metadata.archived (no work fact). */
  readonly setArtifactArchived: (input: {
    readonly sink: SinkRefValue;
    readonly artifactId: string;
    readonly archived: boolean;
  }) => Effect.Effect<ArtifactValue, RepositoryFailure>;
  /** Operator hard-delete of an artifact row (content objects retained). */
  readonly deleteArtifact: (input: {
    readonly sink: SinkRefValue;
    readonly artifactId: string;
  }) => Effect.Effect<{ readonly artifactId: string }, RepositoryFailure>;
  /** How far this machine is caught up on each other writer's rows for a canvas. */
  readonly exchangeHave: (
    canvasName: string,
  ) => Effect.Effect<ReadonlyArray<ExchangeCursor>, WorkRepositoryError>;
  /** Every writer with rows for a canvas that this machine holds. */
  readonly exchangeWriters: (
    canvasName: string,
  ) => Effect.Effect<ReadonlyArray<InstallationId>, WorkRepositoryError>;
  /** One page of a writer's rows for a canvas, above a sequence, in order. */
  readonly exchangeRows: (
    input: ExchangeRowsInput,
  ) => Effect.Effect<ExchangeRowsPage, WorkRepositoryError>;
  /**
   * Take one frame of rows from a peer, or refuse all of it. Every row is
   * checked before anything is written: the peer may pass on that writer, the
   * content matches its hash, the row was written where its author lives, and
   * this machine is entitled to it. Rows and cursor commit together.
   */
  readonly applyExchangeRows: (
    input: ApplyExchangeRowsInput,
  ) => Effect.Effect<AppliedExchangeRows, RepositoryFailure>;
  readonly subscribeChanges: (
    listener: (canvasName: string, nodeId: string, kind?: "mail" | "work") => void,
  ) => () => void;
}

export type WorkRepository = WorkRepositoryId;

export const WorkRepository = Context.Service<
  WorkRepository,
  WorkRepositoryShape
>("@junto/WorkRepository");

/** Reads participate in the caller's SQL lease or transaction. */
export class WorkRevisions extends Context.Service<WorkRevisions, {
  readonly revision: (canvasName: string) => Effect.Effect<string, WorkRepositoryError>;
}>()("@junto/WorkRevisions") {}

export const WorkRevisionsLive = Layer.effect(WorkRevisions, Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return WorkRevisions.of({
    revision: Effect.fn("WorkRevisions.revision")((name: string) =>
      withSqlRead(sql, readCanvasWorkRevision(sql, name)).pipe(
        Effect.mapError((error) => toRepositoryError("work.revision", error)),
      )),
  });
}));

export const WorkRepositoryLive = Layer.effect(
  WorkRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* WorkJournal;
    const crew = yield* CrewRepository;
    const records = yield* ModelRecords;
    const manifest = yield* ContentManifest;
    const provideParticipants = <A, E>(
      body: Effect.Effect<
        A,
        E,
        WorkJournal | CrewRepository | ModelRecords | ContentManifest
      >,
    ) =>
      body.pipe(
        Effect.provideService(WorkJournal, journal),
        Effect.provideService(CrewRepository, crew),
        Effect.provideService(ModelRecords, records),
        Effect.provideService(ContentManifest, manifest),
      );
    const changes = workProjectionChanges(sql);
    const notify = changes.notify;

    const readRecentOpsForSeat = (input: {
      readonly canvasName: string;
      readonly actorSeatId: ActorSeatId;
      readonly limit?: number;
    }): Effect.Effect<WorkSeatRecentOpsFeed, WorkRepositoryError> =>
      withSqlRead(
        sql,
        ((reader: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            return yield* recentOpsForSeat(reader, input);
          }))(sql),
      )
        .pipe(
          Effect.provideService(
            StateTransactionOperation,
            "work.recentOpsForSeat",
          ),
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.recentOpsForSeat", error),
          ),
        );

    const itemHome = (
      lane: "task" | "request",
      canvasName: string,
      nodeId: string,
      itemId: string,
    ): Effect.Effect<InstallationId | undefined, WorkRepositoryError> =>
      withSqlRead(
        sql,
        ((reader: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            return (yield* selectTaskIdentity(
              reader,
              lane,
              { canvasName, nodeId },
              itemId,
            ))?.entity_home as InstallationId | undefined;
          }))(sql),
      )
        .pipe(Effect.provideService(StateTransactionOperation, "work.itemHome"))
        .pipe(
          Effect.mapError((error) => toRepositoryError("work.itemHome", error)),
        );

    // Canonical facts are immutable. Cache at most 1,024 material heads so a
    // pulse does one task-PK read, and a new progress fact normally walks one
    // predecessor. Cold reads follow only this task's indexed fact chain.
    const taskClaimHeads = new Map<string, CurrentTaskClaim>();
    const currentTaskClaim = (
      sink: SinkRefValue,
      taskId: string,
      actorSeatId: ActorSeatId,
    ): Effect.Effect<CurrentTaskClaim | undefined, WorkRepositoryError> =>
      withSqlRead(
        sql,
        ((reader: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const current = yield* selectTaskIdentity(
              reader,
              "task",
              sink,
              taskId,
            );
            if (
              current?.state !== "working" ||
              current.actor_seat_id !== actorSeatId
            ) {
              return undefined;
            }
            let cursor: WorkRecordId | null = yield* Effect.try(
              currentIdentity.bind(undefined, current),
            );
            const visited = new Set<string>();
            const replacedBriefMessageIds: string[] = [];
            let claim: CurrentTaskClaim | undefined;
            while (cursor !== null) {
              const key = JSON.stringify(cursor);
              if (visited.has(key)) return undefined;
              visited.add(key);
              const cached = taskClaimHeads.get(key);
              if (cached !== undefined) {
                claim = {
                  ...cached,
                  replacedBriefMessageIds: [
                    ...replacedBriefMessageIds,
                    ...cached.replacedBriefMessageIds,
                  ],
                };
                break;
              }
              const row: TaskClaimFactRow | undefined =
                yield* SqlSchema.findOneOption({
                  Request: WorkSqlBindings,
                  Result: TaskClaimFactRowSchema,
                  execute: (bindings) =>
                    reader.unsafe(
                      `
            SELECT event.operation,
              fact.predecessor_event_home, fact.predecessor_entity_home,
              fact.predecessor_seq,
              CASE WHEN event.operation = 'task.claim' THEN
                json_extract(fact.result_json, '$.task.history[#-1].messageId')
              END AS boundary_message_id,
              CASE WHEN event.operation = 'task.claim' THEN
                json_array_length(fact.result_json, '$.task.history') - 1
              END AS boundary_index,
              CASE WHEN event.operation = 'task.describe' THEN
                json_extract(fact.result_json, '$.task.history[0].messageId')
              END AS replaced_brief_message_id,
              CASE WHEN event.operation = 'task.claim' THEN
                json_extract(fact.result_json, '$.claimedBy.seatId')
              END AS claimed_actor_seat_id
            FROM work_events AS event
            JOIN work_facts AS fact USING (event_home, entity_home, seq)
            WHERE event.event_home = ? AND event.entity_home = ? AND event.seq = ?
              AND event.item_kind = 'task' AND event.item_id = ?
              AND event.item_canvas_name = ? AND event.item_node_id = ?
          `,
                      bindings,
                    ),
                })([
                  cursor.route.eventHome,
                  cursor.route.entityHome,
                  cursor.seq,
                  taskId,
                  sink.canvasName,
                  sink.nodeId,
                ]).pipe(Effect.map(Option.getOrUndefined));
              if (row === undefined) return undefined;
              if (row.operation === "task.claim") {
                if (row.claimed_actor_seat_id !== actorSeatId) return undefined;
                claim = {
                  id: cursor,
                  historyBoundaryMessageId:
                    row.boundary_message_id ?? undefined,
                  historyBoundaryIndex: Math.max(0, row.boundary_index ?? 0),
                  replacedBriefMessageIds,
                };
                break;
              }
              if (
                row.operation !== "task.transition" &&
                row.operation !== "task.describe"
              ) {
                return undefined;
              }
              if (row.replaced_brief_message_id !== null) {
                replacedBriefMessageIds.push(row.replaced_brief_message_id);
              }
              cursor =
                row.predecessor_event_home === null ||
                row.predecessor_entity_home === null ||
                row.predecessor_seq === null
                  ? null
                  : yield* Effect.try(
                      recordId.bind(
                        undefined,
                        row.predecessor_event_home as InstallationId,
                        row.predecessor_entity_home as InstallationId,
                        row.predecessor_seq,
                      ),
                    );
            }
            if (claim !== undefined) {
              for (const key of Array.from(visited).reverse()) {
                taskClaimHeads.set(key, claim);
                if (taskClaimHeads.size > 1_024) {
                  taskClaimHeads.delete(taskClaimHeads.keys().next().value!);
                }
              }
            }
            return claim;
          }))(sql),
      )
        .pipe(
          Effect.provideService(
            StateTransactionOperation,
            "work.currentTaskClaim",
          ),
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.currentTaskClaim", error),
          ),
        );

    const hasAcceptedDelivery = (
      sink: SinkRefValue,
      deliveryId: string,
    ): Effect.Effect<boolean, WorkRepositoryError> =>
      acceptedDeliveryAt(sink, deliveryId).pipe(
        Effect.map((at) => at !== undefined),
      );

    const acceptedDeliveryAt = (
      sink: SinkRefValue,
      deliveryId: string,
    ): Effect.Effect<string | undefined, WorkRepositoryError> =>
      withSqlRead(
        sql,
        ((reader: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const row = yield* SqlSchema.findOneOption({
              Request: WorkSqlBindings,
              Result: AcceptedAtRow,
              execute: (bindings) =>
                reader.unsafe(
                  `
                SELECT accepted_at
                FROM work_delivery_receipts
                WHERE delivered_canvas_name = ?
                  AND delivered_node_id = ?
                  AND delivery_id = ?
              `,
                  bindings,
                ),
            })([sink.canvasName, sink.nodeId, deliveryId]).pipe(
              Effect.map(Option.getOrUndefined),
            );
            return row?.accepted_at;
          }))(sql),
      )
        .pipe(
          Effect.provideService(
            StateTransactionOperation,
            "work.acceptedDeliveryAt",
          ),
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.acceptedDeliveryAt", error),
          ),
        );

    const transaction = <A>(
      operation: string,
      sink: SinkRefValue,
      body: (
        writer: SqlClient.SqlClient,
      ) => Effect.Effect<
        A,
        WorkSqlFailure,
        WorkJournal | CrewRepository | ModelRecords | ContentManifest
      >,
      kind: "mail" | "work" = "work",
    ): Effect.Effect<A, RepositoryFailure> =>
      sql
        .withTransaction(
          ((writer: SqlClient.SqlClient) =>
            Effect.gen(function* () {
              const before = (yield* SqlSchema.findOneOption({
                Request: Schema.Void,
                Result: TotalChangesRow,
                execute: () =>
                  writer.unsafe("SELECT total_changes() AS total_changes"),
              })(undefined).pipe(Effect.map(Option.getOrUndefined)))!
                .total_changes;
              const value = yield* body(writer);
              const after = (yield* SqlSchema.findOneOption({
                Request: Schema.Void,
                Result: TotalChangesRow,
                execute: () =>
                  writer.unsafe("SELECT total_changes() AS total_changes"),
              })(undefined).pipe(Effect.map(Option.getOrUndefined)))!
                .total_changes;
              const changed = BigInt(after) > BigInt(before);
              return { value, changed };
            }))(sql),
        )
        .pipe(Effect.provideService(StateTransactionOperation, operation))
        .pipe(
          provideParticipants,
          Effect.mapError((error) =>
            unwrapStateFailure(
              operation,
              error,
              WorkAuthorityError as unknown as new (
                ...args: never[]
              ) => WorkAuthorityError,
            ),
          ),
          Effect.tap(({ changed }) =>
            changed && kind !== "mail"
              ? afterSqlCommit(sql, () => {
                  notify(sink, kind);
                })
              : Effect.void,
          ),
          Effect.map(({ value }) => value),
        );

    const createTask = (
      input: CreateTaskInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const task = Schema.decodeUnknownSync(Task, strictDecode)(input.task);
      return transaction(
        "work.task.create",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const authority = yield* canonicalLocalWorkAuthority(writer);
            const localInstallationId = authority.installationId;
            yield* localDependencyCapability(
              writer,
              input.sink,
              input.basis,
              task.dependsOn,
              input.dependencyScope,
            );
            if (task.state !== "submitted" || task.claimedBy !== undefined) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  "task.create requires a submitted unclaimed task",
                ),
              );
            }
            yield* Effect.try(
              assertNoReservedTaskMetadata.bind(undefined, task.metadata),
            );
            yield* Effect.try(assertCanonicalWaitUntil.bind(undefined, task));
            if (task.checkResults !== undefined) {
              // Check results are stamped only by the check verb, never authored.
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  "task.create must not carry check results",
                ),
              );
            }
            if (
              (yield* selectTaskIdentity(
                writer,
                "task",
                input.sink,
                task.id,
              )) !== undefined
            ) {
              return yield* Effect.fail(
                authorityError(
                  "identity-conflict",
                  `task "${task.id}" already exists`,
                ),
              );
            }
            yield* assertTaskDependenciesInLocalScope(
              writer,
              input.sink,
              input.basis,
              task.id,
              task.dependsOn,
              input.dependencyScope,
            );
            return yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("task", task.id, input.sink),
              operation: "task.create",
              predecessor: null,
              body: { operation: "task.create", task },
              value: task,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const describeTask = (
      input: DescribeTaskInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const message = Schema.decodeUnknownSync(
        Message,
        strictDecode,
      )(input.message);
      return transaction(
        "work.task.describe",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const { installationId: localInstallationId } =
              yield* canonicalLocalWorkAuthority(writer);
            const current = yield* loadTask(
              writer,
              "task",
              input.sink,
              input.taskId,
            );
            if (current === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `task "${input.taskId}" does not exist`,
                ),
              );
            }
            if (current.row.entity_home !== localInstallationId) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "local installation does not own this task",
                ),
              );
            }
            if (
              current.task.state === "completed" ||
              current.task.state === "canceled" ||
              current.task.state === "failed" ||
              current.task.state === "rejected" ||
              current.task.state === "archived"
            ) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `cannot describe terminal task "${input.taskId}"`,
                ),
              );
            }
            const task: TaskValue = {
              ...current.task,
              history: [message, ...current.task.history.slice(1)],
            };
            return yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("task", task.id, input.sink),
              operation: "task.describe",
              predecessor: yield* Effect.try(
                currentIdentity.bind(undefined, current.row),
              ),
              body: { operation: "task.describe", task },
              value: task,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const transitionTask = (
      input: TransitionTaskInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const message =
        input.message === undefined
          ? undefined
          : Schema.decodeUnknownSync(Message, strictDecode)(input.message);
      return transaction(
        "work.task.transition",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            if (message !== undefined) {
            }
            const { installationId: localInstallationId } =
              yield* canonicalLocalWorkAuthority(writer);
            const current = yield* loadTask(
              writer,
              "task",
              input.sink,
              input.taskId,
            );
            if (current === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `task "${input.taskId}" does not exist`,
                ),
              );
            }
            if (current.row.entity_home !== localInstallationId) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "local installation does not own this task",
                ),
              );
            }
            if (!canTransitionTaskState(current.task.state, input.state)) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `cannot transition task "${input.taskId}" from ${current.task.state} to ${input.state}`,
                ),
              );
            }
            if (
              current.task.state === "completed" &&
              input.state === "submitted" &&
              !hasNonEmptyTaskTransitionMessage(message)
            ) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  "a QA rejection comment is required before returning a completed task to Queue",
                ),
              );
            }
            // Completion evidence persists on completed AND working: a working task
            // may carry staged review refs. Only completed runs the finish and
            // review gates below; working just stages the refs.
            const evidenceState =
              input.state === "completed" || input.state === "working";
            const evidence = evidenceState
              ? normalizeRuleEvidence(
                  normalizeCompletionEvidence(input.completionEvidence),
                  input.completionEvidence,
                )
              : undefined;
            if (input.state === "completed") {
              const artifactsByNode = yield* loadAllArtifactsByNode(
                writer,
                input.sink.canvasName,
              );
              const gate = evaluateFinishCriteria({
                task: current.task,
                taskNodeId: input.sink.nodeId,
                canvasName: input.sink.canvasName,
                evidence,
                artifactsByNode,
              });
              if (gate !== undefined) {
                return yield* Effect.fail(
                  authorityError(
                    "invalid-transition",
                    `finish criteria unsatisfied [${gate.missing}]: ${gate.message} (next: ${gate.next_step})`,
                  ),
                );
              }
              if (input.reviewGate !== undefined) {
                // CAS the live task epoch against the reviewed epoch first: a
                // concurrent blocking that reclaimed the task to a newer epoch must
                // fail an old completion writer even though a green still exists at
                // the stale epoch the preflight saw.
                if ((current.task.epoch ?? 0) !== input.reviewGate.epoch) {
                  return yield* Effect.fail(
                    authorityError(
                      "invalid-transition",
                      "requires-review: task epoch advanced since the reviewed subject",
                    ),
                  );
                }
                // Then the gate: a distinct eligible reviewer's latest verdict on
                // the exact epoch + subject hash must be green. Both are checked in
                // the completion transaction so a concurrent blocking or changed
                // subject cannot pass a stale preflight then commit.
                if (
                  !(yield* (yield* CrewRepository).currentGreenExists(
                    input.reviewGate,
                  ))
                ) {
                  return yield* Effect.fail(
                    authorityError(
                      "invalid-transition",
                      "requires-review: no current green verdict from a distinct reviewer for this epoch and subject",
                    ),
                  );
                }
              }
            }
            const base = applyTaskRecordPatch(
              taskWithTransitionState(current.task, input.state),
              input.taskPatch,
            );
            const withoutEvidence = evidenceState
              ? base
              : (() => {
                  const { completionEvidence: _c, ...rest } = base;
                  return rest;
                })();
            const task = yield* Schema.decodeUnknownEffect(
              Task,
              strictDecode,
            )({
              ...withoutEvidence,
              history:
                message === undefined
                  ? current.task.history
                  : [...current.task.history, message],
              ...(evidenceState && evidence !== undefined
                ? { completionEvidence: evidence }
                : {}),
            });
            const factResult = yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("task", task.id, input.sink),
              operation: "task.transition",
              predecessor: yield* Effect.try(
                currentIdentity.bind(undefined, current.row),
              ),
              body: { operation: "task.transition", task },
              value: task,
              originAt,
              receivedAt,
            });
            if (input.receiptAuthor === undefined) return factResult;
            const reviewReceipts = yield* mintReviewReceipts(
              writer,
              localInstallationId,
              input.basis,
              input.sink.canvasName,
              input.sink,
              factResult.value,
              factResult.record,
              input.receiptAuthor,
              originAt,
              receivedAt,
            );
            return reviewReceipts.length > 0
              ? { ...factResult, reviewReceipts }
              : factResult;
          }),
      );
    };

    const claimLocalTask = (
      input: ClaimLocalTaskInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction(
        "work.task.claim-local",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const authority = yield* canonicalLocalWorkAuthority(writer);
            const localInstallationId = authority.installationId;
            yield* localDependencyCapability(
              writer,
              input.sink,
              input.basis,
              undefined,
              input.dependencyScope,
            );
            const current = yield* loadTask(
              writer,
              "task",
              input.sink,
              input.taskId,
            );
            if (current === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `task "${input.taskId}" does not exist`,
                ),
              );
            }
            if (current.row.entity_home !== localInstallationId) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "local installation does not own this task queue",
                ),
              );
            }
            if (
              current.task.state !== "submitted" ||
              current.task.claimedBy !== undefined
            ) {
              return yield* Effect.fail(
                authorityError(
                  "claim-contention",
                  `task "${input.taskId}" is not available to start`,
                ),
              );
            }
            yield* Effect.try(
              assertTaskAdmissionReady.bind(
                undefined,
                current.task,
                input.sink,
                input.dependencyScope,
              ),
            );
            yield* assertTaskClaimReady(
              writer,
              current.task,
              input.sink,
              input.basis,
              input.dependencyScope,
            );
            yield* assertActorAvailable(writer, input.actor.seatId);
            const task = yield* Schema.decodeUnknownEffect(
              Task,
              strictDecode,
            )({
              ...current.task,
              state: "working",
              claimedBy: input.actor.seatId,
            });
            return yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("task", task.id, input.sink),
              operation: "task.claim",
              predecessor: yield* Effect.try(
                currentIdentity.bind(undefined, current.row),
              ),
              body: {
                operation: "task.claim",
                task,
                claimedBy: input.actor,
                previousHome: localInstallationId,
              },
              value: task,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const sendTaskOn = (
      input: SendOnTaskInput,
    ): Effect.Effect<LocalFactResult<SendOnTaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const message =
        input.message === undefined
          ? undefined
          : Schema.decodeUnknownSync(Message, strictDecode)(input.message);
      const nextTask = Schema.decodeUnknownSync(
        Task,
        strictDecode,
      )(input.nextTask);
      return transaction(
        "work.task.send-on",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const { installationId: localInstallationId } =
              yield* canonicalLocalWorkAuthority(writer);
            if (input.next.canvasName !== input.sink.canvasName) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  "sending a task on stays on one canvas",
                ),
              );
            }
            if (
              nextTask.id !== input.taskId ||
              nextTask.state !== "submitted" ||
              nextTask.claimedBy !== undefined
            ) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  "send on must re-home the same task as submitted and unclaimed",
                ),
              );
            }
            const current = yield* loadTask(
              writer,
              "task",
              input.sink,
              input.taskId,
            );
            if (current === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `task "${input.taskId}" does not exist`,
                ),
              );
            }
            if (current.row.entity_home !== localInstallationId) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "local installation does not own this task",
                ),
              );
            }
            if (!canTransitionTaskState(current.task.state, "completed")) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `cannot send task "${input.taskId}" on from ${current.task.state}`,
                ),
              );
            }
            const evidence = normalizeRuleEvidence(
              normalizeCompletionEvidence(input.completionEvidence),
              input.completionEvidence,
            );
            const gate = evaluateFinishCriteria({
              task: current.task,
              taskNodeId: input.sink.nodeId,
              canvasName: input.sink.canvasName,
              evidence,
              artifactsByNode: yield* loadAllArtifactsByNode(
                writer,
                input.sink.canvasName,
              ),
            });
            if (gate !== undefined) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `finish criteria unsatisfied [${gate.missing}]: ${gate.message} (next: ${gate.next_step})`,
                ),
              );
            }
            if (input.reviewGate !== undefined) {
              // Same CAS + gate as transitionTask for the complete-here step: the
              // live epoch must still match the reviewed epoch, and a distinct
              // reviewer's latest verdict on the exact subject must be green.
              if ((current.task.epoch ?? 0) !== input.reviewGate.epoch) {
                return yield* Effect.fail(
                  authorityError(
                    "invalid-transition",
                    "requires-review: task epoch advanced since the reviewed subject",
                  ),
                );
              }
              if (
                !(yield* (yield* CrewRepository).currentGreenExists(
                  input.reviewGate,
                ))
              ) {
                return yield* Effect.fail(
                  authorityError(
                    "invalid-transition",
                    "requires-review: no current green verdict from a distinct reviewer for this epoch and subject",
                  ),
                );
              }
            }
            const completed = yield* Schema.decodeUnknownEffect(
              Task,
              strictDecode,
            )({
              ...taskWithTransitionState(current.task, "completed"),
              history:
                message === undefined
                  ? current.task.history
                  : [...current.task.history, message],
              visits: input.visits,
              ...(evidence !== undefined
                ? { completionEvidence: evidence }
                : {}),
            });
            const sourceFact = yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("task", input.taskId, input.sink),
              operation: "task.transition",
              predecessor: yield* Effect.try(
                currentIdentity.bind(undefined, current.row),
              ),
              body: { operation: "task.transition", task: completed },
              value: completed,
              originAt,
              receivedAt,
            });
            // Successor row keyed (canvas, next board, same task id): fresh create
            // on a first visit, re-open (rejected → submitted) after a send-back
            // cycle. Both use existing immutable-log vocabulary.
            const existing = yield* loadTask(
              writer,
              "task",
              input.next,
              input.taskId,
            );
            if (existing === undefined) {
              yield* commitLocalFact(writer, {
                localInstallationId,
                sink: input.next,
                basis: input.basis,
                item: item("task", input.taskId, input.next),
                operation: "task.create",
                predecessor: null,
                body: { operation: "task.create", task: nextTask },
                value: nextTask,
                originAt,
                receivedAt,
              });
            } else {
              if (existing.row.entity_home !== localInstallationId) {
                return yield* Effect.fail(
                  authorityError(
                    "authority-mismatch",
                    "local installation does not own the next board row",
                  ),
                );
              }
              // "rejected" stays terminal in the generic matrix so no other
              // caller can resurrect a rejected task in place; the task path's
              // own send-back re-open of a completed visit row is authorized here,
              // locally, when the task is later sent on through the same board.
              if (
                existing.task.state !== "rejected" &&
                !canTransitionTaskState(existing.task.state, "submitted")
              ) {
                return yield* Effect.fail(
                  authorityError(
                    "invalid-transition",
                    `cannot re-open next board row from ${existing.task.state}`,
                  ),
                );
              }
              yield* commitLocalFact(writer, {
                localInstallationId,
                sink: input.next,
                basis: input.basis,
                item: item("task", input.taskId, input.next),
                operation: "task.transition",
                predecessor: yield* Effect.try(
                  currentIdentity.bind(undefined, existing.row),
                ),
                body: { operation: "task.transition", task: nextTask },
                value: nextTask,
                originAt,
                receivedAt,
              });
            }
            const reviewReceipts =
              input.receiptAuthor === undefined
                ? []
                : yield* mintReviewReceipts(
                    writer,
                    localInstallationId,
                    input.basis,
                    input.sink.canvasName,
                    input.sink,
                    completed,
                    sourceFact.record,
                    input.receiptAuthor,
                    originAt,
                    receivedAt,
                  );
            return {
              value: { completed, next: nextTask },
              record: sourceFact.record,
              ...(reviewReceipts.length > 0 ? { reviewReceipts } : {}),
            };
          }),
      );
    };

    const sendTaskBack = (
      input: SendBackTaskInput,
    ): Effect.Effect<LocalFactResult<SendBackTaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const message =
        input.message === undefined
          ? undefined
          : Schema.decodeUnknownSync(Message, strictDecode)(input.message);
      const sentBackTask = Schema.decodeUnknownSync(
        Task,
        strictDecode,
      )(input.sentBackTask);
      return transaction(
        "work.task.send-back",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const { installationId: localInstallationId } =
              yield* canonicalLocalWorkAuthority(writer);
            if (input.target.canvasName !== input.sink.canvasName) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  "sending a task back stays on one canvas",
                ),
              );
            }
            if (
              sentBackTask.id !== input.taskId ||
              sentBackTask.state !== "submitted" ||
              sentBackTask.claimedBy !== undefined
            ) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  "send back must re-home the same task as submitted and unclaimed",
                ),
              );
            }
            const current = yield* loadTask(
              writer,
              "task",
              input.sink,
              input.taskId,
            );
            if (current === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `task "${input.taskId}" does not exist`,
                ),
              );
            }
            if (current.row.entity_home !== localInstallationId) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "local installation does not own this task",
                ),
              );
            }
            if (!canTransitionTaskState(current.task.state, "rejected")) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `cannot send task "${input.taskId}" back from ${current.task.state}`,
                ),
              );
            }
            const previousRow = yield* loadTask(
              writer,
              "task",
              input.target,
              input.taskId,
            );
            if (previousRow === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `task "${input.taskId}" has no visit row at "${input.target.nodeId}"`,
                ),
              );
            }
            if (previousRow.row.entity_home !== localInstallationId) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "local installation does not own the previous visit row",
                ),
              );
            }
            if (!canTransitionTaskState(previousRow.task.state, "submitted")) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `cannot re-open previous visit row from ${previousRow.task.state}`,
                ),
              );
            }
            const rejected = yield* Schema.decodeUnknownEffect(
              Task,
              strictDecode,
            )({
              ...(() => {
                const { completionEvidence: _evidence, ...rest } =
                  taskWithTransitionState(current.task, "rejected");
                return rest;
              })(),
              history:
                message === undefined
                  ? current.task.history
                  : [...current.task.history, message],
              visits: input.visits,
              ...(input.defects !== undefined
                ? { defects: input.defects }
                : {}),
            });
            const rejectedFact = yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("task", input.taskId, input.sink),
              operation: "task.transition",
              predecessor: yield* Effect.try(
                currentIdentity.bind(undefined, current.row),
              ),
              body: { operation: "task.transition", task: rejected },
              value: rejected,
              originAt,
              receivedAt,
            });
            yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.target,
              basis: input.basis,
              item: item("task", input.taskId, input.target),
              operation: "task.transition",
              predecessor: yield* Effect.try(
                currentIdentity.bind(undefined, previousRow.row),
              ),
              body: { operation: "task.transition", task: sentBackTask },
              value: sentBackTask,
              originAt,
              receivedAt,
            });
            if (input.review !== undefined) {
              // CAS against the loaded current task: a blocking verdict is bound to
              // the epoch it judged. If the task was reclaimed and its epoch moved
              // since the verdict was formed, this write is stale and must not land
              // — otherwise a delayed old-epoch blocking would kill a fresh claim.
              const currentEpoch = current.task.epoch ?? 0;
              if (input.review.verdict.epoch !== currentEpoch) {
                return yield* Effect.fail(
                  authorityError(
                    "invalid-transition",
                    `stale review: verdict epoch ${String(input.review.verdict.epoch)} ` +
                      `no longer matches the current task epoch ${String(currentEpoch)}`,
                  ),
                );
              }
              // Immutable blocking verdict in the same transaction as the reject.
              yield* (yield* CrewRepository).postVerdictWithin(
                input.review.verdict,
              );
              const receipt = input.review.receipt;
              if (receipt !== undefined) {
                yield* (yield* CrewRepository).recordReviewReceiptWithin(
                  receipt,
                );
              }
            }
            return {
              value: { rejected, sentBack: sentBackTask },
              record: rejectedFact.record,
            };
          }),
      );
    };

    const mintReviewReceipts = Effect.fn("work.mintReviewReceipts")(function* (
      writer: SqlClient.SqlClient,
      installationId: InstallationId,
      basis: IntentFactBasisValue,
      canvasName: string,
      taskSink: SinkRefValue,
      committedTask: TaskValue,
      committedRecord: WorkFactValue,
      receiptAuthor: MailSenderStamp,
      originAt: DisplayTimestampValue,
      receivedAt: DisplayTimestampValue,
    ): Effect.fn.Return<
      ReadonlyArray<ReviewReceiptRecord>,
      WorkSqlFailure,
      ModelRecords | CrewRepository | WorkJournal
    > {
      // The explicit author stamp must match the committed task's live author
      // seat. A claim flip between the caller's preflight and this commit is an
      // authority refusal that rolls the whole transaction back — never a silent
      // drop that would mutate a fresh claimant's task without its receipt.
      const authorSeat = reviewAuthorSeat(committedTask);
      if (authorSeat === undefined || receiptAuthor.fromSeat !== authorSeat) {
        return yield* Effect.fail(
          authorityError(
            "authority-mismatch",
            "receipt author no longer matches the current task claimant",
          ),
        );
      }
      const { doc, actorRefs: refsHere } = yield* readReviewCanvas(writer, canvasName);
      if (doc === undefined) return [];
      const authorNode = agentNodeForSeat(refsHere, authorSeat);
      if (authorNode === undefined) return [];
      const reviewers = reviewersOfAuthor({
        doc,
        authorNodeId: authorNode.nodeId,
        actorRefs: refsHere,
      });
      if (reviewers.length === 0) return [];
      const projection = reviewSubjectProjection({
        installationId,
        canvasName,
        nodeId: taskSink.nodeId,
        task: committedTask,
      });
      if (projection.refs.length === 0) return [];
      const source = receiptSourceForRecord({ id: committedRecord.id });
      const sourceIdStr = receiptSourceId(source);
      const existing = yield* SqlSchema.findAll({
        Request: WorkSqlBindings,
        Result: ReviewReceiptKeyRow,
        execute: (bindings) =>
          writer.unsafe(
            `SELECT ref_sha, reviewer_seat_id FROM work_review_receipts
         WHERE canvas_name = ? AND source_kind = ? AND source_id = ?`,
            bindings,
          ),
      })([canvasName, source.kind, sourceIdStr]);
      const sent = new Set(
        existing.map((row) =>
          receiptDedupeKey({
            canvasName,
            source,
            refSha: row.ref_sha,
            reviewerSeatId: row.reviewer_seat_id as ActorSeatId,
          }),
        ),
      );
      const authorRef = {
        seatId: authorSeat,
        canvasName,
        nodeId: authorNode.nodeId,
      };
      const plan = planReceiptMail({
        canvasName,
        nodeId: taskSink.nodeId,
        task: committedTask,
        refs: projection.refs,
        source,
        reviewers,
        author: {
          seatId: receiptAuthor.fromSeat,
          generation: receiptAuthor.senderGeneration,
          harness: receiptAuthor.senderHarness,
        },
        contextId: canvasName,
        projection,
        alreadySent: (key) => sent.has(key),
        messageId: () => ulid(),
      });
      const records: ReviewReceiptRecord[] = [];
      for (const mail of plan.mail) {
        const reviewerSink = { canvasName, nodeId: mail.reviewerNodeId };
        // Admit once so the returned record is byte-identical to the row the
        // writer persists (senderNodeId stamped, forged facts stripped).
        const message = admitMailboxMessage(mail.message, authorRef);
        yield* commitLocalFact(writer, {
          localInstallationId: installationId,
          sink: reviewerSink,
          basis,
          item: item("message", message.messageId, reviewerSink),
          operation: "message.append",
          predecessor: null,
          body: {
            operation: "message.append",
            message,
            sentBy: authorRef,
            destination: { kind: "mailbox" },
          },
          value: message,
          originAt,
          receivedAt,
        });
        const freshShas = (readMailExtension(message.metadata)?.refs ?? [])
          .filter((ref) => ref.kind === "commit")
          .map((ref) => (ref.kind === "commit" ? ref.sha : ""));
        for (const sha of freshShas) {
          yield* (yield* CrewRepository).recordReviewReceiptWithin({
            canvasName,
            sourceKind: source.kind,
            sourceId: sourceIdStr,
            refSha: sha,
            reviewerSeatId: mail.reviewerSeatId,
            authorSeatId: authorSeat,
            taskId: committedTask.id,
            messageId: message.messageId,
            createdAt: receivedAt,
          });
        }
        records.push({
          canvas: canvasName,
          nodeId: mail.reviewerNodeId,
          message,
        });
      }
      return records;
    });

    const publishCheckoutReceipts = (input: {
      readonly basis: IntentFactBasisValue;
      readonly canvasName: string;
      readonly nodeId: string;
      readonly taskId: string;
      readonly checkoutKey: string;
      readonly author: MailSenderStamp;
      readonly shas: ReadonlyArray<string>;
    }): Effect.Effect<
      ReadonlyArray<ReviewReceiptRecord>,
      RepositoryFailure
    > => {
      const sink = { canvasName: input.canvasName, nodeId: input.nodeId };
      return transaction(
        "work.review.publish-checkout-receipts",
        sink,
        (
          writer: SqlClient.SqlClient,
        ): Effect.Effect<
          ReadonlyArray<ReviewReceiptRecord>,
          WorkSqlFailure,
          ModelRecords | CrewRepository | WorkJournal
        > =>
          Effect.gen(function* () {
            const authority = yield* canonicalLocalWorkAuthority(writer);
            yield* assertCurrentIntentBasis(writer, sink,
              input.basis,
            );
            const installationId = authority.installationId;
            const current = yield* loadTask(writer, "task", sink, input.taskId);
            // Task gone: the trigger's group is stale — no receipts, no failure.
            if (current === undefined) return [];
            const authorSeat = reviewAuthorSeat(current.task);
            // A claim flip since the observation is an authority refusal, not a
            // silent drop: the whole transaction rolls back.
            if (
              authorSeat === undefined ||
              input.author.fromSeat !== authorSeat
            ) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "checkout receipt author no longer matches the current task claimant",
                ),
              );
            }
            // Provenance CAS across the whole batch, BEFORE any mail: a sha first
            // seen under another author stays owned by that author (firstAuthorForSha
            // and its commit verdict remain pinned to A). Re-stamping the current
            // claimant B would mint a receipt no one can action at its sender, so a
            // batch containing any conflicting sha is refused atomically — nothing
            // is written, and a fresh sha in the same batch gains no provenance.
            for (const sha of input.shas) {
              const norm = sha.trim().toLowerCase();
              if (norm.length === 0) continue;
              // A commit sha is globally unique, so its author is global: the same
              // provenance firstAuthorForSha and the commit-verdict branch read.
              // A sha first attributed to another author stays theirs, or a receipt
              // stamped under the current claimant could never be actioned at its
              // sender. Any conflicting sha refuses the whole batch atomically.
              const prior = yield* SqlSchema.findOneOption({
                Request: WorkSqlBindings,
                Result: ReviewAuthorRow,
                execute: (bindings) =>
                  writer.unsafe(
                    `SELECT author_seat_id FROM work_review_receipts
               WHERE ref_sha = ? ORDER BY created_at, source_id LIMIT 1`,
                    bindings,
                  ),
              })([norm]).pipe(Effect.map(Option.getOrUndefined));
              if (prior !== undefined && prior.author_seat_id !== authorSeat) {
                return yield* Effect.fail(
                  authorityError(
                    "authority-mismatch",
                    `commit ${norm} is already attributed to a different author; ` +
                      "refusing to re-stamp it under the current claimant",
                  ),
                );
              }
            }
            const { doc, actorRefs: refsHere } = yield* readReviewCanvas(writer, input.canvasName);
            const authorNode = agentNodeForSeat(refsHere, authorSeat);
            if (doc === undefined || authorNode === undefined) return [];
            const reviewers = reviewersOfAuthor({
              doc,
              authorNodeId: authorNode.nodeId,
              actorRefs: refsHere,
            });
            if (reviewers.length === 0) return [];
            const source = {
              kind: "checkout" as const,
              checkoutKey: input.checkoutKey,
            };
            const sourceIdStr = receiptSourceId(source);
            const existing = yield* SqlSchema.findAll({
              Request: WorkSqlBindings,
              Result: ReviewReceiptKeyRow,
              execute: (bindings) =>
                writer.unsafe(
                  `SELECT ref_sha, reviewer_seat_id FROM work_review_receipts
             WHERE canvas_name = ? AND source_kind = 'checkout' AND source_id = ?`,
                  bindings,
                ),
            })([input.canvasName, sourceIdStr]);
            const sent = new Set(
              existing.map((row) =>
                receiptDedupeKey({
                  canvasName: input.canvasName,
                  source,
                  refSha: row.ref_sha,
                  reviewerSeatId: row.reviewer_seat_id as ActorSeatId,
                }),
              ),
            );
            const authorRef = {
              seatId: authorSeat,
              canvasName: input.canvasName,
              nodeId: authorNode.nodeId,
            };
            const plan = planCheckoutReceiptMail({
              canvasName: input.canvasName,
              checkoutKey: input.checkoutKey,
              shas: input.shas,
              reviewers,
              author: {
                seatId: input.author.fromSeat,
                generation: input.author.senderGeneration,
                harness: input.author.senderHarness,
              },
              contextId: input.canvasName,
              alreadySent: (key) => sent.has(key),
              messageId: () => ulid(),
            });
            const records: ReviewReceiptRecord[] = [];
            for (const mail of plan.mail) {
              const reviewerSink = {
                canvasName: input.canvasName,
                nodeId: mail.reviewerNodeId,
              };
              const message = admitMailboxMessage(mail.message, authorRef);
              const at = yield* Effect.try(now.bind(undefined));
              yield* commitLocalFact(writer, {
                localInstallationId: installationId,
                sink: reviewerSink,
                basis: input.basis,
                item: item("message", message.messageId, reviewerSink),
                operation: "message.append",
                predecessor: null,
                body: {
                  operation: "message.append",
                  message,
                  sentBy: authorRef,
                  destination: { kind: "mailbox" },
                },
                value: message,
                originAt: at,
                receivedAt: at,
              });
              const freshShas = (
                readMailExtension(message.metadata)?.refs ?? []
              )
                .filter((ref) => ref.kind === "commit")
                .map((ref) => (ref.kind === "commit" ? ref.sha : ""));
              for (const sha of freshShas) {
                yield* (yield* CrewRepository).recordReviewReceiptWithin({
                  canvasName: input.canvasName,
                  sourceKind: "checkout",
                  sourceId: sourceIdStr,
                  refSha: sha,
                  reviewerSeatId: mail.reviewerSeatId,
                  authorSeatId: authorSeat,
                  taskId: input.taskId,
                  messageId: message.messageId,
                  createdAt: at,
                });
              }
              records.push({
                canvas: input.canvasName,
                nodeId: mail.reviewerNodeId,
                message,
              });
            }
            return records;
          }),
      );
    };

    const postReviewVerdict = (
      verdict: ReviewVerdict,
      opts: {
        readonly basis: IntentFactBasisValue;
        readonly canvasName: string;
      },
    ): Effect.Effect<PostReviewVerdictResult, RepositoryFailure> => {
      const subject = verdict.subject;
      if (subject.kind === "commit") {
        // A commit subject carries no live task to CAS, but still requires live
        // authority: the author is the durable first-seen-sha provenance, the
        // reviewer may not be that author, and a current directed reviews edge
        // reviewer->author must hold verdict.post. Only the task epoch/hash CAS
        // and the work-side effect are omitted (a sha may belong to many tasks).
        return transaction(
          "work.review.post-verdict",
          {
            canvasName: opts.canvasName,
            nodeId: verdict.reviewerNodeId ?? "review",
          },
          (
            writer: SqlClient.SqlClient,
          ): Effect.Effect<
            PostReviewVerdictResult,
            WorkSqlFailure,
            ModelRecords | CrewRepository
          > =>
            Effect.gen(function* () {
              const provenance = yield* SqlSchema.findOneOption({
                Request: WorkSqlBindings,
                Result: ReviewAuthorRow,
                execute: (bindings) =>
                  writer.unsafe(
                    `SELECT author_seat_id FROM work_review_receipts
               WHERE ref_sha = ? ORDER BY created_at, source_id LIMIT 1`,
                    bindings,
                  ),
              })([subject.sha.trim().toLowerCase()]).pipe(
                Effect.map(Option.getOrUndefined),
              );
              if (provenance === undefined) {
                return { rejected: "reviews-edge-missing" };
              }
              const authorSeat = provenance.author_seat_id as ActorSeatId;
              if (verdict.reviewerSeatId === authorSeat) {
                return { rejected: "reviewer-is-author" };
              }
              const { doc, actorRefs: refsHere } = yield* readReviewCanvas(writer, opts.canvasName);
              const reviewerNode = agentNodeForSeat(
                refsHere,
                verdict.reviewerSeatId,
              );
              const authorNode = agentNodeForSeat(refsHere, authorSeat);
              if (
                doc === undefined ||
                reviewerNode === undefined ||
                authorNode === undefined ||
                !reviewsEdgeExists(doc, reviewerNode.nodeId, authorNode.nodeId)
              ) {
                return { rejected: "reviews-edge-missing" };
              }
              const before = yield* SqlSchema.findOneOption({
                Request: WorkSqlBindings,
                Result: VerdictIdRow,
                execute: (bindings) =>
                  writer.unsafe(
                    `SELECT verdict_id FROM work_review_verdicts WHERE verdict_id = ?`,
                    bindings,
                  ),
              })([verdict.verdictId]).pipe(Effect.map(Option.getOrUndefined));
              yield* (yield* CrewRepository).postVerdictWithin(verdict);
              return { verdict, created: before === undefined };
            }),
        );
      }
      const sink = { canvasName: opts.canvasName, nodeId: subject.nodeId };
      return transaction(
        "work.review.post-verdict",
        sink,
        (
          writer: SqlClient.SqlClient,
        ): Effect.Effect<
          PostReviewVerdictResult,
          WorkSqlFailure,
          ModelRecords | CrewRepository
        > =>
          Effect.gen(function* () {
            const { installationId } =
              yield* canonicalLocalWorkAuthority(writer);
            const current = yield* loadTask(
              writer,
              "task",
              sink,
              subject.taskId,
            );
            if (current === undefined) {
              return { rejected: "stale-subject" };
            }
            // Recompute the subject from the live task's canonical completion
            // refs — never a cached derived hash.
            const projection = reviewSubjectProjection({
              installationId,
              canvasName: opts.canvasName,
              nodeId: subject.nodeId,
              task: current.task,
            });
            const authorSeat = reviewAuthorSeat(current.task);
            if (authorSeat === undefined) {
              // No live author to target: no reviews edge can hold.
              return { rejected: "reviews-edge-missing" };
            }
            // Self-review: the reviewer is (or has become) the current author.
            if (verdict.reviewerSeatId === authorSeat) {
              return { rejected: "reviewer-is-author" };
            }
            // Stale: the live epoch, subject hash, or author moved since the
            // verdict was formed.
            if (
              projection.epoch !== verdict.epoch ||
              projection.subjectHash !== verdict.subjectHash ||
              verdict.authorSeatId !== authorSeat
            ) {
              return { rejected: "stale-subject" };
            }
            // A current directed reviews edge reviewer→author holding verdict.post
            // in this canvas, re-read in the same writer (mask respected).
            const { doc, actorRefs: refsHere } = yield* readReviewCanvas(writer, opts.canvasName);
            const reviewerNode = agentNodeForSeat(
              refsHere,
              verdict.reviewerSeatId,
            );
            const authorNode = agentNodeForSeat(refsHere, authorSeat);
            if (
              doc === undefined ||
              reviewerNode === undefined ||
              authorNode === undefined ||
              !reviewsEdgeExists(doc, reviewerNode.nodeId, authorNode.nodeId)
            ) {
              return { rejected: "reviews-edge-missing" };
            }
            const before = yield* SqlSchema.findOneOption({
              Request: WorkSqlBindings,
              Result: VerdictIdRow,
              execute: (bindings) =>
                writer.unsafe(
                  `SELECT verdict_id FROM work_review_verdicts WHERE verdict_id = ?`,
                  bindings,
                ),
            })([verdict.verdictId]).pipe(Effect.map(Option.getOrUndefined));
            yield* (yield* CrewRepository).postVerdictWithin(verdict);
            return { verdict, created: before === undefined };
          }),
      );
    };

    const promoteTask = (
      input: PromoteTaskInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction(
        "work.task.promote",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const authority = yield* canonicalLocalWorkAuthority(writer);
            const current = yield* loadTask(
              writer,
              "task",
              input.sink,
              input.taskId,
            );
            if (current === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `task "${input.taskId}" does not exist`,
                ),
              );
            }
            if (current.row.entity_home !== authority.installationId) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "local installation does not own this task",
                ),
              );
            }
            if (current.task.state !== "submitted") {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `cannot promote task "${input.taskId}" in state ${current.task.state}`,
                ),
              );
            }
            // Promotion is an approval stamp on the waiting task, not a state change;
            // it records as a same-state 'task.transition' fact (the closed
            // immutable-log vocabulary has no dedicated word for it).
            const taskWithMessage =
              input.message === undefined
                ? current.task
                : {
                    ...current.task,
                    history: [...current.task.history, input.message],
                  };
            const task = yield* Schema.decodeUnknownEffect(
              Task,
              strictDecode,
            )(
              applyTaskRecordPatch(taskWithMessage, {
                approvedEpoch: current.task.epoch ?? 0,
              }),
            );
            return yield* commitLocalFact(writer, {
              localInstallationId: authority.installationId,
              sink: input.sink,
              basis: input.basis,
              item: item("task", input.taskId, input.sink),
              operation: "task.transition",
              predecessor: yield* Effect.try(
                currentIdentity.bind(undefined, current.row),
              ),
              body: { operation: "task.transition", task },
              value: task,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const recordCheckResults = (
      input: RecordCheckResultsInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const results = input.results.map((result) =>
        Schema.decodeUnknownSync(CheckResult, strictDecode)(result),
      );
      return transaction(
        "work.task.check",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const { installationId: localInstallationId } =
              yield* canonicalLocalWorkAuthority(writer);
            const current = yield* loadTask(
              writer,
              "task",
              input.sink,
              input.taskId,
            );
            if (current === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `task "${input.taskId}" does not exist`,
                ),
              );
            }
            if (current.row.entity_home !== localInstallationId) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "local installation does not own this task",
                ),
              );
            }
            if (isTerminalTaskState(current.task.state)) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `cannot record check results on terminal task "${input.taskId}"`,
                ),
              );
            }
            // Merge against the row just loaded in this transaction — never a
            // pre-transaction snapshot — so two concurrent check runs (e.g. for
            // two different Next boards) can't clobber each other's results:
            // same-epoch results for other checks survive; stale epochs drop
            // (send-back staled them for completion accounting).
            const epoch = results[0]?.epoch;
            const merged = [
              ...(current.task.checkResults ?? []).filter(
                (result) =>
                  result.epoch !== epoch ||
                  results.some(
                    (candidate) =>
                      candidate.checkId === result.checkId &&
                      candidate.side === result.side,
                  ),
              ),
              ...results,
            ];
            // Same-state 'task.transition' fact, like approval — check results
            // are a system stamp, not a state change.
            const task = yield* Schema.decodeUnknownEffect(
              Task,
              strictDecode,
            )(
              applyTaskRecordPatch(current.task, {
                checkResults: merged.length > 0 ? merged : null,
              }),
            );
            return yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("task", input.taskId, input.sink),
              operation: "task.transition",
              predecessor: yield* Effect.try(
                currentIdentity.bind(undefined, current.row),
              ),
              body: { operation: "task.transition", task },
              value: task,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const createRequest = (
      input: CreateRequestInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const request = Schema.decodeUnknownSync(
        Task,
        strictDecode,
      )(input.request);
      return transaction(
        "work.request.create",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const { installationId: localInstallationId } =
              yield* canonicalLocalWorkAuthority(writer);
            if (
              request.state !== "input-required" ||
              request.claimedBy !== input.raisedBy.seatId
            ) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "request must be input-required work claimed by its exact raiser",
                ),
              );
            }
            if (
              (yield* selectTaskIdentity(
                writer,
                "request",
                input.sink,
                request.id,
              )) !== undefined
            ) {
              return yield* Effect.fail(
                authorityError(
                  "identity-conflict",
                  `request "${request.id}" already exists`,
                ),
              );
            }
            return yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("request", request.id, input.sink),
              operation: "request.create",
              predecessor: null,
              body: { operation: "request.create", request },
              value: request,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const resolveRequest = (
      input: ResolveRequestInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const message =
        input.message === undefined
          ? undefined
          : Schema.decodeUnknownSync(Message, strictDecode)(input.message);
      return transaction(
        "work.request.resolve",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            if (message !== undefined) {
            }
            const { installationId: localInstallationId } =
              yield* canonicalLocalWorkAuthority(writer);
            const current = yield* loadTask(
              writer,
              "request",
              input.sink,
              input.requestId,
            );
            if (current === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `request "${input.requestId}" does not exist`,
                ),
              );
            }
            if (current.row.entity_home !== localInstallationId) {
              return yield* Effect.fail(
                authorityError(
                  "authority-mismatch",
                  "local installation does not own this request",
                ),
              );
            }
            if (
              !canTransitionTaskState(current.task.state, input.disposition)
            ) {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `cannot resolve request "${input.requestId}" from ${current.task.state}`,
                ),
              );
            }
            const request = yield* Schema.decodeUnknownEffect(
              Task,
              strictDecode,
            )({
              ...current.task,
              state: input.disposition,
              response: input.response,
              history:
                message === undefined
                  ? current.task.history
                  : [...current.task.history, message],
            });
            return yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("request", request.id, input.sink),
              operation: "request.resolve",
              predecessor: yield* Effect.try(
                currentIdentity.bind(undefined, current.row),
              ),
              body: { operation: "request.resolve", request },
              value: request,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const appendMessage = (
      input: AppendMessageInput,
    ): Effect.Effect<LocalFactResult<MessageValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const decodedMessage = Schema.decodeUnknownSync(
        Message,
        strictDecode,
      )(input.message);
      const sentBy = Schema.decodeUnknownSync(
        ActorRefSchema,
        strictDecode,
      )(input.sentBy);
      const destination = Schema.decodeUnknownSync(
        MessageAppendDestinationSchema,
        strictDecode,
      )(input.destination);
      // Admit before the fact is minted so the durable fact body and the
      // returned value (which drives the delivery nudge) never carry forged
      // reserved keys. writeInboxMessage re-admits as the universal row gate
      // for facts that arrive from other ingest paths.
      const message =
        destination.kind === "mailbox"
          ? admitMailboxMessage(decodedMessage, sentBy)
          : decodedMessage;
      return transaction(
        "work.message.append",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const authority = yield* canonicalLocalWorkAuthority(writer);
            const localInstallationId = authority.installationId;
            if (destination.kind !== "mailbox") {
              if (message.taskId !== destination.itemId) {
                return yield* Effect.fail(
                  authorityError(
                    "target-mismatch",
                    "task/request message destination must equal Message.taskId",
                  ),
                );
              }
              yield* requireThreadParent(
                writer,
                input.sink,
                destination,
                localInstallationId,
              );
            }
            yield* assertMessageIdentityAvailable(
              writer,
              input.sink,
              message.messageId,
            );
            return yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("message", message.messageId, input.sink),
              operation: "message.append",
              predecessor: null,
              body: {
                operation: "message.append",
                message,
                sentBy,
                destination,
              },
              value: message,
              originAt,
              receivedAt,
            });
          }),
        destination.kind === "mailbox" ? "mail" : "work",
      );
    };

    const publishArtifact = (
      input: PublishArtifactInput,
    ): Effect.Effect<LocalFactResult<ArtifactValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const artifact = Schema.decodeUnknownSync(
        Artifact,
        strictDecode,
      )(input.artifact);
      return transaction(
        "work.artifact.publish",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const { installationId: localInstallationId } =
              yield* canonicalLocalWorkAuthority(writer);
            yield* assertArtifactTaskReference(
              writer,
              input.sink,
              artifact,
              localInstallationId,
            );
            if (
              (yield* SqlSchema.findOneOption({
                Request: WorkSqlBindings,
                Result: ExistsRow,
                execute: (bindings) =>
                  writer.unsafe(
                    `
              SELECT 1 FROM work_artifacts
              WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
            `,
                    bindings,
                  ),
              })([
                input.sink.canvasName,
                input.sink.nodeId,
                artifact.artifactId,
              ]).pipe(Effect.map(Option.getOrUndefined))) !== undefined
            ) {
              return yield* Effect.fail(
                authorityError(
                  "identity-conflict",
                  `artifact "${artifact.artifactId}" already exists`,
                ),
              );
            }
            return yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("artifact", artifact.artifactId, input.sink),
              operation: "artifact.publish",
              predecessor: null,
              body: {
                operation: "artifact.publish",
                artifact,
                publishedBy: input.publishedBy,
              },
              value: artifact,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const acceptDelivery = (
      input: AcceptDeliveryInput,
    ): Effect.Effect<LocalFactResult<DeliveryReceipt>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction(
        "work.delivery.accepted",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const { installationId: localInstallationId } =
              yield* canonicalLocalWorkAuthority(writer);
            const receipt = input.receipt;
            if (
              receipt.deliveredItem.sink.canvasName !== input.sink.canvasName ||
              receipt.deliveredItem.sink.nodeId !== input.sink.nodeId
            ) {
              return yield* Effect.fail(
                authorityError(
                  "target-mismatch",
                  "delivery receipt sink differs from the accepted item sink",
                ),
              );
            }
            if (
              (yield* SqlSchema.findOneOption({
                Request: WorkSqlBindings,
                Result: ExistsRow,
                execute: (bindings) =>
                  writer.unsafe(
                    `
              SELECT 1
              FROM work_delivery_receipts
              WHERE delivered_canvas_name = ?
                AND delivered_node_id = ?
                AND delivery_id = ?
            `,
                    bindings,
                  ),
              })([
                receipt.deliveredItem.sink.canvasName,
                receipt.deliveredItem.sink.nodeId,
                receipt.deliveryId,
              ]).pipe(Effect.map(Option.getOrUndefined))) !== undefined
            ) {
              return yield* Effect.fail(
                authorityError(
                  "identity-conflict",
                  `delivery "${receipt.deliveryId}" already exists`,
                ),
              );
            }
            return yield* commitLocalFact(writer, {
              localInstallationId,
              sink: input.sink,
              basis: input.basis,
              item: item("delivery", receipt.deliveryId, input.sink),
              operation: "delivery.accepted",
              predecessor: null,
              body: { operation: "delivery.accepted", receipt },
              value: receipt,
              originAt,
              receivedAt,
            });
          }),
        input.receipt.deliveredItem.kind === "message" ? "mail" : "work",
      );
    };

    const createBoardTopic = (
      input: CreateBoardTopicInput,
    ): Effect.Effect<LocalFactResult<BoardTopicValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const createdBy = input.createdBy;
      const topic = topicWithBoundAuthors(
        Schema.decodeUnknownSync(BoardTopic, strictDecode)(input.topic),
        createdBy,
      );
      return transaction(
        "work.board.topic.create",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const authority = yield* canonicalLocalWorkAuthority(writer);
            if (
              (yield* SqlSchema.findOneOption({
                Request: WorkSqlBindings,
                Result: ExistsRow,
                execute: (bindings) =>
                  writer.unsafe(
                    `
              SELECT 1 FROM work_board_topics
              WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
            `,
                    bindings,
                  ),
              })([
                input.sink.canvasName,
                input.sink.nodeId,
                topic.topicId,
              ]).pipe(Effect.map(Option.getOrUndefined))) !== undefined
            ) {
              return yield* Effect.fail(
                authorityError(
                  "identity-conflict",
                  `topic "${topic.topicId}" already exists`,
                ),
              );
            }
            return yield* commitLocalFact(writer, {
              localInstallationId: authority.installationId,
              sink: input.sink,
              basis: input.basis,
              item: item("topic", topic.topicId, input.sink),
              operation: "board.topic.create",
              predecessor: null,
              body: {
                operation: "board.topic.create",
                topic,
                createdBy,
              },
              value: topic,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const appendBoardPost = (
      input: AppendBoardPostInput,
    ): Effect.Effect<LocalFactResult<BoardPostValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const post = Schema.decodeUnknownSync(
        BoardPost,
        strictDecode,
      )(input.post);
      const createdBy = input.createdBy;
      return transaction(
        "work.board.post.append",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const authority = yield* canonicalLocalWorkAuthority(writer);
            const topic = yield* SqlSchema.findOneOption({
              Request: WorkSqlBindings,
              Result: BoardStateRow,
              execute: (bindings) =>
                writer.unsafe(
                  `
            SELECT state FROM work_board_topics
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
          `,
                  bindings,
                ),
            })([input.sink.canvasName, input.sink.nodeId, post.topicId]).pipe(
              Effect.map(Option.getOrUndefined),
            );
            if (topic === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `topic "${post.topicId}" does not exist`,
                ),
              );
            }
            if (topic.state === "archived") {
              return yield* Effect.fail(
                authorityError(
                  "invalid-transition",
                  `topic "${post.topicId}" is archived`,
                ),
              );
            }
            const maxPos = yield* SqlSchema.findOneOption({
              Request: WorkSqlBindings,
              Result: MaxPositionRow,
              execute: (bindings) =>
                writer.unsafe(
                  `
            SELECT MAX(position) AS m FROM work_board_posts
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
          `,
                  bindings,
                ),
            })([input.sink.canvasName, input.sink.nodeId, post.topicId]).pipe(
              Effect.map(Option.getOrUndefined),
            );
            if (
              (yield* SqlSchema.findOneOption({
                Request: WorkSqlBindings,
                Result: ExistsRow,
                execute: (bindings) =>
                  writer.unsafe(
                    `
              SELECT 1 FROM work_board_posts
              WHERE canvas_name = ? AND node_id = ? AND topic_id = ? AND post_id = ?
            `,
                    bindings,
                  ),
              })([
                input.sink.canvasName,
                input.sink.nodeId,
                post.topicId,
                post.postId,
              ]).pipe(Effect.map(Option.getOrUndefined))) !== undefined
            ) {
              return yield* Effect.fail(
                authorityError(
                  "identity-conflict",
                  `post "${post.postId}" already exists`,
                ),
              );
            }
            const position =
              typeof maxPos?.m === "number" && Number.isFinite(maxPos.m)
                ? maxPos.m + 1
                : 0;
            const stored = { ...post, author: createdBy, position };
            return yield* commitLocalFact(writer, {
              localInstallationId: authority.installationId,
              sink: input.sink,
              basis: input.basis,
              item: item("post", stored.postId, input.sink),
              operation: "board.post.append",
              predecessor: null,
              body: {
                operation: "board.post.append",
                post: stored,
                createdBy,
              },
              value: stored,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const readPad = (
      canvasName: string,
      nodeId: string,
    ): Effect.Effect<Pad, WorkRepositoryError> =>
      withSqlRead(
        sql,
        ((reader: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            return yield* loadPad(reader, { canvasName, nodeId });
          }))(sql),
      )
        .pipe(Effect.provideService(StateTransactionOperation, "work.pad.read"))
        .pipe(
          Effect.mapError((error) => toRepositoryError("work.pad.read", error)),
        );

    const applyPadPatch = (
      input: ApplyPadPatchInput,
    ): Effect.Effect<LocalFactResult<Pad>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction(
        "work.pad.patch",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const authority = yield* canonicalLocalWorkAuthority(writer);
            const patches = stampPadPatchAuthors(input.patches, input.author);
            yield* assertPadPatchRules(
              writer,
              input.sink,
              input.author,
              patches,
              input.overseer,
            );
            const current = yield* loadPad(writer, input.sink);
            const applied = applyPatches(current, patches);
            if (Result.isFailure(applied)) {
              return yield* Effect.fail(
                authorityError("invalid-transition", applied.failure.message),
              );
            }
            return yield* commitLocalFact(writer, {
              localInstallationId: authority.installationId,
              sink: input.sink,
              basis: input.basis,
              item: item("pad", input.patchId, input.sink),
              operation: "pad.patch",
              predecessor: null,
              body: {
                operation: "pad.patch",
                patchId: input.patchId,
                patches: [...patches],
                author: input.author,
                revision: applied.success.revision,
              },
              value: applied.success,
              originAt,
              receivedAt,
            });
          }),
      );
    };

    const markPadRead = (input: {
      readonly sink: SinkRefValue;
      readonly pinId: string;
      readonly principalKey: string;
      readonly lastReadPosition: number;
      readonly updatedAt?: string;
    }): Effect.Effect<void, RepositoryFailure> => {
      const updatedAt = timestamp(input.updatedAt);
      return transaction(
        "work.pad.mark_read",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            yield* writer.unsafe(
              `
            INSERT INTO work_pad_read_cursors(
              canvas_name, node_id, pin_id, principal_key,
              last_read_position, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(canvas_name, node_id, pin_id, principal_key)
            DO UPDATE SET
              last_read_position = MAX(
                work_pad_read_cursors.last_read_position,
                excluded.last_read_position
              ),
              updated_at = excluded.updated_at
          `,
              [
                input.sink.canvasName,
                input.sink.nodeId,
                input.pinId,
                input.principalKey,
                input.lastReadPosition,
                updatedAt,
              ],
            );
          }),
      );
    };

    const markBoardRead = (input: {
      readonly sink: SinkRefValue;
      readonly topicId: string;
      readonly principalKey: string;
      readonly lastReadPosition: number;
      readonly updatedAt?: string;
    }): Effect.Effect<void, RepositoryFailure> => {
      const updatedAt = timestamp(input.updatedAt);
      return transaction(
        "work.board.mark_read",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            // Clamp to the topic's real max inside the write transaction: an
            // oversized request acknowledges nothing past the stored posts, and
            // the MAX() UPSERT keeps existing cursors monotone. An empty topic
            // clamps to -1 so its future first post stays unread.
            const topicMax = yield* SqlSchema.findOneOption({
              Request: WorkSqlBindings,
              Result: MaxPositionRow,
              execute: (bindings) =>
                writer.unsafe(
                  `
            SELECT MAX(position) AS m FROM work_board_posts
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
          `,
                  bindings,
                ),
            })([input.sink.canvasName, input.sink.nodeId, input.topicId]).pipe(
              Effect.map(Option.getOrUndefined),
            );
            const topicMaxPosition =
              typeof topicMax?.m === "number" && Number.isFinite(topicMax.m)
                ? topicMax.m
                : -1;
            const clamped = Math.max(
              -1,
              Math.min(Math.trunc(input.lastReadPosition), topicMaxPosition),
            );
            yield* writer.unsafe(
              `
            INSERT INTO work_board_read_cursors(
              canvas_name, node_id, topic_id, principal_key,
              last_read_position, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(canvas_name, node_id, topic_id, principal_key)
            DO UPDATE SET
              last_read_position = MAX(
                work_board_read_cursors.last_read_position,
                excluded.last_read_position
              ),
              updated_at = excluded.updated_at
          `,
              [
                input.sink.canvasName,
                input.sink.nodeId,
                input.topicId,
                input.principalKey,
                clamped,
                updatedAt,
              ],
            );
          }),
      );
    };

    const setArtifactArchived = (input: {
      readonly sink: SinkRefValue;
      readonly artifactId: string;
      readonly archived: boolean;
    }): Effect.Effect<ArtifactValue, RepositoryFailure> =>
      transaction(
        "work.artifact.set_archived",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const row = yield* SqlSchema.findOneOption({
              Request: WorkSqlBindings,
              Result: ArtifactRowSchema,
              execute: (bindings) =>
                writer.unsafe(
                  `
            SELECT
              artifact_id,
              name,
              parts_json,
              task_canvas_name,
              task_node_id,
              task_id,
              task_entity_home,
              metadata_json
            FROM work_artifacts
            WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
          `,
                  bindings,
                ),
            })([
              input.sink.canvasName,
              input.sink.nodeId,
              input.artifactId,
            ]).pipe(Effect.map(Option.getOrUndefined));
            if (row === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `artifact "${input.artifactId}" not found`,
                ),
              );
            }
            const metadata =
              row.metadata_json === null
                ? ({} as Record<string, unknown>)
                : ((yield* Effect.try(
                    parseJson.bind(undefined, row.metadata_json),
                  )) as Record<string, unknown>);
            if (input.archived) {
              metadata.archived = true;
            } else {
              delete metadata.archived;
            }
            const metadataJson =
              Object.keys(metadata).length === 0
                ? null
                : canonicalJson(metadata);
            // Declared journal-free: metadata-only operator flag, mints no fact.
            yield* unjournaledWorkMutationEffect(
              "work.artifact.set_archived",
              (() =>
                Effect.gen(function* () {
                  yield* writer.unsafe(
                    `
              UPDATE work_artifacts
              SET metadata_json = ?
              WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
            `,
                    [
                      metadataJson,
                      input.sink.canvasName,
                      input.sink.nodeId,
                      input.artifactId,
                    ],
                  );
                }))(),
            );
            return yield* Schema.decodeUnknownEffect(
              Artifact,
              strictDecode,
            )({
              artifactId: row.artifact_id,
              ...(row.name === null ? {} : { name: row.name }),
              parts: yield* Effect.try(() => parseJson(row.parts_json)),
              ...(row.task_id === null
                ? {}
                : {
                    task: {
                      kind: "task",
                      itemId: row.task_id,
                      sink: {
                        canvasName: row.task_canvas_name,
                        nodeId: row.task_node_id,
                      },
                    },
                  }),
              ...(metadataJson === null ? {} : { metadata }),
            });
          }),
      );

    const deleteArtifact = (input: {
      readonly sink: SinkRefValue;
      readonly artifactId: string;
    }): Effect.Effect<{ readonly artifactId: string }, RepositoryFailure> =>
      transaction(
        "work.artifact.delete",
        input.sink,
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            const row = yield* SqlSchema.findOneOption({
              Request: WorkSqlBindings,
              Result: ExistsRow,
              execute: (bindings) =>
                writer.unsafe(
                  `
            SELECT 1 FROM work_artifacts
            WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
          `,
                  bindings,
                ),
            })([
              input.sink.canvasName,
              input.sink.nodeId,
              input.artifactId,
            ]).pipe(Effect.map(Option.getOrUndefined));
            if (row === undefined) {
              return yield* Effect.fail(
                authorityError(
                  "missing-entity",
                  `artifact "${input.artifactId}" not found`,
                ),
              );
            }
            // Declared journal-free: operator delete mints no tombstone record.
            yield* unjournaledWorkMutationEffect(
              "work.artifact.delete",
              (() =>
                Effect.gen(function* () {
                  yield* writer.unsafe(
                    `
              DELETE FROM work_artifacts
              WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
            `,
                    [
                      input.sink.canvasName,
                      input.sink.nodeId,
                      input.artifactId,
                    ],
                  );
                }))(),
            );
            return { artifactId: input.artifactId };
          }),
      );

    const exchangeHave = (
      canvasName: string,
    ): Effect.Effect<ReadonlyArray<ExchangeCursor>, WorkRepositoryError> =>
      withSqlRead(
        sql,
        sql.unsafe<{ writer: string; through: string }>(
          "SELECT writer, through FROM work_exchange_cursors WHERE canvas_name = ? ORDER BY writer",
          [canvasName],
        ),
      ).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            writer: Schema.decodeUnknownSync(InstallationId)(row.writer),
            through: row.through,
          })),
        ),
        Effect.mapError((error) => toRepositoryError("work.exchange.have", error)),
      );

    const exchangeWriters = (
      canvasName: string,
    ): Effect.Effect<ReadonlyArray<InstallationId>, WorkRepositoryError> =>
      withSqlRead(
        sql,
        sql.unsafe<{ writer: string }>(
          "SELECT DISTINCT event_home AS writer FROM work_events WHERE item_canvas_name = ? ORDER BY 1",
          [canvasName],
        ),
      ).pipe(
        Effect.map((rows) =>
          rows.map((row) => Schema.decodeUnknownSync(InstallationId)(row.writer)),
        ),
        Effect.mapError((error) => toRepositoryError("work.exchange.writers", error)),
      );

    const exchangeRows = (
      input: ExchangeRowsInput,
    ): Effect.Effect<ExchangeRowsPage, WorkRepositoryError> =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          const self = (yield* canonicalLocalWorkAuthority(sql)).installationId;
          const stored = yield* SqlSchema.findAll({
            Request: WorkSqlBindings,
            Result: ExchangeFactRow,
            execute: (bindings) =>
              sql.unsafe(
                `
              SELECT event.event_home, event.seq, event.item_kind, event.item_id,
                event.item_canvas_name, event.item_node_id, event.operation,
                event.content_sha256, event.origin_at, fact.basis_kind,
                fact.basis_canvas_name, fact.basis_canvas_seq, fact.result_json
              FROM work_events AS event
              JOIN work_facts AS fact USING (event_home, entity_home, seq)
              WHERE event.event_home = ?
                AND event.entity_home = ?
                AND event.item_canvas_name = ?
                AND event.operation IN ('message.append', 'delivery.accepted')
                AND fact.predecessor_seq IS NULL
                AND (
                  length(event.seq) > length(?)
                  OR (length(event.seq) = length(?) AND event.seq > ?)
                )
              ORDER BY length(event.seq), event.seq
              LIMIT ?
            `,
                bindings,
              ),
          })([
            input.writer,
            input.writer,
            input.canvasName,
            input.after,
            input.after,
            input.after,
            input.limit + 1,
          ]);
          const more = stored.length > input.limit;
          const page = more ? stored.slice(0, input.limit) : stored;
          const rows: ExchangeRow[] = [];
          for (const row of page) {
            const fact = exchangeFactOf(row);
            if (fact === undefined) continue;
            rows.push({ fact, mailAuthorNodeId: yield* exchangeMailAuthor(sql, fact) });
          }
          if (more) return { rows, through: page.at(-1)!.seq, more };
          // Past the last row, a machine vouches for its own sequence, or for
          // as far as it was itself vouched another writer's.
          const through =
            input.writer === self
              ? ((yield* sql.unsafe<{ last_seq: string }>(
                  "SELECT last_seq FROM work_event_sequences WHERE event_home = ? AND entity_home = ?",
                  [self, self],
                ))[0]?.last_seq ?? "0")
              : (yield* exchangeCursorOf(sql, input.canvasName, input.writer)).through;
          return {
            rows,
            through: compareSequence(through, input.after) < 0 ? input.after : through,
            more,
          };
        }),
      ).pipe(
        Effect.provideService(StateTransactionOperation, "work.exchange.rows"),
        Effect.mapError((error) => toRepositoryError("work.exchange.rows", error)),
      );

    const applyExchangeRows = (
      input: ApplyExchangeRowsInput,
    ): Effect.Effect<AppliedExchangeRows, RepositoryFailure> => {
      const receivedAt = timestamp(input.receivedAt);
      const { frame, peer, placement } = input;
      return transaction(
        "work.exchange.apply",
        { canvasName: frame.canvasName, nodeId: "exchange" },
        (writer: SqlClient.SqlClient) =>
          Effect.gen(function* () {
            if (placement === undefined) {
              return yield* Effect.fail(refuseExchange("this machine does not hold that canvas"));
            }
            if (!peerMayPassOn(peer, frame.writer, placement)) {
              return yield* Effect.fail(
                refuseExchange("that machine may not pass on this writer's rows for this canvas"),
              );
            }
            const self = (yield* canonicalLocalWorkAuthority(writer)).installationId;
            if (frame.writer === self) {
              return yield* Effect.fail(refuseExchange("a machine is never sent its own rows"));
            }
            const cursor = yield* exchangeCursorOf(writer, frame.canvasName, frame.writer);
            let lastSeq = "0";
            let lastBasisSeq = cursor.lastBasisSeq;
            const fresh: ExchangeFact[] = [];
            for (const fact of frame.facts) {
              const { basis } = fact;
              if (
                fact.id.route.eventHome !== frame.writer ||
                fact.item.sink.canvasName !== frame.canvasName ||
                basis.kind !== "canvas"
              ) {
                return yield* Effect.fail(refuseExchange("a row is not of the writer and canvas its frame names"));
              }
              if (
                compareSequence(fact.id.seq, lastSeq) <= 0 ||
                compareSequence(fact.id.seq, frame.through) > 0
              ) {
                return yield* Effect.fail(refuseExchange("rows are out of order or past what their frame vouches"));
              }
              lastSeq = fact.id.seq;
              const { contentSha256: _hash, originAt: _originAt, ...semantic } = fact;
              if (workRecordContentSha256(semantic) !== fact.contentSha256) {
                return yield* Effect.fail(refuseExchange("a row does not match its hash"));
              }
              if (!writtenByItsAuthor(fact, placement)) {
                return yield* Effect.fail(refuseExchange("a row was not written where its author lives"));
              }
              if (!entitledTo(self, fact, placement, yield* exchangeMailAuthor(writer, fact))) {
                return yield* Effect.fail(refuseExchange("this machine is not entitled to a row it was sent"));
              }
              // Above the cursor a writer's stated canvas count never goes
              // backwards. At or below it, a row is one this machine became
              // entitled to later and keeps the count it was written under.
              if (compareSequence(fact.id.seq, cursor.through) > 0) {
                if (basis.seq < lastBasisSeq) {
                  return yield* Effect.fail(refuseExchange("a writer's canvas count went backwards"));
                }
                lastBasisSeq = basis.seq;
              }
              const held = yield* writer.unsafe<{ content_sha256: string }>(
                "SELECT content_sha256 FROM work_events WHERE event_home = ? AND entity_home = ? AND seq = ?",
                [frame.writer, frame.writer, fact.id.seq],
              );
              if (held[0] === undefined) fresh.push(fact);
              else if (held[0].content_sha256 !== fact.contentSha256) {
                return yield* Effect.fail(
                  authorityError("identity-conflict", "a row this machine holds arrived with other content"),
                );
              }
            }

            yield* writer.unsafe(
              "INSERT OR IGNORE INTO station_known_installations(installation_id, registered_at) VALUES (?, ?)",
              [frame.writer, receivedAt],
            );
            const mail: Array<AppliedExchangeRows["mail"][number]> = [];
            if (fresh.length > 0) {
              const newest = fresh.at(-1)!.id.seq;
              const known = yield* writer.unsafe<{ last_seq: string }>(
                "SELECT last_seq FROM work_event_sequences WHERE event_home = ? AND entity_home = ?",
                [frame.writer, frame.writer],
              );
              if (known[0] === undefined || compareSequence(newest, known[0].last_seq) > 0) {
                yield* writer.unsafe(
                  `INSERT INTO work_event_sequences(event_home, entity_home, last_seq) VALUES (?, ?, ?)
                   ON CONFLICT(event_home, entity_home) DO UPDATE SET last_seq = excluded.last_seq`,
                  [frame.writer, frame.writer, newest],
                );
              }
              const journal = yield* WorkJournal;
              for (const fact of fresh) {
                yield* journal.appendWorkRecord(fact, receivedAt);
                if (fact.body.operation === "message.append") {
                  yield* writeInboxMessage(
                    writer,
                    fact.item.sink,
                    fact.body.message,
                    fact.body.sentBy,
                    fact,
                    receivedAt,
                  );
                  mail.push({
                    canvasName: fact.item.sink.canvasName,
                    nodeId: fact.item.sink.nodeId,
                    message: fact.body.message,
                  });
                } else if (fact.body.operation === "delivery.accepted") {
                  yield* writeDelivery(writer, fact.body.receipt, fact, receivedAt);
                }
              }
            }
            const through =
              compareSequence(frame.through, cursor.through) > 0 ? frame.through : cursor.through;
            yield* writer.unsafe(
              `INSERT INTO work_exchange_cursors(canvas_name, writer, through, last_basis_seq, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(canvas_name, writer) DO UPDATE SET
                 through = excluded.through,
                 last_basis_seq = excluded.last_basis_seq,
                 updated_at = excluded.updated_at`,
              [frame.canvasName, frame.writer, through, lastBasisSeq, receivedAt],
            );
            return { taken: fresh.length, mail };
          }),
        "mail",
      ).pipe(
        Effect.tap(({ mail }) =>
          Effect.sync(() => {
            for (const sent of mail) notify({ canvasName: sent.canvasName, nodeId: sent.nodeId }, "mail");
          }),
        ),
      );
    };

    return WorkRepository.of({
      kernelWork: Effect.fn("WorkRepository.kernelWork")((canvasName: string) =>
        withSqlRead(sql, Effect.gen(function* () {
          const tasks = new Map<string, ReadonlyArray<TaskValue>>();
          for (const lane of ["task", "request"] as const) {
            const table = lane === "task" ? "work_tasks" : "work_requests";
            const nodeTable = lane === "task" ? "task_boards" : "request_boards";
            const id = lane === "task" ? "task_id" : "request_id";
            const rows = yield* SqlSchema.findAll({
              Request: Schema.String,
              Result: Schema.Struct({ node_id: Schema.String, item_id: Schema.String }),
              execute: (canvas) => sql.unsafe(`SELECT work.node_id,work.${id} AS item_id FROM ${table} AS work
                JOIN ${nodeTable} AS node ON node.canvas_name=work.canvas_name AND node.id=work.node_id
                WHERE work.canvas_name=? ${lane === "task" ? "AND work.state != 'archived'" : ""}
                ORDER BY node.z_index,node.id,work.created_at,work.${id}`, [canvas]),
            })(canvasName);
            const byNode = new Map<string, string[]>();
            for (const row of rows) {
              const ids = byNode.get(row.node_id) ?? [];
              ids.push(row.item_id); byNode.set(row.node_id, ids);
            }
            for (const [nodeId, ids] of byNode)
              tasks.set(nodeId, yield* loadLaneTasks(sql, { canvasName, nodeId }, lane, ids));
          }
          const boards = new Map<string, { readonly topics: number; readonly posts: number }>();
          for (const row of yield* SqlSchema.findAll({
            Request: Schema.String,
            Result: Schema.Struct({ node_id: Schema.String, topics: Schema.Number, posts: Schema.Number }),
            execute: (canvas) => sql`SELECT work.node_id,COUNT(*) AS topics,SUM(work.post_count) AS posts
              FROM work_board_topics AS work
              JOIN boards AS node ON node.canvas_name=work.canvas_name AND node.id=work.node_id
              WHERE work.canvas_name=${canvas} GROUP BY work.node_id`,
          })(canvasName)) boards.set(row.node_id, { topics: row.topics, posts: row.posts });
          const artifacts = new Map<string, number>();
          for (const row of yield* SqlSchema.findAll({
            Request: Schema.String,
            Result: Schema.Struct({ node_id: Schema.String, count: Schema.Number }),
            execute: (canvas) => sql`SELECT work.node_id,COUNT(*) AS count FROM work_artifacts AS work
              JOIN artifact_boards AS node ON node.canvas_name=work.canvas_name AND node.id=work.node_id
              WHERE work.canvas_name=${canvas} GROUP BY work.node_id`,
          })(canvasName)) artifacts.set(row.node_id, row.count);
          return { tasks, boards, artifacts };
        })).pipe(Effect.mapError((error) => toRepositoryError("work.kernel.read", error))),
      ),
      taskRowsByIds: Effect.fn("WorkRepository.taskRowsByIds")((canvasName: string, requested: ReadonlyArray<string>) =>
        withSqlRead(sql, Effect.gen(function* () {
          const ids = [...new Set(requested)];
          if (ids.length === 0) return [];
          const rows = yield* SqlSchema.findAll({
            Request: Schema.Array(Schema.String),
            Result: Schema.Struct({ node_id: Schema.String, task_id: Schema.String }),
            execute: (values) => sql.unsafe(`SELECT work.node_id,work.task_id FROM work_tasks AS work
              JOIN task_boards AS node ON node.canvas_name=work.canvas_name AND node.id=work.node_id
              WHERE work.canvas_name=? AND work.task_id IN (${ids.map(() => "?").join(",")})
              ORDER BY node.z_index,node.id,work.created_at,work.task_id`, values),
          })([canvasName, ...ids]);
          const grouped = new Map<string, string[]>();
          for (const row of rows) {
            const selected = grouped.get(row.node_id) ?? [];
            selected.push(row.task_id); grouped.set(row.node_id, selected);
          }
          const result: Array<{ nodeId: string; item: TaskValue }> = [];
          for (const [nodeId, selected] of grouped)
            for (const item of yield* loadLaneTasks(sql, { canvasName, nodeId }, "task", selected))
              result.push({ nodeId, item });
          return result;
        })).pipe(Effect.mapError((error) => toRepositoryError("work.tasks.selected", error))),
      ),
      taskLane: Effect.fn("WorkRepository.taskLane")((canvasName: string, nodeId: string, kind: "task" | "requests") =>
        withSqlRead(sql, loadLaneTasks(sql, { canvasName, nodeId }, kind === "task" ? "task" : "request")).pipe(
          Effect.mapError((error) => toRepositoryError("work.tasks.list", error)),
        )),
      boardTopics: Effect.fn("WorkRepository.boardTopics")((canvasName: string, nodeId: string, topicId?: string) =>
        withSqlRead(sql, loadBoardTopics(sql, { canvasName, nodeId }, topicId)).pipe(
          Effect.mapError((error) => toRepositoryError("work.board.topics", error)),
        )),
      artifactLane: Effect.fn("WorkRepository.artifactLane")((canvasName: string, nodeId: string) =>
        withSqlRead(sql, loadArtifacts(sql, { canvasName, nodeId })).pipe(
          Effect.mapError((error) => toRepositoryError("work.artifacts.list", error)),
        )),
      artifactIds: Effect.fn("WorkRepository.artifactIds")((canvasName: string, nodeId: string) =>
        withSqlRead(sql, SqlSchema.findAll({
          Request: WorkSqlBindings,
          Result: Schema.Struct({ artifact_id: Schema.String }),
          execute: (bindings) => sql.unsafe(`SELECT artifact_id FROM work_artifacts
            WHERE canvas_name=? AND node_id=? ORDER BY origin_at DESC,artifact_id`, bindings),
        })([canvasName, nodeId])).pipe(
          Effect.map((rows) => rows.map((row) => row.artifact_id)),
          Effect.mapError((error) => toRepositoryError("work.artifacts.ids", error)),
        )),
      artifactItem: Effect.fn("WorkRepository.artifactItem")((canvasName: string, nodeId: string, id: string) =>
        withSqlRead(sql, loadArtifacts(sql, { canvasName, nodeId }, [id])).pipe(
          Effect.map((items) => items[0]), Effect.mapError((error) => toRepositoryError("work.artifact.item", error)),
        )),
      taskItem: Effect.fn("WorkRepository.taskItem")((input: WorkItemQuery) =>
        withSqlRead(sql, Effect.gen(function* () {
          const query = yield* Schema.decodeUnknownEffect(WorkItemQuery, strictDecode)(input);
          return (yield* loadLaneTasks(sql, query, query.kind === "task" ? "task" : "request", [query.itemId]))[0];
        })).pipe(
          Effect.provideService(StateTransactionOperation, "work.item"),
          Effect.mapError((error) => toRepositoryError("work.item", error)),
        )),
      actorPage: Effect.fn("WorkRepository.actorPage")((query: WorkActorQuery) =>
        withSqlRead(sql, readWorkActorPage(sql, query)).pipe(
          Effect.provideService(StateTransactionOperation, "work.actor.page"),
          Effect.mapError((error) => toRepositoryError("work.actor.page", error)),
        )),
      attentionSnapshot: Effect.fn("WorkRepository.attentionSnapshot")((query: WorkAttentionQuery) =>
        withSqlRead(sql, Effect.gen(function* () {
          const glances = yield* readWorkGlances(sql, query);
          const items = yield* readWorkAttention(sql, query);
          return { glances, items };
        })).pipe(
          Effect.provideService(StateTransactionOperation, "work.attention"),
          Effect.mapError((error) => toRepositoryError("work.attention", error)),
        )),
      attentionItems: Effect.fn("WorkRepository.attentionItems")((query: WorkAttentionQuery) =>
        withSqlRead(sql, readWorkAttention(sql, query)).pipe(
          Effect.provideService(StateTransactionOperation, "work.attention"),
          Effect.mapError((error) => toRepositoryError("work.attention", error)),
        )),
      taskPolicy: Effect.fn("WorkRepository.taskPolicy")((query: WorkAttentionQuery) =>
        withSqlRead(sql, readWorkTaskPolicy(sql, query)).pipe(
          Effect.provideService(StateTransactionOperation, "work.task.policy"),
          Effect.mapError((error) => toRepositoryError("work.task.policy", error)),
        )),
      sinkPage: Effect.fn("WorkRepository.sinkPage")((query: WorkSinkQuery) =>
        withSqlRead(sql, readWorkSinkPage(sql, query)).pipe(
          Effect.provideService(StateTransactionOperation, "work.sink.page"),
          Effect.mapError((error) => toRepositoryError("work.sink.page", error)),
        )),
      mailbox: Effect.fn("WorkRepository.mailbox")((canvasName: string, nodeId: string) =>
        withSqlRead(sql, loadInbox(sql, { canvasName, nodeId })).pipe(
          Effect.provideService(StateTransactionOperation, "work.mailbox"),
          Effect.mapError((error) => toRepositoryError("work.mailbox", error)),
        )),
      companionMail: Effect.fn("WorkRepository.companionMail")((canvasName: string, nodeId: string, limit: number) =>
        withSqlRead(sql, readCompanionMail(sql, canvasName, nodeId, limit)).pipe(
          Effect.mapError((error) => toRepositoryError("work.mail.companion", error)),
        )),
      mailMessage: Effect.fn("WorkRepository.mailMessage")((canvasName: string, nodeId: string, messageId: string) =>
        withSqlRead(sql, readWorkMailPage(sql, { canvasName, nodeId, limit: 1 }, messageId)).pipe(
          Effect.map((page) => page.items[0]?.message),
          Effect.provideService(StateTransactionOperation, "work.mail.message"),
          Effect.mapError((error) => toRepositoryError("work.mail.message", error)),
        )),
      mailPage: Effect.fn("WorkRepository.mailPage")((query: WorkMailQuery) =>
        withSqlRead(sql, readWorkMailPage(sql, query)).pipe(
          Effect.provideService(StateTransactionOperation, "work.mail.page"),
          Effect.mapError((error) => toRepositoryError("work.mail.page", error)),
        )),
      recentOpsForSeat: readRecentOpsForSeat,
      itemHome,
      currentTaskClaim,
      hasAcceptedDelivery,
      acceptedDeliveryAt,
      createTask,
      describeTask,
      transitionTask,
      claimLocalTask,
      sendTaskOn,
      sendTaskBack,
      postReviewVerdict,
      publishCheckoutReceipts,
      promoteTask,
      recordCheckResults,
      createRequest,
      resolveRequest,
      appendMessage,
      publishArtifact,
      acceptDelivery,
      createBoardTopic,
      appendBoardPost,
      readPad,
      applyPadPatch,
      markPadRead,
      markBoardRead,
      setArtifactArchived,
      deleteArtifact,
      exchangeHave,
      exchangeWriters,
      exchangeRows,
      applyExchangeRows,
      subscribeChanges: changes.subscribe,
    });
  }),
).pipe(
  Layer.provide([
    WorkJournalLive,
    CrewRepositoryLive,
    ModelRecords.layer,
    ContentManifest.layer,
  ]),
);

export type WorkContentProjectionRow = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly partsJson: string;
} & (
  | { readonly kind: "message"; readonly messageId: string }
  | {
      readonly kind: "task-message";
      readonly lane: "task" | "request";
      readonly itemId: string;
      readonly messageId: string;
    }
  | { readonly kind: "artifact"; readonly artifactId: string }
  | { readonly kind: "board-topic"; readonly topicId: string }
  | {
      readonly kind: "board-post";
      readonly topicId: string;
      readonly postId: string;
    }
);
export type WorkContentProjectionKind = WorkContentProjectionRow["kind"];

/** Closed projection-only backfill surface. Content owns the transaction and manifest writes. */
export class WorkContentProjections extends Context.Service<
  WorkContentProjections,
  {
    readonly scan: (
      kind: WorkContentProjectionKind,
    ) => Effect.Effect<
      ReadonlyArray<WorkContentProjectionRow>,
      WorkRepositoryError
    >;
    readonly rewrite: (
      row: WorkContentProjectionRow,
      partsJson: string,
    ) => Effect.Effect<void, WorkRepositoryError>;
  }
>()("@junto/WorkContentProjections") {}

export const WorkContentProjectionsLive = Layer.effect(
  WorkContentProjections,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = {
      message: "work_messages",
      "task-message": "work_task_messages",
      artifact: "work_artifacts",
      "board-topic": "work_board_topics",
      "board-post": "work_board_posts",
    } as const;
    const exists = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ name: Schema.String }),
      execute: (name) =>
        sql`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ${name}`,
    });
    const common = {
      canvas_name: Schema.String,
      node_id: Schema.String,
      parts_json: Schema.String,
    };
    const messages = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ ...common, message_id: Schema.String }),
      execute: () =>
        sql`SELECT canvas_name, node_id, message_id, parts_json FROM work_messages`,
    });
    const taskMessages = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        ...common,
        parent_lane: Schema.Literals(["task", "request"]),
        item_id: Schema.String,
        message_id: Schema.String,
      }),
      execute: () =>
        sql`SELECT canvas_name, node_id, parent_lane, item_id, message_id, parts_json FROM work_task_messages`,
    });
    const artifacts = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ ...common, artifact_id: Schema.String }),
      execute: () =>
        sql`SELECT canvas_name, node_id, artifact_id, parts_json FROM work_artifacts`,
    });
    const topics = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ ...common, topic_id: Schema.String }),
      execute: () =>
        sql`SELECT canvas_name, node_id, topic_id, parts_json FROM work_board_topics`,
    });
    const posts = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        ...common,
        topic_id: Schema.String,
        post_id: Schema.String,
      }),
      execute: () =>
        sql`SELECT canvas_name, node_id, topic_id, post_id, parts_json FROM work_board_posts`,
    });
    const scan = Effect.fn("work.contentProjections.scan")(
      function* (kind: WorkContentProjectionKind) {
        if ((yield* exists(tables[kind]))._tag === "None") return [];
        switch (kind) {
          case "message":
            return (yield* messages(undefined)).map(
              (row): WorkContentProjectionRow => ({
                kind,
                canvasName: row.canvas_name,
                nodeId: row.node_id,
                messageId: row.message_id,
                partsJson: row.parts_json,
              }),
            );
          case "task-message":
            return (yield* taskMessages(undefined)).map(
              (row): WorkContentProjectionRow => ({
                kind,
                canvasName: row.canvas_name,
                nodeId: row.node_id,
                lane: row.parent_lane,
                itemId: row.item_id,
                messageId: row.message_id,
                partsJson: row.parts_json,
              }),
            );
          case "artifact":
            return (yield* artifacts(undefined)).map(
              (row): WorkContentProjectionRow => ({
                kind,
                canvasName: row.canvas_name,
                nodeId: row.node_id,
                artifactId: row.artifact_id,
                partsJson: row.parts_json,
              }),
            );
          case "board-topic":
            return (yield* topics(undefined)).map(
              (row): WorkContentProjectionRow => ({
                kind,
                canvasName: row.canvas_name,
                nodeId: row.node_id,
                topicId: row.topic_id,
                partsJson: row.parts_json,
              }),
            );
          case "board-post":
            return (yield* posts(undefined)).map(
              (row): WorkContentProjectionRow => ({
                kind,
                canvasName: row.canvas_name,
                nodeId: row.node_id,
                topicId: row.topic_id,
                postId: row.post_id,
                partsJson: row.parts_json,
              }),
            );
        }
      },
      Effect.mapError((error) =>
        toRepositoryError("work.contentProjections.scan", error),
      ),
    );
    const rewrite = Effect.fn("work.contentProjections.rewrite")(
      function* (row: WorkContentProjectionRow, partsJson: string) {
        const update = (() => {
          switch (row.kind) {
            case "message":
              return sql`UPDATE work_messages SET parts_json = ${partsJson}
          WHERE canvas_name = ${row.canvasName} AND node_id = ${row.nodeId} AND message_id = ${row.messageId}`;
            case "task-message":
              return sql`UPDATE work_task_messages SET parts_json = ${partsJson}
          WHERE canvas_name = ${row.canvasName} AND node_id = ${row.nodeId} AND parent_lane = ${row.lane}
            AND item_id = ${row.itemId} AND message_id = ${row.messageId}`;
            case "artifact":
              return sql`UPDATE work_artifacts SET parts_json = ${partsJson}
          WHERE canvas_name = ${row.canvasName} AND node_id = ${row.nodeId} AND artifact_id = ${row.artifactId}`;
            case "board-topic":
              return sql`UPDATE work_board_topics SET parts_json = ${partsJson}
          WHERE canvas_name = ${row.canvasName} AND node_id = ${row.nodeId} AND topic_id = ${row.topicId}`;
            case "board-post":
              return sql`UPDATE work_board_posts SET parts_json = ${partsJson}
          WHERE canvas_name = ${row.canvasName} AND node_id = ${row.nodeId}
            AND topic_id = ${row.topicId} AND post_id = ${row.postId}`;
          }
        })();
        yield* unjournaledWorkMutationEffect(
          "content.inline-media.backfill",
          update,
        );
      },
      Effect.mapError((error) =>
        toRepositoryError("work.contentProjections.rewrite", error),
      ),
    );
    return WorkContentProjections.of({ scan, rewrite });
  }),
);
