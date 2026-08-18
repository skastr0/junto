import { createHash } from "node:crypto";
import { Context, Effect, Result, Layer, Schema } from "effect";
import {
  decodeCanvasDoc,
  type CanvasDoc,
  type CanvasNode,
} from "@shared/canvas";
import type { ActorSeatId } from "@shared/actor-seat";
import { InstallationId } from "@shared/installation-id";
import {
  STATION_API_MAX_ACKS_PER_REPORT,
  StationApiRole,
  decideRouteCursorAdvance,
  type StationApiRole as StationApiRoleValue,
} from "@shared/station-api";
import {
  Artifact,
  CompletionEvidence,
  FinishCriteria,
  Message,
  Task,
  TaskProposal,
  type Artifact as ArtifactValue,
  type Message as MessageValue,
  type Task as TaskValue,
  type TaskProposal as TaskProposalValue,
  type TaskState,
  type WorkSnapshot as WorkSnapshotValue,
  type BoardTopic as BoardTopicValue,
  type BoardPost as BoardPostValue,
  type BoardAuthor as BoardAuthorValue,
  type EtherPad as EtherPadValue,
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
  RouteCursor,
  SinkRef,
  WORK_PROTOCOL,
  WorkAction,
  WorkCommand,
  FactBasis,
  WorkFact,
  WorkRecord,
  WorkSha256,
  decodeWorkRecord,
  type ActorRef,
  type DeliveryReceipt,
  type DisplayTimestamp as DisplayTimestampValue,
  type FactBasis as FactBasisValue,
  type IntentFactBasis as IntentFactBasisValue,
  type LogicalSequence as LogicalSequenceValue,
  type MessageAppendDestination,
  type RouteCursor as RouteCursorValue,
  type SinkRef as SinkRefValue,
  type WorkAction as WorkActionValue,
  type WorkCommand as WorkCommandValue,
  type WorkDisposition as WorkDispositionValue,
  type WorkFact as WorkFactValue,
  type WorkItemRef,
  type WorkOperation,
  type WorkRecord as WorkRecordValue,
  type WorkRecordId,
  type WorkRejectionReason,
  type WorkResult,
  type WorkSha256 as WorkSha256Value,
} from "@shared/work-protocol";
import {
  canTransitionTaskState,
  mirrorArtifactsText,
  mirrorBoardText,
  mirrorPadText,
  mirrorRequestsText,
  mirrorTasksText,
  taskWithTransitionState,
} from "@shared/task";
import {
  taskContentPendingMessage,
  taskContentReadiness,
} from "@shared/content";
import {
  taskIndexById,
  taskIsClaimReady,
  validateTaskDependsOn,
} from "@shared/task-deps";
import {
  evaluateFinishCriteria,
  normalizeCompletionEvidence,
} from "@shared/finish-criteria";
import {
  StateEngine,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../state/service";
import {
  inboundActorNodeIds,
  padAuthorRuleError,
  stampPadPatchAuthors,
} from "./pad-rules";
import { manifestAvailability } from "../content/manifest";
import {
  mailboxMessageDeliveryId,
  mailboxMessageReactId,
  mailboxMessageReadId,
} from "./mailbox-receipts";

const DEFAULT_RECORD_LIMIT = 256;
const MAX_RECORD_LIMIT = 1_024;

const strictDecode = { onExcessProperty: "error" } as const;

const now = (): DisplayTimestampValue =>
  Schema.decodeUnknownSync(DisplayTimestamp)(new Date().toISOString());

/**
 * DependsOn + verified content receipts. Media bytes are not in Work rows;
 * claimability requires a local verified receipt for every ContentRef.
 */
const assertTaskClaimReady = (
  reader: StateReader,
  task: TaskValue,
  canvasName: string,
): void => {
  // Canvas-wide index: cross-sink dependsOn may point at other task nodes.
  // Pure policy already rejected cross-region at create/propose time.
  if (!taskIsClaimReady(task, taskIndexById(loadCanvasTasks(reader, canvasName)))) {
    throw authorityError(
      "invalid-transition",
      `task "${task.id}" is not claim-ready (unsatisfied dependsOn)`,
    );
  }
  const content = taskContentReadiness(task, (ref) =>
    manifestAvailability(reader, ref),
  );
  if (content.kind === "pending") {
    throw authorityError(
      "invalid-transition",
      taskContentPendingMessage(task.id, content),
    );
  }
};

const timestamp = (
  value: string | undefined,
): DisplayTimestampValue =>
  Schema.decodeUnknownSync(DisplayTimestamp)(value ?? now());

const sequence = (value: string): LogicalSequenceValue =>
  Schema.decodeUnknownSync(LogicalSequence)(value);

const sha256 = (value: string): WorkSha256Value =>
  Schema.decodeUnknownSync(WorkSha256)(
    createHash("sha256").update(value, "utf8").digest("hex"),
  );

const normalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([key, nested]) => [key, normalizeJson(nested)]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalizeJson(value));

/**
 * Hash only the semantic record. `originAt` is display metadata and
 * `contentSha256` is the resulting digest, so neither participates.
 */
export const workRecordContentSha256 = (
  record: WorkRecordSemantic,
): WorkSha256Value => sha256(canonicalJson(record));

type WorkRecordSemantic =
  | Omit<WorkCommandValue, "contentSha256" | "originAt">
  | Omit<WorkFactValue, "contentSha256" | "originAt">
  | Omit<WorkDispositionValue, "contentSha256" | "originAt">;

const recordWithHash = (
  semantic: WorkRecordSemantic,
  originAt: DisplayTimestampValue,
): WorkRecordValue => {
  const candidate = {
    ...semantic,
    contentSha256: workRecordContentSha256(semantic),
    originAt,
  };
  return Schema.decodeUnknownSync(WorkRecord, strictDecode)(candidate);
};

const sameRoute = (
  left: WorkRecordId["route"],
  right: WorkRecordId["route"],
): boolean =>
  left.eventHome === right.eventHome &&
  left.entityHome === right.entityHome;

const sameId = (
  left: WorkRecordId | null,
  right: WorkRecordId | null,
): boolean =>
  left === null
    ? right === null
    : right !== null &&
      sameRoute(left.route, right.route) &&
      left.seq === right.seq;

const sameItem = (left: WorkItemRef, right: WorkItemRef): boolean =>
  left.kind === right.kind &&
  left.itemId === right.itemId &&
  left.sink.canvasName === right.sink.canvasName &&
  left.sink.nodeId === right.sink.nodeId;

const sameActor = (left: ActorRef, right: ActorRef): boolean =>
  left.seatId === right.seatId &&
  left.canvasName === right.canvasName &&
  left.nodeId === right.nodeId;

const sameBoardAuthor = (
  left: BoardAuthorValue,
  right: BoardAuthorValue,
): boolean =>
  left.kind === right.kind &&
  (left.seatId ?? null) === (right.seatId ?? null) &&
  (left.nodeId ?? null) === (right.nodeId ?? null) &&
  (left.label ?? null) === (right.label ?? null);

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

const boundedDiagnostic = (message: string): string => {
  const normalized = message.trim() || "Command rejected";
  return normalized.length <= 2_048
    ? normalized
    : `${normalized.slice(0, 2_045)}...`;
};

export class WorkRepositoryError extends Schema.TaggedErrorClass<WorkRepositoryError>()(
  "WorkRepositoryError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class WorkAuthorityError extends Schema.TaggedErrorClass<WorkAuthorityError>()(
  "WorkAuthorityError",
  {
    reason: Schema.Literals(["authority-mismatch", "causal-conflict",
    "claim-contention",
    "identity-conflict",
    "invalid-transition",
    "missing-entity",
    "target-mismatch",]),
    message: Schema.String,
  },
) {}


export class WorkReplicationError extends Schema.TaggedErrorClass<WorkReplicationError>()(
  "WorkReplicationError",
  {
    reason: Schema.Literals(["direction-mismatch", "integrity",
    "identity-conflict",
    "causal-conflict",
    "cursor-regression",
    "sequence-gap",
    "response-capacity",]),
    senderInstallationId: Schema.String,
    sequence: Schema.optionalKey(LogicalSequence),
    message: Schema.String,
  },
) {}

type RepositoryFailure =
  | WorkRepositoryError
  | WorkAuthorityError;

type ReplicationFailure =
  | WorkRepositoryError
  | WorkReplicationError;

export type WorkRepositoryInput = {
  readonly sink: SinkRefValue;
  readonly originAt?: string;
  readonly receivedAt?: string;
};

export type LocalWorkInput = WorkRepositoryInput & {
  readonly basis: IntentFactBasisValue;
};

export type CreateTaskInput = LocalWorkInput & {
  readonly task: TaskValue;
};

export type CreateProposalInput = LocalWorkInput & {
  readonly proposal: TaskProposalValue;
};

export type ApproveProposalInput = LocalWorkInput & {
  readonly proposalId: string;
  readonly task: TaskValue;
};

export type RejectProposalInput = LocalWorkInput & {
  readonly proposalId: string;
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
};

export type ClaimLocalTaskInput = LocalWorkInput & {
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
};

export type ReserveRemoteTaskClaimInput = WorkRepositoryInput & {
  readonly taskId: string;
  readonly actor: ActorRef;
  readonly targetInstallationId: InstallationId;
};

export type EnqueueRemoteCommandInput = WorkRepositoryInput & {
  readonly targetInstallationId: InstallationId;
  readonly item: WorkItemRef;
  readonly action: Exclude<WorkActionValue, { readonly operation: "task.claim" }>;
};

export type EnqueueRemoteProposalApprovalInput = WorkRepositoryInput & {
  readonly targetInstallationId: InstallationId;
  readonly item: WorkItemRef & { readonly kind: "proposal" };
  readonly action: Extract<
    WorkActionValue,
    { readonly operation: "proposal.approve" }
  >;
};

export type LocalFactResult<A> = {
  readonly value: A;
  readonly record: WorkFactValue;
  readonly snapshot: WorkSnapshotValue;
};

export type ProposalApprovalValue = {
  readonly proposal: TaskProposalValue;
  readonly task: TaskValue;
};

export type RecordsAfterInput = {
  readonly route: {
    readonly eventHome: InstallationId;
    readonly entityHome: InstallationId;
  };
  /** Absence is the only representation of sequence zero. */
  readonly after?: LogicalSequenceValue;
  readonly limit?: number;
};

export type PendingCommand = {
  readonly command: WorkCommandValue;
  readonly resolution:
    | {
        readonly status: "applied" | "rejected";
        readonly disposition: WorkRecordId;
        readonly resolvedAt: DisplayTimestampValue;
      }
    | undefined;
};

export type WorkCommandAuthorization =
  | { readonly _tag: "admitted" }
  | {
      readonly _tag: "rejected";
      readonly reason: WorkRejectionReason;
      readonly message: string;
    };

export type WorkFactAuthorization = WorkCommandAuthorization;

export type WorkResponseAdmission =
  | { readonly _tag: "admitted" }
  | {
      readonly _tag: "rejected";
      readonly message: string;
    };

export type WorkResponseCandidate = {
  readonly emitted: ReadonlyArray<WorkRecordValue>;
  readonly acknowledge: ReadonlyArray<RouteCursorValue>;
};

export type AcceptRecordsInput = {
  /** Identity already authenticated by the Station transport. */
  readonly senderInstallationId: InstallationId;
  readonly records: ReadonlyArray<WorkRecordValue>;
  /**
   * Cumulative acknowledgement of records emitted by this installation.
   * These cursors commit in the exact transaction that accepts `records`.
   */
  readonly peerAcknowledgements: ReadonlyArray<RouteCursorValue>;
  readonly receivedAt?: string;
  /**
   * Pure capability/projection admission. It executes inside the SQLite
   * transaction and therefore must never yield, open a nested repository
   * transaction, or perform I/O.
   */
  readonly authorizeCommand: (
    command: WorkCommandValue,
  ) => WorkCommandAuthorization;
  /** Pure projection/locality admission; denied facts roll back without ACK. */
  readonly authorizeFact: (
    fact: WorkFactValue,
  ) => WorkFactAuthorization;
  /**
   * Transport-neutral capacity gate. A rejected mandatory response aborts the
   * transaction, including materialization and receive-cursor advancement.
   */
  readonly admitResponse: (
    response: WorkResponseCandidate,
  ) => WorkResponseAdmission;
};

export type AcceptRecordsResult = {
  readonly accepted: number;
  readonly idempotent: number;
  readonly rejected: number;
  readonly acknowledge: ReadonlyArray<RouteCursorValue>;
  /** Newly committed facts/dispositions, plus prior outcomes on command replay. */
  readonly emitted: ReadonlyArray<WorkRecordValue>;
};

type EventRow = StateRow & {
  readonly event_home: string;
  readonly entity_home: string;
  readonly seq: string;
  readonly protocol: string;
  readonly record_type: "command" | "fact" | "disposition";
  readonly item_kind: WorkItemRef["kind"];
  readonly item_id: string;
  readonly item_canvas_name: string;
  readonly item_node_id: string;
  readonly operation: WorkOperation;
  readonly content_sha256: string;
  readonly origin_at: string;
  readonly received_at: string;
};

type VariantRow = StateRow & {
  readonly predecessor_event_home: string | null;
  readonly predecessor_entity_home: string | null;
  readonly predecessor_seq: string | null;
  readonly body_json: string;
};

type FactVariantRow = VariantRow & {
  readonly basis_kind: FactBasisValue["kind"];
  readonly basis_authorial_generation: string | null;
  readonly basis_authorial_content_sha256: string | null;
  readonly basis_projected_generation: string | null;
  readonly basis_projected_content_sha256: string | null;
  readonly basis_command_event_home: string | null;
  readonly basis_command_entity_home: string | null;
  readonly basis_command_seq: string | null;
  readonly basis_command_sha256: string | null;
};

type DispositionRow = StateRow & {
  readonly status: "applied" | "rejected";
  readonly command_event_home: string;
  readonly command_entity_home: string;
  readonly command_seq: string;
  readonly command_sha256: string;
  readonly fact_event_home: string | null;
  readonly fact_entity_home: string | null;
  readonly fact_seq: string | null;
  readonly fact_sha256: string | null;
  readonly rejection_reason: WorkRejectionReason | null;
  readonly rejection_message: string | null;
};

type RecentSeatOpRow = StateRow & {
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

type TaskRow = StateRow & {
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
};

type ProposalRow = StateRow & {
  readonly proposal_id: string;
  readonly state: TaskProposalValue["state"];
  readonly brief_json: string;
  readonly proposer_seat_id: string;
  readonly proposer_canvas_name: string;
  readonly proposer_node_id: string;
  readonly approved_task_id: string | null;
  readonly metadata_json: string | null;
  readonly reason: string | null;
};

type MessageRow = StateRow & {
  readonly message_id: string;
  readonly role: MessageValue["role"];
  readonly parts_json: string;
  readonly task_id: string | null;
  readonly context_id: string | null;
  readonly reference_task_ids_json: string | null;
  readonly metadata_json: string | null;
};

type ArtifactRow = StateRow & {
  readonly artifact_id: string;
  readonly name: string | null;
  readonly parts_json: string;
  readonly task_canvas_name: string | null;
  readonly task_node_id: string | null;
  readonly task_id: string | null;
  readonly task_entity_home: string | null;
  readonly metadata_json: string | null;
};

type IdentityRow = StateRow & {
  readonly entity_home: string;
  readonly actor_seat_id: string | null;
  readonly fact_event_home: string;
  readonly fact_entity_home: string;
  readonly fact_seq: string;
  readonly state: TaskState;
};

type ProposalIdentityRow = StateRow & {
  readonly entity_home: string;
  readonly fact_event_home: string;
  readonly fact_entity_home: string;
  readonly fact_seq: string;
  readonly state: TaskProposalValue["state"];
};

type SequenceRow = StateRow & {
  readonly last_seq: string;
};

type CursorRow = StateRow & {
  readonly through_sequence: string;
};

type LocalWorkAuthority = {
  readonly installationId: InstallationId;
  readonly role: StationApiRoleValue;
};

/**
 * Resolve the complete authority required by every locally initiated Work
 * mutation inside its transaction. Installation identity without an explicit
 * configured role is not enough to mint a Work record.
 */
const canonicalLocalWorkAuthority = (
  reader: StateReader,
): LocalWorkAuthority => {
  const row = reader.get<
    StateRow & {
      readonly installation_id: string;
      readonly role: string;
    }
  >(
    `
      SELECT installation.installation_id, configuration.role
      FROM station_installation AS installation
      JOIN station_configuration AS configuration
        ON configuration.singleton = installation.singleton
      WHERE installation.singleton = 1
    `,
  );
  if (row === undefined) {
    throw WorkAuthorityError.make({
      reason: "authority-mismatch",
      message:
        "local Station installation must be explicitly configured before Work mutation",
    });
  }
  return {
    installationId: Schema.decodeUnknownSync(InstallationId)(
      row.installation_id,
    ),
    role: Schema.decodeUnknownSync(StationApiRole)(row.role),
  };
};

/**
 * Reassert the exact intent snapshot captured by WorkService inside the same
 * SQLite transaction that will materialize the fact. This closes the
 * read/policy/write race without turning current intent into a retroactive
 * validator for already committed historical facts.
 */
const assertCurrentIntentBasis = (
  reader: StateReader,
  authority: LocalWorkAuthority,
  sink: SinkRefValue,
  basis: IntentFactBasisValue,
): void => {
  if (authority.role === "command-center") {
    if (basis.kind !== "authorial-intent") {
      throw authorityError(
        "authority-mismatch",
        "Command Center local work requires an authorial intent basis",
      );
    }
    const current = reader.get<StateRow>(
      `
        SELECT 1
        FROM canvas_head AS head
        JOIN canvas_generations AS generation
          ON generation.generation = head.generation
        JOIN canvas_generation_documents AS document
          ON document.generation = generation.generation
        WHERE head.singleton = 1
          AND generation.generation = ?
          AND generation.intent_sha256 = ?
          AND document.name = ?
      `,
      [basis.generation, basis.contentSha256, sink.canvasName],
    );
    if (current === undefined) {
      throw authorityError(
        "causal-conflict",
        "authorial intent changed before the local Work mutation committed",
      );
    }
    return;
  }

  if (basis.kind !== "projected-intent") {
    throw authorityError(
      "authority-mismatch",
      "Remote local work requires a projected intent basis",
    );
  }
  const current = reader.get<StateRow>(
    `
      SELECT 1
      FROM station_projection_head AS head
      JOIN station_projection_versions AS version
        ON version.generation = head.generation
        AND version.content_sha256 = head.content_sha256
      WHERE head.singleton = 1
        AND version.generation = ?
        AND version.content_sha256 = ?
    `,
    [basis.generation, basis.contentSha256],
  );
  if (current === undefined) {
    throw authorityError(
      "causal-conflict",
      "projected intent changed before the local Work mutation committed",
    );
  }
};

const textNode = (node: CanvasNode): CanvasNode =>
  node;

/**
 * Runtime-only overlay retained for canvas readers. SQLite remains the sole
 * durability; this function never converts projected work back into authorial
 * canvas input.
 */
const emptyPadGlance = (): EtherPadValue => ({
  revision: 0,
  shapeCount: 0,
  unreadPinCount: 0,
});

/** Factory-card glance is the operator's unread pins. */
const PAD_GLANCE_PRINCIPAL_KEY = "operator";

const inboundActorsForPad = (
  reader: StateReader,
  sink: SinkRefValue,
): ReadonlySet<string> => {
  const row = reader.get<StateRow & { readonly body: string }>(
    `
      SELECT document.body AS body
      FROM canvas_head AS head
      JOIN canvas_generation_documents AS document
        ON document.generation = head.generation
      WHERE head.singleton = 1
        AND document.name = ?
    `,
    [sink.canvasName],
  );
  if (row === undefined) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.body) as unknown;
  } catch {
    return new Set();
  }
  const decoded = decodeCanvasDoc(parsed);
  if (Result.isFailure(decoded)) return new Set();
  return inboundActorNodeIds(decoded.success, sink.nodeId);
};

const assertPadPatchRules = (
  reader: StateReader,
  sink: SinkRefValue,
  author: BoardAuthorValue,
  patches: ReadonlyArray<import("@shared/pad").PadPatch>,
): void => {
  const rule = padAuthorRuleError(
    author,
    patches,
    inboundActorsForPad(reader, sink),
  );
  if (rule !== undefined) {
    throw authorityError("invalid-transition", rule);
  }
};

export const projectWorkSnapshots = (
  doc: CanvasDoc,
  snapshots: ReadonlyArray<WorkSnapshotValue>,
): CanvasDoc => {
  const byNode = new Map(
    snapshots.map((snapshot) => [snapshot.nodeId, snapshot]),
  );
  return {
    ...doc,
    nodes: doc.nodes.map((source) => {
      const snapshot = byNode.get(source.id);
      const kind = source.ether?.entity?.kind;
      if (kind === "pad") {
        const glance = snapshot?.pad ?? emptyPadGlance();
        const node = textNode(source);
        const ether = { ...(node.ether ?? {}) };
        delete ether.tasks;
        delete ether.requests;
        delete ether.messages;
        delete ether.artifacts;
        delete ether.board;
        ether.pad = glance;
        return {
          ...node,
          ...(source.type === "text"
            ? { text: mirrorPadText(source.text, glance) }
            : {}),
          ether,
        } as CanvasNode;
      }
      if (snapshot === undefined) return source;
      const node = textNode(source);
      const ether = { ...(node.ether ?? {}) };
      delete ether.tasks;
      delete ether.requests;
      delete ether.messages;
      delete ether.artifacts;
      delete ether.board;
      delete ether.pad;
      if (kind === "task") ether.tasks = snapshot.tasks;
      if (kind === "requests") ether.requests = snapshot.requests;
      if (kind === "artifacts") ether.artifacts = snapshot.artifacts;
      if (kind === "board") {
        ether.board = {
          topics: snapshot.board.topics.map((topic) => ({
            topicId: topic.topicId,
            title: topic.title,
            state: topic.state,
            postCount: topic.postCount,
            lastActivityAt: topic.lastActivityAt,
            authorLabel:
              topic.openedBy.label ??
              (topic.openedBy.kind === "operator" ? "operator" : topic.openedBy.nodeId),
          })),
        };
      }
      if (snapshot.messages.items.length > 0) {
        ether.messages = snapshot.messages;
      }
      return {
        ...node,
        ...(node.type === "text" && kind === "task"
          ? { text: mirrorTasksText(snapshot.tasks.items) }
          : {}),
        ...(node.type === "text" && kind === "requests"
          ? { text: mirrorRequestsText(snapshot.requests.items) }
          : {}),
        ...(node.type === "text" && kind === "artifacts"
          ? { text: mirrorArtifactsText(snapshot.artifacts.items) }
          : {}),
        ...(node.type === "text" && kind === "board"
          ? { text: mirrorBoardText(snapshot.board.topics) }
          : {}),
        ether,
      } as CanvasNode;
    }),
  };
};

const parseJson = (value: string): unknown => JSON.parse(value);

const optionalJson = <A>(value: string | null): A | undefined =>
  value === null ? undefined : (parseJson(value) as A);

/**
 * Narrow coercion for the whole-object JSON columns.
 *
 * Durable JSON is written with `canonicalJson`, which sorts keys, so parsing a
 * column back yields sorted key order while a projected value's order is the
 * schema's declaration order. For the columns that store a whole schema object
 * — finish criteria, completion evidence, a proposal's brief — that difference
 * is visible in the projection, so these three restore the schema's order.
 *
 * They are per-task and per-proposal, never per-part and never per-message, so
 * they do not grow with the message volume the retired read-path decode walked.
 */
const finishCriteriaFromJson = (value: string): TaskValue["finishCriteria"] =>
  Schema.decodeUnknownSync(FinishCriteria, strictDecode)(parseJson(value));

