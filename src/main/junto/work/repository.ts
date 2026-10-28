import { readWorkGlances } from "./glance";
import type { WorkAttentionSnapshot } from "@shared/work-attention";
import { mailThreadOf } from "@shared/crew";
import { pageShotOf } from "@shared/thread-subject";
import { WorkItemQuery, WorkActorQuery, type WorkActorPage, type WorkLaneRow, WorkAttentionQuery, type WorkAttentionRow, WorkSinkQuery, type WorkSinkPage, WORK_SINK_PAGE_SIZE } from "@shared/work-sinks";
import { WorkMailQuery, type WorkMailPage, WORK_MAIL_PAGE_SIZE } from "@shared/work-mail";
import { workProjectionChanges } from "./projection-changes";
import {
  ExchangeFact,
  compareSequence,
  editorTakesFromNoPeer,
  authorityOf,
  entitledTo,
  type ReceiptMailAuthor,
  judgedAt,
  peerMayPassOn,
  writtenByItsAuthor,
  type CanvasPlacement,
  type RowsFrame,
} from "@shared/work-exchange";
import {
  CommandQueueFull,
  CommandTargetUnknown,
  TARGET_NODE_KINDS,
  CommandQueuedResult,
  RulingAppliedResult,
  RulingRefusedResult,
  commandRowWrittenBy,
  isCommandRowBody,
  queueAdmits,
  refusalErrorOf,
  rulingRowOf,
  type OpState,
  type QueueLoad,
  type QueuedCommand,
  type RulingResult,
} from "@shared/command-row";
import type { ResourceCommand, ResourceKind, ResourceRuling } from "@shared/resource-command";
import { writeRuling, type RulingRecord } from "./resource-rulings";
import { keepShotPurge, shotPurgedHere, type PurgedComment } from "./shot-purge";
import { refusalNoticeWrite, refusedKindOf } from "./refusal-notice";
import { rulingNoticesHere, type RulingNoticeWrite } from "@shared/ruling-notices";
import type { OpId } from "@shared/work-ids";
import { RulingFoldRefused, foldRuling } from "./ruling-projection";
import { KIND_TABLES } from "../model/state-schema";
import { writeMentions } from "./mention-backlinks";
import { assertWorkRowBound, pageExchangeRows } from "@shared/exchange-bounds";
import { createHash } from "node:crypto";
import { Cause, Context, Effect, Option, Result, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import { withSqlRead } from "../state/sql-read";
import { afterSqlCommit } from "../state/sql-commit";
import { ModelRecords, ModelError } from "../model/records";
import { deriveActorSeatId } from "../actor-seat-id";
import { asCanvasName, type Canvas } from "@shared/model";
import {
  ActorSeatId as ActorSeatIdSchema,
  type ActorSeatId,
} from "@shared/actor-seat";
import { InstallationId } from "@shared/installation-id";
import {
  Artifact,
  CompletionEvidence,
  FinishCriteria,
  Message,
  Task,
  type Artifact as ArtifactValue,
  type Message as MessageValue,
  type Task as TaskValue,
  type TaskState,
} from "@shared/work-model";
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
import { StateTransactionOperation } from "../state/service";
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
} from "./crew-repository";
import { unjournaledWorkMutationEffect } from "./mutation-seam";
import {
  agentNodeForSeat,
  planCheckoutReceiptMail,
  receiptDedupeKey,
  receiptSourceId,
  reviewerSeatsOf,
} from "./reviews";
import { readTaskReviewers } from "./task-repository";
import { isOpenTaskState, type TaskState as HeadState } from "@shared/task-model";
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
const CountRow = Schema.Struct({ n: Schema.Number });
const RecentSeatOpRowSchema = Schema.Struct({
  operation: Schema.Union([
    Schema.Literal("task.claim"),
    Schema.Literal("message.append"),
    Schema.Literal("artifact.publish"),
    Schema.Literal("delivery.accepted"),
  ]),
  origin_at: Schema.String,
  applied_at: Schema.String,
  target_node_id: Schema.String,
  item_kind: Schema.Union([
    Schema.Literal("message"),
    Schema.Literal("task"),
    Schema.Literal("artifact"),
    Schema.Literal("delivery"),
  ]),
  item_id: Schema.String,
  summary_label: Schema.Union([Schema.Null, Schema.String]),
  related_kind: Schema.Union([
    Schema.Null,
    Schema.Literal("message"),
    Schema.Literal("task"),
    Schema.Literal("artifact"),
    Schema.Literal("delivery"),
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
const AcceptedAtRow = Schema.Struct({ accepted_at: Schema.String });
const TotalChangesRow = Schema.Struct({
  total_changes: Schema.Union([Schema.Number, Schema.BigInt]),
});
const ReviewReceiptKeyRow = Schema.Struct({
  ref_sha: Schema.String,
  reviewer_seat_id: Schema.String,
});
const ReviewAuthorRow = Schema.Struct({ author_seat_id: Schema.String });
const CheckoutTaskHeadRow = Schema.Struct({
  node_id: Schema.String,
  state: Schema.String,
  assignee_node_id: Schema.Union([Schema.Null, Schema.String]),
  epoch: Schema.Number,
});
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
};

export type AppendMessageInput = LocalWorkInput & {
  readonly message: MessageValue;
  readonly sentBy: ActorRef;
  readonly destination: MessageAppendDestination;
};

export type AcceptDeliveryInput = LocalWorkInput & {
  readonly receipt: DeliveryReceipt;
};

/** A resource command this machine queues for the editing machine to rule. */
export type QueueCommandInput = {
  readonly command: QueuedCommand;
  /** The canvas count this machine had applied; the author is judged at it, as mail is. */
  readonly basis: IntentFactBasisValue;
  readonly originAt?: string;
  readonly receivedAt?: string;
};

/** A held command no ruling answers yet, and the machine that wrote it. */
export type UnruledCommand = { readonly writer: InstallationId; readonly command: QueuedCommand };

/** A ruling the editing machine made, to record beside the facts it applied. */
export type RecordRulingInput = {
  readonly canvasName: string;
  /** The machine whose command this rules. */
  readonly writer: InstallationId;
  readonly command: Pick<ResourceCommand<unknown>, "opId" | "actor" | "target">;
  readonly kind: ResourceKind;
  /** What the domain stores of the ruling, to answer a replay. */
  readonly record: RulingRecord;
  readonly ruling: ResourceRuling<typeof Schema.Json.Type>;
  readonly at?: string;
  /** The canvas as this machine holds it: an applied ruling's notices to this machine's own seats are written with it. */
  readonly placement?: CanvasPlacement;
};

/** A recorded ruling, and the notices it owed this machine's seats, for delivery once the caller commits. */
export type RecordedRuling = LocalFactResult<RulingResult> & { readonly notices: ReadonlyArray<RulingNoticeWrite> };

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
      FROM installation
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
  const own = yield* reader.unsafe<{ machine_name: string }>("SELECT machine_name FROM machine_configuration WHERE singleton = 1");
  const others = yield* reader.unsafe<{ machine_name: string; installation_id: string }>("SELECT machine_name, installation_id FROM machine_peers WHERE retired_at IS NULL");
  const installations = new Map(others.map((row) => [row.machine_name, row.installation_id as InstallationId]));
  if (own[0]) installations.set(own[0].machine_name, authority.installationId);
  const actorRefs: ActorRef[] = [];
  for (const node of doc.nodes.values()) {
    if (node.kind !== "agent") continue;
    const home = installations.get(node.host);
    if (home === undefined) return yield* Effect.fail(authorityError("authority-mismatch", `seat host ${node.host} has no installation`));
    actorRefs.push({ canvasName, nodeId: node.id, seatId: deriveActorSeatId(home, node.bindingId) });
  }
  return { doc, actorRefs };
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
  lane: "task",
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
  lane: "task",
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
 * (same task_id at every board row); `task show` reconstructs the visits
 * from the live row's append-only visits field; ClaimConflict stays
 * per-board (claimedBy is a per-row column); same-sink dependsOn is
 * satisfied by local visit completion (the source row completes on
 * send-on); no orphan facts (nothing is deleted or renumbered).
 */
const TASK_METADATA_BAG_KEY = "junto.tasks";

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

const taskFromRow = Effect.fn("work.taskFromRow")(function* (
  reader: SqlClient.SqlClient,
  sink: SinkRefValue,
  lane: "task",
  row: TaskRow,
  dependsOn?: ReadonlyArray<string>,
  finish?: {
    readonly finishCriteria?: TaskValue["finishCriteria"];
    readonly completionEvidence?: TaskValue["completionEvidence"];
  },
  history?: ReadonlyArray<MessageValue>,
): Effect.fn.Return<TaskValue, WorkSqlFailure> {
  // Constructed, not decoded — see messageFromRow. Every `work_tasks` row is
  // the materialization of a `Task` the write path already strict-decoded
  // (createTask / transitionTask / claimTask all decode before
  // commitLocalFact), and state / seat id /
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
  lane: "task",
  itemIds?: ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<TaskValue>, WorkSqlFailure> {
  const table = "work_tasks";
  const id = "task_id";
  const dependsMap =
    lane === "task" ? yield* loadTaskDependsOnMap(reader, sink, itemIds) : undefined;
  const finishMap =
    lane === "task" ? yield* loadTaskFinishMap(reader, sink, itemIds) : undefined;
  const verdictsMap =
    lane === "task" ? yield* loadTaskVerdictsMap(reader, sink, itemIds) : undefined;
  const threads = yield* loadThreadsByItem(reader, sink, lane, itemIds);
  // Tasks keep oldest-first claim order.
  const orderBy = `ORDER BY created_at, ${id}`;
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
  return yield* mailRowsWithReceipts(reader, canvasName, rows);
});

/**
 * The newest mail two seats sent each other, both ways, with its receipts:
 * the peer read's view of a conversation. Selected before any payload is
 * decoded, and bounded.
 */
const readMailBetween = Effect.fn("work.mail.between")(function* (
  reader: SqlClient.SqlClient,
  canvasName: string,
  a: string,
  b: string,
  requestedLimit: number,
): Effect.fn.Return<ReadonlyArray<{ readonly nodeId: string; readonly message: MessageValue }>, WorkSqlFailure> {
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.trunc(requestedLimit))) : WORK_MAIL_PAGE_SIZE;
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: Schema.Struct({ ...MessageRowSchema.fields, node_id: Schema.String }),
    execute: (bindings) => reader.unsafe(`SELECT mail.node_id,mail.message_id,mail.role,mail.parts_json,
      mail.task_id,mail.context_id,mail.reference_task_ids_json,mail.metadata_json
      FROM work_messages AS mail
      WHERE mail.canvas_name=? AND mail.role='user'
        AND ((mail.node_id=? AND json_extract(mail.metadata_json,'$.senderNodeId')=?)
          OR (mail.node_id=? AND json_extract(mail.metadata_json,'$.senderNodeId')=?))
      ORDER BY (length(mail.message_id)=26 AND mail.message_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*') DESC,
        mail.message_id DESC,mail.node_id LIMIT ?`, bindings),
  })([canvasName, a, b, b, a, limit]);
  return yield* mailRowsWithReceipts(reader, canvasName, rows);
});

