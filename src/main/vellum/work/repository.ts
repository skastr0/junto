import { createHash } from "node:crypto";
import { Context, Effect, Either, Layer, Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { ActorSeatId } from "@shared/actor-seat";
import { InstallationId } from "@shared/installation-id";
import {
  StationApiRole,
  type StationApiRole as StationApiRoleValue,
} from "@shared/station-api";
import {
  Artifact,
  Message,
  Task,
  WorkSnapshot,
  type Artifact as ArtifactValue,
  type Message as MessageValue,
  type Task as TaskValue,
  type TaskState,
  type WorkSnapshot as WorkSnapshotValue,
} from "@shared/work-model";
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
  WorkFact,
  WorkRecord,
  WorkSha256,
  decodeWorkRecord,
  type ActorRef,
  type DeliveryReceipt,
  type DisplayTimestamp as DisplayTimestampValue,
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
  mirrorRequestsText,
  mirrorTasksText,
} from "@shared/task";
import {
  StateEngine,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../state/service";

const DEFAULT_RECORD_LIMIT = 256;
const MAX_RECORD_LIMIT = 1_024;

const strictDecode = { onExcessProperty: "error" } as const;

const now = (): DisplayTimestampValue =>
  Schema.decodeUnknownSync(DisplayTimestamp)(new Date().toISOString());

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

export class WorkRepositoryError extends Schema.TaggedError<WorkRepositoryError>()(
  "WorkRepositoryError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class WorkAuthorityError extends Schema.TaggedError<WorkAuthorityError>()(
  "WorkAuthorityError",
  {
    reason: Schema.Literal(
      "authority-mismatch",
      "causal-conflict",
      "claim-contention",
      "identity-conflict",
      "invalid-transition",
      "missing-entity",
      "target-mismatch",
    ),
    message: Schema.String,
  },
) {}

export class WorkReplicationError extends Schema.TaggedError<WorkReplicationError>()(
  "WorkReplicationError",
  {
    reason: Schema.Literal(
      "direction-mismatch",
      "integrity",
      "identity-conflict",
      "causal-conflict",
      "cursor-regression",
      "sequence-gap",
      "response-capacity",
    ),
    senderInstallationId: Schema.String,
    sequence: Schema.optionalWith(LogicalSequence, { exact: true }),
    message: Schema.String,
  },
) {}

type RepositoryFailure =
  | WorkRepositoryError
  | WorkAuthorityError;

type ReplicationFailure =
  | WorkRepositoryError
  | WorkReplicationError;

export type LocalWorkInput = {
  readonly sink: SinkRefValue;
  readonly originAt?: string;
  readonly receivedAt?: string;
};

export type CreateTaskInput = LocalWorkInput & {
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

export type ReserveRemoteTaskClaimInput = LocalWorkInput & {
  readonly taskId: string;
  readonly actor: ActorRef;
  readonly targetInstallationId: InstallationId;
};

export type EnqueueRemoteCommandInput = LocalWorkInput & {
  readonly targetInstallationId: InstallationId;
  readonly item: WorkItemRef;
  readonly action: Exclude<WorkActionValue, { readonly operation: "task.claim" }>;
};

export type LocalFactResult<A> = {
  readonly value: A;
  readonly record: WorkFactValue;
  readonly snapshot: WorkSnapshotValue;
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
  readonly task_id: string | null;
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

const canonicalLocalInstallation = (
  reader: StateReader,
): InstallationId => {
  const row = reader.get<StateRow & { readonly installation_id: string }>(
    `
      SELECT installation_id
      FROM station_installation
      WHERE singleton = 1
    `,
  );
  if (row === undefined) {
    throw new Error("local Station installation identity is not initialized");
  }
  return Schema.decodeUnknownSync(InstallationId)(row.installation_id);
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

const textNode = (node: CanvasNode): CanvasNode =>
  node;

/**
 * Runtime-only overlay retained for canvas readers. SQLite remains the sole
 * durability; this function never converts projected work back into authorial
 * canvas input.
 */
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
      if (snapshot === undefined) return source;
      const node = textNode(source);
      const ether = { ...(node.ether ?? {}) };
      delete ether.tasks;
      delete ether.requests;
      delete ether.messages;
      delete ether.artifacts;
      const kind = node.ether?.entity?.kind;
      if (kind === "task") ether.tasks = snapshot.tasks;
      if (kind === "requests") ether.requests = snapshot.requests;
      if (kind === "artifacts") ether.artifacts = snapshot.artifacts;
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
        ether,
      } as CanvasNode;
    }),
  };
};