const completionEvidenceFromJson = (
  value: string,
): TaskValue["completionEvidence"] =>
  Schema.decodeUnknownSync(CompletionEvidence, strictDecode)(parseJson(value));

const briefFromJson = (value: string): MessageValue =>
  Schema.decodeUnknownSync(Message, strictDecode)(parseJson(value));

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

const loadThread = (
  reader: StateReader,
  sink: SinkRefValue,
  lane: "task" | "request",
  itemId: string,
): ReadonlyArray<MessageValue> =>
  reader
    .all<MessageRow>(
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
      [sink.canvasName, sink.nodeId, lane, itemId],
    )
    .map((row) => messageFromRow(row, itemId));

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
const loadThreadsByItem = (
  reader: StateReader,
  sink: SinkRefValue,
  lane: "task" | "request",
): ReadonlyMap<string, ReadonlyArray<MessageValue>> => {
  const rows = reader.all<MessageRow & { readonly item_id: string }>(
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
      ORDER BY item_id, position
    `,
    [sink.canvasName, sink.nodeId, lane],
  );
  const byItem = new Map<string, MessageValue[]>();
  for (const row of rows) {
    const message = messageFromRow(row, row.item_id);
    const thread = byItem.get(row.item_id);
    if (thread === undefined) byItem.set(row.item_id, [message]);
    else thread.push(message);
  }
  return byItem;
};

const loadTaskDependsOnMap = (
  reader: StateReader,
  sink: SinkRefValue,
): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  const rows = reader.all<
    StateRow & {
      readonly task_id: string;
      readonly depends_on_task_id: string;
    }
  >(
    `
      SELECT task_id, depends_on_task_id
      FROM work_task_dependencies
      WHERE canvas_name = ? AND node_id = ?
      ORDER BY task_id, position, depends_on_task_id
    `,
    [sink.canvasName, sink.nodeId],
  );
  for (const row of rows) {
    const list = map.get(row.task_id);
    if (list === undefined) map.set(row.task_id, [row.depends_on_task_id]);
    else list.push(row.depends_on_task_id);
  }
  return map;
};

const loadTaskDependsOn = (
  reader: StateReader,
  sink: SinkRefValue,
  taskId: string,
): string[] | undefined => {
  const rows = reader.all<StateRow & { readonly depends_on_task_id: string }>(
    `
      SELECT depends_on_task_id
      FROM work_task_dependencies
      WHERE canvas_name = ? AND node_id = ? AND task_id = ?
      ORDER BY position, depends_on_task_id
    `,
    [sink.canvasName, sink.nodeId, taskId],
  );
  if (rows.length === 0) return undefined;
  return rows.map((row) => row.depends_on_task_id);
};

const loadTaskFinish = (
  reader: StateReader,
  sink: SinkRefValue,
  taskId: string,
): {
  readonly finishCriteria?: TaskValue["finishCriteria"];
  readonly completionEvidence?: TaskValue["completionEvidence"];
} => {
  const row = reader.get<
    StateRow & {
      readonly finish_criteria_json: string | null;
      readonly completion_evidence_json: string | null;
    }
  >(
    `
      SELECT finish_criteria_json, completion_evidence_json
      FROM work_task_finish
      WHERE canvas_name = ? AND node_id = ? AND task_id = ?
    `,
    [sink.canvasName, sink.nodeId, taskId],
  );
  if (row === undefined) return {};
  return {
    ...(row.finish_criteria_json === null
      ? {}
      : { finishCriteria: finishCriteriaFromJson(row.finish_criteria_json) }),
    ...(row.completion_evidence_json === null
      ? {}
      : {
          completionEvidence: completionEvidenceFromJson(
            row.completion_evidence_json,
          ),
        }),
  };
};

const loadTaskFinishMap = (
  reader: StateReader,
  sink: SinkRefValue,
): Map<
  string,
  {
    readonly finishCriteria?: TaskValue["finishCriteria"];
    readonly completionEvidence?: TaskValue["completionEvidence"];
  }
> => {
  const rows = reader.all<
    StateRow & {
      readonly task_id: string;
      readonly finish_criteria_json: string | null;
      readonly completion_evidence_json: string | null;
    }
  >(
    `
      SELECT task_id, finish_criteria_json, completion_evidence_json
      FROM work_task_finish
      WHERE canvas_name = ? AND node_id = ?
    `,
    [sink.canvasName, sink.nodeId],
  );
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
        : { finishCriteria: finishCriteriaFromJson(row.finish_criteria_json) }),
      ...(row.completion_evidence_json === null
        ? {}
        : {
            completionEvidence: completionEvidenceFromJson(
              row.completion_evidence_json,
            ),
          }),
    });
  }
  return map;
};

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
const loadAllArtifactsByNode = (
  reader: StateReader,
  canvasName: string,
): Map<string, ReadonlyArray<ArtifactValue>> => {
  const rows = reader.all<
    StateRow & {
      readonly node_id: string;
      readonly artifact_id: string;
      readonly actor_seat_id: string | null;
      readonly name: string | null;
      readonly parts_json: string;
      readonly task_canvas_name: string | null;
      readonly task_node_id: string | null;
      readonly task_id: string | null;
      readonly metadata_json: string | null;
    }
  >(
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
    [canvasName],
  );
  const map = new Map<string, ArtifactValue[]>();
  for (const row of rows) {
    const decoded = Schema.decodeUnknownSync(Artifact, strictDecode)({
      artifactId: row.artifact_id,
      parts: parseJson(row.parts_json),
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
        : { metadata: parseJson(row.metadata_json) }),
    });
    const artifact = stampPublishedBySeat(decoded, row.actor_seat_id);
    const list = map.get(row.node_id);
    if (list === undefined) map.set(row.node_id, [artifact]);
    else list.push(artifact);
  }
  return map;
};

const writeTaskFinish = (
  writer: StateWriter,
  sink: SinkRefValue,
  task: TaskValue,
): void => {
  // undefined on both = snapshot omitted finish fields; keep durable row
  // (mirrors dependsOn preserve semantics).
  if (
    task.finishCriteria === undefined &&
    task.completionEvidence === undefined
  ) {
    return;
  }
  // When one field is present, merge: keep the other from existing row if
  // the snapshot omitted it.
  const existing = loadTaskFinish(writer, sink, task.id);
  const criteria =
    task.finishCriteria !== undefined
      ? task.finishCriteria
      : existing.finishCriteria;
  const evidence =
    task.completionEvidence !== undefined
      ? task.completionEvidence
      : existing.completionEvidence;
  writer.run(
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
};

const writeTaskDependsOn = (
  writer: StateWriter,
  sink: SinkRefValue,
  taskId: string,
  dependsOn: ReadonlyArray<string> | undefined,
): void => {
  // undefined means "field omitted on this snapshot" — do not wipe durable edges.
  // Explicit [] clears; non-empty replaces.
  if (dependsOn === undefined) return;
  writer.run(
    `
      DELETE FROM work_task_dependencies
      WHERE canvas_name = ? AND node_id = ? AND task_id = ?
    `,
    [sink.canvasName, sink.nodeId, taskId],
  );
  for (let position = 0; position < dependsOn.length; position += 1) {
    writer.run(
      `
        INSERT INTO work_task_dependencies(
          canvas_name,
          node_id,
          task_id,
          depends_on_task_id,
          position
        ) VALUES (?, ?, ?, ?, ?)
      `,
      [
        sink.canvasName,
        sink.nodeId,
        taskId,
        dependsOn[position]!,
        position,
      ],
    );
  }
};

const taskFromRow = (
  reader: StateReader,
  sink: SinkRefValue,
  lane: "task" | "request",
  row: TaskRow,
  dependsOn?: ReadonlyArray<string>,
  finish?: {
    readonly finishCriteria?: TaskValue["finishCriteria"];
    readonly completionEvidence?: TaskValue["completionEvidence"];
  },
  history?: ReadonlyArray<MessageValue>,
): TaskValue => ({
  // Constructed, not decoded — see messageFromRow. Every `work_tasks` /
  // `work_requests` row is the materialization of a `Task` the write path
  // already strict-decoded (createTask / transitionTask / claimTask /
  // resolveRequest all decode before commitLocalFact), and state / seat id /
  // JSON columns carry SQL CHECK domains. Field order is the `Task` schema
  // order the decode used to emit.
  id: row.item_id,
  state: row.state as TaskValue["state"],
  ...(row.actor_seat_id === null
    ? {}
    : { claimedBy: row.actor_seat_id as TaskValue["claimedBy"] }),
  history: history ?? loadThread(reader, sink, lane, row.item_id),
  ...(row.artifact_ids_json === null
    ? {}
    : {
        artifactIds: parseJson(
          row.artifact_ids_json,
        ) as TaskValue["artifactIds"],
      }),
  ...(lane === "task" && dependsOn !== undefined && dependsOn.length > 0
    ? { dependsOn: [...dependsOn] }
    : {}),
  ...(lane === "task" && finish?.finishCriteria !== undefined
    ? { finishCriteria: finish.finishCriteria }
    : {}),
  ...(lane === "task" && finish?.completionEvidence !== undefined
    ? { completionEvidence: finish.completionEvidence }
    : {}),
  ...(row.metadata_json === null
    ? {}
    : { metadata: parseJson(row.metadata_json) as TaskValue["metadata"] }),
  ...(row.reason === null ? {} : { reason: row.reason }),
  ...(row.response === null ? {} : { response: row.response }),
});

const loadLaneTasks = (
  reader: StateReader,
  sink: SinkRefValue,
  lane: "task" | "request",
): ReadonlyArray<TaskValue> => {
  const table = lane === "task" ? "work_tasks" : "work_requests";
  const id = lane === "task" ? "task_id" : "request_id";
  const dependsMap =
    lane === "task" ? loadTaskDependsOnMap(reader, sink) : undefined;
  const finishMap =
    lane === "task" ? loadTaskFinishMap(reader, sink) : undefined;
  const threads = loadThreadsByItem(reader, sink, lane);
  // Requests: newest first (operator triage). Tasks keep oldest-first claim order.
  const orderBy =
    lane === "request"
      ? `ORDER BY created_at DESC, ${id} DESC`
      : `ORDER BY created_at, ${id}`;
  return reader
    .all<TaskRow>(
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
        WHERE canvas_name = ? AND node_id = ?
        ${orderBy}
      `,
      [sink.canvasName, sink.nodeId],
    )
    .map((row) =>
      taskFromRow(
        reader,
        sink,
        lane,
        row,
        dependsMap?.get(row.item_id),
        finishMap?.get(row.item_id),
        threads.get(row.item_id) ?? [],
      ),
    );
};

/**
 * All tasks on a canvas — used for dependsOn existence / claim-ready so
 * cross-sink prereqs (same region at the policy layer) resolve in SQLite.
 * Region geometry is enforced by pure work policy before commit.
 */
const loadCanvasTasks = (
  reader: StateReader,
  canvasName: string,
): ReadonlyArray<TaskValue> => {
  const nodes = reader.all<StateRow & { readonly node_id: string }>(
    `
      SELECT DISTINCT node_id
      FROM work_tasks
      WHERE canvas_name = ?
      ORDER BY node_id
    `,
    [canvasName],
  );
  const items: TaskValue[] = [];
  for (const { node_id } of nodes) {
    items.push(
      ...loadLaneTasks(reader, { canvasName, nodeId: node_id }, "task"),
    );
  }
  return items;
};

const loadProposals = (
  reader: StateReader,
  sink: SinkRefValue,
): ReadonlyArray<TaskProposalValue> => {
  const planning = loadProposalPlanningMap(reader, sink);
  return reader
    .all<ProposalRow>(
      `
        SELECT
          proposal_id,
          state,
          brief_json,
          proposer_seat_id,
          proposer_canvas_name,
          proposer_node_id,
          approved_task_id,
          metadata_json,
          reason
        FROM work_task_proposals
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY created_at, proposal_id
      `,
      [sink.canvasName, sink.nodeId],
    )
    .map((row): TaskProposalValue => {
      const arms = planning.get(row.proposal_id);
      // Constructed, not decoded — see messageFromRow. proposeTask /
      // approveProposal / rejectProposal decode the `TaskProposal` before the
      // row exists. Field order is the `TaskProposal` schema order.
      return {
        id: row.proposal_id,
        state: row.state as TaskProposalValue["state"],
        brief: briefFromJson(row.brief_json),
        proposedBy: {
          seatId: row.proposer_seat_id as TaskProposalValue["proposedBy"]["seatId"],
          canvasName: row.proposer_canvas_name,
          nodeId: row.proposer_node_id,
        },
        ...(row.approved_task_id === null
          ? {}
          : { approvedTaskId: row.approved_task_id }),
        ...(arms?.dependsOn !== undefined ? { dependsOn: arms.dependsOn } : {}),
        ...(arms?.finishCriteria !== undefined
          ? { finishCriteria: arms.finishCriteria }
          : {}),
        ...(row.metadata_json === null
          ? {}
          : {
              metadata: parseJson(
                row.metadata_json,
              ) as TaskProposalValue["metadata"],
            }),
        ...(row.reason === null ? {} : { reason: row.reason }),
      };
    });
};

const loadProposalPlanningMap = (
  reader: StateReader,
  sink: SinkRefValue,
): Map<
  string,
  {
    readonly dependsOn?: ReadonlyArray<string>;
    readonly finishCriteria?: TaskProposalValue["finishCriteria"];
  }
> => {
  const rows = reader.all<
    StateRow & {
      readonly proposal_id: string;
      readonly depends_on_json: string | null;
      readonly finish_criteria_json: string | null;
    }
  >(
    `
      SELECT proposal_id, depends_on_json, finish_criteria_json
      FROM work_proposal_planning
      WHERE canvas_name = ? AND node_id = ?
    `,
    [sink.canvasName, sink.nodeId],
  );
  const map = new Map<
    string,
    {
      readonly dependsOn?: ReadonlyArray<string>;
      readonly finishCriteria?: TaskProposalValue["finishCriteria"];
    }
  >();
  for (const row of rows) {
    map.set(row.proposal_id, {
      ...(row.depends_on_json === null
        ? {}
        : {
            dependsOn: parseJson(row.depends_on_json) as ReadonlyArray<string>,
          }),
      ...(row.finish_criteria_json === null
        ? {}
        : { finishCriteria: finishCriteriaFromJson(row.finish_criteria_json) }),
    });
  }
  return map;
};

const writeProposalPlanning = (
  writer: StateWriter,
  sink: SinkRefValue,
  proposal: TaskProposalValue,
): void => {
  const hasDepends =
    proposal.dependsOn !== undefined && proposal.dependsOn.length > 0;
  const hasFinish = proposal.finishCriteria !== undefined;
  if (!hasDepends && !hasFinish) {
    writer.run(
      `
        DELETE FROM work_proposal_planning
        WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
      `,
      [sink.canvasName, sink.nodeId, proposal.id],
    );
    return;
  }
  writer.run(
    `
      INSERT INTO work_proposal_planning(
        canvas_name,
        node_id,
        proposal_id,
        depends_on_json,
        finish_criteria_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(canvas_name, node_id, proposal_id) DO UPDATE SET
        depends_on_json = excluded.depends_on_json,
        finish_criteria_json = excluded.finish_criteria_json
    `,
    [
      sink.canvasName,
      sink.nodeId,
      proposal.id,
      hasDepends ? canonicalJson(proposal.dependsOn) : null,
      hasFinish ? canonicalJson(proposal.finishCriteria) : null,
    ],
  );
};

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
const loadMessageReceiptAcceptedAtMap = (
  reader: StateReader,
  sink: SinkRefValue,
): ReadonlyMap<string, number> => {
  const rows = reader.all<
    StateRow & {
      readonly delivery_id: string;
      readonly accepted_at: string;
    }
  >(
    `
      SELECT delivery_id, accepted_at
      FROM work_delivery_receipts
      WHERE delivered_canvas_name = ?
        AND delivered_node_id = ?
        AND delivered_item_kind = 'message'
    `,
    [sink.canvasName, sink.nodeId],
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    const ms = Date.parse(row.accepted_at);
    if (Number.isFinite(ms)) map.set(row.delivery_id, ms);
  }
  return map;
};

const loadInbox = (
  reader: StateReader,
  sink: SinkRefValue,
): ReadonlyArray<MessageValue> => {
  const receipts = loadMessageReceiptAcceptedAtMap(reader, sink);
  return reader
    .all<MessageRow>(
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
      [sink.canvasName, sink.nodeId],
    )
    .map((row) => {
      const message = messageFromRow(row);
      const deliveredAt = receipts.get(
        mailboxMessageDeliveryId(sink.canvasName, sink.nodeId, row.message_id),
      );
      const readAt = receipts.get(
        mailboxMessageReadId(sink.canvasName, sink.nodeId, row.message_id),
      );
      const ackAt = receipts.get(
        mailboxMessageReactId(
          sink.canvasName,
          sink.nodeId,
          row.message_id,
          "ack",
        ),
      );
      if (
        deliveredAt === undefined &&
        readAt === undefined &&
        ackAt === undefined
      ) {
        return message;
      }
      return {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          ...(deliveredAt !== undefined ? { deliveredAt } : {}),
          ...(readAt !== undefined ? { readAt } : {}),
          ...(ackAt !== undefined
            ? { reactions: [{ kind: "ack", at: ackAt }] }
            : {}),
        },
      };
    });
};