/** Rows per receipt lookup: three stamps each, well under SQLite's bound on parameters. */
const RECEIPT_LOOKUP_ROWS = 1_000;

/**
 * Every mail one seat wrote into the other mailboxes on a canvas, in no order.
 * A seat's mail sits in its recipient's mailbox, so this is a scan of the
 * canvas's mail for the sender's stamp: one statement, read in SQLite.
 */
const readMailSentBy = Effect.fn("work.mail.sent-by")(function* (
  reader: SqlClient.SqlClient,
  canvasName: string,
  sender: string,
): Effect.fn.Return<ReadonlyArray<{ readonly nodeId: string; readonly message: MessageValue }>, WorkSqlFailure> {
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: Schema.Struct({ ...MessageRowSchema.fields, node_id: Schema.String }),
    execute: (bindings) => reader.unsafe(`SELECT node_id,message_id,role,parts_json,
      task_id,context_id,reference_task_ids_json,metadata_json
      FROM work_messages
      WHERE canvas_name=? AND node_id<>? AND json_extract(metadata_json,'$.senderNodeId')=?
      ORDER BY node_id,position`, bindings),
  })([canvasName, sender, sender]);
  const read: Array<{ readonly nodeId: string; readonly message: MessageValue }> = [];
  for (let at = 0; at < rows.length; at += RECEIPT_LOOKUP_ROWS) {
    read.push(...(yield* mailRowsWithReceipts(reader, canvasName, rows.slice(at, at + RECEIPT_LOOKUP_ROWS))));
  }
  return read;
});