const parseJson = (value: string): unknown => JSON.parse(value);

const optionalJson = <A>(value: string | null): A | undefined =>
  value === null ? undefined : (parseJson(value) as A);

const messageFromRow = (
  row: MessageRow,
  parentTaskId?: string,
): MessageValue =>
  Schema.decodeUnknownSync(Message, strictDecode)({
    messageId: row.message_id,
    role: row.role,
    parts: parseJson(row.parts_json),
    ...((row.task_id ?? parentTaskId) === null ||
    (row.task_id ?? parentTaskId) === undefined
      ? {}
      : { taskId: row.task_id ?? parentTaskId }),
    ...(row.context_id === null ? {} : { contextId: row.context_id }),
    ...(row.reference_task_ids_json === null
      ? {}
      : { referenceTaskIds: parseJson(row.reference_task_ids_json) }),
    ...(row.metadata_json === null
      ? {}
      : { metadata: parseJson(row.metadata_json) }),
  });

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

const taskFromRow = (
  reader: StateReader,
  sink: SinkRefValue,
  lane: "task" | "request",
  row: TaskRow,
): TaskValue =>
  Schema.decodeUnknownSync(Task, strictDecode)({
    id: row.item_id,
    state: row.state,
    ...(row.actor_seat_id === null
      ? {}
      : { claimedBy: row.actor_seat_id }),
    history: loadThread(reader, sink, lane, row.item_id),
    ...(row.artifact_ids_json === null
      ? {}
      : { artifactIds: parseJson(row.artifact_ids_json) }),
    ...(row.metadata_json === null
      ? {}
      : { metadata: parseJson(row.metadata_json) }),
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
        ORDER BY created_at, ${id}
      `,
      [sink.canvasName, sink.nodeId],
    )
    .map((row) => taskFromRow(reader, sink, lane, row));
};

const loadInbox = (
  reader: StateReader,
  sink: SinkRefValue,
): ReadonlyArray<MessageValue> =>
  reader
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
    .map((row) => messageFromRow(row));

const loadArtifacts = (
  reader: StateReader,
  sink: SinkRefValue,
): ReadonlyArray<ArtifactValue> =>
  reader
    .all<ArtifactRow>(
      `
        SELECT
          artifact_id,
          name,
          parts_json,
          task_id,
          metadata_json
        FROM work_artifacts
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY artifact_id
      `,
      [sink.canvasName, sink.nodeId],
    )
    .map((row) =>
      Schema.decodeUnknownSync(Artifact, strictDecode)({
        artifactId: row.artifact_id,
        ...(row.name === null ? {} : { name: row.name }),
        parts: parseJson(row.parts_json),
        ...(row.task_id === null ? {} : { taskId: row.task_id }),
        ...(row.metadata_json === null
          ? {}
          : { metadata: parseJson(row.metadata_json) }),
      }),
    );

const loadSnapshot = (
  reader: StateReader,
  sink: SinkRefValue,
): WorkSnapshotValue =>
  Schema.decodeUnknownSync(WorkSnapshot, strictDecode)({
    ...sink,
    tasks: { items: loadLaneTasks(reader, sink, "task") },
    requests: { items: loadLaneTasks(reader, sink, "request") },
    messages: { items: loadInbox(reader, sink) },
    artifacts: { items: loadArtifacts(reader, sink) },
  });

const snapshotsForCanvas = (
  reader: StateReader,
  canvasName: string,
): ReadonlyArray<WorkSnapshotValue> => {
  const nodes = reader.all<StateRow & { readonly node_id: string }>(
    `
      SELECT node_id FROM work_tasks WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_requests WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_messages WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_artifacts WHERE canvas_name = ?
      ORDER BY node_id
    `,
    [canvasName, canvasName, canvasName, canvasName],
  );
  return nodes.map(({ node_id }) =>
    loadSnapshot(reader, { canvasName, nodeId: node_id }),
  );
};

const currentIdentity = (
  row: IdentityRow,
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
  return { row, task: taskFromRow(reader, sink, lane, detail) };
};

const authorityError = (
  reason: WorkAuthorityError["reason"],
  message: string,
): WorkAuthorityError => WorkAuthorityError.make({ reason, message });

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

const loadRecord = (
  reader: StateReader,
  identity: WorkRecordId,
): WorkRecordValue | undefined => {
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
    const row = reader.get<VariantRow>(
      `
        SELECT
          predecessor_event_home,
          predecessor_entity_home,
          predecessor_seq,
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
          result_json
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

const writeInboxMessage = (
  writer: StateWriter,
  sink: SinkRefValue,
  message: MessageValue,
  sentBy: ActorRef,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
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
        task_id,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      artifact.taskId ?? null,
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

const materializeFact = (
  writer: StateWriter,
  fact: WorkFactValue,
  receivedAt: DisplayTimestampValue,
): void => {
  switch (fact.body.operation) {
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
  current: IdentityRow | undefined,
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
    readonly body: WorkResult;
    readonly value: A;
    readonly originAt: DisplayTimestampValue;
    readonly receivedAt: DisplayTimestampValue;
  },
): LocalFactResult<A> => {
  const fact = makeFact(
    writer,
    input.localInstallationId,
    input.item,
    input.operation,
    input.predecessor,
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
    case "task.create":
    case "request.create":
    case "message.append":
    case "artifact.publish":
    case "delivery.accepted":
      return null;
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
      if (!canTransitionTaskState(current!.task.state, action.state)) {
        throw authorityError(
          "invalid-transition",
          `cannot transition task "${action.taskId}" from ${current!.task.state} to ${action.state}`,
        );
      }
      return {
        body: {
          operation: "task.transition",
          task: {
            ...current!.task,
            state: action.state,
            history:
              action.message === undefined
                ? current!.task.history
                : [...current!.task.history, action.message],
          },
        },
      };
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
      FROM work_pending_commands
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
      UPDATE work_pending_commands
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

const findPendingClaim = (
  reader: StateReader,
  sender: InstallationId,
  fact: WorkFactValue,
): WorkCommandValue | undefined => {
  const row = reader.get<
    StateRow & {
      readonly event_home: string;
      readonly entity_home: string;
      readonly seq: string;
    }
  >(
    `
      SELECT event_home, entity_home, seq
      FROM work_pending_commands
      WHERE entity_home = ?
        AND operation = 'task.claim'
        AND item_canvas_name = ?
        AND item_node_id = ?
        AND item_id = ?
        AND resolution_event_home IS NULL
      LIMIT 1
    `,
    [
      sender,
      fact.item.sink.canvasName,
      fact.item.sink.nodeId,
      fact.item.itemId,
    ],
  );
  if (row === undefined) return undefined;
  const record = loadRecord(
    reader,
    recordId(
      row.event_home as InstallationId,
      row.entity_home as InstallationId,
      row.seq,
    ),
  );
  return record?.recordType === "command" ? record : undefined;
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
  switch (fact.body.operation) {
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
        const command = findPendingClaim(writer, sender, fact);
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
      if (
        !canTransitionTaskState(current!.task.state, next.state) ||
        canonicalJson(taskWithoutStateHistoryResponse(next)) !==
          canonicalJson(
            taskWithoutStateHistoryResponse(current!.task),
          ) ||
        next.response !== current!.task.response ||
        !historyIsSameOrOneAppend(current!.task.history, next.history)
      ) {
        throw authorityError(
          "invalid-transition",
          "task.transition fact is not one legal state transition",
        );
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
      return;
    }
    case "message.append": {
      if (fact.body.destination.kind !== "mailbox") {
        requireThreadParent(
          writer,
          fact.item.sink,
          fact.body.destination,
          sender,
        );
      }
      assertMessageIdentityAvailable(
        writer,
        fact.item.sink,
        fact.item.itemId,
      );
      return;
    }
    case "artifact.publish": {
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
      !sameItem(fact.item, disposition.item)
    ) {
      throw authorityError(
        "causal-conflict",
        "applied disposition fact reference is not coherent",
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

export class WorkRepository extends Context.Tag("@vellum/WorkRepository")<
  WorkRepository,
  {
    readonly readSnapshot: (
      canvasName: string,
      nodeId: string,
    ) => Effect.Effect<WorkSnapshotValue, WorkRepositoryError>;
    readonly snapshotsForCanvas: (
      canvasName: string,
    ) => Effect.Effect<ReadonlyArray<WorkSnapshotValue>, WorkRepositoryError>;
    readonly itemHome: (
      lane: "task" | "request",
      canvasName: string,
      nodeId: string,
      itemId: string,
    ) => Effect.Effect<InstallationId | undefined, WorkRepositoryError>;
    readonly hasAcceptedDelivery: (
      sink: SinkRefValue,
      deliveryId: string,
    ) => Effect.Effect<boolean, WorkRepositoryError>;
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
    readonly reserveRemoteTaskClaim: (
      input: ReserveRemoteTaskClaimInput,
    ) => Effect.Effect<WorkCommandValue, RepositoryFailure>;
    readonly enqueueRemoteCommand: (
      input: EnqueueRemoteCommandInput,
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
>() {}

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

    const itemHome = (
      lane: "task" | "request",
      canvasName: string,
      nodeId: string,
      itemId: string,
    ): Effect.Effect<InstallationId | undefined, WorkRepositoryError> =>
      state
        .read("work.itemHome", (reader) =>
          selectTaskIdentity(
            reader,
            lane,
            { canvasName, nodeId },
            itemId,
          )?.entity_home as InstallationId | undefined,
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
      state
        .read(
          "work.hasAcceptedDelivery",
          (reader) =>
            reader.get<StateRow>(
              `
                SELECT 1
                FROM work_delivery_receipts
                WHERE delivered_canvas_name = ?
                  AND delivered_node_id = ?
                  AND delivery_id = ?
              `,
              [sink.canvasName, sink.nodeId, deliveryId],
            ) !== undefined,
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.hasAcceptedDelivery", error),
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
        return commitLocalFact(writer, {
          localInstallationId,
          sink: input.sink,
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
          current.task.state === "rejected"
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
        const task = Schema.decodeUnknownSync(Task, strictDecode)({
          ...current.task,
          state: input.state,
          history:
            message === undefined
              ? current.task.history
              : [...current.task.history, message],
        });
        return commitLocalFact(writer, {
          localInstallationId,
          sink: input.sink,
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
        assertActorAvailable(writer, input.actor.seatId);
        const task = Schema.decodeUnknownSync(Task, strictDecode)({
          ...current.task,
          state: "working",
          claimedBy: input.actor.seatId,
        });
        return commitLocalFact(writer, {
          localInstallationId,
          sink: input.sink,
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
          (request.state !== "input-required" &&
            request.state !== "auth-required") ||
          request.claimedBy !== input.raisedBy.seatId
        ) {
          throw authorityError(
            "authority-mismatch",
            "request must be attention-state work claimed by its exact raiser",
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
      const message = Schema.decodeUnknownSync(
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
                FROM work_events
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
              FROM work_pending_commands
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
          if (Either.isLeft(result)) {
            return Effect.fail(
              replicationError(
                input.senderInstallationId,
                "integrity",
                "report contains a malformed Work record",
              ),
            );
          }
          validateIncomingHash(input.senderInstallationId, result.right);
          decoded.push(result.right);
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
          const localInstallationId = canonicalLocalInstallation(writer);
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
              const existing = eventRow(writer, record.id);
              if (seqValue <= through) {
                if (
                  existing === undefined ||
                  existing.content_sha256 !== record.contentSha256
                ) {
                  throw replicationError(
                    input.senderInstallationId,
                    existing === undefined
                      ? "cursor-regression"
                      : "identity-conflict",
                    existing === undefined
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
              if (existing !== undefined) {
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
                materializeFact(writer, record, observedAt);
                accepted += 1;
                changed.add(
                  `${record.item.sink.canvasName}\u0000${record.item.sink.nodeId}`,
                );
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
      itemHome,
      hasAcceptedDelivery,
      createTask,
      describeTask,
      transitionTask,
      claimLocalTask,
      createRequest,
      resolveRequest,
      appendMessage,
      publishArtifact,
      acceptDelivery,
      reserveRemoteTaskClaim,
      enqueueRemoteCommand,
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