const boardAuthorFromRow = (row: {
  readonly author_kind: string;
  readonly author_seat_id: string | null;
  readonly author_node_id: string | null;
  readonly author_label: string | null;
}): BoardAuthorValue => ({
  kind: row.author_kind === "operator" ? "operator" : "actor",
  ...(row.author_seat_id ? { seatId: row.author_seat_id as BoardAuthorValue["seatId"] } : {}),
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
const loadBoardPostsByTopic = (
  reader: StateReader,
  sink: SinkRefValue,
): ReadonlyMap<string, ReadonlyArray<BoardPostValue>> => {
  const rows = reader.all<
    StateRow & {
      readonly post_id: string;
      readonly topic_id: string;
      readonly position: number;
      readonly author_kind: string;
      readonly author_seat_id: string | null;
      readonly author_node_id: string | null;
      readonly author_label: string | null;
      readonly parts_json: string;
      readonly tags_json: string | null;
      readonly created_at: string;
    }
  >(
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
      ORDER BY topic_id, position
    `,
    [sink.canvasName, sink.nodeId],
  );
  const byTopic = new Map<string, BoardPostValue[]>();
  for (const row of rows) {
    const tagsRaw =
      typeof row.tags_json === "string" ? parseJson(row.tags_json) : undefined;
    const tags =
      Array.isArray(tagsRaw) && tagsRaw.every((t) => typeof t === "string")
        ? (tagsRaw as string[])
        : undefined;
    const post: BoardPostValue = {
      postId: row.post_id,
      topicId: row.topic_id,
      author: boardAuthorFromRow(row),
      parts: parseJson(row.parts_json) as BoardPostValue["parts"],
      position: row.position,
      createdAt: row.created_at,
      ...(tags && tags.length > 0 ? { tags } : {}),
    };
    const group = byTopic.get(row.topic_id);
    if (group === undefined) byTopic.set(row.topic_id, [post]);
    else group.push(post);
  }
  return byTopic;
};

const loadBoardTopics = (
  reader: StateReader,
  sink: SinkRefValue,
): ReadonlyArray<BoardTopicValue> => {
  try {
    const postsByTopic = loadBoardPostsByTopic(reader, sink);
    return reader
      .all<
        StateRow & {
          readonly topic_id: string;
          readonly title: string;
          readonly state: string;
          readonly author_kind: string;
          readonly author_seat_id: string | null;
          readonly author_node_id: string | null;
          readonly author_label: string | null;
          readonly parts_json: string;
          readonly post_count: number;
          readonly last_activity_at: string;
          readonly created_at: string;
        }
      >(
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
          ORDER BY last_activity_at DESC, topic_id
        `,
        [sink.canvasName, sink.nodeId],
      )
      .map((row): BoardTopicValue => {
        const parts = parseJson(row.parts_json);
        const posts = postsByTopic.get(row.topic_id) ?? [];
        return {
          topicId: row.topic_id,
          title: row.title,
          state: row.state as BoardTopicValue["state"],
          openedBy: boardAuthorFromRow(row),
          openedAt: row.created_at,
          postCount: row.post_count,
          lastActivityAt: row.last_activity_at,
          ...(Array.isArray(parts) && parts.length > 0
            ? { parts: parts as BoardTopicValue["parts"] }
            : {}),
          ...(posts.length > 0 ? { posts } : {}),
        };
      });
  } catch {
    // Pre-migration databases or missing table — empty lane.
    return [];
  }
};

const loadArtifacts = (
  reader: StateReader,
  sink: SinkRefValue,
): ReadonlyArray<ArtifactValue> =>
  reader
    .all<ArtifactRow & { readonly actor_seat_id: string | null }>(
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
        ORDER BY origin_at DESC, artifact_id ASC
      `,
      [sink.canvasName, sink.nodeId],
    )
    .map((row) =>
      stampPublishedBySeat(
        Schema.decodeUnknownSync(Artifact, strictDecode)({
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
    );

const optionalString = (value: string | null): string | undefined =>
  value === null || value.length === 0 ? undefined : value;

const loadPad = (reader: StateReader, sink: SinkRefValue): Pad => {
  const meta = reader.get<StateRow & { readonly revision: number }>(
    `
      SELECT revision
      FROM work_pad_meta
      WHERE canvas_name = ? AND node_id = ?
    `,
    [sink.canvasName, sink.nodeId],
  );
  if (meta === undefined) return emptyPad();

  const images = reader
    .all<
      StateRow & {
        readonly element_id: string;
        readonly x: number;
        readonly y: number;
        readonly w: number;
        readonly h: number;
        readonly z: number;
        readonly ref_json: string;
      }
    >(
      `
        SELECT element_id, x, y, w, h, z, ref_json
        FROM work_pad_images
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY z, element_id
      `,
      [sink.canvasName, sink.nodeId],
    )
    .map((row): PadImage => ({
      id: row.element_id as PadImage["id"],
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      z: row.z,
      ref: parseJson(row.ref_json) as PadImage["ref"],
    }));

  const shapes = reader
    .all<
      StateRow & {
        readonly element_id: string;
        readonly type: PadShape["type"];
        readonly x: number;
        readonly y: number;
        readonly w: number;
        readonly h: number;
        readonly z: number;
        readonly fill: string | null;
        readonly stroke: string | null;
        readonly text: string | null;
        readonly status: PadShape["status"] | null;
      }
    >(
      `
        SELECT element_id, type, x, y, w, h, z, fill, stroke, text, status
        FROM work_pad_shapes
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY z, element_id
      `,
      [sink.canvasName, sink.nodeId],
    )
    .map((row): PadShape => ({
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

  const edges = reader
    .all<
      StateRow & {
        readonly element_id: string;
        readonly from_id: string;
        readonly to_id: string;
        readonly from_side: PadEdge["fromSide"] | null;
        readonly to_side: PadEdge["toSide"] | null;
        readonly label: string | null;
      }
    >(
      `
        SELECT element_id, from_id, to_id, from_side, to_side, label
        FROM work_pad_edges
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY element_id
      `,
      [sink.canvasName, sink.nodeId],
    )
    .map((row): PadEdge => ({
      id: row.element_id as PadEdge["id"],
      from: row.from_id as PadEdge["from"],
      to: row.to_id as PadEdge["to"],
      ...(row.from_side === null ? {} : { fromSide: row.from_side }),
      ...(row.to_side === null ? {} : { toSide: row.to_side }),
      ...(optionalString(row.label) === undefined
        ? {}
        : { label: optionalString(row.label) }),
    }));

  const inks = reader
    .all<
      StateRow & {
        readonly element_id: string;
        readonly z: number;
        readonly color: string;
        readonly width: number;
        readonly points_json: string;
      }
    >(
      `
        SELECT element_id, z, color, width, points_json
        FROM work_pad_inks
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY z, element_id
      `,
      [sink.canvasName, sink.nodeId],
    )
    .map((row): PadInk => ({
      id: row.element_id as PadInk["id"],
      z: row.z,
      color: row.color,
      width: row.width,
      points: parseJson(row.points_json) as PadInk["points"],
    }));

  const pinRows = reader.all<
    StateRow & {
      readonly element_id: string;
      readonly x: number;
      readonly y: number;
      readonly bounds_json: string | null;
      readonly mentions_json: string;
    }
  >(
    `
      SELECT element_id, x, y, bounds_json, mentions_json
      FROM work_pad_pins
      WHERE canvas_name = ? AND node_id = ?
      ORDER BY element_id
    `,
    [sink.canvasName, sink.nodeId],
  );
  const postRows = reader.all<
    StateRow & {
      readonly pin_id: string;
      readonly post_id: string;
      readonly position: number;
      readonly author_kind: BoardAuthorValue["kind"];
      readonly author_seat_id: string | null;
      readonly author_node_id: string | null;
      readonly author_label: string | null;
      readonly parts_json: string;
    }
  >(
    `
      SELECT
        pin_id, post_id, position, author_kind,
        author_seat_id, author_node_id, author_label, parts_json
      FROM work_pad_posts
      WHERE canvas_name = ? AND node_id = ?
      ORDER BY pin_id, position
    `,
    [sink.canvasName, sink.nodeId],
  );
  const postsByPin = new Map<string, PadPost[]>();
  for (const row of postRows) {
    const post: PadPost = {
      postId: row.post_id as PadPost["postId"],
      author: boardAuthorFromRow(row),
      parts: parseJson(row.parts_json) as PadPost["parts"],
    };
    const list = postsByPin.get(row.pin_id) ?? [];
    list.push(post);
    postsByPin.set(row.pin_id, list);
  }
  const pins = pinRows.map((row): PadPin => ({
    id: row.element_id as PadPin["id"],
    x: row.x,
    y: row.y,
    ...(row.bounds_json === null
      ? {}
      : { bounds: parseJson(row.bounds_json) as PadPin["bounds"] }),
    mentions: parseJson(row.mentions_json) as PadPin["mentions"],
    posts: postsByPin.get(row.element_id) ?? [],
  }));

  const decoded = decodePad({
    revision: meta.revision,
    images,
    shapes,
    edges,
    inks,
    pins,
  });
  if (Result.isFailure(decoded)) {
    throw new Error(`stored pad is invalid: ${decoded.failure.message}`);
  }
  return decoded.success;
};

const loadPadGlance = (
  reader: StateReader,
  sink: SinkRefValue,
): EtherPadValue | undefined => {
  const meta = reader.get<StateRow & { readonly revision: number }>(
    `
      SELECT revision
      FROM work_pad_meta
      WHERE canvas_name = ? AND node_id = ?
    `,
    [sink.canvasName, sink.nodeId],
  );
  if (meta === undefined) return undefined;
  const shapeCount =
    reader.get<StateRow & { readonly n: number }>(
      `
        SELECT count(*) AS n
        FROM work_pad_shapes
        WHERE canvas_name = ? AND node_id = ?
      `,
      [sink.canvasName, sink.nodeId],
    )?.n ?? 0;
  const unreadPinCount =
    reader.get<StateRow & { readonly n: number }>(
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
      [PAD_GLANCE_PRINCIPAL_KEY, sink.canvasName, sink.nodeId],
    )?.n ?? 0;
  return {
    revision: meta.revision,
    shapeCount,
    unreadPinCount,
  };
};

const idsOf = (items: ReadonlyArray<{ readonly id: string }>): Set<string> =>
  new Set(items.map((item) => item.id));

const persistPad = (
  writer: StateWriter,
  sink: SinkRefValue,
  next: Pad,
  updatedAt: string,
): void => {
  writer.run(
    `
      INSERT INTO work_pad_meta(canvas_name, node_id, revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(canvas_name, node_id) DO UPDATE SET
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `,
    [sink.canvasName, sink.nodeId, next.revision, updatedAt],
  );

  const removeMissing = (table: string, keep: ReadonlySet<string>): void => {
    const existing = writer.all<StateRow & { readonly element_id: string }>(
      `SELECT element_id FROM ${table} WHERE canvas_name = ? AND node_id = ?`,
      [sink.canvasName, sink.nodeId],
    );
    for (const row of existing) {
      if (keep.has(row.element_id)) continue;
      writer.run(
        `DELETE FROM ${table} WHERE canvas_name = ? AND node_id = ? AND element_id = ?`,
        [sink.canvasName, sink.nodeId, row.element_id],
      );
    }
  };

  const existingPosts = writer.all<
    StateRow & { readonly pin_id: string; readonly post_id: string }
  >(
    `
      SELECT pin_id, post_id
      FROM work_pad_posts
      WHERE canvas_name = ? AND node_id = ?
    `,
    [sink.canvasName, sink.nodeId],
  );
  const nextPosts = new Set(
    next.pins.flatMap((pin) => pin.posts.map((post) => `${pin.id}\0${post.postId}`)),
  );
  for (const row of existingPosts) {
    if (nextPosts.has(`${row.pin_id}\0${row.post_id}`)) continue;
    writer.run(
      `
        DELETE FROM work_pad_posts
        WHERE canvas_name = ? AND node_id = ? AND pin_id = ? AND post_id = ?
      `,
      [sink.canvasName, sink.nodeId, row.pin_id, row.post_id],
    );
  }

  removeMissing("work_pad_images", idsOf(next.images));
  removeMissing("work_pad_shapes", idsOf(next.shapes));
  removeMissing("work_pad_edges", idsOf(next.edges));
  removeMissing("work_pad_inks", idsOf(next.inks));
  removeMissing("work_pad_pins", idsOf(next.pins));

  for (const image of next.images) {
    writer.run(
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
    writer.run(
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
    writer.run(
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
    writer.run(
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
    writer.run(
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
    pin.posts.forEach((post, position) => {
      writer.run(
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
    });
  }
};

/**
 * Assemble one sink's read model from already-typed lane values.
 *
 * There is deliberately no aggregate `Schema.decodeUnknownSync(WorkSnapshot)`
 * here. Every lane loader above returns a `*Value` this module constructed from
 * columns the write path already validated, so an aggregate decode on the read
 * path is a second full traversal of the same bytes that can only restate what
 * the loaders' types already say. Validation lives at ingress
 * (`Schema.decodeUnknownSync` in createTask / appendMessage / publishArtifact /
 * openTopic / appendPost / proposeTask, plus the SQLite CHECK domains on every
 * column those writes land in), not on every read of the world.
 */
const loadSnapshot = (
  reader: StateReader,
  sink: SinkRefValue,
): WorkSnapshotValue => {
  const pad = loadPadGlance(reader, sink);
  return {
    canvasName: sink.canvasName,
    nodeId: sink.nodeId,
    tasks: {
      // Soft-deleted tasks stay durable in work_tasks but leave the board /
      // CLI projection entirely (not merely the Closed lane).
      items: loadLaneTasks(reader, sink, "task").filter(
        (task) => task.state !== "archived",
      ),
      proposals: loadProposals(reader, sink),
    },
    requests: { items: loadLaneTasks(reader, sink, "request") },
    messages: { items: loadInbox(reader, sink) },
    artifacts: { items: loadArtifacts(reader, sink) },
    board: { topics: loadBoardTopics(reader, sink) },
    ...(pad === undefined ? {} : { pad }),
  };
};

export type CanvasWorkProjection = {
  readonly snapshots: ReadonlyArray<WorkSnapshotValue>;
  /**
   * Opaque monotonic invalidation identity for this canvas's runtime Work
   * projection, read as one PRIMARY KEY point lookup on
   * `work_canvas_revisions`.
   *
   * The counter is bumped by AFTER INSERT/UPDATE/DELETE triggers on every
   * durable table a snapshot projects from, so it cannot stay unchanged when a
   * projected task/request/message/artifact/topic/post/pad changes — including
   * the in-place UPDATEs (topic retitle, post_count, pad revision, read cursor)
   * that the retired per-canvas row count could not see. Its cost does not grow
   * with factory size, so a projection cache may key on it at any scale.
   */
  readonly workRevision: string;
};

const snapshotsForCanvas = (
  reader: StateReader,
  canvasName: string,
): ReadonlyArray<WorkSnapshotValue> => {
  const nodes = reader.all<StateRow & { readonly node_id: string }>(
    `
      SELECT node_id FROM work_tasks WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_task_proposals WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_requests WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_messages WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_artifacts WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_board_topics WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_pad_meta WHERE canvas_name = ?
      ORDER BY node_id
    `,
    [canvasName, canvasName, canvasName, canvasName, canvasName, canvasName, canvasName],
  );
  return nodes.map(({ node_id }) =>
    loadSnapshot(reader, { canvasName, nodeId: node_id }),
  );
};

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

const recentOpSummary = (row: RecentSeatOpRow): WorkSeatRecentOpValue["summary"] => {
  switch (row.operation) {
    case "proposal.create":
      return { kind: "proposal", proposalId: row.item_id };
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
  }
};

/**
 * Actor attribution comes only from the successful fact's explicit actor
 * field. A task claimant is deliberately not used for describe/transition:
 * operator IPC may issue the same mutation against that actor's task.
 */
const recentOpsForSeat = (
  reader: StateReader,
  input: {
    readonly canvasName: string;
    readonly actorSeatId: ActorSeatId;
    readonly limit?: number;
  },
): WorkSeatRecentOpsFeed => {
  const rows = reader.all<RecentSeatOpRow>(
    `
      WITH fact_rows AS (
        SELECT
          fact_event.operation,
          coalesce(command_event.origin_at, fact_event.origin_at) AS origin_at,
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
        LEFT JOIN work_events AS command_event
          ON fact.basis_kind = 'command'
          AND command_event.record_type = 'command'
          AND command_event.event_home = fact.basis_command_event_home
          AND command_event.entity_home = fact.basis_command_entity_home
          AND command_event.seq = fact.basis_command_seq
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

        UNION ALL

        SELECT
          fact_event.operation,
          coalesce(command_event.origin_at, fact_event.origin_at) AS origin_at,
          fact_event.origin_at AS applied_at,
          fact_event.received_at AS observed_at,
          fact_event.node_id AS target_node_id,
          'proposal' AS item_kind,
          fact_event.proposal_id AS item_id,
          json_extract(fact_event.record_json, '$.body') AS result_json,
          fact_event.event_home,
          fact_event.entity_home,
          fact_event.seq
        FROM work_proposal_events AS fact_event
        LEFT JOIN work_proposal_events AS command_event
          ON json_extract(fact_event.record_json, '$.basis.kind') = 'command'
          AND command_event.record_type = 'command'
          AND command_event.event_home = json_extract(
            fact_event.record_json,
            '$.basis.command.route.eventHome'
          )
          AND command_event.entity_home = json_extract(
            fact_event.record_json,
            '$.basis.command.route.entityHome'
          )
          AND command_event.seq = json_extract(
            fact_event.record_json,
            '$.basis.command.seq'
          )
        WHERE fact_event.record_type = 'fact'
          AND fact_event.operation = 'proposal.create'
          AND fact_event.canvas_name = ?
      ),
      attributed AS (
        SELECT
          *,
          CASE operation
            WHEN 'proposal.create' THEN
              json_extract(result_json, '$.proposal.proposedBy.seatId')
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
    [
      input.canvasName,
      input.canvasName,
      input.actorSeatId,
      normalizeRecentOpsLimit(input.limit),
    ],
  );
  const operations = rows.map((row) =>
    Schema.decodeUnknownSync(WorkSeatRecentOp, strictDecode)({
      operation: row.operation,
      originAt: row.origin_at,
      appliedAt: row.applied_at,
      targetNodeId: row.target_node_id,
      summary: recentOpSummary(row),
    }),
  );
  return {
    operations,
    lastOpAt: operations[0]?.appliedAt ?? null,
    coverage: WORK_SEAT_RECENT_OPS_COVERAGE,
  };
};

/**
 * Read the complete runtime Work overlay and its invalidation identity through
 * one caller-owned StateReader. CanvasesService uses this with the authorial
 * portfolio read so one CanvasReadResult never mixes SQLite snapshots.
 */
export const readCanvasWorkProjection = (
  reader: StateReader,
  canvasName: string,
): CanvasWorkProjection => ({
  // Revision first, snapshots second, inside the caller's single read: the
  // value witnesses the rows the snapshots are then built from, never a
  // later state.
  workRevision: readCanvasWorkRevision(reader, canvasName),
  snapshots: snapshotsForCanvas(reader, canvasName),
});

/**
 * The invalidation identity alone, without building any snapshot.
 *
 * One PRIMARY KEY point lookup on `work_canvas_revisions`. A projection cache
 * probes with this on every read and only pays `readCanvasWorkProjection` when
 * the value moved, so an unchanged world costs one statement instead of the
 * whole factory.
 *
 * A canvas with no counter row reads "0": no projected Work row has ever
 * existed for it, and the first one to appear bumps the row into existence.
 */
export const readCanvasWorkRevision = (
  reader: StateReader,
  canvasName: string,
): string =>
  reader.get<{ readonly work_revision: string }>(
    `
      SELECT CAST(revision AS TEXT) AS work_revision
      FROM work_canvas_revisions
      WHERE canvas_name = ?
    `,
    [canvasName],
  )?.work_revision ?? "0";

const currentIdentity = (
  row: Pick<
    IdentityRow,
    "fact_event_home" | "fact_entity_home" | "fact_seq"
  >,
): WorkRecordId =>
  recordId(
    row.fact_event_home as InstallationId,
    row.fact_entity_home as InstallationId,
    row.fact_seq,
  );

const selectTaskIdentity = (
  reader: StateReader,
  lane: "task" | "request",
  sink: SinkRefValue,
  itemId: string,
): IdentityRow | undefined => {
  const table = lane === "task" ? "work_tasks" : "work_requests";
  const id = lane === "task" ? "task_id" : "request_id";
  return reader.get<IdentityRow>(
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
    [sink.canvasName, sink.nodeId, itemId],
  );
};

const selectProposalIdentity = (
  reader: StateReader,
  sink: SinkRefValue,
  proposalId: string,
): ProposalIdentityRow | undefined =>
  reader.get<ProposalIdentityRow>(
    `
      SELECT
        entity_home,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        state
      FROM work_task_proposals
      WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
    `,
    [sink.canvasName, sink.nodeId, proposalId],
  );

const loadProposal = (
  reader: StateReader,
  sink: SinkRefValue,
  proposalId: string,
): {
  readonly row: ProposalIdentityRow;
  readonly proposal: TaskProposalValue;
} | undefined => {
  const row = selectProposalIdentity(reader, sink, proposalId);
  if (row === undefined) return undefined;
  const proposal = loadProposals(reader, sink).find(
    (candidate) => candidate.id === proposalId,
  );
  return proposal === undefined ? undefined : { row, proposal };
};

const loadTask = (
  reader: StateReader,
  lane: "task" | "request",
  sink: SinkRefValue,
  itemId: string,
): { readonly row: IdentityRow; readonly task: TaskValue } | undefined => {
  const row = selectTaskIdentity(reader, lane, sink, itemId);
  if (row === undefined) return undefined;
  const table = lane === "task" ? "work_tasks" : "work_requests";
  const id = lane === "task" ? "task_id" : "request_id";
  const detail = reader.get<TaskRow>(
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
    [sink.canvasName, sink.nodeId, itemId],
  );
  if (detail === undefined) return undefined;
  const dependsOn =
    lane === "task"
      ? loadTaskDependsOn(reader, sink, itemId)
      : undefined;
  const finish =
    lane === "task" ? loadTaskFinish(reader, sink, itemId) : undefined;
  return {
    row,
    task: taskFromRow(reader, sink, lane, detail, dependsOn, finish),
  };
};

const authorityError = (
  reason: WorkAuthorityError["reason"],
  message: string,
): WorkAuthorityError => WorkAuthorityError.make({ reason, message });

const assertArtifactTaskReference = (
  reader: StateReader,
  artifactSink: SinkRefValue,
  artifact: ArtifactValue,
  entityHome: InstallationId,
): void => {
  const taskRef = artifact.task;
  if (taskRef === undefined) return;
  if (taskRef.sink.canvasName !== artifactSink.canvasName) {
    throw authorityError(
      "target-mismatch",
      "artifact task reference must belong to the artifact canvas",
    );
  }
  const current = loadTask(
    reader,
    "task",
    taskRef.sink,
    taskRef.itemId,
  );
  if (current === undefined) {
    throw authorityError(
      "missing-entity",
      `artifact task "${taskRef.itemId}" does not exist`,
    );
  }
  if (current.row.entity_home !== entityHome) {
    throw authorityError(
      "authority-mismatch",
      `artifact task "${taskRef.itemId}" is homed on another installation`,
    );
  }
  if (current.task.claimedBy === undefined) {
    throw authorityError(
      "invalid-transition",
      `artifact task "${taskRef.itemId}" must be claimed before linkage`,
    );
  }
};

type ThreadMessageDestination = Exclude<
  MessageAppendDestination,
  { readonly kind: "mailbox" }
>;

const requireThreadParent = (
  reader: StateReader,
  sink: SinkRefValue,
  destination: ThreadMessageDestination,
  entityHome: InstallationId,
): IdentityRow => {
  const parent = selectTaskIdentity(
    reader,
    destination.kind,
    sink,
    destination.itemId,
  );
  if (parent === undefined) {
    throw authorityError(
      "missing-entity",
      `${destination.kind} "${destination.itemId}" does not exist at the message sink`,
    );
  }
  if (parent.entity_home !== entityHome) {
    throw authorityError(
      "authority-mismatch",
      `${destination.kind} message history must share its parent entity home`,
    );
  }
  return parent;
};

const assertMessageIdentityAvailable = (
  reader: StateReader,
  sink: SinkRefValue,
  messageId: string,
): void => {
  const existing = reader.get<StateRow>(
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
    [
      sink.canvasName,
      sink.nodeId,
      messageId,
      sink.canvasName,
      sink.nodeId,
      messageId,
    ],
  );
  if (existing !== undefined) {
    throw authorityError(
      "identity-conflict",
      `message "${messageId}" already exists at the sink`,
    );
  }
};

const replicationError = (
  senderInstallationId: InstallationId,
  reason: WorkReplicationError["reason"],
  message: string,
  seq?: LogicalSequenceValue,
): WorkReplicationError =>
  WorkReplicationError.make({
    reason,
    senderInstallationId,
    ...(seq === undefined ? {} : { sequence: seq }),
    message,
  });

const toRepositoryError = (
  operation: string,
  error: unknown,
): WorkRepositoryError =>
  error instanceof WorkRepositoryError
    ? error
    : WorkRepositoryError.make({
        operation,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });

const unwrapStateFailure = <E extends Error>(
  operation: string,
  error: unknown,
  DomainError: new (...args: never[]) => E,
): WorkRepositoryError | E => {
  const cause =
    typeof error === "object" &&
    error !== null &&
    "cause" in error
      ? (error as { readonly cause: unknown }).cause
      : undefined;
  return cause instanceof DomainError
    ? cause
    : toRepositoryError(operation, error);
};

const stateCause = (error: unknown): unknown =>
  typeof error === "object" &&
  error !== null &&
  "cause" in error
    ? (error as { readonly cause: unknown }).cause
    : undefined;

const allocateSequence = (
  writer: StateWriter,
  eventHome: InstallationId,
  entityHome: InstallationId,
): LogicalSequenceValue => {
  const current = writer.get<SequenceRow>(
    `
      SELECT last_seq
      FROM work_event_sequences
      WHERE event_home = ? AND entity_home = ?
    `,
    [eventHome, entityHome],
  )?.last_seq;
  const next = (current === undefined ? 1n : BigInt(current) + 1n).toString();
  writer.run(
    `
      INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
      VALUES (?, ?, ?)
      ON CONFLICT(event_home, entity_home) DO UPDATE SET
        last_seq = excluded.last_seq
    `,
    [eventHome, entityHome, next],
  );
  return sequence(next);
};

const rememberIncomingSequence = (
  writer: StateWriter,
  identity: WorkRecordId,
): void => {
  const current = writer.get<SequenceRow>(
    `
      SELECT last_seq
      FROM work_event_sequences
      WHERE event_home = ? AND entity_home = ?
    `,
    [identity.route.eventHome, identity.route.entityHome],
  )?.last_seq;
  if (current !== undefined && BigInt(current) >= BigInt(identity.seq)) return;
  writer.run(
    `
      INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
      VALUES (?, ?, ?)
      ON CONFLICT(event_home, entity_home) DO UPDATE SET
        last_seq = excluded.last_seq
    `,
    [
      identity.route.eventHome,
      identity.route.entityHome,
      identity.seq,
    ],
  );
};

const eventRow = (
  reader: StateReader,
  identity: WorkRecordId,
): EventRow | undefined =>
  reader.get<EventRow>(
    `
      SELECT
        event_home,
        entity_home,
        seq,
        protocol,
        record_type,
        item_kind,
        item_id,
        item_canvas_name,
        item_node_id,
        operation,
        content_sha256,
        origin_at,
        received_at
      FROM work_events
      WHERE event_home = ? AND entity_home = ? AND seq = ?
    `,
    [
      identity.route.eventHome,
      identity.route.entityHome,
      identity.seq,
    ],
  );

const durableRecordHash = (
  reader: StateReader,
  identity: WorkRecordId,
): string | undefined =>
  reader.get<{ readonly content_sha256: string }>(
    `
      SELECT content_sha256
      FROM (
        SELECT event_home, entity_home, seq, content_sha256
        FROM work_events
        UNION ALL
        SELECT event_home, entity_home, seq, content_sha256
        FROM work_proposal_events
      )
      WHERE event_home = ? AND entity_home = ? AND seq = ?
      LIMIT 1
    `,
    [
      identity.route.eventHome,
      identity.route.entityHome,
      identity.seq,
    ],
  )?.content_sha256;

const predecessorFromRow = (
  row: VariantRow,
): WorkRecordId | null =>
  row.predecessor_event_home === null ||
  row.predecessor_entity_home === null ||
  row.predecessor_seq === null
    ? null
    : recordId(
        row.predecessor_event_home as InstallationId,
        row.predecessor_entity_home as InstallationId,
        row.predecessor_seq,
      );

const factBasisFromRow = (row: FactVariantRow): FactBasisValue => {
  const candidate =
    row.basis_kind === "authorial-intent"
      ? {
          kind: "authorial-intent" as const,
          generation: row.basis_authorial_generation,
          contentSha256: row.basis_authorial_content_sha256,
        }
      : row.basis_kind === "projected-intent"
        ? {
            kind: "projected-intent" as const,
            generation: row.basis_projected_generation,
            contentSha256: row.basis_projected_content_sha256,
          }
        : {
            kind: "command" as const,
            command: recordId(
              row.basis_command_event_home as InstallationId,
              row.basis_command_entity_home as InstallationId,
              row.basis_command_seq!,
            ),
            commandSha256: row.basis_command_sha256,
          };
  return Schema.decodeUnknownSync(FactBasis, strictDecode)(candidate);
};

const loadRecord = (
  reader: StateReader,
  identity: WorkRecordId,
): WorkRecordValue | undefined => {
  const proposal = reader.get<StateRow & { readonly record_json: string }>(
    `
      SELECT record_json
      FROM work_proposal_events
      WHERE event_home = ? AND entity_home = ? AND seq = ?
    `,
    [
      identity.route.eventHome,
      identity.route.entityHome,
      identity.seq,
    ],
  );
  if (proposal !== undefined) {
    return Schema.decodeUnknownSync(WorkRecord, strictDecode)(
      parseJson(proposal.record_json),
    );
  }
  const common = eventRow(reader, identity);
  if (common === undefined) return undefined;
  const base = {
    protocol: WORK_PROTOCOL,
    id: identity,
    item: {
      kind: common.item_kind,
      itemId: common.item_id,
      sink: {
        canvasName: common.item_canvas_name,
        nodeId: common.item_node_id,
      },
    },
    operation: common.operation,
    contentSha256: common.content_sha256,
    originAt: common.origin_at,
  };
  if (common.record_type === "command") {
    const row = reader.get<VariantRow>(
      `
        SELECT
          predecessor_event_home,
          predecessor_entity_home,
          predecessor_seq,
          action_json AS body_json
        FROM work_commands
        WHERE event_home = ? AND entity_home = ? AND seq = ?
      `,
      [
        identity.route.eventHome,
        identity.route.entityHome,
        identity.seq,
      ],
    );
    if (row === undefined) {
      throw new Error("work command variant row is missing");
    }
    return Schema.decodeUnknownSync(WorkCommand, strictDecode)({
      ...base,
      recordType: "command",
      predecessor: predecessorFromRow(row),
      body: parseJson(row.body_json),
    });
  }
  if (common.record_type === "fact") {
    const row = reader.get<FactVariantRow>(
      `
        SELECT
          predecessor_event_home,
          predecessor_entity_home,
          predecessor_seq,
          basis_kind,
          basis_authorial_generation,
          basis_authorial_content_sha256,
          basis_projected_generation,
          basis_projected_content_sha256,
          basis_command_event_home,
          basis_command_entity_home,
          basis_command_seq,
          basis_command_sha256,
          result_json AS body_json
        FROM work_facts
        WHERE event_home = ? AND entity_home = ? AND seq = ?
      `,
      [
        identity.route.eventHome,
        identity.route.entityHome,
        identity.seq,
      ],
    );
    if (row === undefined) throw new Error("work fact variant row is missing");
    return Schema.decodeUnknownSync(WorkFact, strictDecode)({
      ...base,
      recordType: "fact",
      basis: factBasisFromRow(row),
      predecessor: predecessorFromRow(row),
      body: parseJson(row.body_json),
    });
  }
  const row = reader.get<DispositionRow>(
    `
      SELECT
        status,
        command_event_home,
        command_entity_home,
        command_seq,
        command_sha256,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        fact_sha256,
        rejection_reason,
        rejection_message
      FROM work_dispositions
      WHERE event_home = ? AND entity_home = ? AND seq = ?
    `,
    [
      identity.route.eventHome,
      identity.route.entityHome,
      identity.seq,
    ],
  );
  if (row === undefined) {
    throw new Error("work disposition variant row is missing");
  }
  const command = recordId(
    row.command_event_home as InstallationId,
    row.command_entity_home as InstallationId,
    row.command_seq,
  );
  const body =
    row.status === "applied"
      ? {
          status: "applied" as const,
          command,
          commandSha256: row.command_sha256,
          fact: recordId(
            row.fact_event_home as InstallationId,
            row.fact_entity_home as InstallationId,
            row.fact_seq!,
          ),
          factSha256: row.fact_sha256,
        }
      : {
          status: "rejected" as const,
          command,
          commandSha256: row.command_sha256,
          reason: row.rejection_reason,
          message: row.rejection_message,
        };
  return Schema.decodeUnknownSync(WorkRecord, strictDecode)({
    ...base,
    recordType: "disposition",
    body,
  });
};

const insertRecord = (
  writer: StateWriter,
  record: WorkRecordValue,
  receivedAt: DisplayTimestampValue,
): void => {
  if (record.item.kind === "proposal") {
    writer.run(
      `
        INSERT INTO work_proposal_events(
          event_home,
          entity_home,
          seq,
          record_type,
          canvas_name,
          node_id,
          proposal_id,
          operation,
          content_sha256,
          record_json,
          origin_at,
          received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        record.id.route.eventHome,
        record.id.route.entityHome,
        record.id.seq,
        record.recordType,
        record.item.sink.canvasName,
        record.item.sink.nodeId,
        record.item.itemId,
        record.operation,
        record.contentSha256,
        canonicalJson(record),
        record.originAt,
        receivedAt,
      ],
    );
    return;
  }
  writer.run(
    `
      INSERT INTO work_events(
        event_home,
        entity_home,
        seq,
        protocol,
        record_type,
        item_kind,
        item_id,
        item_canvas_name,
        item_node_id,
        operation,
        content_sha256,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      record.id.route.eventHome,
      record.id.route.entityHome,
      record.id.seq,
      record.protocol,
      record.recordType,
      record.item.kind,
      record.item.itemId,
      record.item.sink.canvasName,
      record.item.sink.nodeId,
      record.operation,
      record.contentSha256,
      record.originAt,
      receivedAt,
    ],
  );
  if (record.recordType === "command") {
    writer.run(
      `
        INSERT INTO work_commands(
          event_home,
          entity_home,
          seq,
          predecessor_event_home,
          predecessor_entity_home,
          predecessor_seq,
          action_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        record.id.route.eventHome,
        record.id.route.entityHome,
        record.id.seq,
        record.predecessor?.route.eventHome ?? null,
        record.predecessor?.route.entityHome ?? null,
        record.predecessor?.seq ?? null,
        canonicalJson(record.body),
      ],
    );
    return;
  }
  if (record.recordType === "fact") {
    writer.run(
      `
        INSERT INTO work_facts(
          event_home,
          entity_home,
          seq,
          predecessor_event_home,
          predecessor_entity_home,
          predecessor_seq,
          basis_kind,
          basis_authorial_generation,
          basis_authorial_content_sha256,
          basis_projected_generation,
          basis_projected_content_sha256,
          basis_command_event_home,
          basis_command_entity_home,
          basis_command_seq,
          basis_command_sha256,
          result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        record.id.route.eventHome,
        record.id.route.entityHome,
        record.id.seq,
        record.predecessor?.route.eventHome ?? null,
        record.predecessor?.route.entityHome ?? null,
        record.predecessor?.seq ?? null,
        record.basis.kind,
        record.basis.kind === "authorial-intent"
          ? record.basis.generation
          : null,
        record.basis.kind === "authorial-intent"
          ? record.basis.contentSha256
          : null,
        record.basis.kind === "projected-intent"
          ? record.basis.generation
          : null,
        record.basis.kind === "projected-intent"
          ? record.basis.contentSha256
          : null,
        record.basis.kind === "command"
          ? record.basis.command.route.eventHome
          : null,
        record.basis.kind === "command"
          ? record.basis.command.route.entityHome
          : null,
        record.basis.kind === "command"
          ? record.basis.command.seq
          : null,
        record.basis.kind === "command"
          ? record.basis.commandSha256
          : null,
        canonicalJson(record.body),
      ],
    );
    return;
  }
  writer.run(
    `
      INSERT INTO work_dispositions(
        event_home,
        entity_home,
        seq,
        status,
        command_event_home,
        command_entity_home,
        command_seq,
        command_sha256,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        fact_sha256,
        rejection_reason,
        rejection_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      record.id.route.eventHome,
      record.id.route.entityHome,
      record.id.seq,
      record.body.status,
      record.body.command.route.eventHome,
      record.body.command.route.entityHome,
      record.body.command.seq,
      record.body.commandSha256,
      record.body.status === "applied"
        ? record.body.fact.route.eventHome
        : null,
      record.body.status === "applied"
        ? record.body.fact.route.entityHome
        : null,
      record.body.status === "applied" ? record.body.fact.seq : null,
      record.body.status === "applied" ? record.body.factSha256 : null,
      record.body.status === "rejected" ? record.body.reason : null,
      record.body.status === "rejected" ? record.body.message : null,
    ],
  );
};

const insertPending = (
  writer: StateWriter,
  command: WorkCommandValue,
  createdAt: DisplayTimestampValue,
): void => {
  if (command.item.kind === "proposal") {
    writer.run(
      `
        INSERT INTO work_pending_proposal_commands(
          event_home,
          entity_home,
          seq,
          operation,
          canvas_name,
          node_id,
          proposal_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        command.id.route.eventHome,
        command.id.route.entityHome,
        command.id.seq,
        command.operation,
        command.item.sink.canvasName,
        command.item.sink.nodeId,
        command.item.itemId,
        createdAt,
      ],
    );
    return;
  }
  writer.run(
    `
      INSERT INTO work_pending_commands(
        event_home,
        entity_home,
        seq,
        operation,
        item_kind,
        item_canvas_name,
        item_node_id,
        item_id,
        claim_actor_seat_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      command.id.route.eventHome,
      command.id.route.entityHome,
      command.id.seq,
      command.operation,
      command.item.kind,
      command.item.sink.canvasName,
      command.item.sink.nodeId,
      command.item.itemId,
      command.body.operation === "task.claim"
        ? command.body.actor.seatId
        : null,
      createdAt,
    ],
  );
};

const writeTaskMessages = (
  writer: StateWriter,
  lane: "task" | "request",
  sink: SinkRefValue,
  task: TaskValue,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  writer.run(
    `
      DELETE FROM work_task_messages
      WHERE canvas_name = ?
        AND node_id = ?
        AND parent_lane = ?
        AND item_id = ?
    `,
    [sink.canvasName, sink.nodeId, lane, task.id],
  );
  task.history.forEach((message, position) => {
    writer.run(
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
  });
};

const writeTransition = (
  writer: StateWriter,
  lane: "task" | "request",
  sink: SinkRefValue,
  task: TaskValue,
  fromState: TaskState | null,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  const ordinal = Number(
    writer.get<StateRow & { readonly next_ordinal: number }>(
      `
        SELECT coalesce(max(ordinal) + 1, 0) AS next_ordinal
        FROM work_task_transitions
        WHERE canvas_name = ?
          AND node_id = ?
          AND item_id = ?
          AND lane = ?
      `,
      [sink.canvasName, sink.nodeId, task.id, lane],
    )?.next_ordinal ?? 0,
  );
  writer.run(
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
};

const writeTask = (
  writer: StateWriter,
  lane: "task" | "request",
  sink: SinkRefValue,
  task: TaskValue,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  const previous = selectTaskIdentity(writer, lane, sink, task.id);
  const table = lane === "task" ? "work_tasks" : "work_requests";
  const id = lane === "task" ? "task_id" : "request_id";
  const createdAt =
    writer.get<StateRow & { readonly created_at: string }>(
      `
        SELECT created_at
        FROM ${table}
        WHERE canvas_name = ? AND node_id = ? AND ${id} = ?
      `,
      [sink.canvasName, sink.nodeId, task.id],
    )?.created_at ?? fact.originAt;
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
    task.artifactIds === undefined
      ? null
      : canonicalJson(task.artifactIds),
    task.metadata === undefined ? null : canonicalJson(task.metadata),
    task.reason ?? null,
    task.response ?? null,
    createdAt,
    fact.originAt,
    fact.originAt,
    receivedAt,
  ];
  writer.run(
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
    writeTaskDependsOn(writer, sink, task.id, task.dependsOn);
    writeTaskFinish(writer, sink, task);
  }
  writeTaskMessages(writer, lane, sink, task, fact, receivedAt);
  writeTransition(
    writer,
    lane,
    sink,
    task,
    previous?.state ?? null,
    fact,
    receivedAt,
  );
};

const writeThreadMessage = (
  writer: StateWriter,
  sink: SinkRefValue,
  destination: ThreadMessageDestination,
  message: MessageValue,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  const position = Number(
    writer.get<StateRow & { readonly next_position: number }>(
      `
        SELECT coalesce(max(position) + 1, 0) AS next_position
        FROM work_task_messages
        WHERE canvas_name = ?
          AND node_id = ?
          AND parent_lane = ?
          AND item_id = ?
      `,
      [
        sink.canvasName,
        sink.nodeId,
        destination.kind,
        destination.itemId,
      ],
    )?.next_position ?? 0,
  );
  writer.run(
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
      message.metadata === undefined
        ? null
        : canonicalJson(message.metadata),
      fact.originAt,
      receivedAt,
    ],
  );
};

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
 * `fromSeat` is the sender node identity the renderer trusts (actor-ledger,
 * edge-sparks). The durable sender is `sentBy` (the actor_seat_id column);
 * when a caller supplies a `fromSeat` that disagrees with the durable
 * sender's node, admission rebinds it to `sentBy.nodeId`. The msg.send /
 * msg.reply control path already stamps `fromSeat = caller.nodeId`, which
 * resolves to the same node as `sentBy` — the rebind is a no-op there.
 */
const admitMailboxMessage = (
  message: MessageValue,
  sentBy: ActorRef,
): MessageValue => {
  const metadata = message.metadata;
  if (metadata === undefined) return message;
  const hasReserved =
    Object.prototype.hasOwnProperty.call(metadata, "deliveredAt") ||
    Object.prototype.hasOwnProperty.call(metadata, "readAt") ||
    Object.prototype.hasOwnProperty.call(metadata, "reactions");
  const forgedFromSeat =
    Object.prototype.hasOwnProperty.call(metadata, "fromSeat") &&
    metadata.fromSeat !== sentBy.nodeId;
  if (!hasReserved && !forgedFromSeat) return message;
  const {
    deliveredAt: _deliveredAt,
    readAt: _readAt,
    reactions: _reactions,
    ...rest
  } = metadata;
  const admitted = {
    ...rest,
    ...(forgedFromSeat ? { fromSeat: sentBy.nodeId } : {}),
  };
  if (Object.keys(admitted).length === 0) {
    const { metadata: _metadata, ...withoutMetadata } = message;
    return withoutMetadata;
  }
  return { ...message, metadata: admitted };
};

const writeInboxMessage = (
  writer: StateWriter,
  sink: SinkRefValue,
  incoming: MessageValue,
  sentBy: ActorRef,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  const message = admitMailboxMessage(incoming, sentBy);
  const position = Number(
    writer.get<StateRow & { readonly next_position: number }>(
      `
        SELECT coalesce(max(position) + 1, 0) AS next_position
        FROM work_messages
        WHERE canvas_name = ? AND node_id = ?
      `,
      [sink.canvasName, sink.nodeId],
    )?.next_position ?? 0,
  );
  writer.run(
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
      message.metadata === undefined
        ? null
        : canonicalJson(message.metadata),
      fact.originAt,
      receivedAt,
    ],
  );
};

const writeArtifact = (
  writer: StateWriter,
  sink: SinkRefValue,
  artifact: ArtifactValue,
  actorSeatId: ActorSeatId,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  writer.run(
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
      artifact.task === undefined
        ? null
        : fact.id.route.entityHome,
      artifact.metadata === undefined
        ? null
        : canonicalJson(artifact.metadata),
      fact.originAt,
      receivedAt,
    ],
  );
};

const writeDelivery = (
  writer: StateWriter,
  receipt: DeliveryReceipt,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  writer.run(
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
};

const writeProposal = (
  writer: StateWriter,
  sink: SinkRefValue,
  proposal: TaskProposalValue,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  writer.run(
    `
      INSERT INTO work_task_proposals(
        canvas_name,
        node_id,
        proposal_id,
        entity_home,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        state,
        brief_json,
        proposer_seat_id,
        proposer_canvas_name,
        proposer_node_id,
        approved_task_id,
        metadata_json,
        reason,
        created_at,
        updated_at,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canvas_name, node_id, proposal_id) DO UPDATE SET
        fact_event_home = excluded.fact_event_home,
        fact_entity_home = excluded.fact_entity_home,
        fact_seq = excluded.fact_seq,
        state = excluded.state,
        approved_task_id = excluded.approved_task_id,
        updated_at = excluded.updated_at,
        origin_at = excluded.origin_at,
        received_at = excluded.received_at
    `,
    [
      sink.canvasName,
      sink.nodeId,
      proposal.id,
      fact.id.route.entityHome,
      fact.id.route.eventHome,
      fact.id.route.entityHome,
      fact.id.seq,
      proposal.state,
      canonicalJson(proposal.brief),
      proposal.proposedBy.seatId,
      proposal.proposedBy.canvasName,
      proposal.proposedBy.nodeId,
      proposal.approvedTaskId ?? null,
      proposal.metadata === undefined
        ? null
        : canonicalJson(proposal.metadata),
      proposal.reason ?? null,
      fact.originAt,
      fact.originAt,
      fact.originAt,
      receivedAt,
    ],
  );
  writeProposalPlanning(writer, sink, proposal);
};

const materializeFact = (
  writer: StateWriter,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  switch (fact.body.operation) {
    case "proposal.create":
      writeProposal(
        writer,
        fact.item.sink,
        fact.body.proposal,
        fact,
        receivedAt,
      );
      return;
    case "proposal.approve":
    case "proposal.reject":
      writeProposal(
        writer,
        fact.item.sink,
        fact.body.proposal,
        fact,
        receivedAt,
      );
      return;
    case "task.create":
    case "task.describe":
    case "task.transition":
    case "task.claim":
      writeTask(
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
      writeTask(
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
        writeInboxMessage(
          writer,
          fact.item.sink,
          fact.body.message,
          fact.body.sentBy,
          fact,
          receivedAt,
        );
      } else {
        writeThreadMessage(
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
      writeArtifact(
        writer,
        fact.item.sink,
        fact.body.artifact,
        fact.body.publishedBy.seatId,
        fact,
        receivedAt,
      );
      return;
    case "delivery.accepted":
      writeDelivery(writer, fact.body.receipt, fact, receivedAt);
      return;
    case "board.topic.create": {
      const createdBy = fact.body.createdBy;
      const topic = topicWithBoundAuthors(fact.body.topic, createdBy);
      writer.run(
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
        const tags =
          post.tags && post.tags.length > 0 ? post.tags : undefined;
        writer.run(
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
      const current = loadPad(writer, fact.item.sink);
      const applied = applyPatches(current, fact.body.patches);
      if (Result.isFailure(applied)) {
        throw authorityError(
          "invalid-transition",
          applied.failure.message,
        );
      }
      persistPad(writer, fact.item.sink, applied.success, receivedAt);
      return;
    }
    case "board.post.append": {
      // Position authority is the fact body (assigned at apply/mint time).
      const post = fact.body.post;
      const createdBy = fact.body.createdBy;
      const tags =
        post.tags && post.tags.length > 0 ? post.tags : undefined;
      const inserted = writer.run(
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
      );
      if (Number(inserted.changes) > 0) {
        writer.run(
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
};

const activeTaskForActor = (
  reader: StateReader,
  actorSeatId: ActorSeatId,
): string | undefined =>
  reader.get<StateRow & { readonly task_id: string }>(
    `
      SELECT task_id
      FROM work_tasks
      WHERE actor_seat_id = ?
        AND state IN ('working', 'input-required', 'auth-required')
      LIMIT 1
    `,
    [actorSeatId],
  )?.task_id;

const pendingClaimForActor = (
  reader: StateReader,
  actorSeatId: ActorSeatId,
): string | undefined =>
  reader.get<StateRow & { readonly item_id: string }>(
    `
      SELECT item_id
      FROM work_pending_commands
      WHERE operation = 'task.claim'
        AND claim_actor_seat_id = ?
        AND resolution_event_home IS NULL
      LIMIT 1
    `,
    [actorSeatId],
  )?.item_id;

const assertActorAvailable = (
  reader: StateReader,
  actorSeatId: ActorSeatId,
  exceptTaskId?: string,
): void => {
  const active = activeTaskForActor(reader, actorSeatId);
  if (active !== undefined && active !== exceptTaskId) {
    throw authorityError(
      "claim-contention",
      `actor seat "${actorSeatId}" already owns active task "${active}"`,
    );
  }
  const pending = pendingClaimForActor(reader, actorSeatId);
  if (pending !== undefined && pending !== exceptTaskId) {
    throw authorityError(
      "claim-contention",
      `actor seat "${actorSeatId}" already has pending claim "${pending}"`,
    );
  }
};

const assertCurrentPredecessor = (
  current:
    | Pick<
        IdentityRow,
        "fact_event_home" | "fact_entity_home" | "fact_seq"
      >
    | undefined,
  predecessor: WorkRecordId | null,
  itemLabel: string,
): void => {
  if (current === undefined) {
    throw authorityError("missing-entity", `${itemLabel} does not exist`);
  }
  if (!sameId(currentIdentity(current), predecessor)) {
    throw authorityError(
      "causal-conflict",
      `${itemLabel} predecessor does not match its current fact`,
    );
  }
};

const makeFact = (
  writer: StateWriter,
  localInstallationId: InstallationId,
  itemRef: WorkItemRef,
  operation: WorkOperation,
  predecessor: WorkRecordId | null,
  basis: FactBasisValue,
  body: WorkResult,
  originAt: DisplayTimestampValue,
): WorkFactValue => {
  const seq = allocateSequence(
    writer,
    localInstallationId,
    localInstallationId,
  );
  return recordWithHash(
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
  ) as WorkFactValue;
};

const makeCommand = (
  writer: StateWriter,
  localInstallationId: InstallationId,
  targetInstallationId: InstallationId,
  itemRef: WorkItemRef,
  predecessor: WorkRecordId | null,
  action: WorkActionValue,
  originAt: DisplayTimestampValue,
): WorkCommandValue => {
  const seq = allocateSequence(
    writer,
    localInstallationId,
    targetInstallationId,
  );
  return recordWithHash(
    {
      protocol: WORK_PROTOCOL,
      id: {
        route: {
          eventHome: localInstallationId,
          entityHome: targetInstallationId,
        },
        seq,
      },
      recordType: "command",
      item: itemRef,
      operation: action.operation,
      predecessor,
      body: action,
    },
    originAt,
  ) as WorkCommandValue;
};

const makeDisposition = (
  writer: StateWriter,
  localInstallationId: InstallationId,
  command: WorkCommandValue,
  outcome:
    | { readonly _tag: "applied"; readonly fact: WorkFactValue }
    | {
        readonly _tag: "rejected";
        readonly reason: WorkRejectionReason;
        readonly message: string;
      },
  originAt: DisplayTimestampValue,
): WorkDispositionValue => {
  const seq = allocateSequence(
    writer,
    localInstallationId,
    localInstallationId,
  );
  const body =
    outcome._tag === "applied"
      ? {
          status: "applied" as const,
          command: command.id,
          commandSha256: command.contentSha256,
          fact: outcome.fact.id,
          factSha256: outcome.fact.contentSha256,
        }
      : {
          status: "rejected" as const,
          command: command.id,
          commandSha256: command.contentSha256,
          reason: outcome.reason,
          message: boundedDiagnostic(outcome.message),
        };
  return recordWithHash(
    {
      protocol: WORK_PROTOCOL,
      id: {
        route: {
          eventHome: localInstallationId,
          entityHome: localInstallationId,
        },
        seq,
      },
      recordType: "disposition",
      item: command.item,
      operation: command.operation,
      body,
    },
    originAt,
  ) as WorkDispositionValue;
};

const commitLocalFact = <A>(
  writer: StateWriter,
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
): LocalFactResult<A> => {
  const authority = canonicalLocalWorkAuthority(writer);
  if (authority.installationId !== input.localInstallationId) {
    throw authorityError(
      "authority-mismatch",
      "local Work authority changed inside its transaction",
    );
  }
  // Every locally minted fact is a new durable write. This catches legacy
  // RawPart values copied forward by claim/transition/approval paths even
  // when the incoming command itself did not carry a new message payload.
  assertCurrentIntentBasis(writer, authority, input.sink, input.basis);
  const fact = makeFact(
    writer,
    input.localInstallationId,
    input.item,
    input.operation,
    input.predecessor,
    input.basis,
    input.body,
    input.originAt,
  );
  insertRecord(writer, fact, input.receivedAt);
  materializeFact(writer, fact, input.receivedAt);
  return {
    value: input.value,
    record: fact,
    snapshot: loadSnapshot(writer, input.sink),
  };
};

const predecessorForAction = (
  writer: StateWriter,
  commandItem: WorkItemRef,
  action: Exclude<WorkActionValue, { readonly operation: "task.claim" }>,
): WorkRecordId | null => {
  switch (action.operation) {
    case "proposal.create":
    case "task.create":
    case "request.create":
    case "message.append":
    case "artifact.publish":
    case "delivery.accepted":
    case "board.topic.create":
    case "board.post.append":
    case "pad.patch":
      return null;
    case "proposal.approve":
    case "proposal.reject": {
      const current = selectProposalIdentity(
        writer,
        commandItem.sink,
        commandItem.itemId,
      );
      if (current === undefined) {
        throw authorityError(
          "missing-entity",
          `proposal "${commandItem.itemId}" does not exist`,
        );
      }
      return currentIdentity(current);
    }
    case "task.describe":
    case "task.transition": {
      const current = selectTaskIdentity(
        writer,
        "task",
        commandItem.sink,
        commandItem.itemId,
      );
      if (current === undefined) {
        throw authorityError(
          "missing-entity",
          `task "${commandItem.itemId}" does not exist`,
        );
      }
      return currentIdentity(current);
    }
    case "request.resolve": {
      const current = selectTaskIdentity(
        writer,
        "request",
        commandItem.sink,
        commandItem.itemId,
      );
      if (current === undefined) {
        throw authorityError(
          "missing-entity",
          `request "${commandItem.itemId}" does not exist`,
        );
      }
      return currentIdentity(current);
    }
  }
};

const resultForCommand = (
  writer: StateWriter,
  command: WorkCommandValue,
): {
  readonly body: WorkResult;
} => {
  const action = command.body;
  switch (action.operation) {
    case "proposal.create": {
      if (
        selectProposalIdentity(
          writer,
          command.item.sink,
          command.item.itemId,
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `proposal "${command.item.itemId}" already exists`,
        );
      }
      return {
        body: {
          operation: "proposal.create",
          proposal: action.proposal,
        },
      };
    }
    case "proposal.approve": {
      const current = loadProposal(
        writer,
        command.item.sink,
        action.proposalId,
      );
      assertCurrentPredecessor(
        current?.row,
        command.predecessor,
        `proposal "${action.proposalId}"`,
      );
      if (current!.proposal.state !== "pending") {
        throw authorityError(
          "invalid-transition",
          `proposal "${action.proposalId}" is not pending`,
        );
      }
      if (
        action.task.state !== "submitted" ||
        action.task.claimedBy !== undefined ||
        selectTaskIdentity(
          writer,
          "task",
          command.item.sink,
          action.task.id,
        ) !== undefined
      ) {
        throw authorityError(
          "invalid-transition",
          "proposal approval must mint one new submitted unclaimed task",
        );
      }
      return {
        body: {
          operation: "proposal.approve",
          proposal: {
            ...current!.proposal,
            state: "approved",
            approvedTaskId: action.task.id,
          },
          task: action.task,
        },
      };
    }
    case "proposal.reject": {
      const current = loadProposal(
        writer,
        command.item.sink,
        action.proposalId,
      );
      assertCurrentPredecessor(
        current?.row,
        command.predecessor,
        `proposal "${action.proposalId}"`,
      );
      if (current!.proposal.state !== "pending") {
        throw authorityError(
          "invalid-transition",
          `proposal "${action.proposalId}" is not pending`,
        );
      }
      return {
        body: {
          operation: "proposal.reject",
          proposal: {
            ...current!.proposal,
            state: "rejected",
          },
        },
      };
    }
    case "task.create": {
      if (
        selectTaskIdentity(
          writer,
          "task",
          command.item.sink,
          command.item.itemId,
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `task "${command.item.itemId}" already exists`,
        );
      }
      return {
        body: { operation: "task.create", task: action.task },
      };
    }
    case "task.describe": {
      const current = loadTask(
        writer,
        "task",
        command.item.sink,
        action.taskId,
      );
      assertCurrentPredecessor(
        current?.row,
        command.predecessor,
        `task "${action.taskId}"`,
      );
      if (
        current!.task.state === "completed" ||
        current!.task.state === "canceled" ||
        current!.task.state === "failed" ||
        current!.task.state === "rejected"
      ) {
        throw authorityError(
          "invalid-transition",
          `cannot describe terminal task "${action.taskId}"`,
        );
      }
      return {
        body: {
          operation: "task.describe",
          task: {
            ...current!.task,
            history: [
              action.message,
              ...current!.task.history.slice(1),
            ],
          },
        },
      };
    }
    case "task.transition": {
      const current = loadTask(
        writer,
        "task",
        command.item.sink,
        action.taskId,
      );
      assertCurrentPredecessor(
        current?.row,
        command.predecessor,
        `task "${action.taskId}"`,
      );
      const { installationId: localInstallationId } =
        canonicalLocalWorkAuthority(writer);
      if (current!.row.entity_home !== localInstallationId) {
        throw authorityError(
          "authority-mismatch",
          "local installation does not own this task",
        );
      }
      if (!canTransitionTaskState(current!.task.state, action.state)) {
        throw authorityError(
          "invalid-transition",
          `cannot transition task "${action.taskId}" from ${current!.task.state} to ${action.state}`,
        );
      }
      if (
        current!.task.state === "completed" &&
        action.state === "submitted" &&
        !hasNonEmptyTaskTransitionMessage(action.message)
      ) {
        throw authorityError(
          "invalid-transition",
          "a QA rejection comment is required before returning a completed task to Queue",
        );
      }
      const evidence =
        action.state === "completed"
          ? normalizeCompletionEvidence(action.completionEvidence)
          : undefined;
      if (action.state === "completed") {
        const gate = evaluateFinishCriteria({
          task: current!.task,
          taskNodeId: command.item.sink.nodeId,
          canvasName: command.item.sink.canvasName,
          evidence,
          artifactsByNode: loadAllArtifactsByNode(
            writer,
            command.item.sink.canvasName,
          ),
        });
        if (gate !== undefined) {
          throw authorityError(
            "invalid-transition",
            `finish criteria unsatisfied [${gate.missing}]: ${gate.message} (next: ${gate.next_step})`,
          );
        }
      }
      {
        const base = taskWithTransitionState(current!.task, action.state);
        const withoutEvidence =
          action.state === "completed"
            ? base
            : (() => {
                const { completionEvidence: _c, ...rest } = base;
                return rest;
              })();
        return {
          body: {
            operation: "task.transition",
            task: {
              ...withoutEvidence,
              history:
                action.message === undefined
                  ? current!.task.history
                  : [...current!.task.history, action.message],
              ...(action.state === "completed" && evidence !== undefined
                ? { completionEvidence: evidence }
                : {}),
            },
          },
        };
      }
    }
    case "task.claim": {
      if (
        command.id.route.entityHome !== action.targetHome ||
        action.targetHome === action.sourceQueueHome ||
        action.sourceQueueHome !== command.id.route.eventHome
      ) {
        throw authorityError(
          "target-mismatch",
          "task claim command homes are incoherent",
        );
      }
      if (
        selectTaskIdentity(
          writer,
          "task",
          action.sink,
          action.sourceTask.id,
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `task "${action.sourceTask.id}" already exists at target`,
        );
      }
      assertActorAvailable(writer, action.actor.seatId);
      const adopted: TaskValue = Schema.decodeUnknownSync(Task, strictDecode)({
        ...action.sourceTask,
        state: "working",
        claimedBy: action.actor.seatId,
      });
      return {
        body: {
          operation: "task.claim",
          task: adopted,
          claimedBy: action.actor,
          previousHome: action.sourceQueueHome,
        },
      };
    }
    case "request.create": {
      if (
        selectTaskIdentity(
          writer,
          "request",
          command.item.sink,
          command.item.itemId,
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `request "${command.item.itemId}" already exists`,
        );
      }
      return {
        body: {
          operation: "request.create",
          request: action.request,
        },
      };
    }
    case "request.resolve": {
      const current = loadTask(
        writer,
        "request",
        command.item.sink,
        action.requestId,
      );
      assertCurrentPredecessor(
        current?.row,
        command.predecessor,
        `request "${action.requestId}"`,
      );
      if (
        !canTransitionTaskState(
          current!.task.state,
          action.disposition,
        )
      ) {
        throw authorityError(
          "invalid-transition",
          `cannot resolve request "${action.requestId}" from ${current!.task.state}`,
        );
      }
      return {
        body: {
          operation: "request.resolve",
          request: {
            ...current!.task,
            state: action.disposition,
            response: action.response,
            history:
              action.message === undefined
                ? current!.task.history
                : [...current!.task.history, action.message],
          },
        },
      };
    }
    case "message.append": {
      const authority = canonicalLocalWorkAuthority(writer);
      if (action.destination.kind === "mailbox") {
        if (authority.role !== "command-center") {
          throw authorityError(
            "authority-mismatch",
            "actor mailbox messages are Command Center-homed",
          );
        }
      } else {
        requireThreadParent(
          writer,
          command.item.sink,
          action.destination,
          command.id.route.entityHome,
        );
      }
      assertMessageIdentityAvailable(
        writer,
        command.item.sink,
        action.message.messageId,
      );
      return {
        body: {
          operation: "message.append",
          message: action.message,
          sentBy: action.sentBy,
          destination: action.destination,
        },
      };
    }
    case "artifact.publish": {
      assertArtifactTaskReference(
        writer,
        command.item.sink,
        action.artifact,
        command.id.route.entityHome,
      );
      const exists = writer.get<StateRow>(
        `
          SELECT 1
          FROM work_artifacts
          WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
        `,
        [
          command.item.sink.canvasName,
          command.item.sink.nodeId,
          action.artifact.artifactId,
        ],
      );
      if (exists !== undefined) {
        throw authorityError(
          "identity-conflict",
          `artifact "${action.artifact.artifactId}" already exists`,
        );
      }
      return {
        body: {
          operation: "artifact.publish",
          artifact: action.artifact,
          publishedBy: action.publishedBy,
        },
      };
    }
    case "board.topic.create": {
      const exists = writer.get<StateRow>(
        `
          SELECT 1 FROM work_board_topics
          WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
        `,
        [
          command.item.sink.canvasName,
          command.item.sink.nodeId,
          action.topic.topicId,
        ],
      );
      if (exists !== undefined) {
        throw authorityError(
          "identity-conflict",
          `topic "${action.topic.topicId}" already exists`,
        );
      }
      const topic = topicWithBoundAuthors(action.topic, action.createdBy);
      return {
        body: {
          operation: "board.topic.create",
          topic,
          createdBy: action.createdBy,
        },
      };
    }
    case "board.post.append": {
      const topic = writer.get<StateRow & { readonly state: string }>(
        `
          SELECT state FROM work_board_topics
          WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
        `,
        [
          command.item.sink.canvasName,
          command.item.sink.nodeId,
          action.post.topicId,
        ],
      );
      if (topic === undefined) {
        throw authorityError(
          "missing-entity",
          `topic "${action.post.topicId}" does not exist`,
        );
      }
      if (topic.state === "archived") {
        throw authorityError(
          "invalid-transition",
          `topic "${action.post.topicId}" is archived`,
        );
      }
      if (
        writer.get<StateRow>(
          `
            SELECT 1 FROM work_board_posts
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ? AND post_id = ?
          `,
          [
            command.item.sink.canvasName,
            command.item.sink.nodeId,
            action.post.topicId,
            action.post.postId,
          ],
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `post "${action.post.postId}" already exists`,
        );
      }
      // Authority assigns position; command body may carry a client placeholder.
      const maxPos = writer.get<StateRow & { readonly m: number | null }>(
        `
          SELECT MAX(position) AS m FROM work_board_posts
          WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
        `,
        [
          command.item.sink.canvasName,
          command.item.sink.nodeId,
          action.post.topicId,
        ],
      );
      const position =
        typeof maxPos?.m === "number" && Number.isFinite(maxPos.m)
          ? maxPos.m + 1
          : 0;
      const post = {
        ...action.post,
        author: action.createdBy,
        position,
      };
      return {
        body: {
          operation: "board.post.append",
          post,
          createdBy: action.createdBy,
        },
      };
    }
    case "pad.patch": {
      const patches = stampPadPatchAuthors(action.patches, action.author);
      assertPadPatchRules(writer, command.item.sink, action.author, patches);
      const current = loadPad(writer, command.item.sink);
      const applied = applyPatches(current, patches);
      if (Result.isFailure(applied)) {
        throw authorityError("invalid-transition", applied.failure.message);
      }
      return {
        body: {
          operation: "pad.patch",
          patchId: action.patchId,
          patches: [...patches],
          author: action.author,
          revision: applied.success.revision,
        },
      };
    }
    case "delivery.accepted": {
      const receipt = action.receipt;
      const exists = writer.get<StateRow>(
        `
          SELECT 1
          FROM work_delivery_receipts
          WHERE delivered_canvas_name = ?
            AND delivered_node_id = ?
            AND delivery_id = ?
        `,
        [
          receipt.deliveredItem.sink.canvasName,
          receipt.deliveredItem.sink.nodeId,
          receipt.deliveryId,
        ],
      );
      if (exists !== undefined) {
        throw authorityError(
          "identity-conflict",
          `delivery "${receipt.deliveryId}" already exists`,
        );
      }
      return {
        body: {
          operation: "delivery.accepted",
          receipt,
        },
      };
    }
  }
};

const priorCommandOutcome = (
  reader: StateReader,
  command: WorkCommandValue,
): ReadonlyArray<WorkRecordValue> => {
  if (command.item.kind === "proposal") {
    const rows = reader
      .all<StateRow & { readonly record_json: string }>(
        `
          SELECT record_json
          FROM work_proposal_events
          WHERE (
            record_type = 'fact'
            AND json_extract(
              record_json,
              '$.basis.command.route.eventHome'
            ) = ?
            AND json_extract(
              record_json,
              '$.basis.command.route.entityHome'
            ) = ?
            AND json_extract(record_json, '$.basis.command.seq') = ?
          ) OR (
            record_type = 'disposition'
            AND json_extract(
              record_json,
              '$.body.command.route.eventHome'
            ) = ?
            AND json_extract(
              record_json,
              '$.body.command.route.entityHome'
            ) = ?
            AND json_extract(record_json, '$.body.command.seq') = ?
          )
          ORDER BY length(seq), seq
        `,
        [
          command.id.route.eventHome,
          command.id.route.entityHome,
          command.id.seq,
          command.id.route.eventHome,
          command.id.route.entityHome,
          command.id.seq,
        ],
      )
      .map((entry) =>
        Schema.decodeUnknownSync(WorkRecord, strictDecode)(
          parseJson(entry.record_json),
        )
      );
    return rows;
  }
  const row = reader.get<
    StateRow & {
      readonly event_home: string;
      readonly entity_home: string;
      readonly seq: string;
      readonly status: "applied" | "rejected";
      readonly fact_event_home: string | null;
      readonly fact_entity_home: string | null;
      readonly fact_seq: string | null;
    }
  >(
    `
      SELECT
        event_home,
        entity_home,
        seq,
        status,
        fact_event_home,
        fact_entity_home,
        fact_seq
      FROM work_dispositions
      WHERE command_event_home = ?
        AND command_entity_home = ?
        AND command_seq = ?
      ORDER BY length(seq), seq
      LIMIT 1
    `,
    [
      command.id.route.eventHome,
      command.id.route.entityHome,
      command.id.seq,
    ],
  );
  if (row === undefined) return [];
  const disposition = loadRecord(
    reader,
    recordId(
      row.event_home as InstallationId,
      row.entity_home as InstallationId,
      row.seq,
    ),
  );
  if (disposition === undefined) {
    throw new Error("remembered command disposition is missing");
  }
  if (
    row.status === "rejected" ||
    row.fact_event_home === null ||
    row.fact_entity_home === null ||
    row.fact_seq === null
  ) {
    return [disposition];
  }
  const fact = loadRecord(
    reader,
    recordId(
      row.fact_event_home as InstallationId,
      row.fact_entity_home as InstallationId,
      row.fact_seq,
    ),
  );
  if (fact === undefined) throw new Error("applied command fact is missing");
  return [fact, disposition];
};

const resolvePending = (
  writer: StateWriter,
  disposition: WorkDispositionValue,
  receivedAt: DisplayTimestampValue,
): void => {
  const command = loadRecord(writer, disposition.body.command);
  const pendingTable =
    command?.recordType === "command" &&
    command.item.kind === "proposal"
      ? "work_pending_proposal_commands"
      : "work_pending_commands";
  const pending = writer.get<
    StateRow & {
      readonly resolution_status: string | null;
      readonly resolution_event_home: string | null;
      readonly resolution_entity_home: string | null;
      readonly resolution_seq: string | null;
    }
  >(
    `
      SELECT
        resolution_status,
        resolution_event_home,
        resolution_entity_home,
        resolution_seq
      FROM ${pendingTable}
      WHERE event_home = ? AND entity_home = ? AND seq = ?
    `,
    [
      disposition.body.command.route.eventHome,
      disposition.body.command.route.entityHome,
      disposition.body.command.seq,
    ],
  );
  if (pending === undefined) {
    throw authorityError(
      "causal-conflict",
      "disposition references no local pending command",
    );
  }
  if (pending.resolution_event_home !== null) {
    if (
      pending.resolution_status !== disposition.body.status ||
      pending.resolution_event_home !== disposition.id.route.eventHome ||
      pending.resolution_entity_home !== disposition.id.route.entityHome ||
      pending.resolution_seq !== disposition.id.seq
    ) {
      throw authorityError(
        "identity-conflict",
        "pending command already has a different disposition",
      );
    }
    return;
  }
  writer.run(
    `
      UPDATE ${pendingTable}
      SET
        resolution_status = ?,
        resolution_event_home = ?,
        resolution_entity_home = ?,
        resolution_seq = ?,
        resolved_at = ?
      WHERE event_home = ? AND entity_home = ? AND seq = ?
    `,
    [
      disposition.body.status,
      disposition.id.route.eventHome,
      disposition.id.route.entityHome,
      disposition.id.seq,
      receivedAt,
      disposition.body.command.route.eventHome,
      disposition.body.command.route.entityHome,
      disposition.body.command.seq,
    ],
  );
};

const validateIncomingHash = (
  sender: InstallationId,
  record: WorkRecordValue,
): void => {
  const { contentSha256: _hash, originAt: _origin, ...semantic } = record;
  const expected = workRecordContentSha256(
    semantic as WorkRecordSemantic,
  );
  if (record.contentSha256 !== expected) {
    throw replicationError(
      sender,
      "integrity",
      "work record semantic content hash does not match",
      record.id.seq,
    );
  }
};

const validateIncomingDirection = (
  local: InstallationId,
  sender: InstallationId,
  record: WorkRecordValue,
): void => {
  if (record.id.route.eventHome !== sender) {
    throw replicationError(
      sender,
      "direction-mismatch",
      "record eventHome does not match the admitted sender",
      record.id.seq,
    );
  }
  const expectedEntityHome =
    record.recordType === "command" ? local : sender;
  if (record.id.route.entityHome !== expectedEntityHome) {
    throw replicationError(
      sender,
      "direction-mismatch",
      `record entityHome must be "${expectedEntityHome}"`,
      record.id.seq,
    );
  }
};

const advancePeerAcknowledgements = (
  writer: StateWriter,
  localInstallationId: InstallationId,
  peerInstallationId: InstallationId,
  acknowledgements: ReadonlyArray<RouteCursorValue>,
  acknowledgedAt: DisplayTimestampValue,
): void => {
  if (peerInstallationId === localInstallationId) {
    throw replicationError(
      peerInstallationId,
      "direction-mismatch",
      "an installation cannot acknowledge events as its own peer",
    );
  }
  if (acknowledgements.length > STATION_API_MAX_ACKS_PER_REPORT) {
    throw replicationError(
      peerInstallationId,
      "integrity",
      `acknowledgement batch exceeds ${STATION_API_MAX_ACKS_PER_REPORT}`,
    );
  }

  for (const proposed of acknowledgements) {
    if (proposed.eventHome !== localInstallationId) {
      throw replicationError(
        peerInstallationId,
        "direction-mismatch",
        "peer acknowledgement eventHome does not match the local emitter",
        proposed.through,
      );
    }
    if (
      durableRecordHash(
        writer,
        recordId(
          proposed.eventHome,
          proposed.entityHome,
          proposed.through,
        ),
      ) === undefined
    ) {
      throw replicationError(
        peerInstallationId,
        "cursor-regression",
        `peer acknowledged ${proposed.eventHome}/${proposed.entityHome}/${proposed.through}, but that exact route event was not emitted`,
        proposed.through,
      );
    }
  }

  for (const proposed of acknowledgements) {
    const row = writer.get<CursorRow>(
      `
        SELECT through_sequence
        FROM station_peer_ack_cursors
        WHERE peer_installation_id = ?
          AND event_home = ?
          AND entity_home = ?
      `,
      [
        peerInstallationId,
        proposed.eventHome,
        proposed.entityHome,
      ],
    );
    const current =
      row === undefined
        ? undefined
        : RouteCursor.make({
            eventHome: proposed.eventHome,
            entityHome: proposed.entityHome,
            through: sequence(row.through_sequence),
          });
    const decision = decideRouteCursorAdvance(current, proposed);
    if (decision._tag !== "advanced") continue;
    writer.run(
      `
        INSERT INTO station_peer_ack_cursors(
          peer_installation_id,
          event_home,
          entity_home,
          through_sequence,
          acknowledged_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(
          peer_installation_id,
          event_home,
          entity_home
        ) DO UPDATE SET
          through_sequence = excluded.through_sequence,
          acknowledged_at = excluded.acknowledged_at
      `,
      [
        peerInstallationId,
        decision.cursor.eventHome,
        decision.cursor.entityHome,
        decision.cursor.through,
        acknowledgedAt,
      ],
    );
  }
};

const exactPendingCommandForFact = (
  reader: StateReader,
  local: InstallationId,
  sender: InstallationId,
  fact: WorkFactValue,
): WorkCommandValue | undefined => {
  if (fact.basis.kind !== "command") return undefined;
  const command = loadRecord(reader, fact.basis.command);
  if (
    command?.recordType !== "command" ||
    command.contentSha256 !== fact.basis.commandSha256 ||
    command.id.route.eventHome !== local ||
    command.id.route.entityHome !== sender ||
    command.operation !== fact.operation ||
    !sameItem(command.item, fact.item)
  ) {
    return undefined;
  }
  const pending = reader.get<
    StateRow & { readonly resolution_event_home: string | null }
  >(
    `
      SELECT resolution_event_home
      FROM ${
        command.item.kind === "proposal"
          ? "work_pending_proposal_commands"
          : "work_pending_commands"
      }
      WHERE event_home = ?
        AND entity_home = ?
        AND seq = ?
    `,
    [
      command.id.route.eventHome,
      command.id.route.entityHome,
      command.id.seq,
    ],
  );
  if (
    pending === undefined ||
    pending.resolution_event_home !== null
  ) {
    return undefined;
  }
  const priorFact =
    command.item.kind === "proposal"
      ? reader.get<StateRow>(
          `
            SELECT 1
            FROM work_proposal_events
            WHERE record_type = 'fact'
              AND json_extract(
                record_json,
                '$.basis.command.route.eventHome'
              ) = ?
              AND json_extract(
                record_json,
                '$.basis.command.route.entityHome'
              ) = ?
              AND json_extract(record_json, '$.basis.command.seq') = ?
            LIMIT 1
          `,
          [
            command.id.route.eventHome,
            command.id.route.entityHome,
            command.id.seq,
          ],
        )
      : reader.get<StateRow>(
          `
            SELECT 1
            FROM work_facts
            WHERE basis_kind = 'command'
              AND basis_command_event_home = ?
              AND basis_command_entity_home = ?
              AND basis_command_seq = ?
            LIMIT 1
          `,
          [
            command.id.route.eventHome,
            command.id.route.entityHome,
            command.id.seq,
          ],
        );
  return priorFact === undefined ? command : undefined;
};

const assertCorrelatedCommandFact = (
  command: WorkCommandValue,
  fact: WorkFactValue,
): void => {
  const expectedPredecessor =
    command.body.operation === "task.claim"
      ? null
      : command.predecessor;
  if (!sameId(expectedPredecessor, fact.predecessor)) {
    throw authorityError(
      "causal-conflict",
      "command fact predecessor differs from the exact pending command",
    );
  }
  const action = command.body;
  switch (action.operation) {
    case "proposal.create":
      if (
        fact.body.operation !== "proposal.create" ||
        canonicalJson(fact.body.proposal) !==
          canonicalJson(action.proposal)
      ) {
        throw authorityError(
          "causal-conflict",
          "proposal creation fact differs from the exact pending command",
        );
      }
      return;
    case "proposal.approve":
      if (
        fact.body.operation !== "proposal.approve" ||
        fact.body.proposal.id !== action.proposalId ||
        fact.body.proposal.state !== "approved" ||
        fact.body.proposal.approvedTaskId !== action.task.id ||
        canonicalJson(fact.body.task) !== canonicalJson(action.task)
      ) {
        throw authorityError(
          "causal-conflict",
          "proposal approval fact differs from the exact pending command",
        );
      }
      return;
    case "proposal.reject":
      if (
        fact.body.operation !== "proposal.reject" ||
        fact.body.proposal.id !== action.proposalId ||
        fact.body.proposal.state !== "rejected"
      ) {
        throw authorityError(
          "causal-conflict",
          "proposal rejection fact differs from the exact pending command",
        );
      }
      return;
    case "task.create":
      if (
        fact.body.operation !== "task.create" ||
        canonicalJson(fact.body.task) !== canonicalJson(action.task)
      ) {
        throw authorityError(
          "causal-conflict",
          "task creation fact differs from the exact pending command",
        );
      }
      return;
    case "task.describe":
      if (
        fact.body.operation !== "task.describe" ||
        canonicalJson(fact.body.task.history[0]) !==
          canonicalJson(action.message)
      ) {
        throw authorityError(
          "causal-conflict",
          "task description fact differs from the exact pending command",
        );
      }
      return;
    case "task.transition": {
      if (
        fact.body.operation !== "task.transition" ||
        fact.body.task.state !== action.state
      ) {
        throw authorityError(
          "causal-conflict",
          "task transition fact differs from the exact pending command",
        );
      }
      if (
        action.message !== undefined &&
        canonicalJson(fact.body.task.history.at(-1)) !==
          canonicalJson(action.message)
      ) {
        throw authorityError(
          "causal-conflict",
          "task transition fact omits the exact commanded message",
        );
      }
      if (action.state === "completed") {
        const expectedEvidence = normalizeCompletionEvidence(
          action.completionEvidence,
        );
        const actualEvidence = fact.body.task.completionEvidence;
        if (
          canonicalJson(expectedEvidence ?? null) !==
          canonicalJson(actualEvidence ?? null)
        ) {
          throw authorityError(
            "causal-conflict",
            "task transition fact completionEvidence differs from the exact pending command",
          );
        }
      } else if (fact.body.task.completionEvidence !== undefined) {
        throw authorityError(
          "causal-conflict",
          "task transition fact stamped completionEvidence without completed state",
        );
      }
      return;
    }
    case "task.claim":
      if (
        fact.body.operation !== "task.claim" ||
        fact.body.previousHome !== action.sourceQueueHome ||
        !sameActor(fact.body.claimedBy, action.actor) ||
        canonicalJson(fact.body.task) !==
          canonicalJson({
            ...action.sourceTask,
            state: "working",
            claimedBy: action.actor.seatId,
          })
      ) {
        throw authorityError(
          "causal-conflict",
          "task claim fact differs from the exact pending command",
        );
      }
      return;
    case "request.create":
      if (
        fact.body.operation !== "request.create" ||
        canonicalJson(fact.body.request) !==
          canonicalJson(action.request)
      ) {
        throw authorityError(
          "causal-conflict",
          "request creation fact differs from the exact pending command",
        );
      }
      return;
    case "request.resolve":
      if (
        fact.body.operation !== "request.resolve" ||
        fact.body.request.state !== action.disposition ||
        fact.body.request.response !== action.response ||
        (
          action.message !== undefined &&
          canonicalJson(fact.body.request.history.at(-1)) !==
            canonicalJson(action.message)
        )
      ) {
        throw authorityError(
          "causal-conflict",
          "request resolution fact differs from the exact pending command",
        );
      }
      return;
    case "message.append":
      if (
        fact.body.operation !== "message.append" ||
        canonicalJson(action.message) !==
          canonicalJson(fact.body.message) ||
        canonicalJson(action.destination) !==
          canonicalJson(fact.body.destination) ||
        !sameActor(action.sentBy, fact.body.sentBy)
      ) {
        throw authorityError(
          "causal-conflict",
          "message append fact differs from the exact pending command",
        );
      }
      return;
    case "artifact.publish":
      if (
        fact.body.operation !== "artifact.publish" ||
        canonicalJson(action.artifact) !==
          canonicalJson(fact.body.artifact) ||
        !sameActor(action.publishedBy, fact.body.publishedBy)
      ) {
        throw authorityError(
          "causal-conflict",
          "artifact fact differs from the exact pending command",
        );
      }
      return;
    case "delivery.accepted":
      if (
        fact.body.operation !== "delivery.accepted" ||
        canonicalJson(action.receipt) !==
          canonicalJson(fact.body.receipt)
      ) {
        throw authorityError(
          "causal-conflict",
          "delivery fact differs from the exact pending command",
        );
      }
      return;
    case "board.topic.create":
      if (
        fact.body.operation !== "board.topic.create" ||
        !sameBoardAuthor(action.createdBy, fact.body.createdBy) ||
        // Fact topic may rewrite seed authors to createdBy; compare after bind.
        canonicalJson(topicWithBoundAuthors(action.topic, action.createdBy)) !==
          canonicalJson(fact.body.topic)
      ) {
        throw authorityError(
          "causal-conflict",
          "board topic fact differs from the exact pending command",
        );
      }
      return;
    case "board.post.append":
      if (
        fact.body.operation !== "board.post.append" ||
        !sameBoardAuthor(action.createdBy, fact.body.createdBy) ||
        // Position is assigned at apply time; match post identity + body without
        // requiring the command's client placeholder position.
        action.post.postId !== fact.body.post.postId ||
        action.post.topicId !== fact.body.post.topicId ||
        canonicalJson(action.post.parts) !==
          canonicalJson(fact.body.post.parts) ||
        !sameBoardAuthor(action.createdBy, fact.body.post.author)
      ) {
        throw authorityError(
          "causal-conflict",
          "board post fact differs from the exact pending command",
        );
      }
      return;
    case "pad.patch":
      if (
        fact.body.operation !== "pad.patch" ||
        action.patchId !== fact.body.patchId ||
        !sameBoardAuthor(action.author, fact.body.author) ||
        canonicalJson(stampPadPatchAuthors(action.patches, action.author)) !==
          canonicalJson(fact.body.patches)
      ) {
        throw authorityError(
          "causal-conflict",
          "pad patch fact differs from the exact pending command",
        );
      }
      return;
  }
};

const taskWithoutHistory = (task: TaskValue): unknown => {
  const { history: _history, ...rest } = task;
  return rest;
};

const taskWithoutStateHistoryResponse = (task: TaskValue): unknown => {
  const {
    state: _state,
    history: _history,
    response: _response,
    ...rest
  } = task;
  return rest;
};

const taskWithoutTransitionFields = (task: TaskValue): unknown => {
  const {
    state: _state,
    claimedBy: _claimedBy,
    history: _history,
    response: _response,
    completionEvidence: _completionEvidence,
    ...rest
  } = task;
  return rest;
};

const hasNonEmptyTaskTransitionMessage = (
  message: MessageValue | undefined,
): boolean =>
  message?.parts.some(
    (part) => part.kind === "text" && part.text.trim().length > 0,
  ) ?? false;

const historyIsSameOrOneAppend = (
  current: ReadonlyArray<MessageValue>,
  next: ReadonlyArray<MessageValue>,
): boolean =>
  canonicalJson(next) === canonicalJson(current) ||
  (next.length === current.length + 1 &&
    canonicalJson(next.slice(0, current.length)) ===
      canonicalJson(current));

const validateIncomingFact = (
  writer: StateWriter,
  local: InstallationId,
  sender: InstallationId,
  fact: WorkFactValue,
): void => {
  const correlatedCommand =
    fact.basis.kind === "command"
      ? exactPendingCommandForFact(writer, local, sender, fact)
      : undefined;
  if (fact.basis.kind === "command") {
    if (correlatedCommand === undefined) {
      throw authorityError(
        "causal-conflict",
        "fact does not name its exact unresolved local command",
      );
    }
    assertCorrelatedCommandFact(correlatedCommand, fact);
  }
  switch (fact.body.operation) {
    case "proposal.create": {
      if (fact.body.proposal.state !== "pending") {
        throw authorityError(
          "invalid-transition",
          "proposal.create fact must contain a pending proposal",
        );
      }
      if (
        selectProposalIdentity(
          writer,
          fact.item.sink,
          fact.item.itemId,
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `proposal "${fact.item.itemId}" already exists`,
        );
      }
      return;
    }
    case "proposal.approve": {
      const current = loadProposal(
        writer,
        fact.item.sink,
        fact.item.itemId,
      );
      assertCurrentPredecessor(
        current?.row,
        fact.predecessor,
        `proposal "${fact.item.itemId}"`,
      );
      if (
        current!.row.entity_home !== sender ||
        current!.proposal.state !== "pending" ||
        fact.body.proposal.state !== "approved" ||
        fact.body.proposal.approvedTaskId !== fact.body.task.id ||
        canonicalJson({
          ...current!.proposal,
          state: "approved",
          approvedTaskId: fact.body.task.id,
        }) !== canonicalJson(fact.body.proposal)
      ) {
        throw authorityError(
          "invalid-transition",
          "proposal approval fact must promote the exact pending proposal",
        );
      }
      return;
    }
    case "proposal.reject": {
      const current = loadProposal(
        writer,
        fact.item.sink,
        fact.item.itemId,
      );
      assertCurrentPredecessor(
        current?.row,
        fact.predecessor,
        `proposal "${fact.item.itemId}"`,
      );
      if (
        current!.row.entity_home !== sender ||
        current!.proposal.state !== "pending" ||
        fact.body.proposal.state !== "rejected" ||
        canonicalJson({
          ...current!.proposal,
          state: "rejected",
        }) !== canonicalJson(fact.body.proposal)
      ) {
        throw authorityError(
          "invalid-transition",
          "proposal rejection fact must reject the exact pending proposal",
        );
      }
      return;
    }
    case "task.create": {
      if (
        fact.body.task.state !== "submitted" ||
        fact.body.task.claimedBy !== undefined
      ) {
        throw authorityError(
          "invalid-transition",
          "task.create fact must contain a submitted unclaimed task",
        );
      }
      if (
        selectTaskIdentity(
          writer,
          "task",
          fact.item.sink,
          fact.item.itemId,
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `task "${fact.item.itemId}" already exists`,
        );
      }
      return;
    }
    case "task.claim": {
      const crossesHome = fact.body.previousHome !== sender;
      if (crossesHome) {
        if (fact.body.previousHome !== local || fact.predecessor !== null) {
          throw authorityError(
            "authority-mismatch",
            "first task adoption does not originate from this installation",
          );
        }
        const command = correlatedCommand;
        if (
          command === undefined ||
          command.body.operation !== "task.claim"
        ) {
          throw authorityError(
            "causal-conflict",
            "first task adoption has no matching pending claim",
          );
        }
        const action = command.body;
        const current = loadTask(
          writer,
          "task",
          fact.item.sink,
          fact.item.itemId,
        );
        if (
          current === undefined ||
          current.row.entity_home !== local ||
          current.task.state !== "submitted" ||
          current.task.claimedBy !== undefined ||
          !sameId(currentIdentity(current.row), action.sourcePredecessor) ||
          canonicalJson(current.task) !== canonicalJson(action.sourceTask) ||
          action.actor.seatId !== fact.body.claimedBy.seatId ||
          action.actor.seatId !== fact.body.task.claimedBy ||
          action.targetHome !== sender ||
          canonicalJson(fact.body.task) !==
            canonicalJson({
              ...action.sourceTask,
              state: "working",
              claimedBy: action.actor.seatId,
            })
        ) {
          throw authorityError(
            "causal-conflict",
            "first task adoption does not match its reserved source snapshot",
          );
        }
        {
          assertTaskClaimReady(
            writer,
            current.task,
            fact.item.sink.canvasName,
          );
        }
        return;
      }
      const current = loadTask(
        writer,
        "task",
        fact.item.sink,
        fact.item.itemId,
      );
      assertCurrentPredecessor(
        current?.row,
        fact.predecessor,
        `task "${fact.item.itemId}"`,
      );
      if (current!.row.entity_home !== sender) {
        throw authorityError(
          "authority-mismatch",
          "task fact sender does not own the material task",
        );
      }
      if (
        current!.task.state !== "submitted" ||
        current!.task.claimedBy !== undefined ||
        canonicalJson(fact.body.task) !==
          canonicalJson({
            ...current!.task,
            state: "working",
            claimedBy: fact.body.claimedBy.seatId,
          })
      ) {
        throw authorityError(
          "invalid-transition",
          "same-home task claim must atomically start one submitted task",
        );
      }
      assertActorAvailable(
        writer,
        fact.body.claimedBy.seatId,
        fact.item.itemId,
      );
      return;
    }
    case "task.describe": {
      const current = loadTask(
        writer,
        "task",
        fact.item.sink,
        fact.item.itemId,
      );
      assertCurrentPredecessor(
        current?.row,
        fact.predecessor,
        `task "${fact.item.itemId}"`,
      );
      if (current!.row.entity_home !== sender) {
        throw authorityError(
          "authority-mismatch",
          "task fact sender does not own the material task",
        );
      }
      const next = fact.body.task;
      if (
        canonicalJson(taskWithoutHistory(next)) !==
          canonicalJson(taskWithoutHistory(current!.task)) ||
        next.history.length !== Math.max(1, current!.task.history.length) ||
        canonicalJson(next.history.slice(1)) !==
          canonicalJson(current!.task.history.slice(1))
      ) {
        throw authorityError(
          "invalid-transition",
          "task.describe fact changed state outside the brief",
        );
      }
      return;
    }
    case "task.transition": {
      const current = loadTask(
        writer,
        "task",
        fact.item.sink,
        fact.item.itemId,
      );
      assertCurrentPredecessor(
        current?.row,
        fact.predecessor,
        `task "${fact.item.itemId}"`,
      );
      if (current!.row.entity_home !== sender) {
        throw authorityError(
          "authority-mismatch",
          "task fact sender does not own the material task",
        );
      }
      const next = fact.body.task;
      const isQaRejection =
        current!.task.state === "completed" && next.state === "submitted";
      const expectedClaimant =
        next.state === "submitted"
          ? undefined
          : current!.task.claimedBy;
      if (
        !canTransitionTaskState(current!.task.state, next.state) ||
        next.claimedBy !== expectedClaimant ||
        (isQaRejection &&
          (next.history.length !== current!.task.history.length + 1 ||
            !hasNonEmptyTaskTransitionMessage(next.history.at(-1)))) ||
        canonicalJson(taskWithoutTransitionFields(next)) !==
          canonicalJson(
            taskWithoutTransitionFields(
              taskWithTransitionState(current!.task, next.state),
            ),
        ) ||
        next.response !== current!.task.response ||
        !historyIsSameOrOneAppend(current!.task.history, next.history)
      ) {
        throw authorityError(
          "invalid-transition",
          "task.transition fact is not one legal state transition",
        );
      }
      // Completion evidence is stamped on completion and cleared when QA
      // rejects that completion back to Queue. Other transitions keep it
      // unchanged for installed rows that predate this QA exit.
      if (next.state === "completed") {
        // Stamp or leave empty is legal; prior non-completed had no evidence.
      } else if (isQaRejection) {
        if (next.completionEvidence !== undefined) {
          throw authorityError(
            "invalid-transition",
            "QA rejection must clear completionEvidence",
          );
        }
      } else if (
        canonicalJson(next.completionEvidence ?? null) !==
        canonicalJson(current!.task.completionEvidence ?? null)
      ) {
        throw authorityError(
          "invalid-transition",
          "completionEvidence may only change when transitioning to completed",
        );
      }
      if (
        correlatedCommand?.body.operation === "task.transition"
      ) {
        const expectedHistory =
          correlatedCommand.body.message === undefined
            ? current!.task.history
            : [
                ...current!.task.history,
                correlatedCommand.body.message,
              ];
        if (
          canonicalJson(next.history) !==
            canonicalJson(expectedHistory)
        ) {
          throw authorityError(
            "causal-conflict",
            "task transition fact history differs from the exact pending command",
          );
        }
        if (correlatedCommand.body.state === "completed") {
          const expectedEvidence = normalizeCompletionEvidence(
            correlatedCommand.body.completionEvidence,
          );
          if (
            canonicalJson(expectedEvidence ?? null) !==
            canonicalJson(next.completionEvidence ?? null)
          ) {
            throw authorityError(
              "causal-conflict",
              "task transition fact completionEvidence differs from the exact pending command",
            );
          }
        }
      }
      return;
    }
    case "request.create": {
      if (
        selectTaskIdentity(
          writer,
          "request",
          fact.item.sink,
          fact.item.itemId,
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `request "${fact.item.itemId}" already exists`,
        );
      }
      return;
    }
    case "request.resolve": {
      const current = loadTask(
        writer,
        "request",
        fact.item.sink,
        fact.item.itemId,
      );
      assertCurrentPredecessor(
        current?.row,
        fact.predecessor,
        `request "${fact.item.itemId}"`,
      );
      if (current!.row.entity_home !== sender) {
        throw authorityError(
          "authority-mismatch",
          "request fact sender does not own the material request",
        );
      }
      const next = fact.body.request;
      if (
        !canTransitionTaskState(current!.task.state, next.state) ||
        (next.state !== "completed" && next.state !== "rejected") ||
        canonicalJson(taskWithoutStateHistoryResponse(next)) !==
          canonicalJson(
            taskWithoutStateHistoryResponse(current!.task),
          ) ||
        next.response === undefined ||
        !historyIsSameOrOneAppend(current!.task.history, next.history)
      ) {
        throw authorityError(
          "invalid-transition",
          "request.resolve fact is not one legal retained-claimant resolution",
        );
      }
      if (
        correlatedCommand?.body.operation === "request.resolve"
      ) {
        const expectedHistory =
          correlatedCommand.body.message === undefined
            ? current!.task.history
            : [
                ...current!.task.history,
                correlatedCommand.body.message,
              ];
        if (
          canonicalJson(next.history) !==
            canonicalJson(expectedHistory)
        ) {
          throw authorityError(
            "causal-conflict",
            "request resolution fact history differs from the exact pending command",
          );
        }
      }
      return;
    }
    case "message.append": {
      const authority = canonicalLocalWorkAuthority(writer);
      if (authority.role === "remote") {
        if (correlatedCommand?.body.operation !== "message.append") {
          throw authorityError(
            "causal-conflict",
            "Command Center message fact has no exact local pending command",
          );
        }
        return;
      }
      if (fact.body.destination.kind === "mailbox") {
        throw authorityError(
          "authority-mismatch",
          "mailbox facts cannot originate from a Remote",
        );
      }
      requireThreadParent(
        writer,
        fact.item.sink,
        fact.body.destination,
        sender,
      );
      assertMessageIdentityAvailable(
        writer,
        fact.item.sink,
        fact.item.itemId,
      );
      return;
    }
    case "artifact.publish": {
      assertArtifactTaskReference(
        writer,
        fact.item.sink,
        fact.body.artifact,
        sender,
      );
      if (
        writer.get<StateRow>(
          `
            SELECT 1
            FROM work_artifacts
            WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
          `,
          [
            fact.item.sink.canvasName,
            fact.item.sink.nodeId,
            fact.item.itemId,
          ],
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `artifact "${fact.item.itemId}" already exists`,
        );
      }
      return;
    }
    case "delivery.accepted": {
      const receipt = fact.body.receipt;
      if (
        receipt.deliveredItem.sink.canvasName !==
          fact.item.sink.canvasName ||
        receipt.deliveredItem.sink.nodeId !== fact.item.sink.nodeId
      ) {
        throw authorityError(
          "target-mismatch",
          "delivery fact sink differs from its delivered item",
        );
      }
      if (
        writer.get<StateRow>(
          `
            SELECT 1
            FROM work_delivery_receipts
            WHERE delivered_canvas_name = ?
              AND delivered_node_id = ?
              AND delivery_id = ?
          `,
          [
            receipt.deliveredItem.sink.canvasName,
            receipt.deliveredItem.sink.nodeId,
            receipt.deliveryId,
          ],
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `delivery "${receipt.deliveryId}" already exists`,
        );
      }
      return;
    }
    case "board.topic.create": {
      // Mailbox twin: Remote keeps event/disposition only — no material parent
      // checks (rows live solely on Command Center).
      const authority = canonicalLocalWorkAuthority(writer);
      if (authority.role === "remote") {
        if (correlatedCommand?.body.operation !== "board.topic.create") {
          throw authorityError(
            "causal-conflict",
            "Command Center board topic fact has no exact local pending command",
          );
        }
        return;
      }
      if (
        writer.get<StateRow>(
          `
            SELECT 1 FROM work_board_topics
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
          `,
          [
            fact.item.sink.canvasName,
            fact.item.sink.nodeId,
            fact.body.topic.topicId,
          ],
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `topic "${fact.body.topic.topicId}" already exists`,
        );
      }
      for (const post of fact.body.topic.posts ?? []) {
        if (!sameBoardAuthor(post.author, fact.body.createdBy)) {
          throw authorityError(
            "causal-conflict",
            "board topic seed post author must equal createdBy",
          );
        }
        if (post.topicId !== fact.body.topic.topicId) {
          throw authorityError(
            "target-mismatch",
            "board topic seed post topicId must match the topic",
          );
        }
      }
      return;
    }
    case "board.post.append": {
      const authority = canonicalLocalWorkAuthority(writer);
      if (authority.role === "remote") {
        if (correlatedCommand?.body.operation !== "board.post.append") {
          throw authorityError(
            "causal-conflict",
            "Command Center board post fact has no exact local pending command",
          );
        }
        return;
      }
      const topic = writer.get<StateRow & { readonly state: string }>(
        `
          SELECT state FROM work_board_topics
          WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
        `,
        [
          fact.item.sink.canvasName,
          fact.item.sink.nodeId,
          fact.body.post.topicId,
        ],
      );
      if (topic === undefined) {
        throw authorityError(
          "missing-entity",
          `topic "${fact.body.post.topicId}" does not exist`,
        );
      }
      if (topic.state === "archived") {
        throw authorityError(
          "invalid-transition",
          `topic "${fact.body.post.topicId}" is archived`,
        );
      }
      if (
        writer.get<StateRow>(
          `
            SELECT 1 FROM work_board_posts
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ? AND post_id = ?
          `,
          [
            fact.item.sink.canvasName,
            fact.item.sink.nodeId,
            fact.body.post.topicId,
            fact.body.post.postId,
          ],
        ) !== undefined
      ) {
        throw authorityError(
          "identity-conflict",
          `post "${fact.body.post.postId}" already exists`,
        );
      }
      if (!sameBoardAuthor(fact.body.post.author, fact.body.createdBy)) {
        throw authorityError(
          "causal-conflict",
          "board post author must equal createdBy",
        );
      }
      return;
    }
    case "pad.patch": {
      const authority = canonicalLocalWorkAuthority(writer);
      if (authority.role === "remote") {
        if (correlatedCommand?.body.operation !== "pad.patch") {
          throw authorityError(
            "causal-conflict",
            "Command Center pad patch fact has no exact local pending command",
          );
        }
        return;
      }
      const current = loadPad(writer, fact.item.sink);
      const applied = applyPatches(current, fact.body.patches);
      if (Result.isFailure(applied)) {
        throw authorityError("invalid-transition", applied.failure.message);
      }
      return;
    }
  }
};

const validateDisposition = (
  writer: StateWriter,
  disposition: WorkDispositionValue,
): void => {
  const command = loadRecord(writer, disposition.body.command);
  if (
    command === undefined ||
    command.recordType !== "command" ||
    command.contentSha256 !== disposition.body.commandSha256 ||
    command.operation !== disposition.operation ||
    !sameItem(command.item, disposition.item)
  ) {
    throw authorityError(
      "causal-conflict",
      "disposition command reference is not coherent",
    );
  }
  if (disposition.body.status === "applied") {
    const fact = loadRecord(writer, disposition.body.fact);
    if (
      fact === undefined ||
      fact.recordType !== "fact" ||
      fact.contentSha256 !== disposition.body.factSha256 ||
      fact.operation !== disposition.operation ||
      !sameItem(fact.item, disposition.item) ||
      fact.basis.kind !== "command" ||
      !sameId(fact.basis.command, command.id) ||
      fact.basis.commandSha256 !== command.contentSha256
    ) {
      throw authorityError(
        "causal-conflict",
        "applied disposition fact does not carry the exact command basis",
      );
    }
    if (
      command.body.operation === "message.append" &&
      fact.body.operation === "message.append" &&
      (canonicalJson(command.body.message) !==
          canonicalJson(fact.body.message) ||
        canonicalJson(command.body.destination) !==
          canonicalJson(fact.body.destination) ||
        !sameActor(command.body.sentBy, fact.body.sentBy))
    ) {
      throw authorityError(
        "causal-conflict",
        "message append fact changed the command payload, destination, or sender",
      );
    }
  }
};

const rejectCommand = (
  writer: StateWriter,
  local: InstallationId,
  command: WorkCommandValue,
  reason: WorkRejectionReason,
  message: string,
  observedAt: DisplayTimestampValue,
): WorkDispositionValue => {
  const disposition = makeDisposition(
    writer,
    local,
    command,
    { _tag: "rejected", reason, message },
    observedAt,
  );
  insertRecord(writer, disposition, observedAt);
  return disposition;
};

const applyCommand = (
  writer: StateWriter,
  local: InstallationId,
  command: WorkCommandValue,
  observedAt: DisplayTimestampValue,
): ReadonlyArray<WorkRecordValue> => {
  const result = resultForCommand(writer, command);
  const predecessor =
    command.body.operation === "task.claim"
      ? null
      : command.predecessor;
  const fact = makeFact(
    writer,
    local,
    command.item,
    command.operation,
    predecessor,
    {
      kind: "command",
      command: command.id,
      commandSha256: command.contentSha256,
    },
    result.body,
    observedAt,
  );
  insertRecord(writer, fact, observedAt);
  materializeFact(writer, fact, observedAt);
  const disposition = makeDisposition(
    writer,
    local,
    command,
    { _tag: "applied", fact },
    observedAt,
  );
  insertRecord(writer, disposition, observedAt);
  return [fact, disposition];
};

/**
 * Work repository service contract (effect v4).
 *
 * Identifier and shape stay separate so there is exactly one repository
 * service key — no dual definitions.
 */
export interface WorkRepositoryId {
  readonly _workRepository: unique symbol;
}

export interface WorkRepositoryShape {
    readonly readSnapshot: (
      canvasName: string,
      nodeId: string,
    ) => Effect.Effect<WorkSnapshotValue, WorkRepositoryError>;
    readonly snapshotsForCanvas: (
      canvasName: string,
    ) => Effect.Effect<ReadonlyArray<WorkSnapshotValue>, WorkRepositoryError>;
    readonly recentOpsForSeat: (input: {
      readonly canvasName: string;
      readonly actorSeatId: ActorSeatId;
      readonly limit?: number;
    }) => Effect.Effect<WorkSeatRecentOpsFeed, WorkRepositoryError>;
    readonly itemHome: (
      lane: "task" | "proposal" | "request",
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
    readonly createTask: (
      input: CreateTaskInput,
    ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
    readonly createProposal: (
      input: CreateProposalInput,
    ) => Effect.Effect<
      LocalFactResult<TaskProposalValue>,
      RepositoryFailure
    >;
    readonly approveProposal: (
      input: ApproveProposalInput,
    ) => Effect.Effect<
      LocalFactResult<ProposalApprovalValue>,
      RepositoryFailure
    >;
    readonly rejectProposal: (
      input: RejectProposalInput,
    ) => Effect.Effect<
      LocalFactResult<TaskProposalValue>,
      RepositoryFailure
    >;
    readonly describeTask: (
      input: DescribeTaskInput,
    ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
    readonly transitionTask: (
      input: TransitionTaskInput,
    ) => Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure>;
    readonly claimLocalTask: (
      input: ClaimLocalTaskInput,
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
    readonly reserveRemoteTaskClaim: (
      input: ReserveRemoteTaskClaimInput,
    ) => Effect.Effect<WorkCommandValue, RepositoryFailure>;
    readonly enqueueRemoteCommand: (
      input: EnqueueRemoteCommandInput,
    ) => Effect.Effect<WorkCommandValue, RepositoryFailure>;
    readonly enqueueRemoteProposalApproval: (
      input: EnqueueRemoteProposalApprovalInput,
    ) => Effect.Effect<WorkCommandValue, RepositoryFailure>;
    readonly recordsAfter: (
      input: RecordsAfterInput,
    ) => Effect.Effect<ReadonlyArray<WorkRecordValue>, WorkRepositoryError>;
    readonly pendingCommands: Effect.Effect<
      ReadonlyArray<PendingCommand>,
      WorkRepositoryError
    >;
    readonly acceptRecords: (
      input: AcceptRecordsInput,
    ) => Effect.Effect<AcceptRecordsResult, ReplicationFailure>;
    readonly subscribeChanges: (
      listener: (canvasName: string, nodeId: string) => void,
    ) => () => void;
}

export type WorkRepository = WorkRepositoryId;

export const WorkRepository = Context.Service<WorkRepository,
  WorkRepositoryShape>("@vellum/WorkRepository");

export const WorkRepositoryLive = Layer.effect(
  WorkRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;
    const listeners = new Set<
      (canvasName: string, nodeId: string) => void
    >();

    const notify = (sink: SinkRefValue): void => {
      for (const listener of listeners) {
        try {
          listener(sink.canvasName, sink.nodeId);
        } catch (error) {
          console.error(
            `[work] change listener failed for ${sink.canvasName}/${sink.nodeId}:`,
            error,
          );
        }
      }
    };

    const readSnapshot = (
      canvasName: string,
      nodeId: string,
    ): Effect.Effect<WorkSnapshotValue, WorkRepositoryError> =>
      state
        .read("work.readSnapshot", (reader) =>
          loadSnapshot(reader, { canvasName, nodeId }),
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.readSnapshot", error),
          ),
        );

    const readSnapshotsForCanvas = (
      canvasName: string,
    ): Effect.Effect<ReadonlyArray<WorkSnapshotValue>, WorkRepositoryError> =>
      state
        .read("work.snapshotsForCanvas", (reader) =>
          snapshotsForCanvas(reader, canvasName),
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.snapshotsForCanvas", error),
          ),
        );

    const readRecentOpsForSeat = (input: {
      readonly canvasName: string;
      readonly actorSeatId: ActorSeatId;
      readonly limit?: number;
    }): Effect.Effect<WorkSeatRecentOpsFeed, WorkRepositoryError> =>
      state
        .read("work.recentOpsForSeat", (reader) =>
          recentOpsForSeat(reader, input),
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.recentOpsForSeat", error),
          ),
        );

    const itemHome = (
      lane: "task" | "proposal" | "request",
      canvasName: string,
      nodeId: string,
      itemId: string,
    ): Effect.Effect<InstallationId | undefined, WorkRepositoryError> =>
      state
        .read("work.itemHome", (reader) =>
          (lane === "proposal"
            ? selectProposalIdentity(
                reader,
                { canvasName, nodeId },
                itemId,
              )
            : selectTaskIdentity(
                reader,
                lane,
                { canvasName, nodeId },
                itemId,
              ))?.entity_home as InstallationId | undefined,
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.itemHome", error),
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
      state
        .read(
          "work.acceptedDeliveryAt",
          (reader) => {
            const row = reader.get<StateRow & { readonly accepted_at: string }>(
              `
                SELECT accepted_at
                FROM work_delivery_receipts
                WHERE delivered_canvas_name = ?
                  AND delivered_node_id = ?
                  AND delivery_id = ?
              `,
              [sink.canvasName, sink.nodeId, deliveryId],
            );
            return row?.accepted_at;
          },
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.acceptedDeliveryAt", error),
          ),
        );

    const transaction = <A>(
      operation: string,
      sink: SinkRefValue,
      body: (writer: StateWriter) => A,
    ): Effect.Effect<A, RepositoryFailure> =>
      state.transaction(operation, body).pipe(
        Effect.mapError((error) =>
          unwrapStateFailure(
            operation,
            error,
            WorkAuthorityError as unknown as new (...args: never[]) => WorkAuthorityError,
          ),
        ),
        Effect.tap(() => Effect.sync(() => notify(sink))),
      );

    const createTask = (
      input: CreateTaskInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const task = Schema.decodeUnknownSync(Task, strictDecode)(input.task);
      return transaction("work.task.create", input.sink, (writer) => {
        const { installationId: localInstallationId } =
          canonicalLocalWorkAuthority(writer);
        if (task.state !== "submitted" || task.claimedBy !== undefined) {
          throw authorityError(
            "invalid-transition",
            "task.create requires a submitted unclaimed task",
          );
        }
        if (
          selectTaskIdentity(
            writer,
            "task",
            input.sink,
            task.id,
          ) !== undefined
        ) {
          throw authorityError(
            "identity-conflict",
            `task "${task.id}" already exists`,
          );
        }
        if (task.dependsOn !== undefined && task.dependsOn.length > 0) {
          const depError = validateTaskDependsOn({
            taskId: task.id,
            dependsOn: task.dependsOn,
            byId: taskIndexById(
              loadCanvasTasks(writer, input.sink.canvasName),
            ),
          });
          if (depError !== undefined) {
            throw authorityError("invalid-transition", depError);
          }
        }
        return commitLocalFact(writer, {
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
      });
    };

    const createProposal = (
      input: CreateProposalInput,
    ): Effect.Effect<
      LocalFactResult<TaskProposalValue>,
      RepositoryFailure
    > => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const proposal = Schema.decodeUnknownSync(
        TaskProposal,
        strictDecode,
      )(input.proposal);
      return transaction("work.proposal.create", input.sink, (writer) => {
        const { installationId: localInstallationId } =
          canonicalLocalWorkAuthority(writer);
        if (proposal.state !== "pending") {
          throw authorityError(
            "invalid-transition",
            "proposal.create requires a pending proposal",
          );
        }
        if (
          selectProposalIdentity(writer, input.sink, proposal.id) !==
            undefined
        ) {
          throw authorityError(
            "identity-conflict",
            `proposal "${proposal.id}" already exists`,
          );
        }
        return commitLocalFact(writer, {
          localInstallationId,
          sink: input.sink,
          basis: input.basis,
          item: item("proposal", proposal.id, input.sink),
          operation: "proposal.create",
          predecessor: null,
          body: { operation: "proposal.create", proposal },
          value: proposal,
          originAt,
          receivedAt,
        });
      });
    };

    const approveProposal = (
      input: ApproveProposalInput,
    ): Effect.Effect<
      LocalFactResult<ProposalApprovalValue>,
      RepositoryFailure
    > => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const task = Schema.decodeUnknownSync(Task, strictDecode)(input.task);
      return transaction("work.proposal.approve", input.sink, (writer) => {
        const authority = canonicalLocalWorkAuthority(writer);
        if (authority.role !== "command-center") {
          throw authorityError(
            "authority-mismatch",
            "only the Command Center operator may approve proposals",
          );
        }
        const current = loadProposal(writer, input.sink, input.proposalId);
        if (current === undefined) {
          throw authorityError(
            "missing-entity",
            `proposal "${input.proposalId}" does not exist`,
          );
        }
        if (
          current.row.entity_home !== authority.installationId ||
          current.proposal.state !== "pending"
        ) {
          throw authorityError(
            "invalid-transition",
            `proposal "${input.proposalId}" is not locally pending`,
          );
        }
        if (
          task.state !== "submitted" ||
          task.claimedBy !== undefined ||
          selectTaskIdentity(writer, "task", input.sink, task.id) !==
            undefined
        ) {
          throw authorityError(
            "invalid-transition",
            "proposal approval must mint one new submitted unclaimed task",
          );
        }
        const proposal: TaskProposalValue = {
          ...current.proposal,
          state: "approved",
          approvedTaskId: task.id,
        };
        const proposalFact = commitLocalFact(writer, {
          localInstallationId: authority.installationId,
          sink: input.sink,
          basis: input.basis,
          item: item("proposal", proposal.id, input.sink),
          operation: "proposal.approve",
          predecessor: currentIdentity(current.row),
          body: { operation: "proposal.approve", proposal, task },
          value: proposal,
          originAt,
          receivedAt,
        });
        commitLocalFact(writer, {
          localInstallationId: authority.installationId,
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
        return {
          value: { proposal, task },
          record: proposalFact.record,
          snapshot: loadSnapshot(writer, input.sink),
        };
      });
    };

    const rejectProposal = (
      input: RejectProposalInput,
    ): Effect.Effect<
      LocalFactResult<TaskProposalValue>,
      RepositoryFailure
    > => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction("work.proposal.reject", input.sink, (writer) => {
        const authority = canonicalLocalWorkAuthority(writer);
        if (authority.role !== "command-center") {
          throw authorityError(
            "authority-mismatch",
            "only the Command Center operator may reject proposals",
          );
        }
        const current = loadProposal(writer, input.sink, input.proposalId);
        if (current === undefined) {
          throw authorityError(
            "missing-entity",
            `proposal "${input.proposalId}" does not exist`,
          );
        }
        if (
          current.row.entity_home !== authority.installationId ||
          current.proposal.state !== "pending"
        ) {
          throw authorityError(
            "invalid-transition",
            `proposal "${input.proposalId}" is not locally pending`,
          );
        }
        const proposal: TaskProposalValue = {
          ...current.proposal,
          state: "rejected",
        };
        return commitLocalFact(writer, {
          localInstallationId: authority.installationId,
          sink: input.sink,
          basis: input.basis,
          item: item("proposal", proposal.id, input.sink),
          operation: "proposal.reject",
          predecessor: currentIdentity(current.row),
          body: { operation: "proposal.reject", proposal },
          value: proposal,
          originAt,
          receivedAt,
        });
      });
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
      return transaction("work.task.describe", input.sink, (writer) => {
        const { installationId: localInstallationId } =
          canonicalLocalWorkAuthority(writer);
        const current = loadTask(
          writer,
          "task",
          input.sink,
          input.taskId,
        );
        if (current === undefined) {
          throw authorityError(
            "missing-entity",
            `task "${input.taskId}" does not exist`,
          );
        }
        if (current.row.entity_home !== localInstallationId) {
          throw authorityError(
            "authority-mismatch",
            "local installation does not own this task",
          );
        }
        if (
          current.task.state === "completed" ||
          current.task.state === "canceled" ||
          current.task.state === "failed" ||
          current.task.state === "rejected" ||
          current.task.state === "archived"
        ) {
          throw authorityError(
            "invalid-transition",
            `cannot describe terminal task "${input.taskId}"`,
          );
        }
        const task: TaskValue = {
          ...current.task,
          history: [message, ...current.task.history.slice(1)],
        };
        return commitLocalFact(writer, {
          localInstallationId,
          sink: input.sink,
          basis: input.basis,
          item: item("task", task.id, input.sink),
          operation: "task.describe",
          predecessor: currentIdentity(current.row),
          body: { operation: "task.describe", task },
          value: task,
          originAt,
          receivedAt,
        });
      });
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
      return transaction("work.task.transition", input.sink, (writer) => {
        if (message !== undefined) {
        }
        const { installationId: localInstallationId } =
          canonicalLocalWorkAuthority(writer);
        const current = loadTask(
          writer,
          "task",
          input.sink,
          input.taskId,
        );
        if (current === undefined) {
          throw authorityError(
            "missing-entity",
            `task "${input.taskId}" does not exist`,
          );
        }
        if (current.row.entity_home !== localInstallationId) {
          throw authorityError(
            "authority-mismatch",
            "local installation does not own this task",
          );
        }
        if (!canTransitionTaskState(current.task.state, input.state)) {
          throw authorityError(
            "invalid-transition",
            `cannot transition task "${input.taskId}" from ${current.task.state} to ${input.state}`,
          );
        }
        if (
          current.task.state === "completed" &&
          input.state === "submitted" &&
          !hasNonEmptyTaskTransitionMessage(message)
        ) {
          throw authorityError(
            "invalid-transition",
            "a QA rejection comment is required before returning a completed task to Queue",
          );
        }
        const evidence =
          input.state === "completed"
            ? normalizeCompletionEvidence(input.completionEvidence)
            : undefined;
        if (input.state === "completed") {
          const artifactsByNode = loadAllArtifactsByNode(
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
            throw authorityError(
              "invalid-transition",
              `finish criteria unsatisfied [${gate.missing}]: ${gate.message} (next: ${gate.next_step})`,
            );
          }
        }
        const base = taskWithTransitionState(current.task, input.state);
        const withoutEvidence =
          input.state === "completed"
            ? base
            : (() => {
                const { completionEvidence: _c, ...rest } = base;
                return rest;
              })();
        const task = Schema.decodeUnknownSync(Task, strictDecode)({
          ...withoutEvidence,
          history:
            message === undefined
              ? current.task.history
              : [...current.task.history, message],
          ...(input.state === "completed" && evidence !== undefined
            ? { completionEvidence: evidence }
            : {}),
        });
        return commitLocalFact(writer, {
          localInstallationId,
          sink: input.sink,
          basis: input.basis,
          item: item("task", task.id, input.sink),
          operation: "task.transition",
          predecessor: currentIdentity(current.row),
          body: { operation: "task.transition", task },
          value: task,
          originAt,
          receivedAt,
        });
      });
    };

    const claimLocalTask = (
      input: ClaimLocalTaskInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction("work.task.claim-local", input.sink, (writer) => {
        const { installationId: localInstallationId } =
          canonicalLocalWorkAuthority(writer);
        const current = loadTask(
          writer,
          "task",
          input.sink,
          input.taskId,
        );
        if (current === undefined) {
          throw authorityError(
            "missing-entity",
            `task "${input.taskId}" does not exist`,
          );
        }
        if (current.row.entity_home !== localInstallationId) {
          throw authorityError(
            "authority-mismatch",
            "local installation does not own this task queue",
          );
        }
        if (
          current.task.state !== "submitted" ||
          current.task.claimedBy !== undefined
        ) {
          throw authorityError(
            "claim-contention",
            `task "${input.taskId}" is not available to start`,
          );
        }
        {
          assertTaskClaimReady(writer, current.task, input.sink.canvasName);
        }
        assertActorAvailable(writer, input.actor.seatId);
        const task = Schema.decodeUnknownSync(Task, strictDecode)({
          ...current.task,
          state: "working",
          claimedBy: input.actor.seatId,
        });
        return commitLocalFact(writer, {
          localInstallationId,
          sink: input.sink,
          basis: input.basis,
          item: item("task", task.id, input.sink),
          operation: "task.claim",
          predecessor: currentIdentity(current.row),
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
      });
    };

    const createRequest = (
      input: CreateRequestInput,
    ): Effect.Effect<LocalFactResult<TaskValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const request = Schema.decodeUnknownSync(Task, strictDecode)(
        input.request,
      );
      return transaction("work.request.create", input.sink, (writer) => {
        const { installationId: localInstallationId } =
          canonicalLocalWorkAuthority(writer);
        if (
          request.state !== "input-required" ||
          request.claimedBy !== input.raisedBy.seatId
        ) {
          throw authorityError(
            "authority-mismatch",
            "request must be input-required work claimed by its exact raiser",
          );
        }
        if (
          selectTaskIdentity(
            writer,
            "request",
            input.sink,
            request.id,
          ) !== undefined
        ) {
          throw authorityError(
            "identity-conflict",
            `request "${request.id}" already exists`,
          );
        }
        return commitLocalFact(writer, {
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
      });
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
      return transaction("work.request.resolve", input.sink, (writer) => {
        if (message !== undefined) {
        }
        const { installationId: localInstallationId } =
          canonicalLocalWorkAuthority(writer);
        const current = loadTask(
          writer,
          "request",
          input.sink,
          input.requestId,
        );
        if (current === undefined) {
          throw authorityError(
            "missing-entity",
            `request "${input.requestId}" does not exist`,
          );
        }
        if (current.row.entity_home !== localInstallationId) {
          throw authorityError(
            "authority-mismatch",
            "local installation does not own this request",
          );
        }
        if (
          !canTransitionTaskState(
            current.task.state,
            input.disposition,
          )
        ) {
          throw authorityError(
            "invalid-transition",
            `cannot resolve request "${input.requestId}" from ${current.task.state}`,
          );
        }
        const request = Schema.decodeUnknownSync(Task, strictDecode)({
          ...current.task,
          state: input.disposition,
          response: input.response,
          history:
            message === undefined
              ? current.task.history
              : [...current.task.history, message],
        });
        return commitLocalFact(writer, {
          localInstallationId,
          sink: input.sink,
          basis: input.basis,
          item: item("request", request.id, input.sink),
          operation: "request.resolve",
          predecessor: currentIdentity(current.row),
          body: { operation: "request.resolve", request },
          value: request,
          originAt,
          receivedAt,
        });
      });
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
      return transaction("work.message.append", input.sink, (writer) => {
        const authority = canonicalLocalWorkAuthority(writer);
        const localInstallationId = authority.installationId;
        if (destination.kind === "mailbox") {
          if (authority.role !== "command-center") {
            throw authorityError(
              "authority-mismatch",
              "actor mailbox messages are Command Center-homed",
            );
          }
        } else {
          if (message.taskId !== destination.itemId) {
            throw authorityError(
              "target-mismatch",
              "task/request message destination must equal Message.taskId",
            );
          }
          requireThreadParent(
            writer,
            input.sink,
            destination,
            localInstallationId,
          );
        }
        assertMessageIdentityAvailable(
          writer,
          input.sink,
          message.messageId,
        );
        return commitLocalFact(writer, {
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
      });
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
      return transaction("work.artifact.publish", input.sink, (writer) => {
        const { installationId: localInstallationId } =
          canonicalLocalWorkAuthority(writer);
        assertArtifactTaskReference(
          writer,
          input.sink,
          artifact,
          localInstallationId,
        );
        if (
          writer.get<StateRow>(
            `
              SELECT 1 FROM work_artifacts
              WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
            `,
            [
              input.sink.canvasName,
              input.sink.nodeId,
              artifact.artifactId,
            ],
          ) !== undefined
        ) {
          throw authorityError(
            "identity-conflict",
            `artifact "${artifact.artifactId}" already exists`,
          );
        }
        return commitLocalFact(writer, {
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
      });
    };

    const acceptDelivery = (
      input: AcceptDeliveryInput,
    ): Effect.Effect<LocalFactResult<DeliveryReceipt>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction("work.delivery.accepted", input.sink, (writer) => {
        const { installationId: localInstallationId } =
          canonicalLocalWorkAuthority(writer);
        const receipt = input.receipt;
        if (
          receipt.deliveredItem.sink.canvasName !== input.sink.canvasName ||
          receipt.deliveredItem.sink.nodeId !== input.sink.nodeId
        ) {
          throw authorityError(
            "target-mismatch",
            "delivery receipt sink differs from the accepted item sink",
          );
        }
        if (
          writer.get<StateRow>(
            `
              SELECT 1
              FROM work_delivery_receipts
              WHERE delivered_canvas_name = ?
                AND delivered_node_id = ?
                AND delivery_id = ?
            `,
            [
              receipt.deliveredItem.sink.canvasName,
              receipt.deliveredItem.sink.nodeId,
              receipt.deliveryId,
            ],
          ) !== undefined
        ) {
          throw authorityError(
            "identity-conflict",
            `delivery "${receipt.deliveryId}" already exists`,
          );
        }
        return commitLocalFact(writer, {
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
      });
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
      return transaction("work.board.topic.create", input.sink, (writer) => {
        const authority = canonicalLocalWorkAuthority(writer);
        if (authority.role !== "command-center") {
          throw authorityError(
            "authority-mismatch",
            "board topics are Command Center-homed",
          );
        }
        if (
          writer.get<StateRow>(
            `
              SELECT 1 FROM work_board_topics
              WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
            `,
            [input.sink.canvasName, input.sink.nodeId, topic.topicId],
          ) !== undefined
        ) {
          throw authorityError(
            "identity-conflict",
            `topic "${topic.topicId}" already exists`,
          );
        }
        return commitLocalFact(writer, {
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
      });
    };

    const appendBoardPost = (
      input: AppendBoardPostInput,
    ): Effect.Effect<LocalFactResult<BoardPostValue>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      const post = Schema.decodeUnknownSync(BoardPost, strictDecode)(
        input.post,
      );
      const createdBy = input.createdBy;
      return transaction("work.board.post.append", input.sink, (writer) => {
        const authority = canonicalLocalWorkAuthority(writer);
        if (authority.role !== "command-center") {
          throw authorityError(
            "authority-mismatch",
            "board posts are Command Center-homed",
          );
        }
        const topic = writer.get<StateRow & { readonly state: string }>(
          `
            SELECT state FROM work_board_topics
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
          `,
          [input.sink.canvasName, input.sink.nodeId, post.topicId],
        );
        if (topic === undefined) {
          throw authorityError(
            "missing-entity",
            `topic "${post.topicId}" does not exist`,
          );
        }
        if (topic.state === "archived") {
          throw authorityError(
            "invalid-transition",
            `topic "${post.topicId}" is archived`,
          );
        }
        const maxPos = writer.get<StateRow & { readonly m: number | null }>(
          `
            SELECT MAX(position) AS m FROM work_board_posts
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
          `,
          [input.sink.canvasName, input.sink.nodeId, post.topicId],
        );
        if (
          writer.get<StateRow>(
            `
              SELECT 1 FROM work_board_posts
              WHERE canvas_name = ? AND node_id = ? AND topic_id = ? AND post_id = ?
            `,
            [
              input.sink.canvasName,
              input.sink.nodeId,
              post.topicId,
              post.postId,
            ],
          ) !== undefined
        ) {
          throw authorityError(
            "identity-conflict",
            `post "${post.postId}" already exists`,
          );
        }
        const position =
          typeof maxPos?.m === "number" && Number.isFinite(maxPos.m)
            ? maxPos.m + 1
            : 0;
        const stored = { ...post, author: createdBy, position };
        return commitLocalFact(writer, {
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
      });
    };

    const readPad = (
      canvasName: string,
      nodeId: string,
    ): Effect.Effect<Pad, WorkRepositoryError> =>
      state
        .read("work.pad.read", (reader) =>
          loadPad(reader, { canvasName, nodeId }),
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.pad.read", error),
          ),
        );

    const applyPadPatch = (
      input: ApplyPadPatchInput,
    ): Effect.Effect<LocalFactResult<Pad>, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction("work.pad.patch", input.sink, (writer) => {
        const authority = canonicalLocalWorkAuthority(writer);
        if (authority.role !== "command-center") {
          throw authorityError(
            "authority-mismatch",
            "pad rows are Command Center-homed",
          );
        }
        const patches = stampPadPatchAuthors(input.patches, input.author);
        assertPadPatchRules(writer, input.sink, input.author, patches);
        const current = loadPad(writer, input.sink);
        const applied = applyPatches(current, patches);
        if (Result.isFailure(applied)) {
          throw authorityError("invalid-transition", applied.failure.message);
        }
        return commitLocalFact(writer, {
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
      });
    };

    const markPadRead = (input: {
      readonly sink: SinkRefValue;
      readonly pinId: string;
      readonly principalKey: string;
      readonly lastReadPosition: number;
      readonly updatedAt?: string;
    }): Effect.Effect<void, RepositoryFailure> => {
      const updatedAt = timestamp(input.updatedAt);
      return transaction("work.pad.mark_read", input.sink, (writer) => {
        writer.run(
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
      });
    };

    const markBoardRead = (input: {
      readonly sink: SinkRefValue;
      readonly topicId: string;
      readonly principalKey: string;
      readonly lastReadPosition: number;
      readonly updatedAt?: string;
    }): Effect.Effect<void, RepositoryFailure> => {
      const updatedAt = timestamp(input.updatedAt);
      return transaction("work.board.mark_read", input.sink, (writer) => {
        writer.run(
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
            input.lastReadPosition,
            updatedAt,
          ],
        );
      });
    };

    const setArtifactArchived = (input: {
      readonly sink: SinkRefValue;
      readonly artifactId: string;
      readonly archived: boolean;
    }): Effect.Effect<ArtifactValue, RepositoryFailure> =>
      transaction("work.artifact.set_archived", input.sink, (writer) => {
        const row = writer.get<ArtifactRow>(
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
          [input.sink.canvasName, input.sink.nodeId, input.artifactId],
        );
        if (row === undefined) {
          throw authorityError(
            "missing-entity",
            `artifact "${input.artifactId}" not found`,
          );
        }
        const metadata =
          row.metadata_json === null
            ? ({} as Record<string, unknown>)
            : (parseJson(row.metadata_json) as Record<string, unknown>);
        if (input.archived) {
          metadata.archived = true;
        } else {
          delete metadata.archived;
        }
        const metadataJson =
          Object.keys(metadata).length === 0
            ? null
            : canonicalJson(metadata);
        writer.run(
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
        return Schema.decodeUnknownSync(Artifact, strictDecode)({
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
          ...(metadataJson === null ? {} : { metadata }),
        });
      });

    const deleteArtifact = (input: {
      readonly sink: SinkRefValue;
      readonly artifactId: string;
    }): Effect.Effect<{ readonly artifactId: string }, RepositoryFailure> =>
      transaction("work.artifact.delete", input.sink, (writer) => {
        const row = writer.get<StateRow>(
          `
            SELECT 1 FROM work_artifacts
            WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
          `,
          [input.sink.canvasName, input.sink.nodeId, input.artifactId],
        );
        if (row === undefined) {
          throw authorityError(
            "missing-entity",
            `artifact "${input.artifactId}" not found`,
          );
        }
        writer.run(
          `
            DELETE FROM work_artifacts
            WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
          `,
          [input.sink.canvasName, input.sink.nodeId, input.artifactId],
        );
        return { artifactId: input.artifactId };
      });

    const reserveRemoteTaskClaim = (
      input: ReserveRemoteTaskClaimInput,
    ): Effect.Effect<WorkCommandValue, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction(
        "work.task.reserve-remote-claim",
        input.sink,
        (writer) => {
          const { installationId: localInstallationId } =
            canonicalLocalWorkAuthority(writer);
          if (
            input.targetInstallationId === localInstallationId
          ) {
            throw authorityError(
              "target-mismatch",
              "remote task claim target must differ from the local installation",
            );
          }
          const current = loadTask(
            writer,
            "task",
            input.sink,
            input.taskId,
          );
          if (current === undefined) {
            throw authorityError(
              "missing-entity",
              `task "${input.taskId}" does not exist`,
            );
          }
          if (
            current.row.entity_home !== localInstallationId ||
            current.task.state !== "submitted" ||
            current.task.claimedBy !== undefined
          ) {
            throw authorityError(
              "authority-mismatch",
              "only a locally owned submitted task may be claimed remotely",
            );
          }
          {
            assertTaskClaimReady(writer, current.task, input.sink.canvasName);
          }
          assertActorAvailable(writer, input.actor.seatId);
          const action = Schema.decodeUnknownSync(
            WorkAction,
            strictDecode,
          )({
            operation: "task.claim",
            sourceQueueHome: localInstallationId,
            sourcePredecessor: currentIdentity(current.row),
            sourceTask: current.task,
            sink: input.sink,
            actor: input.actor,
            targetHome: input.targetInstallationId,
          });
          const command = makeCommand(
            writer,
            localInstallationId,
            input.targetInstallationId,
            item("task", input.taskId, input.sink),
            null,
            action,
            originAt,
          );
          insertRecord(writer, command, receivedAt);
          insertPending(writer, command, receivedAt);
          return command;
        },
      );
    };

    const enqueueRemoteCommand = (
      input: EnqueueRemoteCommandInput,
    ): Effect.Effect<WorkCommandValue, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction(
        `work.${input.action.operation}.enqueue`,
        input.sink,
        (writer) => {
          const { installationId: localInstallationId } =
            canonicalLocalWorkAuthority(writer);
          if (
            input.targetInstallationId === localInstallationId
          ) {
            throw authorityError(
              "target-mismatch",
              "remote command target must differ from the local installation",
            );
          }
          if (
            input.item.sink.canvasName !== input.sink.canvasName ||
            input.item.sink.nodeId !== input.sink.nodeId
          ) {
            throw authorityError(
              "target-mismatch",
              "command item sink differs from the repository route",
            );
          }
          const action = Schema.decodeUnknownSync(
            WorkAction,
            strictDecode,
          )(input.action);
          if (action.operation === "task.claim") {
            throw authorityError(
              "target-mismatch",
              "task.claim must use reserveRemoteTaskClaim",
            );
          }
          const predecessor = predecessorForAction(
            writer,
            input.item,
            action,
          );
          if (
            predecessor !== null &&
            predecessor.route.entityHome !== input.targetInstallationId
          ) {
            throw authorityError(
              "authority-mismatch",
              "remote command target does not own the current item fact",
            );
          }
          const command = makeCommand(
            writer,
            localInstallationId,
            input.targetInstallationId,
            input.item,
            predecessor,
            action,
            originAt,
          );
          insertRecord(writer, command, receivedAt);
          insertPending(writer, command, receivedAt);
          return command;
        },
      );
    };

    const enqueueRemoteProposalApproval = (
      input: EnqueueRemoteProposalApprovalInput,
    ): Effect.Effect<WorkCommandValue, RepositoryFailure> => {
      const originAt = timestamp(input.originAt);
      const receivedAt = timestamp(input.receivedAt);
      return transaction(
        "work.proposal.approve.enqueue",
        input.sink,
        (writer) => {
          const { installationId: localInstallationId } =
            canonicalLocalWorkAuthority(writer);
          if (input.targetInstallationId === localInstallationId) {
            throw authorityError(
              "target-mismatch",
              "remote proposal approval target must differ from local installation",
            );
          }
          const action = Schema.decodeUnknownSync(
            WorkAction,
            strictDecode,
          )(input.action);
          if (action.operation !== "proposal.approve") {
            throw authorityError(
              "target-mismatch",
              "proposal approval enqueue requires proposal.approve",
            );
          }
          const predecessor = predecessorForAction(
            writer,
            input.item,
            action,
          );
          if (
            predecessor === null ||
            predecessor.route.entityHome !== input.targetInstallationId
          ) {
            throw authorityError(
              "authority-mismatch",
              "remote target does not own the pending proposal",
            );
          }
          const approval = makeCommand(
            writer,
            localInstallationId,
            input.targetInstallationId,
            input.item,
            predecessor,
            action,
            originAt,
          );
          insertRecord(writer, approval, receivedAt);
          insertPending(writer, approval, receivedAt);

          const creationAction = Schema.decodeUnknownSync(
            WorkAction,
            strictDecode,
          )({ operation: "task.create", task: action.task });
          const creation = makeCommand(
            writer,
            localInstallationId,
            input.targetInstallationId,
            item("task", action.task.id, input.sink),
            null,
            creationAction,
            originAt,
          );
          insertRecord(writer, creation, receivedAt);
          insertPending(writer, creation, receivedAt);
          return approval;
        },
      );
    };

    const recordsAfter = (
      input: RecordsAfterInput,
    ): Effect.Effect<ReadonlyArray<WorkRecordValue>, WorkRepositoryError> =>
      state
        .read("work.recordsAfter", (reader) => {
          const after = input.after ?? "0";
          const limit = Math.max(
            1,
            Math.min(
              MAX_RECORD_LIMIT,
              Math.floor(input.limit ?? DEFAULT_RECORD_LIMIT),
            ),
          );
          return reader
            .all<StateRow & { readonly seq: string }>(
              `
                SELECT seq
                FROM (
                  SELECT event_home, entity_home, seq FROM work_events
                  UNION ALL
                  SELECT event_home, entity_home, seq
                  FROM work_proposal_events
                )
                WHERE event_home = ?
                  AND entity_home = ?
                  AND (
                    length(seq) > length(?)
                    OR (length(seq) = length(?) AND seq > ?)
                  )
                ORDER BY length(seq), seq
                LIMIT ?
              `,
              [
                input.route.eventHome,
                input.route.entityHome,
                after,
                after,
                after,
                limit,
              ],
            )
            .map(({ seq }) => {
              const loaded = loadRecord(
                reader,
                recordId(
                  input.route.eventHome,
                  input.route.entityHome,
                  seq,
                ),
              );
              if (loaded === undefined) {
                throw new Error("work record disappeared during read");
              }
              return loaded;
            });
        })
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.recordsAfter", error),
          ),
        );

    const pendingCommands = state
      .read("work.pendingCommands", (reader) =>
        reader
          .all<
            StateRow & {
              readonly event_home: string;
              readonly entity_home: string;
              readonly seq: string;
              readonly resolution_status: "applied" | "rejected" | null;
              readonly resolution_event_home: string | null;
              readonly resolution_entity_home: string | null;
              readonly resolution_seq: string | null;
              readonly resolved_at: string | null;
            }
          >(
            `
              SELECT
                event_home,
                entity_home,
                seq,
                resolution_status,
                resolution_event_home,
                resolution_entity_home,
                resolution_seq,
                resolved_at
              FROM (
                SELECT
                  event_home,
                  entity_home,
                  seq,
                  resolution_status,
                  resolution_event_home,
                  resolution_entity_home,
                  resolution_seq,
                  resolved_at
                FROM work_pending_commands
                UNION ALL
                SELECT
                  event_home,
                  entity_home,
                  seq,
                  resolution_status,
                  resolution_event_home,
                  resolution_entity_home,
                  resolution_seq,
                  resolved_at
                FROM work_pending_proposal_commands
              )
              ORDER BY
                event_home,
                entity_home,
                length(seq),
                seq
            `,
          )
          .map((row): PendingCommand => {
            const command = loadRecord(
              reader,
              recordId(
                row.event_home as InstallationId,
                row.entity_home as InstallationId,
                row.seq,
              ),
            );
            if (command?.recordType !== "command") {
              throw new Error("pending command has no command record");
            }
            return {
              command,
              resolution:
                row.resolution_status === null ||
                row.resolution_event_home === null ||
                row.resolution_entity_home === null ||
                row.resolution_seq === null ||
                row.resolved_at === null
                  ? undefined
                  : {
                      status: row.resolution_status,
                      disposition: recordId(
                        row.resolution_event_home as InstallationId,
                        row.resolution_entity_home as InstallationId,
                        row.resolution_seq,
                      ),
                      resolvedAt: timestamp(row.resolved_at),
                    },
            };
          }),
      )
      .pipe(
        Effect.mapError((error) =>
          toRepositoryError("work.pendingCommands", error),
        ),
      );

    const acceptRecords = (
      input: AcceptRecordsInput,
    ): Effect.Effect<AcceptRecordsResult, ReplicationFailure> => {
      const observedAt = timestamp(input.receivedAt);
      const decoded: WorkRecordValue[] = [];
      try {
        for (const candidate of input.records) {
          const result = decodeWorkRecord(candidate);
          if (Result.isFailure(result)) {
            return Effect.fail(
              replicationError(
                input.senderInstallationId,
                "integrity",
                "report contains a malformed Work record",
              ),
            );
          }
          validateIncomingHash(input.senderInstallationId, result.success);
          decoded.push(result.success);
        }
      } catch (error) {
        return Effect.fail(
          error instanceof WorkReplicationError
            ? error
            : toRepositoryError("work.acceptRecords.decode", error),
        );
      }

      return state
        .transaction("work.acceptRecords", (writer) => {
          const localAuthority = canonicalLocalWorkAuthority(writer);
          const localInstallationId = localAuthority.installationId;
          const routes = new Map<string, WorkRecordValue[]>();
          for (const record of decoded) {
            const key = `${record.id.route.eventHome}\u0000${record.id.route.entityHome}`;
            const list = routes.get(key) ?? [];
            list.push(record);
            routes.set(key, list);
          }
          let accepted = 0;
          let idempotent = 0;
          let rejected = 0;
          const emitted: WorkRecordValue[] = [];
          const acknowledge: RouteCursorValue[] = [];
          const changed = new Set<string>();

          for (const records of routes.values()) {
            records.sort((left, right) =>
              BigInt(left.id.seq) < BigInt(right.id.seq) ? -1 : 1,
            );
            const route = records[0]!.id.route;
            const cursor = writer.get<CursorRow>(
              `
                SELECT through_sequence
                FROM station_received_cursors
                WHERE event_home = ? AND entity_home = ?
              `,
              [route.eventHome, route.entityHome],
            )?.through_sequence;
            let through = cursor === undefined ? 0n : BigInt(cursor);

            for (const record of records) {
              validateIncomingDirection(
                localInstallationId,
                input.senderInstallationId,
                record,
              );
              const seqValue = BigInt(record.id.seq);
              const existingHash = durableRecordHash(writer, record.id);
              if (seqValue <= through) {
                if (
                  existingHash === undefined ||
                  existingHash !== record.contentSha256
                ) {
                  throw replicationError(
                    input.senderInstallationId,
                    existingHash === undefined
                      ? "cursor-regression"
                      : "identity-conflict",
                    existingHash === undefined
                      ? "receive cursor has no corresponding durable record"
                      : "record identity was reused with different content",
                    record.id.seq,
                  );
                }
                idempotent += 1;
                if (record.recordType === "command") {
                  emitted.push(...priorCommandOutcome(writer, record));
                }
                continue;
              }
              const expected = through + 1n;
              if (seqValue !== expected) {
                throw replicationError(
                  input.senderInstallationId,
                  "sequence-gap",
                  `expected route sequence ${expected}, received ${record.id.seq}`,
                  record.id.seq,
                );
              }
              if (existingHash !== undefined) {
                throw replicationError(
                  input.senderInstallationId,
                  "identity-conflict",
                  "record identity already names different content",
                  record.id.seq,
                );
              }

              if (record.recordType === "fact") {
                const admission = input.authorizeFact(record);
                if (admission._tag === "rejected") {
                  throw replicationError(
                    input.senderInstallationId,
                    "causal-conflict",
                    `fact admission denied (${admission.reason}): ${admission.message}`,
                    record.id.seq,
                  );
                }
                validateIncomingFact(
                  writer,
                  localInstallationId,
                  input.senderInstallationId,
                  record,
                );
              } else if (record.recordType === "disposition") {
                validateDisposition(writer, record);
              }
              rememberIncomingSequence(writer, record.id);
              insertRecord(writer, record, observedAt);

              if (record.recordType === "command") {
                const admission = input.authorizeCommand(record);
                if (admission._tag === "rejected") {
                  const disposition = rejectCommand(
                    writer,
                    localInstallationId,
                    record,
                    admission.reason,
                    admission.message,
                    observedAt,
                  );
                  emitted.push(disposition);
                  rejected += 1;
                } else {
                  try {
                    const outcome = applyCommand(
                      writer,
                      localInstallationId,
                      record,
                      observedAt,
                    );
                    emitted.push(...outcome);
                    accepted += 1;
                    changed.add(
                      `${record.item.sink.canvasName}\u0000${record.item.sink.nodeId}`,
                    );
                  } catch (error) {
                    if (!(error instanceof WorkAuthorityError)) throw error;
                    const disposition = rejectCommand(
                      writer,
                      localInstallationId,
                      record,
                      error.reason,
                      error.message,
                      observedAt,
                    );
                    emitted.push(disposition);
                    rejected += 1;
                  }
                }
              } else if (record.recordType === "fact") {
                // Command Center-homed residencies (mailbox messages; board
                // topics/posts) materialize only on CC. A Remote keeps
                // correlated command/disposition state and must not grow a
                // second material replica — same law as vellum-protocol
                // mailbox residency.
                const materializesHere = !(
                  localAuthority.role === "remote" &&
                  (
                    record.body.operation === "message.append" ||
                    record.body.operation === "board.topic.create" ||
                    record.body.operation === "board.post.append" ||
                    record.body.operation === "pad.patch"
                  )
                );
                if (materializesHere) {
                  materializeFact(writer, record, observedAt);
                }
                accepted += 1;
                if (materializesHere) {
                  changed.add(
                    `${record.item.sink.canvasName}\u0000${record.item.sink.nodeId}`,
                  );
                }
              } else {
                resolvePending(writer, record, observedAt);
                accepted += 1;
              }
              through = seqValue;
            }

            if (through > 0n) {
              const cursorValue = Schema.decodeUnknownSync(
                RouteCursor,
                strictDecode,
              )({
                eventHome: route.eventHome,
                entityHome: route.entityHome,
                through: through.toString(),
              });
              writer.run(
                `
                  INSERT INTO station_received_cursors(
                    event_home,
                    entity_home,
                    through_sequence,
                    updated_at
                  ) VALUES (?, ?, ?, ?)
                  ON CONFLICT(event_home, entity_home) DO UPDATE SET
                    through_sequence = excluded.through_sequence,
                    updated_at = excluded.updated_at
                `,
                [
                  cursorValue.eventHome,
                  cursorValue.entityHome,
                  cursorValue.through,
                  observedAt,
                ],
              );
              acknowledge.push(cursorValue);
            }
          }

          const responseAdmission = input.admitResponse({
            emitted,
            acknowledge,
          });
          if (responseAdmission._tag === "rejected") {
            throw replicationError(
              input.senderInstallationId,
              "response-capacity",
              responseAdmission.message,
            );
          }
          advancePeerAcknowledgements(
            writer,
            localInstallationId,
            input.senderInstallationId,
            input.peerAcknowledgements,
            observedAt,
          );

          return {
            accepted,
            idempotent,
            rejected,
            acknowledge,
            emitted,
            changed: [...changed],
          };
        })
        .pipe(
          Effect.mapError((error) => {
            const cause = stateCause(error);
            if (cause instanceof WorkReplicationError) return cause;
            if (cause instanceof WorkAuthorityError) {
              return replicationError(
                input.senderInstallationId,
                cause.reason === "identity-conflict"
                  ? "identity-conflict"
                  : "causal-conflict",
                cause.message,
              );
            }
            return toRepositoryError("work.acceptRecords", error);
          }),
          Effect.tap((result) =>
            Effect.sync(() => {
              for (const key of result.changed) {
                const separator = key.indexOf("\u0000");
                notify({
                  canvasName: key.slice(0, separator),
                  nodeId: key.slice(separator + 1),
                });
              }
            }),
          ),
          Effect.map(({ changed: _changed, ...result }) => result),
        );
    };

    return WorkRepository.of({
      readSnapshot,
      snapshotsForCanvas: readSnapshotsForCanvas,
      recentOpsForSeat: readRecentOpsForSeat,
      itemHome,
      hasAcceptedDelivery,
      acceptedDeliveryAt,
      createTask,
      createProposal,
      approveProposal,
      rejectProposal,
      describeTask,
      transitionTask,
      claimLocalTask,
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
      reserveRemoteTaskClaim,
      enqueueRemoteCommand,
      enqueueRemoteProposalApproval,
      recordsAfter,
      pendingCommands,
      acceptRecords,
      subscribeChanges: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  }),
);