/** Mail rows from several mailboxes, each with its delivery, read and ack stamps. */
const mailRowsWithReceipts = Effect.fn("work.mail.receipts")(function* (
  reader: SqlClient.SqlClient,
  canvasName: string,
  rows: ReadonlyArray<typeof MessageRowSchema.Type & { readonly node_id: string }>,
): Effect.fn.Return<ReadonlyArray<{ readonly nodeId: string; readonly message: MessageValue }>, WorkSqlFailure> {
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


/** Attention policy sees every claimant without loading threads or work contents. */
export const readWorkAttention = Effect.fn("work.attention")(function* (
  reader: SqlClient.SqlClient,
  input: WorkAttentionQuery,
): Effect.fn.Return<ReadonlyArray<WorkAttentionRow>, WorkSqlFailure> {
  const query = yield* Schema.decodeUnknownEffect(WorkAttentionQuery, strictDecode)(input);
  const rows = yield* SqlSchema.findAll({
    Request: WorkSqlBindings,
    Result: Schema.Struct({ node_id: Schema.String, item_id: Schema.String, kind: Schema.Literal("task"),
      state: Schema.Literals(["working", "input-required", "auth-required"]),
      actor_seat_id: Schema.NullOr(ActorSeatIdSchema),
      metadata_json: Schema.NullOr(Schema.String), origin_at: Schema.String, brief: Schema.NullOr(Schema.String) }),
    execute: (bindings) => reader.unsafe(`
      SELECT work.node_id, 'task' AS kind, task_id AS item_id,
        work.state, work.actor_seat_id, work.metadata_json, work.origin_at,
        (SELECT json_extract(part.value, '$.text') FROM json_each(
          (SELECT message.parts_json FROM work_task_messages AS message
            WHERE message.canvas_name = work.canvas_name AND message.node_id = work.node_id
              AND message.parent_lane = 'task'
              AND message.item_id = work.task_id
            ORDER BY message.position LIMIT 1)
        ) AS part WHERE json_extract(part.value, '$.kind') = 'text' ORDER BY part.key LIMIT 1) AS brief
      FROM work_tasks AS work JOIN task_boards AS node
        ON node.canvas_name = work.canvas_name AND node.id = work.node_id
      WHERE work.canvas_name = ?
        ${query.nodeId === undefined ? "" : "AND work.node_id = ?"}
        AND (state IN ('input-required','auth-required') OR (state = 'working' AND actor_seat_id IS NOT NULL))`, bindings),
  })([query.canvasName, ...(query.nodeId === undefined ? [] : [query.nodeId])]);
  return rows.map((row) => ({ nodeId: row.node_id, kind: row.kind, item: {
    id: row.item_id, state: row.state, history: [],
    ...(row.brief === null ? {} : { metadata: { title: row.brief.split(/\r?\n/, 1)[0] ?? row.item_id } }),
    ...(row.actor_seat_id === null ? {} : { claimedBy: row.actor_seat_id }),
    stateSince: rowStateSince(row),
  }}));
});

/** Seat ledger pages hydrate only the selected rows, across live sinks. */
export const readWorkActorPage = Effect.fn("work.actor.page")(function* (
  reader: SqlClient.SqlClient, input: WorkActorQuery,
): Effect.fn.Return<WorkActorPage, WorkSqlFailure> {
  const query = yield* Schema.decodeUnknownEffect(WorkActorQuery, strictDecode)(input);
  const [table, nodes, id] = query.kind === "task" ? ["work_tasks", "task_boards", "task_id"]
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
    for (const item of yield* loadLaneTasks(reader, { canvasName: query.canvasName, nodeId }, "task", ids))
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
  const [table, id] = query.kind === "task" ? ["work_tasks", "task_id"] : ["work_artifacts", "artifact_id"];
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
  if (query.kind === "task") return {
    kind: "task", items: ids.length === 0 ? [] : [...(yield* loadLaneTasks(reader, sink, "task", ids))].sort((a, b) => byIdDescending(a.id, b.id)), ...next,
  };
  return {
    kind: "artifacts", items: ids.length === 0 ? [] : [...(yield* loadArtifacts(reader, sink, ids))].sort((a, b) => byIdDescending(a.artifactId, b.artifactId)), ...next,
  };
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
            'message.append',
            'artifact.publish',
            'delivery.accepted'
          )
      ),
      attributed AS (
        SELECT
          *,
          CASE operation
            WHEN 'task.claim' THEN
              json_extract(result_json, '$.claimedBy.seatId')
            WHEN 'message.append' THEN
              json_extract(result_json, '$.sentBy.seatId')
            WHEN 'artifact.publish' THEN
              json_extract(result_json, '$.publishedBy.seatId')
            WHEN 'delivery.accepted' THEN
              json_extract(result_json, '$.receipt.actor.seatId')
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

const selectTaskIdentity = Effect.fn("work.selectTaskIdentity")(function* (
  reader: SqlClient.SqlClient,
  lane: "task",
  sink: SinkRefValue,
  itemId: string,
): Effect.fn.Return<IdentityRow | undefined, WorkSqlFailure> {
  const table = "work_tasks";
  const id = "task_id";
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
  lane: "task",
  sink: SinkRefValue,
  itemId: string,
): Effect.fn.Return<
  { readonly row: IdentityRow; readonly task: TaskValue } | undefined,
  WorkSqlFailure
> {
  const row = yield* selectTaskIdentity(reader, lane, sink, itemId);
  if (row === undefined) return undefined;
  const table = "work_tasks";
  const id = "task_id";
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
  lane: "task",
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
  lane: "task",
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
  lane: "task",
  sink: SinkRefValue,
  task: TaskValue,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): Effect.fn.Return<void, WorkSqlFailure> {
  const previous = yield* selectTaskIdentity(writer, lane, sink, task.id);
  const table = "work_tasks";
  const id = "task_id";
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
      key === "senderNodeId" ||
      key === "senderAutomationId"
    ) {
      continue;
    }
    rest[key] = value;
  }
  const admitted = {
    ...rest,
    fromSeat: sentBy.seatId,
    senderNodeId: sentBy.nodeId,
    ...(sentBy.automationId === undefined ? {} : { senderAutomationId: sentBy.automationId }),
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
  // Where the row's words name a seat, a task, an artifact or a page: the backlinks go with the row.
  yield* writeMentions(writer, sink.canvasName, sink.nodeId, message.messageId, {
    actorSeatId: sentBy.seatId,
    parts: message.parts,
    metadata: message.metadata,
  });
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
  // One row is at most 64 KiB, so a page of rows always fits a link frame.
  const tooLarge = assertWorkRowBound(fact);
  if (tooLarge !== undefined) return yield* Effect.fail(tooLarge);
  yield* (yield* WorkJournal).appendWorkRecord(fact, input.receivedAt);
  yield* materializeFact(writer, fact, input.receivedAt);
  return {
    value: input.value,
    record: fact,
  };
});

/**
 * Work repository service contract (effect v4).
 *
 * Identifier and shape stay separate so there is exactly one repository
 * service key — no dual definitions.
 */
export interface WorkRepositoryId {
  readonly _workRepository: unique symbol;
}

export type ExchangeCursor = {
  readonly writer: InstallationId;
  readonly through: string;
};

export type ExchangeRowsInput = {
  readonly canvasName: string;
  readonly writer: InstallationId;
  readonly after: string;
  readonly limit: number;
  /** The bytes of rows one page may carry, so it fits one frame (EXCHANGE_ROWS_PAGE_BYTES). */
  readonly bytes: number;
};

export type ExchangeRow = {
  readonly fact: ExchangeFact;
  /** For a receipt, who wrote the mail it answers, when held. */
  readonly mailAuthor: ReceiptMailAuthor | undefined;
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

/** A canvas copy the machine that edits the canvas sent, and where each seat was at that count. */
export type CanvasCopySent = {
  readonly canvasName: string;
  readonly target: InstallationId;
  readonly seq: number;
  readonly seats: ReadonlyArray<{
    readonly nodeId: string;
    readonly seatId: string;
    readonly machine: InstallationId;
  }>;
  /** Where each automation was in that copy, by Automations node and automation id. */
  readonly automations?: ReadonlyArray<{
    readonly nodeId: string;
    readonly automationId: string;
    readonly machine: InstallationId;
  }>;
  readonly sentAt?: string;
};

export type AppliedExchangeRows = {
  /** Rows that were new to this machine. */
  readonly taken: number;
  /** Commands that arrived, for the editing machine's ruler to sweep. */
  readonly commands: number;
  /** The resource kinds a ruling folded here changed, for the panes to read again. */
  readonly changed: ReadonlyArray<RulingAppliedResult["kind"]>;
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

/**
 * One mail row this machine holds, by its key, as the fact that may cross
 * machines (for `entitledTo`), with the metadata it was written with and the
 * machine that wrote it. A primary-key read of `work_messages`.
 */
export const heldMailRow = Effect.fn("work.heldMailRow")(function* (
  reader: SqlClient.SqlClient,
  key: { readonly canvasName: string; readonly nodeId: string; readonly messageId: string },
): Effect.fn.Return<
  { readonly fact: ExchangeFact; readonly writer: string; readonly metadata: Readonly<Record<string, unknown>> | undefined } | undefined,
  SqlError.SqlError | Schema.SchemaError
> {
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: Schema.Struct({ ...ExchangeFactRow.fields, metadata_json: Schema.NullOr(Schema.String) }),
    execute: (bindings) =>
      reader.unsafe(
        `
          SELECT event.event_home, event.seq, event.item_kind, event.item_id,
            event.item_canvas_name, event.item_node_id, event.operation,
            event.content_sha256, event.origin_at, fact.basis_kind,
            fact.basis_canvas_name, fact.basis_canvas_seq, fact.result_json, mail.metadata_json
          FROM work_messages AS mail
          JOIN work_events AS event
            ON event.event_home = mail.fact_event_home
            AND event.entity_home = mail.fact_entity_home
            AND event.seq = mail.fact_seq
          JOIN work_facts AS fact USING (event_home, entity_home, seq)
          WHERE mail.canvas_name = ? AND mail.node_id = ? AND mail.message_id = ?
        `,
        bindings,
      ),
  })([key.canvasName, key.nodeId, key.messageId]);
  const row = rows[0];
  if (row === undefined) return undefined;
  const fact = exchangeFactOf(row);
  if (fact === undefined) return undefined;
  const metadata = row.metadata_json === null ? undefined : Option.getOrUndefined(decodeMailMetadata(row.metadata_json));
  return { fact, writer: row.event_home, metadata };
});
const decodeMailMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

/** Who wrote the mail a receipt answers, when this machine holds that mail: its node, and an automation's id. */
const exchangeMailAuthor = Effect.fn("work.exchangeMailAuthor")(function* (
  reader: SqlClient.SqlClient,
  fact: ExchangeFact,
): Effect.fn.Return<ReceiptMailAuthor | undefined, WorkSqlFailure> {
  if (fact.body.operation !== "delivery.accepted") return undefined;
  const { deliveredItem } = fact.body.receipt;
  const rows = yield* reader.unsafe<{ node_id: string | null; automation_id: string | null }>(
    `
      SELECT json_extract(fact.result_json, '$.sentBy.nodeId') AS node_id,
        json_extract(fact.result_json, '$.sentBy.automationId') AS automation_id
      FROM work_messages AS mail
      JOIN work_facts AS fact
        ON fact.event_home = mail.fact_event_home
        AND fact.entity_home = mail.fact_entity_home
        AND fact.seq = mail.fact_seq
      WHERE mail.canvas_name = ? AND mail.node_id = ? AND mail.message_id = ?
    `,
    [deliveredItem.sink.canvasName, deliveredItem.sink.nodeId, deliveredItem.itemId],
  );
  const row = rows[0];
  if (row === undefined || row.node_id === null) return undefined;
  return row.automation_id === null ? { nodeId: row.node_id } : { nodeId: row.node_id, automationId: row.automation_id };
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

/**
 * On the machine that edits a canvas: was the seat this row is judged by
 * (`judgedAt`: its author, or for a notice the seat whose mailbox it is in) on
 * the row's writer at the canvas count the row states, and is that a count
 * this machine sent that writer? A writer cannot state a count it was never
 * sent, and a count cannot put a seat where it was not. A notice's own node
 * held no seat at that count either.
 */
const exchangeAuthorWasThere = Effect.fn("work.exchangeAuthorWasThere")(function* (
  reader: SqlClient.SqlClient,
  fact: ExchangeFact,
  placement: CanvasPlacement,
): Effect.fn.Return<boolean, WorkSqlFailure> {
  if (fact.basis.kind !== "canvas") return false;
  const seat = judgedAt(fact, placement);
  if (seat === undefined) return false;
  const writer = fact.id.route.eventHome;
  if (seat.automationId !== undefined) {
    // An automation is judged as a seat is: where it was at the stated count,
    // on a node that held no seat then, by a copy sent to the writer at that count.
    const placed = yield* reader.unsafe<{ found: number }>(
      `
        SELECT 1 AS found
        FROM automation_placements AS placed
        WHERE placed.canvas_name = ?
          AND placed.node_id = ?
          AND placed.automation_id = ?
          AND placed.machine = ?
          AND placed.from_seq <= ?
          AND (placed.until_seq IS NULL OR ? < placed.until_seq)
          AND NOT EXISTS (
            SELECT 1 FROM canvas_placements AS held
            WHERE held.canvas_name = placed.canvas_name
              AND held.node_id = placed.node_id
              AND held.from_seq <= ?
              AND (held.until_seq IS NULL OR ? < held.until_seq)
          )
          AND EXISTS (
            SELECT 1 FROM canvas_copies_sent AS sent
            WHERE sent.canvas_name = placed.canvas_name AND sent.target = ? AND sent.seq = ?
          )
        LIMIT 1
      `,
      [
        fact.item.sink.canvasName,
        seat.nodeId,
        seat.automationId,
        writer,
        fact.basis.seq,
        fact.basis.seq,
        fact.basis.seq,
        fact.basis.seq,
        writer,
        fact.basis.seq,
      ],
    );
    return placed.length > 0;
  }
  const rows = yield* reader.unsafe<{ found: number }>(
    `
      SELECT 1 AS found
      FROM canvas_placements AS placed
      WHERE placed.canvas_name = ?
        AND placed.node_id = ?
        AND (? IS NULL OR placed.seat_id = ?)
        AND placed.machine = ?
        AND placed.from_seq <= ?
        AND (placed.until_seq IS NULL OR ? < placed.until_seq)
        AND (? IS NULL OR NOT EXISTS (
          SELECT 1 FROM canvas_placements AS held
          WHERE held.canvas_name = placed.canvas_name
            AND held.node_id = ?
            AND held.from_seq <= ?
            AND (held.until_seq IS NULL OR ? < held.until_seq)
        ))
        AND EXISTS (
          SELECT 1 FROM canvas_copies_sent AS sent
          WHERE sent.canvas_name = placed.canvas_name AND sent.target = ? AND sent.seq = ?
        )
      LIMIT 1
    `,
    [
      fact.item.sink.canvasName,
      seat.nodeId,
      seat.seatId ?? null,
      seat.seatId ?? null,
      writer,
      fact.basis.seq,
      fact.basis.seq,
      seat.seatless ?? null,
      seat.seatless ?? null,
      fact.basis.seq,
      fact.basis.seq,
      writer,
      fact.basis.seq,
    ],
  );
  return rows.length > 0;
});

/**
 * Write the notices an applied ruling owes this machine's own seats
 * (`rulingNoticesHere`), in the caller's transaction, each once: a ruling
 * committed or folded again writes nothing. The editing machine calls this as
 * it records the ruling, every other machine as it folds it.
 */
const writeRulingNotices = Effect.fn("work.writeRulingNotices")(function* (
  writer: SqlClient.SqlClient,
  self: InstallationId,
  canvasName: string,
  ruling: RulingAppliedResult,
  placement: CanvasPlacement,
  at: DisplayTimestampValue,
) {
  const written: RulingNoticeWrite[] = [];
  const owed = rulingNoticesHere({ self, canvasName, ruling, placement });
  if (owed.length === 0) return written;
  const canvas = yield* writer.unsafe<{ seq: number }>("SELECT seq FROM canvases WHERE canvas_name = ?", [canvasName]);
  const basis = { kind: "canvas" as const, canvasName, seq: canvas[0]?.seq ?? 0 };
  for (const notice of owed) {
    const held = yield* writer.unsafe<{ found: number }>(
      "SELECT 1 AS found FROM work_messages WHERE canvas_name = ? AND node_id = ? AND message_id = ? LIMIT 1",
      [canvasName, notice.sink.nodeId, notice.message.messageId],
    );
    if (held.length > 0) continue;
    yield* commitLocalFact(writer, {
      localInstallationId: self,
      sink: notice.sink,
      basis,
      item: item("message", notice.message.messageId, notice.sink),
      operation: "message.append",
      predecessor: null,
      body: { operation: "message.append", message: notice.message, sentBy: notice.sentBy, destination: { kind: "mailbox" } },
      value: notice.message,
      originAt: at,
      receivedAt: at,
    });
    written.push(notice);
  }
  return written;
});

const refuseExchange = (message: string): WorkAuthorityError =>
  authorityError("authority-mismatch", message);

export interface WorkRepositoryShape {
  /** Exact policy inputs across the task's visited boards and prerequisite ids. */
  readonly taskRowsByIds: (canvasName: string, ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<{ readonly nodeId: string; readonly item: TaskValue }>, WorkRepositoryError>;
  readonly artifactLane: (canvasName: string, nodeId: string) => Effect.Effect<ReadonlyArray<ArtifactValue>, WorkRepositoryError>;
  readonly artifactIds: (canvasName: string, nodeId: string) => Effect.Effect<ReadonlyArray<string>, WorkRepositoryError>;
  readonly artifactItem: (canvasName: string, nodeId: string, id: string) => Effect.Effect<ArtifactValue | undefined, WorkRepositoryError>;
  readonly taskItem: (query: WorkItemQuery) => Effect.Effect<TaskValue | undefined, WorkRepositoryError>;
  readonly actorPage: (query: WorkActorQuery) => Effect.Effect<WorkActorPage, WorkRepositoryError>;
  readonly attentionSnapshot: (query: WorkAttentionQuery) => Effect.Effect<WorkAttentionSnapshot, WorkRepositoryError>;
  readonly sinkPage: (query: WorkSinkQuery) => Effect.Effect<WorkSinkPage, WorkRepositoryError>;
  readonly mailPage: (query: WorkMailQuery) => Effect.Effect<WorkMailPage, WorkRepositoryError>;
  readonly mailbox: (canvasName: string, nodeId: string) => Effect.Effect<ReadonlyArray<MessageValue>, WorkRepositoryError>;
  readonly companionMail: (canvasName: string, nodeId: string, limit: number) => Effect.Effect<ReadonlyArray<{ readonly nodeId: string; readonly message: MessageValue }>, WorkRepositoryError>;
  /** The newest mail seats `a` and `b` sent each other, both ways; `nodeId` is the mailbox it sits in. */
  readonly mailBetween: (canvasName: string, a: string, b: string, limit: number) => Effect.Effect<ReadonlyArray<{ readonly nodeId: string; readonly message: MessageValue }>, WorkRepositoryError>;
  /** Every mail `sender` wrote into another mailbox on the canvas, with its receipts; `nodeId` is the mailbox it sits in. */
  readonly mailSentBy: (canvasName: string, sender: string) => Effect.Effect<ReadonlyArray<{ readonly nodeId: string; readonly message: MessageValue }>, WorkRepositoryError>;
  readonly mailMessage: (canvasName: string, nodeId: string, messageId: string) => Effect.Effect<MessageValue | undefined, WorkRepositoryError>;
  readonly recentOpsForSeat: (input: {
    readonly canvasName: string;
    readonly actorSeatId: ActorSeatId;
    readonly limit?: number;
  }) => Effect.Effect<WorkSeatRecentOpsFeed, WorkRepositoryError>;
  readonly itemHome: (
    lane: "task",
    canvasName: string,
    nodeId: string,
    itemId: string,
  ) => Effect.Effect<InstallationId | undefined, WorkRepositoryError>;
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
  /**
   * Atomic checkout-watch receipt writer: fresh-reads the task and its live
   * claimant (refusing a changed author), the task's reviewer list, and the
   * intent basis, then composes commit-subject receipt mail for the
   * newly observed shas and their dedupe rows in one transaction. Returns the
   * created records for the caller to notify after commit.
   */
  readonly publishCheckoutReceipts: (input: {
    readonly basis: IntentFactBasisValue;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly taskId: string;
    /** The task's epoch when the claim was read: a new epoch is a new review subject. */
    readonly epoch: number;
    readonly checkoutKey: string;
    readonly author: MailSenderStamp;
    readonly shas: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<ReviewReceiptRecord>, RepositoryFailure>;
  readonly appendMessage: (
    input: AppendMessageInput,
  ) => Effect.Effect<LocalFactResult<MessageValue>, RepositoryFailure>;
  readonly acceptDelivery: (
    input: AcceptDeliveryInput,
  ) => Effect.Effect<LocalFactResult<DeliveryReceipt>, RepositoryFailure>;
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
  /**
   * Remember a canvas copy this machine sent: the count it sent that machine,
   * and which machine each seat is on from that count. Sending the same count
   * again changes nothing.
   */
  readonly recordCanvasCopySent: (
    input: CanvasCopySent,
  ) => Effect.Effect<void, WorkRepositoryError>;
  /**
   * Write a resource command as this machine's own `command.queued` row, for
   * the editing machine to rule. Refused at once, writing nothing, when this
   * machine already holds the bound of unruled commands for the canvas.
   */
  readonly queueCommand: (
    input: QueueCommandInput,
  ) => Effect.Effect<LocalFactResult<OpId>, RepositoryFailure | CommandQueueFull | CommandTargetUnknown>;
  /**
   * Record a ruling on the machine that edits the canvas: its row in
   * `resource_rulings` and its `ruling.*` fact for every machine, in the
   * caller's transaction with the facts it applied. Refused on any other
   * machine.
   */
  readonly recordRuling: (
    input: RecordRulingInput,
  ) => Effect.Effect<RecordedRuling, RepositoryFailure>;
  /**
   * The operator purges a page box comment's shot, on the machine that edits
   * the canvas only (plan 06, B7). In one transaction: the purge is kept, the
   * claims of the comment and its replies are released, and one `shot.purged`
   * row is written for every machine linked for the canvas. A reply names its
   * thread's comment. Purging again writes no second row. Refused when this
   * machine does not edit the canvas or the comment names no shot.
   */
  readonly purgeShot: (
    input: PurgedComment & { readonly at?: string },
  ) => Effect.Effect<{ readonly comment: PurgedComment; readonly released: number; readonly written: boolean }, RepositoryFailure>;
  /** Is this message owner's shot purged here: the comment, or a reply in its thread? */
  readonly shotPurged: (
    owner: { readonly canvasName: string; readonly nodeId: string; readonly recordId: string },
  ) => Effect.Effect<boolean, WorkRepositoryError>;
  /**
   * Every command this machine holds for a canvas, from any writer, that no
   * ruling row answers yet: each writer's in its seq order. The editing
   * machine's ruler sweeps these.
   */
  readonly unruledCommands: (
    canvasName: string,
  ) => Effect.Effect<ReadonlyArray<UnruledCommand>, WorkRepositoryError>;
  /** This machine's unruled commands for a canvas: rows and bytes. */
  readonly commandQueueLoad: (canvasName: string) => Effect.Effect<QueueLoad, WorkRepositoryError>;
  /** What became of one command of one writer, from the rows this machine holds. */
  readonly commandState: (
    canvasName: string,
    writer: InstallationId,
    opId: OpId,
  ) => Effect.Effect<OpState, WorkRepositoryError>;
  /** How far this machine is caught up on each other writer's rows for a canvas. */
  readonly exchangeHave: (
    canvasName: string,
  ) => Effect.Effect<ReadonlyArray<ExchangeCursor>, WorkRepositoryError>;
  /**
   * Forget how far this machine is caught up on a canvas: a seat came to live
   * here, so rows it was told it holds may now include rows it was not
   * entitled to then. Its next word asks for every writer's rows from the start.
   */
  readonly exchangeForget: (canvasName: string) => Effect.Effect<void, WorkRepositoryError>;
  /**
   * The machines that lost their last seat or automation on a canvas and have
   * not yet been recorded as told so: placement history still has a row of
   * theirs open, or closed after the last count recorded for them. Read on the
   * editing machine; every other machine keeps no placement history.
   */
  readonly departingFrom: (canvasName: string) => Effect.Effect<ReadonlySet<InstallationId>, WorkRepositoryError>;
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
      lane: "task",
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

    const publishCheckoutReceipts = (input: {
      readonly basis: IntentFactBasisValue;
      readonly canvasName: string;
      readonly nodeId: string;
      readonly taskId: string;
      readonly epoch: number;
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
            // The held task as the task store has it (plan 0.10/04): open on
            // this node at the claim's epoch, its assignee the commits' author.
            const head = yield* SqlSchema.findOneOption({
              Request: WorkSqlBindings,
              Result: CheckoutTaskHeadRow,
              execute: (bindings) =>
                writer.unsafe(
                  `SELECT node_id, state, assignee_node_id, epoch FROM task_heads
               WHERE canvas_name = ? AND task_id = ?`,
                  bindings,
                ),
            })([input.canvasName, input.taskId]).pipe(Effect.map(Option.getOrUndefined));
            // Task gone: the trigger's group is stale — no receipts, no failure.
            if (head === undefined) return [];
            const { doc, actorRefs: refsHere } = yield* readReviewCanvas(writer, input.canvasName);
            const held = head.node_id === input.nodeId && head.epoch === input.epoch &&
              isOpenTaskState(head.state as HeadState) && head.assignee_node_id !== null;
            // The assignee's seat is not live here: no author to stamp, nothing to send.
            const assignee = held ? refsHere.find((ref) => ref.nodeId === head.assignee_node_id) : undefined;
            if (held && assignee === undefined) return [];
            const authorSeat = assignee?.seatId;
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
            const authorNode = agentNodeForSeat(refsHere, authorSeat);
            if (doc === undefined || authorNode === undefined) return [];
            const reviewers = reviewerSeatsOf({
              reviewers: yield* readTaskReviewers(writer, input.canvasName, input.taskId),
              actorRefs: refsHere,
            }).filter((reviewer) => reviewer.seatId !== authorSeat);
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

    const recordCanvasCopySent = (
      input: CanvasCopySent,
    ): Effect.Effect<void, WorkRepositoryError> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(
              "INSERT OR IGNORE INTO canvas_copies_sent(canvas_name, target, seq, sent_at) VALUES (?, ?, ?, ?)",
              [input.canvasName, input.target, input.seq, timestamp(input.sentAt)],
            );
            const open = yield* sql.unsafe<{
              node_id: string;
              from_seq: number;
              seat_id: string;
              machine: string;
            }>(
              "SELECT node_id, from_seq, seat_id, machine FROM canvas_placements WHERE canvas_name = ? AND until_seq IS NULL",
              [input.canvasName],
            );
            const now = new Map(input.seats.map((seat) => [seat.nodeId, seat]));
            const kept = new Set<string>();
            for (const row of open) {
              const seat = now.get(row.node_id);
              if (seat !== undefined && seat.seatId === row.seat_id && seat.machine === row.machine) {
                kept.add(row.node_id);
              } else if (input.seq > row.from_seq) {
                yield* sql.unsafe(
                  "UPDATE canvas_placements SET until_seq = ? WHERE canvas_name = ? AND node_id = ? AND from_seq = ?",
                  [input.seq, input.canvasName, row.node_id, row.from_seq],
                );
              }
            }
            for (const seat of input.seats) {
              if (kept.has(seat.nodeId)) continue;
              yield* sql.unsafe(
                `INSERT OR IGNORE INTO canvas_placements(canvas_name, node_id, from_seq, until_seq, seat_id, machine)
                 VALUES (?, ?, ?, NULL, ?, ?)`,
                [input.canvasName, seat.nodeId, input.seq, seat.seatId, seat.machine],
              );
            }
            // Automations the same way, keyed by node and id: a move closes the old row at this count.
            if (input.automations === undefined) return;
            const openAutomations = yield* sql.unsafe<{ node_id: string; automation_id: string; from_seq: number; machine: string }>(
              "SELECT node_id, automation_id, from_seq, machine FROM automation_placements WHERE canvas_name = ? AND until_seq IS NULL",
              [input.canvasName],
            );
            const automationKey = (nodeId: string, automationId: string) => JSON.stringify([nodeId, automationId]);
            const automationsNow = new Map(input.automations.map((placed) => [automationKey(placed.nodeId, placed.automationId), placed]));
            const keptAutomations = new Set<string>();
            for (const row of openAutomations) {
              const key = automationKey(row.node_id, row.automation_id);
              if (automationsNow.get(key)?.machine === row.machine) {
                keptAutomations.add(key);
              } else if (input.seq > row.from_seq) {
                yield* sql.unsafe(
                  "UPDATE automation_placements SET until_seq = ? WHERE canvas_name = ? AND node_id = ? AND automation_id = ? AND from_seq = ?",
                  [input.seq, input.canvasName, row.node_id, row.automation_id, row.from_seq],
                );
              }
            }
            for (const [key, placed] of automationsNow) {
              if (keptAutomations.has(key)) continue;
              yield* sql.unsafe(
                `INSERT OR IGNORE INTO automation_placements(canvas_name, node_id, automation_id, from_seq, until_seq, machine)
                 VALUES (?, ?, ?, ?, NULL, ?)`,
                [input.canvasName, placed.nodeId, placed.automationId, input.seq, placed.machine],
              );
            }
          }),
        )
        .pipe(
          Effect.provideService(StateTransactionOperation, "work.exchange.copy-sent"),
          Effect.mapError((error) => toRepositoryError("work.exchange.copy-sent", error)),
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

    const exchangeForget = (canvasName: string): Effect.Effect<void, WorkRepositoryError> =>
      sql
        .withTransaction(sql.unsafe("DELETE FROM work_exchange_cursors WHERE canvas_name = ?", [canvasName]))
        .pipe(
          Effect.asVoid,
          Effect.provideService(StateTransactionOperation, "work.exchange.forget"),
          Effect.mapError((error) => toRepositoryError("work.exchange.forget", error)),
        );

    const departingFrom = (canvasName: string): Effect.Effect<ReadonlySet<InstallationId>, WorkRepositoryError> =>
      withSqlRead(
        sql,
        sql.unsafe<{ machine: string }>(
          `
            WITH placed AS (
              SELECT machine, until_seq FROM canvas_placements WHERE canvas_name = ?
              UNION ALL
              SELECT machine, until_seq FROM automation_placements WHERE canvas_name = ?
            )
            SELECT DISTINCT placed.machine
            FROM placed
            WHERE placed.until_seq IS NULL
              OR placed.until_seq > COALESCE(
                (SELECT MAX(sent.seq) FROM canvas_copies_sent AS sent WHERE sent.canvas_name = ? AND sent.target = placed.machine),
                0
              )
          `,
          [canvasName, canvasName, canvasName],
        ),
      ).pipe(
        Effect.map((rows) => new Set(rows.map((row) => Schema.decodeUnknownSync(InstallationId)(row.machine)))),
        Effect.mapError((error) => toRepositoryError("work.exchange.departing", error)),
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
                AND event.operation IN ('message.append', 'delivery.accepted', 'command.queued', 'ruling.applied', 'ruling.refused', 'shot.purged')
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
          const page = pageExchangeRows(
            stored.slice(0, input.limit + 1).map((row) => ({ seq: row.seq, fact: exchangeFactOf(row) })),
            { count: input.limit, bytes: input.bytes },
          );
          const rows: ExchangeRow[] = [];
          for (const fact of page.taken) {
            rows.push({ fact, mailAuthor: yield* exchangeMailAuthor(sql, fact) });
          }
          if (page.cutAt !== undefined) return { rows, through: page.cutAt, more: true };
          const more = stored.length > input.limit;
          if (more) return { rows, through: stored.at(-1)!.seq, more };
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
            if (placement.canvasId !== frame.canvasId) {
              return yield* Effect.fail(refuseExchange("this machine holds another canvas of that name"));
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
              // The machine that rules the canvas judges a seat or an
              // automation against where it was at the count the row states,
              // and takes the operator's rows from no peer: only it writes those.
              // Any other machine takes the ruling machine's rows as already
              // judged, and judges a writer's own rows against the copy it holds.
              // A ruling, and the operator's command, is the ruling machine's
              // own row: from any other writer it closes the link before its
              // author is looked at.
              // A shot's purge is the operator's, so the editing machine's alone, whoever passes it on.
              if (
                (isCommandRowBody(fact.body) &&
                  !commandRowWrittenBy(fact.id.route.eventHome, authorityOf(placement), fact.body)) ||
                (fact.body.operation === "shot.purged" && fact.id.route.eventHome !== placement.editor)
              ) {
                return yield* Effect.fail(refuseExchange("only the machine that edits a canvas writes this row"));
              }
              const authority = authorityOf(placement);
              const authored =
                authority === self
                  ? !editorTakesFromNoPeer(fact) && (yield* exchangeAuthorWasThere(writer, fact, placement))
                  : peer === authority || writtenByItsAuthor(fact, placement);
              if (!authored) {
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
              if (held[0] === undefined) {
                // A receipt says "this mail was typed into this seat", and its id
                // is the same on every machine. A seat that moved has it written
                // by each machine it typed on: one already held for the same mail
                // is a repeat and is skipped; for other mail it is refused.
                if (fact.body.operation === "delivery.accepted") {
                  const { receipt } = fact.body;
                  const receiptHeld = yield* writer.unsafe<{ delivered_item_kind: string; delivered_item_id: string }>(
                    `SELECT delivered_item_kind, delivered_item_id FROM work_delivery_receipts
                     WHERE delivered_canvas_name = ? AND delivered_node_id = ? AND delivery_id = ?`,
                    [receipt.deliveredItem.sink.canvasName, receipt.deliveredItem.sink.nodeId, receipt.deliveryId],
                  );
                  if (receiptHeld[0] !== undefined) {
                    if (
                      receiptHeld[0].delivered_item_kind !== receipt.deliveredItem.kind ||
                      receiptHeld[0].delivered_item_id !== receipt.deliveredItem.itemId
                    ) {
                      return yield* Effect.fail(
                        authorityError("identity-conflict", "a receipt this machine holds arrived for other mail"),
                      );
                    }
                    continue;
                  }
                }
                fresh.push(fact);
              } else if (held[0].content_sha256 !== fact.contentSha256) {
                return yield* Effect.fail(
                  authorityError("identity-conflict", "a row this machine holds arrived with other content"),
                );
              }
            }

            yield* writer.unsafe(
              "INSERT OR IGNORE INTO known_installations(installation_id, registered_at) VALUES (?, ?)",
              [frame.writer, receivedAt],
            );
            const mail: Array<AppliedExchangeRows["mail"][number]> = [];
            const changed = new Set<RulingAppliedResult["kind"]>();
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
                } else if (fact.body.operation === "ruling.applied") {
                  // The editing machine's ruled facts, folded here as they were ruled there.
                  yield* foldRuling(writer, frame.canvasName, fact.body, Date.parse(fact.originAt)).pipe(
                    Effect.catchTag("RulingFoldRefused", (refused: RulingFoldRefused) =>
                      Effect.fail(refuseExchange(refused.message)),
                    ),
                  );
                  changed.add(fact.body.kind);
                  // Every machine takes every ruling: this one tells its own seats what the ruling owes them.
                  for (const notice of yield* writeRulingNotices(writer, self, frame.canvasName, fact.body, placement, receivedAt)) {
                    mail.push({ canvasName: notice.sink.canvasName, nodeId: notice.sink.nodeId, message: notice.message });
                  }
                } else if (fact.body.operation === "shot.purged") {
                  // The operator purged a comment's shot: this machine's copy and claims go, and it stays removed.
                  yield* keepShotPurge(writer, { canvasName: frame.canvasName, nodeId: fact.item.sink.nodeId, messageId: fact.body.messageId }, receivedAt);
                } else if (fact.body.operation === "ruling.refused") {
                  // One of this machine's own commands was refused: its seat is told, once, from the refused node.
                  const notice = yield* refusalNoticeWrite(writer, self, frame.canvasName, fact.body, placement);
                  // A queued write of this machine's was ruled: its panes read their pending writes again.
                  const refusedKind = yield* refusedKindOf(writer, self, frame.canvasName, fact.body);
                  if (refusedKind !== undefined) changed.add(refusedKind);
                  if (notice !== undefined) {
                    const canvas = yield* writer.unsafe<{ seq: number }>("SELECT seq FROM canvases WHERE canvas_name = ?", [frame.canvasName]);
                    const basis = { kind: "canvas" as const, canvasName: frame.canvasName, seq: canvas[0]?.seq ?? 0 };
                    yield* commitLocalFact(writer, {
                      localInstallationId: self,
                      sink: notice.sink,
                      basis,
                      item: item("message", notice.message.messageId, notice.sink),
                      operation: "message.append",
                      predecessor: null,
                      body: { operation: "message.append", message: notice.message, sentBy: notice.sentBy, destination: { kind: "mailbox" } },
                      value: notice.message,
                      originAt: receivedAt,
                      receivedAt,
                    });
                    mail.push({ canvasName: frame.canvasName, nodeId: notice.sink.nodeId, message: notice.message });
                  }
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
            return { taken: fresh.length, commands: fresh.filter((fact) => fact.body.operation === "command.queued").length, changed: [...changed], mail };
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

    /**
     * Unruled commands of this machine for a canvas. A command is ruled when
     * a ruling for this writer and its opId is held, which is the editing
     * machine's row or, on the editing machine, its own.
     */
    /** A queue refusal anywhere in a failure's chain of causes. */
    const queueRefusalIn = (error: unknown): CommandQueueFull | CommandTargetUnknown | undefined => {
      for (let at: unknown = error, depth = 0; at !== undefined && depth < 8; depth += 1) {
        if (at instanceof CommandQueueFull || at instanceof CommandTargetUnknown) return at;
        at = typeof at === "object" && at !== null && "cause" in at ? (at as { readonly cause: unknown }).cause : undefined;
      }
      return undefined;
    };

    /** Whether a command's target names a node, on this machine's copy, of a kind its resource kind may name. */
    const targetNamesItsKind = (
      reader: SqlClient.SqlClient,
      canvasName: string,
      target: { readonly kind: ResourceKind; readonly nodeId: string },
    ) => {
      const tables = TARGET_NODE_KINDS[target.kind].map((kind) => KIND_TABLES[kind]);
      return reader
        .unsafe<{ found: number }>(
          tables.map((table) => `SELECT 1 AS found FROM ${table} WHERE canvas_name = ? AND id = ?`).join(" UNION ALL "),
          tables.flatMap(() => [canvasName, target.nodeId]),
        )
        .pipe(Effect.map((rows) => rows.length > 0));
    };

    const queueLoadOf = (reader: SqlClient.SqlClient, self: string, canvasName: string) =>
      reader
        .unsafe<{ rows: number; bytes: number | null }>(
          `
            SELECT count(*) AS rows, sum(length(CAST(fact.result_json AS BLOB))) AS bytes
            FROM work_events AS command
            JOIN work_facts AS fact USING (event_home, entity_home, seq)
            WHERE command.event_home = ?
              AND command.entity_home = ?
              AND command.item_canvas_name = ?
              AND command.operation = 'command.queued'
              AND NOT EXISTS (
                SELECT 1
                FROM work_events AS ruling
                JOIN work_facts AS ruled USING (event_home, entity_home, seq)
                WHERE ruling.item_canvas_name = command.item_canvas_name
                  AND ruling.item_node_id = command.item_node_id
                  AND ruling.item_kind = 'ruling'
                  AND ruling.item_id = command.item_id
                  AND json_extract(ruled.result_json, '$.writer') = command.event_home
              )
          `,
          [self, self, canvasName],
        )
        .pipe(Effect.map((rows): QueueLoad => ({ rows: rows[0]?.rows ?? 0, bytes: rows[0]?.bytes ?? 0 })));

    const queueCommand = (
      input: QueueCommandInput,
    ): Effect.Effect<LocalFactResult<OpId>, RepositoryFailure | CommandQueueFull | CommandTargetUnknown> => {
      const { command } = input;
      const sink = { canvasName: command.canvasName, nodeId: command.target.nodeId };
      const body = { operation: "command.queued" as const, command };
      return transaction("work.command.queue", sink, (writer: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const self = (yield* canonicalLocalWorkAuthority(writer)).installationId;
          if (!(yield* targetNamesItsKind(writer, command.canvasName, command.target))) {
            return yield* Effect.fail(
              new CommandTargetUnknown({ opId: command.opId, kind: command.target.kind, nodeId: command.target.nodeId }),
            );
          }
          const load = yield* queueLoadOf(writer, self, command.canvasName);
          const rowBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
          if (!queueAdmits(load, rowBytes)) {
            return yield* Effect.fail(new CommandQueueFull({ opId: command.opId, rows: load.rows, bytes: load.bytes }));
          }
          return yield* commitLocalFact(writer, {
            localInstallationId: self,
            sink,
            basis: input.basis,
            item: item("command", command.opId, sink),
            operation: "command.queued",
            predecessor: null,
            body,
            value: command.opId,
            originAt: timestamp(input.originAt),
            receivedAt: timestamp(input.receivedAt),
          });
        }),
      ).pipe(
        // The transaction wraps a failure as a repository error; a queue refusal is the caller's to answer, so it comes back as itself.
        Effect.mapError((error) => queueRefusalIn(error) ?? error),
      ) as Effect.Effect<LocalFactResult<OpId>, RepositoryFailure | CommandQueueFull | CommandTargetUnknown>;
    };

    const commandQueueLoad = (canvasName: string): Effect.Effect<QueueLoad, WorkRepositoryError> =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          const self = (yield* canonicalLocalWorkAuthority(sql)).installationId;
          return yield* queueLoadOf(sql, self, canvasName);
        }),
      ).pipe(Effect.mapError((error) => toRepositoryError("work.command.queue-load", error)));

    const decodeRuling = Schema.decodeUnknownResult(Schema.Union([RulingAppliedResult, RulingRefusedResult]), strictDecode);

    const commandState = (
      canvasName: string,
      writer: InstallationId,
      opId: OpId,
    ): Effect.Effect<OpState, WorkRepositoryError> =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          const rulings = yield* sql.unsafe<{ result_json: string }>(
            `
              SELECT fact.result_json
              FROM work_events AS event
              JOIN work_facts AS fact USING (event_home, entity_home, seq)
              WHERE event.item_canvas_name = ?
                AND event.item_kind = 'ruling'
                AND event.item_id = ?
                AND json_extract(fact.result_json, '$.writer') = ?
              LIMIT 1
            `,
            [canvasName, opId, writer],
          );
          if (rulings[0] !== undefined) {
            const ruling = decodeRuling(JSON.parse(rulings[0].result_json));
            if (Result.isSuccess(ruling)) {
              return ruling.success.operation === "ruling.applied"
                ? ({ kind: "applied", ruling: ruling.success } as const)
                : ({ kind: "refused", ruling: ruling.success, error: refusalErrorOf(ruling.success) } as const);
            }
          }
          const queued = yield* sql.unsafe<{ found: number }>(
            `
              SELECT 1 AS found FROM work_events
              WHERE event_home = ? AND entity_home = ? AND item_canvas_name = ?
                AND item_kind = 'command' AND item_id = ?
              LIMIT 1
            `,
            [writer, writer, canvasName, opId],
          );
          return queued.length > 0 ? ({ kind: "queued" } as const) : ({ kind: "unknown" } as const);
        }),
      ).pipe(Effect.mapError((error) => toRepositoryError("work.command.state", error)));

    const recordRuling = (
      input: RecordRulingInput,
    ): Effect.Effect<RecordedRuling, RepositoryFailure> => {
      const { command } = input;
      const sink = { canvasName: input.canvasName, nodeId: command.target.nodeId };
      const body = rulingRowOf(input.writer, command, input.kind, input.ruling);
      return transaction("work.ruling.record", sink, (writer: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const self = (yield* canonicalLocalWorkAuthority(writer)).installationId;
          const canvas = yield* writer.unsafe<{ seq: number; editor: string | null }>(
            "SELECT seq, editor_installation_id AS editor FROM canvases WHERE canvas_name = ?",
            [input.canvasName],
          );
          // No editor named is this machine's own canvas, as the model reads it (canvasEdits).
          if (canvas[0] === undefined || (canvas[0].editor !== null && canvas[0].editor !== self)) {
            return yield* Effect.fail(
              authorityError("authority-mismatch", "only the machine that edits a canvas rules its commands"),
            );
          }
          yield* writeRuling(writer, { canvas: input.canvasName, writer: input.writer, command, record: input.record });
          const recorded = yield* commitLocalFact(writer, {
            localInstallationId: self,
            sink,
            basis: { kind: "canvas", canvasName: input.canvasName, seq: canvas[0].seq },
            item: item("ruling", command.opId, sink),
            operation: body.operation,
            predecessor: null,
            body,
            value: body,
            originAt: timestamp(input.at),
            receivedAt: timestamp(input.at),
          });
          // The editing machine's own seats are told here, with the ruling; every other machine's as it folds it.
          const notices = body.operation === "ruling.applied" && input.placement !== undefined
            ? yield* writeRulingNotices(writer, self, input.canvasName, body, input.placement, timestamp(input.at))
            : [];
          return { ...recorded, notices };
        }),
      );
    };

    const purgeShot: WorkRepositoryShape["purgeShot"] = (input) => {
      const sink = { canvasName: input.canvasName, nodeId: input.nodeId };
      return transaction("work.shot.purge", sink, (writer: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const self = (yield* canonicalLocalWorkAuthority(writer)).installationId;
          const canvas = yield* writer.unsafe<{ seq: number; editor: string | null }>(
            "SELECT seq, editor_installation_id AS editor FROM canvases WHERE canvas_name = ?",
            [input.canvasName],
          );
          // Only the operator purges, so only where the operator writes: the editing machine.
          if (canvas[0] === undefined || (canvas[0].editor !== null && canvas[0].editor !== self)) {
            return yield* Effect.fail(
              authorityError("authority-mismatch", "only the machine that edits a canvas purges a shot"),
            );
          }
          const row = yield* heldMailRow(writer, input);
          if (row === undefined || pageShotOf({ metadata: row.metadata }) === undefined) {
            return yield* Effect.fail(authorityError("missing-entity", "the comment names no shot"));
          }
          const comment = { canvasName: input.canvasName, nodeId: input.nodeId, messageId: mailThreadOf({ messageId: input.messageId, metadata: row.metadata }) };
          const at = timestamp(input.at);
          const already = yield* shotPurgedHere(writer, { canvasName: comment.canvasName, nodeId: comment.nodeId, recordId: comment.messageId });
          const released = yield* keepShotPurge(writer, comment, at);
          if (already) return { comment, released, written: false };
          const body = { operation: "shot.purged" as const, messageId: comment.messageId };
          yield* commitLocalFact(writer, {
            localInstallationId: self,
            sink,
            basis: { kind: "canvas", canvasName: input.canvasName, seq: canvas[0].seq },
            item: item("purge", comment.messageId, sink),
            operation: body.operation,
            predecessor: null,
            body,
            value: body,
            originAt: at,
            receivedAt: at,
          });
          return { comment, released, written: true };
        }),
      );
    };

    const shotPurged: WorkRepositoryShape["shotPurged"] = (owner) =>
      withSqlRead(sql, shotPurgedHere(sql, owner)).pipe(
        Effect.provideService(StateTransactionOperation, "work.shot.purged"),
        Effect.mapError((error) => toRepositoryError("work.shot.purged", error)),
      );

    const decodeQueued = Schema.decodeUnknownResult(CommandQueuedResult, strictDecode);

    const unruledCommands = (canvasName: string): Effect.Effect<ReadonlyArray<UnruledCommand>, WorkRepositoryError> =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<{ writer: string; result_json: string }>(
            `
              SELECT command.event_home AS writer, fact.result_json
              FROM work_events AS command
              JOIN work_facts AS fact USING (event_home, entity_home, seq)
              WHERE command.item_canvas_name = ?
                AND command.operation = 'command.queued'
                AND command.event_home = command.entity_home
                AND NOT EXISTS (
                  SELECT 1
                  FROM work_events AS ruling
                  JOIN work_facts AS ruled USING (event_home, entity_home, seq)
                  WHERE ruling.item_canvas_name = command.item_canvas_name
                    AND ruling.item_node_id = command.item_node_id
                    AND ruling.item_kind = 'ruling'
                    AND ruling.item_id = command.item_id
                    AND json_extract(ruled.result_json, '$.writer') = command.event_home
                )
              ORDER BY command.event_home, length(command.seq), command.seq
            `,
            [canvasName],
          );
          const found: Array<UnruledCommand> = [];
          for (const row of rows) {
            // Every held row decoded when it was taken; one that no longer does is a defect, never a command.
            const body = decodeQueued(JSON.parse(row.result_json));
            if (Result.isFailure(body)) return yield* Effect.die(new Error(`a held command row of ${row.writer} does not decode`));
            found.push({ writer: row.writer as InstallationId, command: body.success.command });
          }
          return found;
        }),
      ).pipe(Effect.mapError((error) => toRepositoryError("work.command.unruled", error)));

    return WorkRepository.of({
      unruledCommands,
      recordRuling,
      purgeShot,
      shotPurged,
      queueCommand,
      commandQueueLoad,
      commandState,
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
          return (yield* loadLaneTasks(sql, query, "task", [query.itemId]))[0];
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
      mailBetween: Effect.fn("WorkRepository.mailBetween")((canvasName: string, a: string, b: string, limit: number) =>
        withSqlRead(sql, readMailBetween(sql, canvasName, a, b, limit)).pipe(
          Effect.mapError((error) => toRepositoryError("work.mail.between", error)),
        )),
      mailSentBy: Effect.fn("WorkRepository.mailSentBy")((canvasName: string, sender: string) =>
        withSqlRead(sql, readMailSentBy(sql, canvasName, sender)).pipe(
          Effect.mapError((error) => toRepositoryError("work.mail.sent-by", error)),
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
      hasAcceptedDelivery,
      acceptedDeliveryAt,
      publishCheckoutReceipts,
      appendMessage,
      acceptDelivery,
      setArtifactArchived,
      deleteArtifact,
      recordCanvasCopySent,
      departingFrom,
      exchangeHave,
      exchangeForget,
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
      readonly lane: "task";
      readonly itemId: string;
      readonly messageId: string;
    }
  | { readonly kind: "artifact"; readonly artifactId: string }
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
        parent_lane: Schema.Literal("task"),
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
