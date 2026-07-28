import { createHash } from "node:crypto";
import { Context, Effect, Either, Layer, Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import {
  InstallationId,
  LogicalSequence,
  STATION_API_MAX_EVENTS_PER_REPORT,
  StationEvent,
  StationEventAck,
  StationSha256,
  type InstallationId as InstallationIdValue,
  type LogicalSequence as LogicalSequenceValue,
  type StationEvent as StationEventValue,
  type StationEventAck as StationEventAckValue,
} from "@shared/station-api";
import {
  Artifact,
  Message,
  Task,
  type Artifact as ArtifactValue,
  type Message as MessageValue,
  type Task as TaskValue,
  type TaskState,
  type WorkSnapshot,
} from "@shared/work-model";
import {
  claimedByOf,
  mirrorArtifactsText,
  mirrorRequestsText,
  mirrorTasksText,
} from "@shared/task";
import { WorkError } from "@shared/work";
import {
  StateEngine,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../state/service";

/**
 * Messages are fleet mail, not stationed execution state. This logical home
 * is intentionally outside the HostId alphabet so it can never be confused
 * with a machine placement.
 */
export const COMMAND_CENTER_WORK_HOME = "vellum:command-center" as const;

type WorkLane = "task" | "request";
type WorkEntityKind = WorkLane | "message" | "artifact" | "receipt";

export type WorkEventIdentity = {
  readonly eventHome: string;
  readonly entityHome: string;
  readonly seq: string;
};

export class WorkRepositoryError extends Schema.TaggedError<WorkRepositoryError>()(
  "WorkRepositoryError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class WorkReplicationError extends Schema.TaggedError<WorkReplicationError>()(
  "WorkReplicationError",
  {
    reason: Schema.Literal(
      "event-home-mismatch",
      "entity-home-mismatch",
      "unsupported-message",
      "invalid-payload",
      "integrity",
      "identity-conflict",
      "causal-conflict",
      "cursor-regression",
      "sequence-gap",
      "batch-limit",
    ),
    eventHome: InstallationId,
    sequence: LogicalSequence,
    message: Schema.String,
  },
) {}

export type WorkEvent = {
  /** Installation-local source stream. Never inferred from entity placement. */
  readonly eventHome: string;
  /** Single execution home for the entity represented by this event. */
  readonly homeStation: string;
  readonly seq: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly entityKind: WorkEntityKind;
  readonly entityId: string;
  readonly operation: string;
  readonly originAt: string;
  readonly receivedAt: string;
  /** Immutable canonical event envelope used by station propagation/replay. */
  readonly payloadJson: string;
  readonly contentSha256: string;
};

export type WorkMutationInput<A> = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly entityHome: string;
  readonly eventHome: string;
  /**
   * Remote commands are durable outbox facts first. Their material state is
   * promoted only by the owning Remote's ordered applied disposition.
   */
  readonly materialization?: "immediate" | "on-disposition";
  readonly operation: string;
  readonly authoredDoc: CanvasDoc;
  readonly transform: (projectedDoc: CanvasDoc) => {
    readonly doc: CanvasDoc;
    readonly value: A;
  };
  readonly originAt?: string;
  readonly receivedAt?: string;
};

export type AcceptReplicatedWorkInput = {
  readonly localEventHome: InstallationIdValue;
  readonly eventHome: InstallationIdValue;
  readonly entityHome: string;
  readonly events: ReadonlyArray<StationEventValue>;
  readonly causalConflict: "fail" | "reject-command";
  readonly receivedAt?: string;
};

export type AcceptReplicatedWorkResult = {
  readonly accepted: number;
  readonly idempotent: number;
  readonly rejected: number;
  readonly acknowledgement: StationEventAckValue;
};

export type WorkRejection = {
  readonly rejected: WorkEventIdentity;
  readonly contentSha256: string;
  readonly reason: "causal-conflict";
  readonly message: string;
  readonly reportedBy: string;
  readonly receipt: WorkEventIdentity;
  readonly receivedAt: string;
};

export type WorkPendingCommand = {
  readonly command: WorkEventIdentity;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly entityKind: "task" | "request" | "artifact";
  readonly entityId: string;
  readonly operation: string;
};

export type WorkCommandStatus = {
  readonly counts: {
    readonly pending: number;
    readonly applied: number;
    readonly rejected: number;
  };
  readonly pending: ReadonlyArray<WorkPendingCommand>;
  readonly rejections: ReadonlyArray<WorkRejection>;
  readonly truncated: {
    readonly pending: boolean;
    readonly rejections: boolean;
  };
};

export type WorkEventsAfterInput = {
  readonly eventHome: string;
  readonly entityHome: string;
  readonly afterSeq: string;
  readonly limit?: number;
};

export const stationEventFromWorkEvent = (
  event: WorkEvent,
): StationEventValue =>
  StationEvent.make({
    identity: {
      home: Schema.decodeUnknownSync(InstallationId)(event.eventHome),
      sequence: Schema.decodeUnknownSync(LogicalSequence)(event.seq),
    },
    kind: "work.event",
    body: event.payloadJson,
    contentSha256: event.contentSha256 as StationEventValue["contentSha256"],
    originAt: event.originAt,
    receivedAt: event.receivedAt,
  });

export type WorkMutationResult<A> = {
  readonly value: A;
  readonly snapshot: WorkSnapshot;
  readonly projectedDoc: CanvasDoc;
  readonly disposition: "applied" | "queued";
};

/**
 * Runtime read projection. Durable rows are overlaid on the authorial document
 * for renderer/kernel consumers and are never written to canvas authority.
 */
export const projectWorkSnapshots = (
  doc: CanvasDoc,
  snapshots: ReadonlyArray<WorkSnapshot>,
): CanvasDoc => {
  const byNode = new Map(snapshots.map((snapshot) => [snapshot.nodeId, snapshot]));
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      const snapshot = byNode.get(node.id);
      if (!snapshot) return node;

      const kind = node.ether?.entity?.kind;
      const ether = { ...(node.ether ?? {}) };
      delete ether.tasks;
      delete ether.requests;
      delete ether.messages;
      delete ether.artifacts;

      let text = node.type === "text" ? node.text : undefined;
      if (kind === "task") {
        ether.tasks = { items: [...snapshot.tasks.items] };
        text = mirrorTasksText(snapshot.tasks.items);
      } else if (kind === "requests") {
        ether.requests = { items: [...snapshot.requests.items] };
        text = mirrorRequestsText(snapshot.requests.items);
      } else if (kind === "artifacts") {
        ether.artifacts = { items: [...snapshot.artifacts.items] };
        text = mirrorArtifactsText(snapshot.artifacts.items);
      }

      if (kind === "agent" || snapshot.messages.items.length > 0) {
        ether.messages = { items: [...snapshot.messages.items] };
      }

      return {
        ...node,
        ...(node.type === "text" && text !== undefined ? { text } : {}),
        ...(Object.keys(ether).length > 0 ? { ether } : {}),
      } as CanvasNode;
    }),
  };
};

/**
 * Remove runtime work data before a document crosses the authorial persistence
 * boundary.
 *
 * Native sink text is reset only when a projected container was actually
 * present. That preserves an operator-authored label on a pristine sink while
 * preventing the last projected task list from becoming stale durable intent.
 */
export const stripWorkProjection = (doc: CanvasDoc): CanvasDoc => ({
  ...doc,
  nodes: doc.nodes.map((node) => {
    const etherIn = node.ether;
    if (
      etherIn === undefined ||
      (
        etherIn.tasks === undefined &&
        etherIn.requests === undefined &&
        etherIn.messages === undefined &&
        etherIn.artifacts === undefined
      )
    ) {
      return node;
    }

    const {
      tasks: _tasks,
      requests: _requests,
      messages: _messages,
      artifacts: _artifacts,
      ...ether
    } = etherIn;
    const kind = ether.entity?.kind;
    const text =
      node.type !== "text"
        ? undefined
        : kind === "task"
          ? mirrorTasksText([])
          : kind === "requests"
            ? mirrorRequestsText([])
            : kind === "artifacts"
              ? mirrorArtifactsText([])
              : node.text;

    if (Object.keys(ether).length === 0) {
      const { ether: _removed, ...withoutEther } = node;
      return {
        ...withoutEther,
        ...(node.type === "text" && text !== undefined ? { text } : {}),
      } as CanvasNode;
    }
    return {
      ...node,
      ...(node.type === "text" && text !== undefined ? { text } : {}),
      ether,
    } as CanvasNode;
  }),
});

/** Recover the target lane after a pure runtime-projection transform. */
const snapshotFromRuntimeProjection = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
): WorkSnapshot => {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new WorkError("node_not_found", `node "${nodeId}" not found`);
  }
  return {
    canvasName,
    nodeId,
    tasks: { items: [...(node.ether?.tasks?.items ?? [])] },
    requests: { items: [...(node.ether?.requests?.items ?? [])] },
    messages: { items: [...(node.ether?.messages?.items ?? [])] },
    artifacts: { items: [...(node.ether?.artifacts?.items ?? [])] },
  };
};

type TaskRow = StateRow & {
  readonly task_id: string;
  readonly home_station: string;
  readonly event_home: string;
  readonly event_seq: string;
  readonly state: string;
  readonly brief_message_id: string;
  readonly artifact_ids_json: string | null;
  readonly metadata_json: string | null;
  readonly reason: string | null;
  readonly response: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly origin_at: string;
  readonly received_at: string;
};

type MessageRow = StateRow & {
  readonly message_id: string;
  readonly task_id: string | null;
  readonly message_kind: string;
  readonly role: string;
  readonly parts_json: string;
  readonly context_id: string | null;
  readonly reference_task_ids_json: string | null;
  readonly metadata_json: string | null;
  readonly origin_at: string;
  readonly received_at: string;
};

type ArtifactRow = StateRow & {
  readonly artifact_id: string;
  readonly home_station: string;
  readonly event_home: string;
  readonly event_seq: string;
  readonly name: string | null;
  readonly parts_json: string;
  readonly task_id: string | null;
  readonly metadata_json: string | null;
  readonly origin_at: string;
  readonly received_at: string;
};

type WorkEventRow = StateRow & {
  readonly event_home: string;
  readonly entity_home: string;
  readonly seq: string;
  readonly canvas_name: string;
  readonly node_id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly operation: string;
  readonly origin_at: string;
  readonly received_at: string;
  readonly payload_json: string;
  readonly content_sha256: string;
};

type ReceivedCursorRow = StateRow & {
  readonly home: string;
  readonly through_sequence: string;
};

type WorkRejectionRow = StateRow & {
  readonly rejected_event_home: string;
  readonly rejected_entity_home: string;
  readonly rejected_seq: string;
  readonly rejected_content_sha256: string;
  readonly reason: string;
  readonly message: string;
  readonly reported_by: string;
  readonly receipt_event_home: string;
  readonly receipt_event_seq: string;
  readonly received_at: string;
};

type PendingCommandRow = StateRow & {
  readonly event_home: string;
  readonly entity_home: string;
  readonly seq: string;
  readonly status: "pending" | "applied" | "rejected";
  readonly acknowledged_by: string | null;
  readonly resolved_at: string | null;
};

type PendingCommandDetailRow = PendingCommandRow & {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly entity_kind: "task" | "request" | "artifact";
  readonly entity_id: string;
  readonly operation: string;
};

type CountRow = StateRow & {
  readonly count: number;
};

const jsonOptional = (value: unknown | undefined): string | null =>
  value === undefined ? null : JSON.stringify(value);

const canonicalJsonValue = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("work event payload cannot contain a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined ? null : canonicalJsonValue(entry),
    );
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) output[key] = canonicalJsonValue(entry);
    }
    return output;
  }
  throw new Error(
    `work event payload cannot encode ${typeof value}`,
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalJsonValue(value));

const taskTable = (lane: WorkLane): "work_tasks" | "work_requests" =>
  lane === "task" ? "work_tasks" : "work_requests";

const messageFromRow = (row: MessageRow): MessageValue =>
  Schema.decodeUnknownSync(Message)({
    messageId: row.message_id,
    role: row.role,
    parts: JSON.parse(row.parts_json),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.context_id === null ? {} : { contextId: row.context_id }),
    ...(row.reference_task_ids_json === null
      ? {}
      : { referenceTaskIds: JSON.parse(row.reference_task_ids_json) }),
    ...(row.metadata_json === null
      ? {}
      : { metadata: JSON.parse(row.metadata_json) }),
  });

const linkedMessageRows = (
  reader: StateReader,
  canvasName: string,
  nodeId: string,
  lane: WorkLane,
  taskId: string,
): ReadonlyArray<MessageRow> =>
  reader.all<MessageRow>(
    `
      SELECT
        message_id,
        task_id,
        message_kind,
        role,
        parts_json,
        context_id,
        reference_task_ids_json,
        metadata_json,
        origin_at,
        received_at
      FROM work_task_messages
      WHERE canvas_name = ?
        AND node_id = ?
        AND parent_lane = ?
        AND task_id = ?
      ORDER BY position, message_id
    `,
    [canvasName, nodeId, lane, taskId],
  );

const loadLaneTasks = (
  reader: StateReader,
  canvasName: string,
  nodeId: string,
  lane: WorkLane,
): ReadonlyArray<TaskValue> => {
  const rows = reader.all<TaskRow>(
    `
      SELECT
        task_id,
        home_station,
        event_home,
        event_seq,
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
      FROM ${taskTable(lane)}
      WHERE canvas_name = ? AND node_id = ?
      ORDER BY created_at, task_id
    `,
    [canvasName, nodeId],
  );

  return rows.map((row) => {
    const messageRows = linkedMessageRows(
      reader,
      canvasName,
      nodeId,
      lane,
      row.task_id,
    );
    const brief = messageRows.find(
      (message) => message.message_id === row.brief_message_id,
    );
    if (!brief) {
      throw new Error(
        `${lane} "${row.task_id}" references missing brief message "${row.brief_message_id}"`,
      );
    }
    const history = [
      messageFromRow(brief),
      ...messageRows
        .filter(
          (message) =>
            message.message_kind !== "brief" &&
            message.message_id !== row.brief_message_id,
        )
        .map(messageFromRow),
    ];
    return Schema.decodeUnknownSync(Task)({
      id: row.task_id,
      state: row.state,
      history,
      ...(row.artifact_ids_json === null
        ? {}
        : { artifactIds: JSON.parse(row.artifact_ids_json) }),
      ...(row.metadata_json === null
        ? {}
        : { metadata: JSON.parse(row.metadata_json) }),
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.response === null ? {} : { response: row.response }),
    });
  });
};

const loadInboxMessages = (
  reader: StateReader,
  canvasName: string,
  nodeId: string,
): ReadonlyArray<MessageValue> =>
  reader
    .all<MessageRow>(
      `
        SELECT
          message_id,
          NULL AS task_id,
          'inbox' AS message_kind,
          role,
          parts_json,
          context_id,
          reference_task_ids_json,
          metadata_json,
          origin_at,
          received_at
        FROM work_messages
        WHERE canvas_name = ?
          AND node_id = ?
        ORDER BY position, message_id
      `,
      [canvasName, nodeId],
    )
    .map(messageFromRow);

const loadArtifacts = (
  reader: StateReader,
  canvasName: string,
  nodeId: string,
): ReadonlyArray<ArtifactValue> =>
  reader
    .all<ArtifactRow>(
      `
        SELECT
          artifact_id,
          home_station,
          event_home,
          event_seq,
          name,
          parts_json,
          task_id,
          metadata_json,
          origin_at,
          received_at
        FROM work_artifacts
        WHERE canvas_name = ? AND node_id = ?
        ORDER BY artifact_id
      `,
      [canvasName, nodeId],
    )
    .map((row) =>
      Schema.decodeUnknownSync(Artifact)({
        artifactId: row.artifact_id,
        parts: JSON.parse(row.parts_json),
        ...(row.name === null ? {} : { name: row.name }),
        ...(row.task_id === null ? {} : { taskId: row.task_id }),
        ...(row.metadata_json === null
          ? {}
          : { metadata: JSON.parse(row.metadata_json) }),
      }),
    );

const loadSnapshot = (
  reader: StateReader,
  canvasName: string,
  nodeId: string,
): WorkSnapshot => ({
  canvasName,
  nodeId,
  tasks: { items: [...loadLaneTasks(reader, canvasName, nodeId, "task")] },
  requests: {
    items: [...loadLaneTasks(reader, canvasName, nodeId, "request")],
  },
  messages: { items: [...loadInboxMessages(reader, canvasName, nodeId)] },
  artifacts: { items: [...loadArtifacts(reader, canvasName, nodeId)] },
});

const loadSnapshotsForCanvas = (
  reader: StateReader,
  canvasName: string,
): ReadonlyArray<WorkSnapshot> => {
  const nodes = reader.all<StateRow & { readonly node_id: string }>(
    `
      SELECT node_id FROM work_tasks WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_requests WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_task_messages WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_messages WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_artifacts WHERE canvas_name = ?
      ORDER BY node_id
    `,
    [canvasName, canvasName, canvasName, canvasName, canvasName],
  );
  return nodes.map((row) => loadSnapshot(reader, canvasName, row.node_id));
};

const canonicalSequence = (raw: string): string => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`invalid persisted work sequence "${raw}"`);
  }
  return raw;
};

const workRejectionFromRow = (
  row: WorkRejectionRow,
): WorkRejection => ({
  rejected: {
    eventHome: row.rejected_event_home,
    entityHome: row.rejected_entity_home,
    seq: canonicalSequence(row.rejected_seq),
  },
  contentSha256: row.rejected_content_sha256,
  reason: "causal-conflict",
  message: row.message,
  reportedBy: row.reported_by,
  receipt: {
    eventHome: row.receipt_event_home,
    entityHome: row.rejected_entity_home,
    seq: canonicalSequence(row.receipt_event_seq),
  },
  receivedAt: row.received_at,
});

const nextSequence = (
  writer: StateWriter,
  eventHome: string,
  entityHome: string,
): string => {
  writer.run(
    `
      INSERT OR IGNORE INTO work_event_sequences(
        event_home,
        entity_home,
        last_seq
      ) VALUES (?, ?, '0')
    `,
    [eventHome, entityHome],
  );
  const row = writer.get<StateRow & { readonly last_seq: string }>(
    `
      SELECT last_seq
      FROM work_event_sequences
      WHERE event_home = ? AND entity_home = ?
    `,
    [eventHome, entityHome],
  );
  if (!row) throw new Error(`failed to allocate event stream "${eventHome}"`);
  const next = (BigInt(canonicalSequence(row.last_seq)) + 1n).toString();
  const updated = writer.run(
    `
      UPDATE work_event_sequences
      SET last_seq = ?
      WHERE event_home = ? AND entity_home = ? AND last_seq = ?
    `,
    [next, eventHome, entityHome, row.last_seq],
  );
  if (Number(updated.changes) !== 1) {
    throw new Error(`work sequence contention for stream "${eventHome}"`);
  }
  return next;
};

const recordEvent = (
  writer: StateWriter,
  input: {
    readonly eventHome: string;
    readonly entityHome: string;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityKind: WorkEntityKind;
    readonly entityId: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly predecessor: WorkEventIdentity | null;
    readonly payload: unknown;
  },
): WorkEventIdentity => {
  const seq = nextSequence(writer, input.eventHome, input.entityHome);
  // StationEvent content identity is semantic: receipt time, origin clock,
  // home, and sequence are envelope metadata and never perturb this hash.
  const payloadJson = canonicalJson({
    schema: "vellum/work-event/v1",
    entityHome: input.entityHome,
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityKind: input.entityKind,
    entityId: input.entityId,
    operation: input.operation,
    predecessor: input.predecessor,
    body: input.payload,
  });
  const contentSha256 = createHash("sha256")
    .update(payloadJson, "utf8")
    .digest("hex");
  writer.run(
    `
      INSERT INTO work_events(
        event_home,
        seq,
        entity_home,
        canvas_name,
        node_id,
        entity_kind,
        entity_id,
        operation,
        origin_at,
        received_at,
        payload_json,
        content_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.eventHome,
      seq,
      input.entityHome,
      input.canvasName,
      input.nodeId,
      input.entityKind,
      input.entityId,
      input.operation,
      input.originAt,
      input.receivedAt,
      payloadJson,
      contentSha256,
    ],
  );
  return {
    eventHome: input.eventHome,
    entityHome: input.entityHome,
    seq,
  };
};

const taskScalar = (task: TaskValue): string =>
  JSON.stringify({
    state: task.state,
    artifactIds: task.artifactIds,
    metadata: task.metadata,
    reason: task.reason,
    response: task.response,
  });

const messageScalar = (message: MessageValue): string =>
  JSON.stringify(message);

const artifactScalar = (artifact: ArtifactValue): string =>
  JSON.stringify(artifact);

const byTaskId = (
  items: ReadonlyArray<TaskValue>,
): ReadonlyMap<string, TaskValue> => {
  const map = new Map<string, TaskValue>();
  for (const item of items) {
    if (map.has(item.id)) {
      throw new WorkError("invalid", `duplicate task id "${item.id}"`);
    }
    map.set(item.id, item);
  }
  return map;
};

const byMessageId = (
  items: ReadonlyArray<MessageValue>,
): ReadonlyMap<string, MessageValue> => {
  const map = new Map<string, MessageValue>();
  for (const item of items) {
    if (map.has(item.messageId)) {
      throw new WorkError(
        "invalid",
        `duplicate message id "${item.messageId}"`,
      );
    }
    map.set(item.messageId, item);
  }
  return map;
};

const byArtifactId = (
  items: ReadonlyArray<ArtifactValue>,
): ReadonlyMap<string, ArtifactValue> => {
  const map = new Map<string, ArtifactValue>();
  for (const item of items) {
    if (map.has(item.artifactId)) {
      throw new WorkError(
        "invalid",
        `duplicate artifact id "${item.artifactId}"`,
      );
    }
    map.set(item.artifactId, item);
  }
  return map;
};

type MessageInsert = {
  readonly message: MessageValue;
  readonly lane: WorkLane | null;
  readonly taskId: string | null;
  readonly position: number;
  readonly kind: "brief" | "history" | "inbox";
};

type TaskChange = {
  readonly lane: WorkLane;
  readonly before: TaskValue | undefined;
  readonly after: TaskValue;
  readonly briefMessageId: string;
};

type WorkMutationPlan = {
  readonly taskChanges: ReadonlyArray<TaskChange>;
  readonly messageInserts: ReadonlyArray<MessageInsert>;
  readonly artifactInserts: ReadonlyArray<ArtifactValue>;
};

const planTaskLane = (
  lane: WorkLane,
  beforeItems: ReadonlyArray<TaskValue>,
  afterItems: ReadonlyArray<TaskValue>,
): {
  readonly taskChanges: ReadonlyArray<TaskChange>;
  readonly messageInserts: ReadonlyArray<MessageInsert>;
} => {
  const before = byTaskId(beforeItems);
  const after = byTaskId(afterItems);
  for (const taskId of before.keys()) {
    if (!after.has(taskId)) {
      throw new WorkError(
        "invalid",
        `${lane} "${taskId}" cannot be deleted through a work mutation`,
      );
    }
  }

  const taskChanges: TaskChange[] = [];
  const messageInserts: MessageInsert[] = [];
  for (const task of after.values()) {
    if (task.history.length === 0) {
      throw new WorkError(
        "invalid",
        `${lane} "${task.id}" must retain a brief message`,
      );
    }
    const prior = before.get(task.id);
    const nextMessages = byMessageId(task.history);
    const brief = task.history[0]!;

    if (!prior) {
      taskChanges.push({
        lane,
        before: undefined,
        after: task,
        briefMessageId: brief.messageId,
      });
      task.history.forEach((message, position) => {
        messageInserts.push({
          message,
          lane,
          taskId: task.id,
          position,
          kind: position === 0 ? "brief" : "history",
        });
      });
      continue;
    }

    const priorMessages = byMessageId(prior.history);
    const priorBriefId = prior.history[0]?.messageId;
    for (const message of prior.history.slice(1)) {
      if (!nextMessages.has(message.messageId)) {
        throw new WorkError(
          "invalid",
          `${lane} "${task.id}" history message "${message.messageId}" cannot be deleted`,
        );
      }
      const nextMessage = nextMessages.get(message.messageId)!;
      if (messageScalar(message) !== messageScalar(nextMessage)) {
        throw new WorkError(
          "invalid",
          `${lane} "${task.id}" history message "${message.messageId}" is immutable`,
        );
      }
    }

    let nextPosition = prior.history.length;
    let addedHistory = false;
    for (const message of task.history) {
      if (priorMessages.has(message.messageId)) continue;
      addedHistory = true;
      messageInserts.push({
        message,
        lane,
        taskId: task.id,
        position: nextPosition,
        kind:
          message.messageId === brief.messageId &&
          message.messageId !== priorBriefId
            ? "brief"
            : "history",
      });
      nextPosition += 1;
    }

    if (
      taskScalar(prior) !== taskScalar(task) ||
      priorBriefId !== brief.messageId ||
      addedHistory
    ) {
      taskChanges.push({
        lane,
        before: prior,
        after: task,
        briefMessageId: brief.messageId,
      });
    }
  }
  return { taskChanges, messageInserts };
};

const planInbox = (
  beforeItems: ReadonlyArray<MessageValue>,
  afterItems: ReadonlyArray<MessageValue>,
): ReadonlyArray<MessageInsert> => {
  const before = byMessageId(beforeItems);
  const after = byMessageId(afterItems);
  for (const [messageId, message] of before) {
    const next = after.get(messageId);
    if (!next) {
      throw new WorkError(
        "invalid",
        `inbox message "${messageId}" cannot be deleted`,
      );
    }
    if (messageScalar(message) !== messageScalar(next)) {
      throw new WorkError(
        "invalid",
        `inbox message "${messageId}" is immutable`,
      );
    }
  }
  const inserts: MessageInsert[] = [];
  let position = beforeItems.length;
  for (const message of afterItems) {
    if (before.has(message.messageId)) continue;
    inserts.push({
      message,
      lane: null,
      taskId: null,
      position,
      kind: "inbox",
    });
    position += 1;
  }
  return inserts;
};

const planArtifacts = (
  beforeItems: ReadonlyArray<ArtifactValue>,
  afterItems: ReadonlyArray<ArtifactValue>,
): ReadonlyArray<ArtifactValue> => {
  const before = byArtifactId(beforeItems);
  const after = byArtifactId(afterItems);
  for (const [artifactId, artifact] of before) {
    const next = after.get(artifactId);
    if (!next) {
      throw new WorkError(
        "invalid",
        `artifact "${artifactId}" cannot be deleted`,
      );
    }
    if (artifactScalar(artifact) !== artifactScalar(next)) {
      throw new WorkError(
        "invalid",
        `artifact "${artifactId}" is immutable`,
      );
    }
  }
  return afterItems.filter((artifact) => !before.has(artifact.artifactId));
};

const planMutation = (
  before: WorkSnapshot,
  after: WorkSnapshot,
): WorkMutationPlan => {
  const tasks = planTaskLane("task", before.tasks.items, after.tasks.items);
  const requests = planTaskLane(
    "request",
    before.requests.items,
    after.requests.items,
  );
  return {
    taskChanges: [...tasks.taskChanges, ...requests.taskChanges],
    messageInserts: [
      ...tasks.messageInserts,
      ...requests.messageInserts,
      ...planInbox(before.messages.items, after.messages.items),
    ],
    artifactInserts: planArtifacts(
      before.artifacts.items,
      after.artifacts.items,
    ),
  };
};

const existingTaskHome = (
  writer: StateReader,
  lane: WorkLane,
  canvasName: string,
  nodeId: string,
  taskId: string,
): string | undefined =>
  writer.get<StateRow & { readonly home_station: string }>(
    `
      SELECT home_station
      FROM ${taskTable(lane)}
      WHERE canvas_name = ? AND node_id = ? AND task_id = ?
    `,
    [canvasName, nodeId, taskId],
  )?.home_station;

const existingArtifactHome = (
  writer: StateWriter,
  canvasName: string,
  nodeId: string,
  artifactId: string,
): string | undefined =>
  writer.get<StateRow & { readonly home_station: string }>(
    `
      SELECT home_station
      FROM work_artifacts
      WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?
    `,
    [canvasName, nodeId, artifactId],
  )?.home_station;

const assertImmutableHome = (
  entity: string,
  existing: string | undefined,
  requested: string,
): void => {
  if (existing !== undefined && existing !== requested) {
    throw new WorkError(
      "invalid",
      `${entity} is homed on "${existing}"; explicit re-home is required before "${requested}"`,
    );
  }
};

const isFirstTaskClaimTransfer = (
  operation: string,
  change: TaskChange,
  existingHome: string | undefined,
  requestedHome: string,
): boolean =>
  change.lane === "task" &&
  operation === "task.claim" &&
  existingHome !== undefined &&
  existingHome !== requestedHome &&
  change.before?.state === "submitted" &&
  claimedByOf(change.before) === undefined &&
  change.after.state === "working" &&
  claimedByOf(change.after) !== undefined;

const assertActorClaimAvailable = (
  reader: StateReader,
  input: {
    readonly actor: string;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly taskId: string;
  },
): void => {
  const active = reader.get<StateRow>(
    `
      SELECT 1 AS occupied
      FROM work_tasks
      WHERE json_extract(metadata_json, '$.claimedBy') = ?
        AND state IN ('working', 'input-required', 'auth-required')
        AND NOT (
          canvas_name = ?
          AND node_id = ?
          AND task_id = ?
        )
      LIMIT 1
    `,
    [input.actor, input.canvasName, input.nodeId, input.taskId],
  );
  if (active !== undefined) {
    throw new WorkError(
      "claim_contention",
      `actor "${input.actor}" already owns a non-terminal task`,
    );
  }

  const pending = reader.get<StateRow>(
    `
      SELECT 1 AS occupied
      FROM work_pending_commands AS command
      JOIN work_events AS event
        ON event.event_home = command.event_home
       AND event.entity_home = command.entity_home
       AND event.seq = command.seq
      WHERE command.status = 'pending'
        AND event.operation = 'task.claim'
        AND json_extract(
          event.payload_json,
          '$.body.task.metadata.claimedBy'
        ) = ?
        AND NOT (
          event.canvas_name = ?
          AND event.node_id = ?
          AND event.entity_id = ?
        )
      LIMIT 1
    `,
    [input.actor, input.canvasName, input.nodeId, input.taskId],
  );
  if (pending !== undefined) {
    throw new WorkError(
      "claim_contention",
      `actor "${input.actor}" already has a pending task claim`,
    );
  }
};

const currentTaskEvent = (
  writer: StateWriter,
  lane: WorkLane,
  canvasName: string,
  nodeId: string,
  taskId: string,
): WorkEventIdentity | null => {
  const row = writer.get<
    StateRow & {
      readonly event_home: string;
      readonly event_seq: string;
      readonly home_station: string;
    }
  >(
    `
      SELECT event_home, event_seq, home_station
      FROM ${taskTable(lane)}
      WHERE canvas_name = ? AND node_id = ? AND task_id = ?
    `,
    [canvasName, nodeId, taskId],
  );
  return row === undefined
    ? null
    : {
        eventHome: row.event_home,
        entityHome: row.home_station,
        seq: row.event_seq,
      };
};

const insertTaskMessage = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly insert: MessageInsert;
    readonly event: WorkEventIdentity;
  },
): void => {
  const message = input.insert.message;
  if (input.insert.lane === null || input.insert.taskId === null) {
    throw new Error("task history materialization requires a parent task");
  }
  writer.run(
    `
      INSERT INTO work_task_messages(
        canvas_name,
        node_id,
        parent_lane,
        task_id,
        message_id,
        position,
        message_kind,
        entity_home,
        event_home,
        event_seq,
        role,
        parts_json,
        context_id,
        reference_task_ids_json,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.canvasName,
      input.nodeId,
      input.insert.lane,
      input.insert.taskId,
      message.messageId,
      input.insert.position,
      input.insert.kind,
      input.event.entityHome,
      input.event.eventHome,
      input.event.seq,
      message.role,
      JSON.stringify(message.parts),
      message.contextId ?? null,
      jsonOptional(message.referenceTaskIds),
      jsonOptional(message.metadata),
      input.originAt,
      input.receivedAt,
    ],
  );
};

const insertInboxMessage = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly eventHome: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly insert: MessageInsert;
  },
): void => {
  if (input.insert.lane !== null || input.insert.taskId !== null) {
    throw new Error("inbox materialization cannot contain task history");
  }
  const message = input.insert.message;
  const event = recordEvent(writer, {
    eventHome: input.eventHome,
    entityHome: COMMAND_CENTER_WORK_HOME,
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityKind: "message",
    entityId: message.messageId,
    operation: input.operation,
    originAt: input.originAt,
    receivedAt: input.receivedAt,
    predecessor: null,
    payload: {
      position: input.insert.position,
      message,
    },
  });
  writer.run(
    `
      INSERT INTO work_messages(
        canvas_name,
        node_id,
        message_id,
        position,
        home_station,
        event_home,
        event_seq,
        role,
        parts_json,
        context_id,
        reference_task_ids_json,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.canvasName,
      input.nodeId,
      message.messageId,
      input.insert.position,
      COMMAND_CENTER_WORK_HOME,
      event.eventHome,
      event.seq,
      message.role,
      JSON.stringify(message.parts),
      message.contextId ?? null,
      jsonOptional(message.referenceTaskIds),
      jsonOptional(message.metadata),
      input.originAt,
      input.receivedAt,
    ],
  );
};

const nextTransitionOrdinal = (
  writer: StateWriter,
  lane: WorkLane,
  canvasName: string,
  nodeId: string,
  taskId: string,
): number => {
  const row = writer.get<StateRow & { readonly next_ordinal: number }>(
    `
      SELECT COALESCE(MAX(ordinal) + 1, 0) AS next_ordinal
      FROM work_task_transitions
      WHERE canvas_name = ? AND node_id = ? AND task_id = ? AND lane = ?
    `,
    [canvasName, nodeId, taskId, lane],
  );
  return Number(row?.next_ordinal ?? 0);
};

const materializeTaskChange = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly change: TaskChange;
    readonly event: WorkEventIdentity;
  },
): void => {
  const { change } = input;
  const table = taskTable(change.lane);
  const existingHome = existingTaskHome(
    writer,
    change.lane,
    input.canvasName,
    input.nodeId,
    change.after.id,
  );
  const transfersOnClaim = isFirstTaskClaimTransfer(
    input.operation,
    change,
    existingHome,
    input.entityHome,
  );
  if (!transfersOnClaim) {
    assertImmutableHome(
      `${change.lane} "${change.after.id}"`,
      existingHome,
      input.entityHome,
    );
  }
  if (!change.before) {
    writer.run(
      `
        INSERT INTO ${table}(
          canvas_name,
          node_id,
          task_id,
          home_station,
          event_home,
          event_seq,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        input.canvasName,
        input.nodeId,
        change.after.id,
        input.entityHome,
        input.event.eventHome,
        input.event.seq,
        change.after.state,
        change.briefMessageId,
        jsonOptional(change.after.artifactIds),
        jsonOptional(change.after.metadata),
        change.after.reason ?? null,
        change.after.response ?? null,
        input.receivedAt,
        input.receivedAt,
        input.originAt,
        input.receivedAt,
      ],
    );
  } else {
    const updated = writer.run(
      `
        UPDATE ${table}
        SET
          home_station = ?,
          event_home = ?,
          event_seq = ?,
          state = ?,
          brief_message_id = ?,
          artifact_ids_json = ?,
          metadata_json = ?,
          reason = ?,
          response = ?,
          updated_at = ?,
          origin_at = ?,
          received_at = ?
        WHERE canvas_name = ?
          AND node_id = ?
          AND task_id = ?
          AND home_station = ?
      `,
      [
        input.entityHome,
        input.event.eventHome,
        input.event.seq,
        change.after.state,
        change.briefMessageId,
        jsonOptional(change.after.artifactIds),
        jsonOptional(change.after.metadata),
        change.after.reason ?? null,
        change.after.response ?? null,
        input.receivedAt,
        input.originAt,
        input.receivedAt,
        input.canvasName,
        input.nodeId,
        change.after.id,
        existingHome!,
      ],
    );
    if (Number(updated.changes) !== 1) {
      throw new Error(
        `${change.lane} "${change.after.id}" disappeared during mutation`,
      );
    }
  }

  if (!change.before || change.before.state !== change.after.state) {
    writer.run(
      `
        INSERT INTO work_task_transitions(
          canvas_name,
          node_id,
          task_id,
          ordinal,
          lane,
          home_station,
          event_home,
          event_seq,
          operation,
          from_state,
          to_state,
          origin_at,
          received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        input.canvasName,
        input.nodeId,
        change.after.id,
        nextTransitionOrdinal(
          writer,
          change.lane,
          input.canvasName,
          input.nodeId,
          change.after.id,
        ),
        change.lane,
        input.entityHome,
        input.event.eventHome,
        input.event.seq,
        input.operation,
        change.before?.state ?? null,
        change.after.state,
        input.originAt,
        input.receivedAt,
      ],
    );
  }
};

const insertPendingCommand = (
  writer: StateWriter,
  event: WorkEventIdentity,
): void => {
  writer.run(
    `
      INSERT INTO work_pending_commands(
        event_home,
        entity_home,
        seq,
        status,
        acknowledged_by,
        resolved_at
      ) VALUES (?, ?, ?, 'pending', NULL, NULL)
    `,
    [event.eventHome, event.entityHome, event.seq],
  );
};

const assertNoPendingCommandForEntity = (
  reader: StateReader,
  input: {
    readonly eventHome: string;
    readonly entityHome: string;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityKind: "task" | "request" | "artifact";
    readonly entityId: string;
  },
): void => {
  const pending = reader.get<StateRow>(
    `
      SELECT 1 AS pending
      FROM work_pending_commands AS command
      JOIN work_events AS event
        ON event.event_home = command.event_home
       AND event.entity_home = command.entity_home
       AND event.seq = command.seq
      WHERE command.event_home = ?
        AND command.entity_home = ?
        AND command.status = 'pending'
        AND event.canvas_name = ?
        AND event.node_id = ?
        AND event.entity_kind = ?
        AND event.entity_id = ?
      LIMIT 1
    `,
    [
      input.eventHome,
      input.entityHome,
      input.canvasName,
      input.nodeId,
      input.entityKind,
      input.entityId,
    ],
  );
  if (pending !== undefined) {
    throw new WorkError(
      "invalid",
      `${input.entityKind} "${input.entityId}" already has a pending Remote command`,
    );
  }
};

const writeTaskChange = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly eventHome: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly materialization: "immediate" | "on-disposition";
    readonly change: TaskChange;
  },
): WorkEventIdentity => {
  const actor =
    input.operation === "task.claim"
      ? claimedByOf(input.change.after)
      : undefined;
  if (actor !== undefined) {
    assertActorClaimAvailable(writer, {
      actor,
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      taskId: input.change.after.id,
    });
  }
  if (input.materialization === "on-disposition") {
    assertNoPendingCommandForEntity(writer, {
      ...input,
      entityKind: input.change.lane,
      entityId: input.change.after.id,
    });
  }
  const event = recordEvent(writer, {
    eventHome: input.eventHome,
    entityHome: input.entityHome,
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityKind: input.change.lane,
    entityId: input.change.after.id,
    operation: input.operation,
    originAt: input.originAt,
    receivedAt: input.receivedAt,
    predecessor: currentTaskEvent(
      writer,
      input.change.lane,
      input.canvasName,
      input.nodeId,
      input.change.after.id,
    ),
    payload: {
      lane: input.change.lane,
      task: input.change.after,
    },
  });
  if (input.materialization === "immediate") {
    materializeTaskChange(writer, { ...input, event });
  } else {
    insertPendingCommand(writer, event);
  }
  return event;
};

const materializeArtifact = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly artifact: ArtifactValue;
    readonly event: WorkEventIdentity;
  },
): void => {
  assertImmutableHome(
    `artifact "${input.artifact.artifactId}"`,
    existingArtifactHome(
      writer,
      input.canvasName,
      input.nodeId,
      input.artifact.artifactId,
    ),
    input.entityHome,
  );
  writer.run(
    `
      INSERT INTO work_artifacts(
        canvas_name,
        node_id,
        artifact_id,
        home_station,
        event_home,
        event_seq,
        name,
        parts_json,
        task_id,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.canvasName,
      input.nodeId,
      input.artifact.artifactId,
      input.entityHome,
      input.event.eventHome,
      input.event.seq,
      input.artifact.name ?? null,
      JSON.stringify(input.artifact.parts),
      input.artifact.taskId ?? null,
      jsonOptional(input.artifact.metadata),
      input.originAt,
      input.receivedAt,
    ],
  );
};

const insertArtifact = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly eventHome: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly materialization: "immediate" | "on-disposition";
    readonly artifact: ArtifactValue;
  },
): void => {
  if (input.materialization === "on-disposition") {
    assertNoPendingCommandForEntity(writer, {
      ...input,
      entityKind: "artifact",
      entityId: input.artifact.artifactId,
    });
  }
  const event = recordEvent(writer, {
    eventHome: input.eventHome,
    entityHome: input.entityHome,
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityKind: "artifact",
    entityId: input.artifact.artifactId,
    operation: input.operation,
    originAt: input.originAt,
    receivedAt: input.receivedAt,
    predecessor: null,
    payload: { artifact: input.artifact },
  });
  if (input.materialization === "immediate") {
    materializeArtifact(writer, { ...input, event });
  } else {
    insertPendingCommand(writer, event);
  }
};

const applyMutationPlan = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly eventHome: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly materialization: "immediate" | "on-disposition";
    readonly plan: WorkMutationPlan;
  },
): void => {
  const taskEvents = new Map<string, WorkEventIdentity>();
  for (const change of input.plan.taskChanges) {
    const event = writeTaskChange(writer, { ...input, change });
    taskEvents.set(`${change.lane}\u0000${change.after.id}`, event);
  }
  for (const insert of input.plan.messageInserts) {
    if (input.materialization === "on-disposition") {
      if (insert.lane === null || insert.taskId === null) {
        throw new WorkError(
          "invalid",
          "Command-Center inbox messages cannot be deferred to a Remote",
        );
      }
      if (
        !taskEvents.has(`${insert.lane}\u0000${insert.taskId}`)
      ) {
        throw new Error(
          `${insert.lane} "${insert.taskId}" history changed without a task command`,
        );
      }
      continue;
    }
    if (insert.lane === null || insert.taskId === null) {
      insertInboxMessage(writer, { ...input, insert });
      continue;
    }
    const event = taskEvents.get(`${insert.lane}\u0000${insert.taskId}`);
    if (event === undefined) {
      throw new Error(
        `${insert.lane} "${insert.taskId}" history changed without a task event`,
      );
    }
    insertTaskMessage(writer, { ...input, insert, event });
  }
  for (const artifact of input.plan.artifactInserts) {
    insertArtifact(writer, { ...input, artifact });
  }
};

type MutationOutcome<A> =
  | {
      readonly _tag: "Success";
      readonly value: A;
      readonly snapshot: WorkSnapshot;
      readonly projectedDoc: CanvasDoc;
    }
  | { readonly _tag: "DomainFailure"; readonly error: WorkError };

const toRepositoryError = (
  operation: string,
  cause: unknown,
): WorkRepositoryError =>
  cause instanceof WorkRepositoryError
    ? cause
    : WorkRepositoryError.make({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const normalizeTimestamp = (value: string | undefined): string =>
  value ?? new Date().toISOString();

const WorkEventIdentitySchema = Schema.Struct({
  eventHome: InstallationId,
  entityHome: Schema.String.pipe(Schema.minLength(1)),
  seq: LogicalSequence,
});

const WorkEventPayloadEnvelope = Schema.Struct({
  schema: Schema.Literal("vellum/work-event/v1"),
  entityHome: Schema.String.pipe(Schema.minLength(1)),
  canvasName: Schema.String.pipe(Schema.minLength(1)),
  nodeId: Schema.String.pipe(Schema.minLength(1)),
  entityKind: Schema.Literal(
    "task",
    "request",
    "message",
    "artifact",
    "receipt",
  ),
  entityId: Schema.String.pipe(Schema.minLength(1)),
  operation: Schema.String.pipe(Schema.minLength(1)),
  predecessor: Schema.NullOr(WorkEventIdentitySchema),
  body: Schema.Unknown,
});
type WorkEventPayloadEnvelopeValue =
  typeof WorkEventPayloadEnvelope.Type;

type DecodedReplicatedWorkEvent = WorkEvent & {
  readonly source: StationEventValue;
  readonly envelope: WorkEventPayloadEnvelopeValue;
  readonly task?: TaskValue;
  readonly artifact?: ArtifactValue;
  readonly disposition?: WorkCommandDispositionValue;
};

const TaskEventBody = Schema.Struct({
  lane: Schema.Literal("task", "request"),
  task: Task,
});

const ArtifactEventBody = Schema.Struct({
  artifact: Artifact,
});

const AppliedCommandDisposition = Schema.Struct({
  command: WorkEventIdentitySchema,
  contentSha256: StationSha256,
  disposition: Schema.Literal("applied"),
  reportedBy: InstallationId,
});

const RejectedCommandDisposition = Schema.Struct({
  command: WorkEventIdentitySchema,
  contentSha256: StationSha256,
  disposition: Schema.Literal("rejected"),
  reason: Schema.Literal("causal-conflict"),
  message: Schema.String.pipe(Schema.minLength(1)),
  reportedBy: InstallationId,
});
const WorkCommandDisposition = Schema.Union(
  AppliedCommandDisposition,
  RejectedCommandDisposition,
);
type WorkCommandDispositionValue = typeof WorkCommandDisposition.Type;

const DispositionEventBody = Schema.Struct({
  disposition: WorkCommandDisposition,
});

const decodeLogicalSequence = Schema.decodeUnknownSync(LogicalSequence);

const replicationError = (
  eventHome: InstallationIdValue,
  sequence: LogicalSequenceValue,
  reason: WorkReplicationError["reason"],
  message: string,
): WorkReplicationError =>
  WorkReplicationError.make({
    reason,
    eventHome,
    sequence,
    message,
  });

const decodeReplicatedWorkEvent = (
  source: StationEventValue,
  expectedEventHome: InstallationIdValue,
  expectedEntityHome: string,
):
  | { readonly _tag: "Success"; readonly event: DecodedReplicatedWorkEvent }
  | { readonly _tag: "Failure"; readonly error: WorkReplicationError } => {
  const fail = (
    reason: WorkReplicationError["reason"],
    message: string,
  ) => ({
    _tag: "Failure" as const,
    error: replicationError(
      source.identity.home,
      source.identity.sequence,
      reason,
      message,
    ),
  });

  if (source.identity.home !== expectedEventHome) {
    return fail(
      "event-home-mismatch",
      `expected source stream "${expectedEventHome}", received "${source.identity.home}"`,
    );
  }
  if (source.kind !== "work.event") {
    return fail(
      "invalid-payload",
      `station event kind "${source.kind}" is not canonical work`,
    );
  }
  const actualHash = createHash("sha256")
    .update(source.body, "utf8")
    .digest("hex");
  if (actualHash !== source.contentSha256) {
    return fail(
      "integrity",
      "station event hash does not match its canonical work payload",
    );
  }

  let unknown: unknown;
  try {
    unknown = JSON.parse(source.body);
  } catch {
    return fail("invalid-payload", "work event body is not JSON");
  }
  try {
    if (canonicalJson(unknown) !== source.body) {
      return fail(
        "invalid-payload",
        "work event body is not canonical JSON",
      );
    }
  } catch (error) {
    return fail(
      "invalid-payload",
      error instanceof Error ? error.message : String(error),
    );
  }

  const decoded = Schema.decodeUnknownEither(WorkEventPayloadEnvelope, {
    onExcessProperty: "error",
  })(unknown);
  if (Either.isLeft(decoded)) {
    return fail("invalid-payload", "work event envelope is malformed");
  }
  const envelope = decoded.right;
  if (envelope.entityHome !== expectedEntityHome) {
    return fail(
      "entity-home-mismatch",
      `expected entity home "${expectedEntityHome}", received "${envelope.entityHome}"`,
    );
  }
  if (envelope.entityKind === "message") {
    return fail(
      "unsupported-message",
      "mailbox messages are Command-Center-homed and never stationed",
    );
  }

  const base = {
    eventHome: source.identity.home,
    homeStation: envelope.entityHome,
    seq: source.identity.sequence,
    canvasName: envelope.canvasName,
    nodeId: envelope.nodeId,
    entityKind: envelope.entityKind,
    entityId: envelope.entityId,
    operation: envelope.operation,
    originAt: source.originAt,
    receivedAt: source.receivedAt ?? source.originAt,
    payloadJson: source.body,
    contentSha256: source.contentSha256,
    source,
    envelope,
  } satisfies Omit<
    DecodedReplicatedWorkEvent,
    "task" | "artifact" | "disposition"
  >;

  if (
    envelope.entityKind === "task" ||
    envelope.entityKind === "request"
  ) {
    const body = Schema.decodeUnknownEither(TaskEventBody, {
      onExcessProperty: "error",
    })(envelope.body);
    if (
      Either.isLeft(body) ||
      body.right.lane !== envelope.entityKind ||
      body.right.task.id !== envelope.entityId
    ) {
      return fail(
        "invalid-payload",
        "task event body does not match its envelope identity",
      );
    }
    return {
      _tag: "Success",
      event: { ...base, task: body.right.task },
    };
  }

  if (envelope.entityKind === "receipt") {
    const body = Schema.decodeUnknownEither(DispositionEventBody, {
      onExcessProperty: "error",
    })(envelope.body);
    if (
      Either.isLeft(body) ||
      body.right.disposition.reportedBy !== source.identity.home ||
      body.right.disposition.command.entityHome !== expectedEntityHome
    ) {
      return fail(
        "invalid-payload",
        "command disposition does not match its source route",
      );
    }
    return {
      _tag: "Success",
      event: { ...base, disposition: body.right.disposition },
    };
  }

  const body = Schema.decodeUnknownEither(ArtifactEventBody, {
    onExcessProperty: "error",
  })(envelope.body);
  if (
    Either.isLeft(body) ||
    body.right.artifact.artifactId !== envelope.entityId
  ) {
    return fail(
      "invalid-payload",
      "artifact event body does not match its envelope identity",
    );
  }
  return {
    _tag: "Success",
    event: { ...base, artifact: body.right.artifact },
  };
};

const workEventFromRow = (row: WorkEventRow): WorkEvent => ({
  eventHome: row.event_home,
  homeStation: row.entity_home,
  seq: row.seq,
  canvasName: row.canvas_name,
  nodeId: row.node_id,
  entityKind: row.entity_kind as WorkEntityKind,
  entityId: row.entity_id,
  operation: row.operation,
  originAt: row.origin_at,
  receivedAt: row.received_at,
  payloadJson: row.payload_json,
  contentSha256: row.content_sha256,
});

const selectWorkEvent = (
  reader: StateReader,
  eventHome: string,
  entityHome: string,
  seq: string,
): WorkEventRow | undefined =>
  reader.get<WorkEventRow>(
    `
      SELECT
        event_home,
        entity_home,
        seq,
        canvas_name,
        node_id,
        entity_kind,
        entity_id,
        operation,
        origin_at,
        received_at,
        payload_json,
        content_sha256
      FROM work_events
      WHERE event_home = ? AND entity_home = ? AND seq = ?
    `,
    [eventHome, entityHome, seq],
  );

const sameEventIdentity = (
  left: WorkEventIdentity | null,
  right: WorkEventIdentity | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.eventHome === right.eventHome &&
      left.entityHome === right.entityHome &&
      left.seq === right.seq;

const rememberReplicatedEvent = (
  writer: StateWriter,
  event: DecodedReplicatedWorkEvent,
  receivedAt: string,
): void => {
  const sequence = writer.get<StateRow & { readonly last_seq: string }>(
    `
      SELECT last_seq
      FROM work_event_sequences
      WHERE event_home = ? AND entity_home = ?
    `,
    [event.eventHome, event.homeStation],
  )?.last_seq;
  if (
    sequence === undefined ||
    BigInt(sequence) < BigInt(event.seq)
  ) {
    writer.run(
      `
        INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
        VALUES (?, ?, ?)
        ON CONFLICT(event_home, entity_home) DO UPDATE SET
          last_seq = excluded.last_seq
      `,
      [event.eventHome, event.homeStation, event.seq],
    );
  }
  writer.run(
    `
      INSERT INTO work_events(
        event_home,
        seq,
        entity_home,
        canvas_name,
        node_id,
        entity_kind,
        entity_id,
        operation,
        origin_at,
        received_at,
        payload_json,
        content_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      event.eventHome,
      event.seq,
      event.homeStation,
      event.canvasName,
      event.nodeId,
      event.entityKind,
      event.entityId,
      event.operation,
      event.originAt,
      receivedAt,
      event.payloadJson,
      event.contentSha256,
    ],
  );
};

const selectLocalRejection = (
  reader: StateReader,
  event: DecodedReplicatedWorkEvent,
  reportedBy: InstallationIdValue,
): WorkRejectionRow | undefined =>
  reader.get<WorkRejectionRow>(
    `
      SELECT
        rejected_content_sha256,
        reason,
        message,
        receipt_event_home,
        receipt_event_seq
      FROM work_rejections
      WHERE rejected_event_home = ?
        AND rejected_entity_home = ?
        AND rejected_seq = ?
        AND reported_by = ?
    `,
    [event.eventHome, event.homeStation, event.seq, reportedBy],
  );

const insertRejection = (
  writer: StateWriter,
  input: {
    readonly rejected: WorkEventIdentity;
    readonly rejectedContentSha256: string;
    readonly rejectedPayloadJson: string | null;
    readonly reason: "causal-conflict";
    readonly message: string;
    readonly reportedBy: InstallationIdValue;
    readonly receipt: WorkEventIdentity;
    readonly receivedAt: string;
  },
): void => {
  writer.run(
    `
      INSERT INTO work_rejections(
        rejected_event_home,
        rejected_entity_home,
        rejected_seq,
        rejected_content_sha256,
        rejected_payload_json,
        reason,
        message,
        reported_by,
        receipt_event_home,
        receipt_event_seq,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        rejected_event_home,
        rejected_entity_home,
        rejected_seq,
        reported_by
      ) DO NOTHING
    `,
    [
      input.rejected.eventHome,
      input.rejected.entityHome,
      input.rejected.seq,
      input.rejectedContentSha256,
      input.rejectedPayloadJson,
      input.reason,
      input.message,
      input.reportedBy,
      input.receipt.eventHome,
      input.receipt.seq,
      input.receivedAt,
    ],
  );
};

const recordCommandDisposition = (
  writer: StateWriter,
  input: {
    readonly event: DecodedReplicatedWorkEvent;
    readonly localEventHome: InstallationIdValue;
    readonly disposition:
      | { readonly _tag: "Applied" }
      | {
        readonly _tag: "Rejected";
        readonly conflict: WorkReplicationError;
      };
    readonly receivedAt: string;
  },
): void => {
  const command = {
    eventHome: input.event.eventHome,
    entityHome: input.event.homeStation,
    seq: input.event.seq,
  };
  const receipt = recordEvent(writer, {
    eventHome: input.localEventHome,
    entityHome: input.event.homeStation,
    canvasName: input.event.canvasName,
    nodeId: input.event.nodeId,
    entityKind: "receipt",
    entityId:
      `disposition:${input.event.eventHome}:${input.event.seq}`,
    operation:
      input.disposition._tag === "Applied"
        ? "work.command-applied"
        : "work.command-rejected",
    originAt: input.receivedAt,
    receivedAt: input.receivedAt,
    predecessor: null,
    payload: {
      disposition: {
        command,
        contentSha256: input.event.contentSha256,
        disposition:
          input.disposition._tag === "Applied" ? "applied" : "rejected",
        reportedBy: input.localEventHome,
        ...(input.disposition._tag === "Rejected"
          ? {
            reason: "causal-conflict" as const,
            message: input.disposition.conflict.message,
          }
          : {}),
      },
    },
  });
  if (input.disposition._tag === "Rejected") {
    insertRejection(writer, {
      rejected: command,
      rejectedContentSha256: input.event.contentSha256,
      rejectedPayloadJson: input.event.payloadJson,
      reason: "causal-conflict",
      message: input.disposition.conflict.message,
      reportedBy: input.localEventHome,
      receipt,
      receivedAt: input.receivedAt,
    });
  }
};

const pendingCommand = (
  reader: StateReader,
  identity: WorkEventIdentity,
): PendingCommandRow | undefined =>
  reader.get<PendingCommandRow>(
    `
      SELECT
        event_home,
        entity_home,
        seq,
        status,
        acknowledged_by,
        resolved_at
      FROM work_pending_commands
      WHERE event_home = ? AND entity_home = ? AND seq = ?
    `,
    [identity.eventHome, identity.entityHome, identity.seq],
  );

const resolvePendingCommand = (
  writer: StateWriter,
  input: {
    readonly command: WorkEventIdentity;
    readonly status: "applied" | "rejected";
    readonly acknowledgedBy: InstallationIdValue;
    readonly resolvedAt: string;
  },
): void => {
  const updated = writer.run(
    `
      UPDATE work_pending_commands
      SET status = ?, acknowledged_by = ?, resolved_at = ?
      WHERE event_home = ?
        AND entity_home = ?
        AND seq = ?
        AND status = 'pending'
    `,
    [
      input.status,
      input.acknowledgedBy,
      input.resolvedAt,
      input.command.eventHome,
      input.command.entityHome,
      input.command.seq,
    ],
  );
  if (Number(updated.changes) !== 1) {
    throw new Error(
      `pending command ${input.command.eventHome}/${input.command.entityHome}/${input.command.seq} could not be resolved`,
    );
  }
};

const materializeReplicatedWorkEvent = (
  writer: StateWriter,
  event: DecodedReplicatedWorkEvent,
  receivedAt: string,
  remember = true,
): void => {
  if (event.entityKind === "receipt") {
    if (!remember) {
      throw new Error("a disposition event cannot be a pending command");
    }
    rememberReplicatedEvent(writer, event, receivedAt);
    const disposition = event.disposition!;
    const pending = pendingCommand(writer, disposition.command);
    const commandRow = selectWorkEvent(
      writer,
      disposition.command.eventHome,
      disposition.command.entityHome,
      disposition.command.seq,
    );
    if (
      pending === undefined ||
      pending.status !== "pending" ||
      commandRow === undefined ||
      commandRow.content_sha256 !== disposition.contentSha256
    ) {
      throw replicationError(
        event.source.identity.home,
        event.source.identity.sequence,
        "identity-conflict",
        "command disposition does not match one pending local command",
      );
    }

    if (disposition.disposition === "applied") {
      const decoded = decodeReplicatedWorkEvent(
        stationEventFromWorkEvent(workEventFromRow(commandRow)),
        disposition.command.eventHome,
        disposition.command.entityHome,
      );
      if (decoded._tag === "Failure") throw decoded.error;
      materializeReplicatedWorkEvent(
        writer,
        decoded.event,
        receivedAt,
        false,
      );
      resolvePendingCommand(writer, {
        command: disposition.command,
        status: "applied",
        acknowledgedBy: disposition.reportedBy,
        resolvedAt: receivedAt,
      });
      return;
    }

    insertRejection(writer, {
      rejected: disposition.command,
      rejectedContentSha256: disposition.contentSha256,
      rejectedPayloadJson: commandRow.payload_json,
      reason: disposition.reason,
      message: disposition.message,
      reportedBy: disposition.reportedBy,
      receipt: {
        eventHome: event.eventHome,
        entityHome: event.homeStation,
        seq: event.seq,
      },
      receivedAt,
    });
    resolvePendingCommand(writer, {
      command: disposition.command,
      status: "rejected",
      acknowledgedBy: disposition.reportedBy,
      resolvedAt: receivedAt,
    });
    return;
  }
  if (event.entityKind === "artifact") {
    const existingHome = existingArtifactHome(
      writer,
      event.canvasName,
      event.nodeId,
      event.entityId,
    );
    if (existingHome !== undefined) {
      throw replicationError(
        event.source.identity.home,
        event.source.identity.sequence,
        "causal-conflict",
        `artifact "${event.entityId}" already exists`,
      );
    }
    if (remember) rememberReplicatedEvent(writer, event, receivedAt);
    materializeArtifact(writer, {
      canvasName: event.canvasName,
      nodeId: event.nodeId,
      entityHome: event.homeStation,
      originAt: event.originAt,
      receivedAt,
      artifact: event.artifact!,
      event: {
        eventHome: event.eventHome,
        entityHome: event.homeStation,
        seq: event.seq,
      },
    });
    return;
  }

  if (event.entityKind === "message") {
    throw replicationError(
      event.source.identity.home,
      event.source.identity.sequence,
      "unsupported-message",
      "mailbox messages are Command-Center-homed and never stationed",
    );
  }
  const lane = event.entityKind;
  const current = loadLaneTasks(
    writer,
    event.canvasName,
    event.nodeId,
    lane,
  ).find((task) => task.id === event.entityId);
  const currentIdentity = currentTaskEvent(
    writer,
    lane,
    event.canvasName,
    event.nodeId,
    event.entityId,
  );
  const incomingFirstClaim =
    lane === "task" &&
    event.operation === "task.claim" &&
    current === undefined &&
    currentIdentity === null &&
    event.envelope.predecessor !== null &&
    event.envelope.predecessor.entityHome !== event.homeStation &&
    event.task?.state === "working" &&
    claimedByOf(event.task) !== undefined;
  if (
    !incomingFirstClaim &&
    !sameEventIdentity(currentIdentity, event.envelope.predecessor)
  ) {
    throw replicationError(
      event.source.identity.home,
      event.source.identity.sequence,
      "causal-conflict",
      `${lane} "${event.entityId}" changed after this event's predecessor`,
    );
  }

  let planned: ReturnType<typeof planTaskLane>;
  try {
    planned = planTaskLane(
      lane,
      current === undefined ? [] : [current],
      [event.task!],
    );
  } catch (error) {
    throw replicationError(
      event.source.identity.home,
      event.source.identity.sequence,
      "invalid-payload",
      error instanceof Error ? error.message : String(error),
    );
  }
  const change = planned.taskChanges[0];
  if (
    change === undefined ||
    change.after.id !== event.entityId ||
    planned.taskChanges.length !== 1
  ) {
    throw replicationError(
      event.source.identity.home,
      event.source.identity.sequence,
      "invalid-payload",
      "task event does not produce one material state change",
    );
  }
  const actor =
    event.operation === "task.claim"
      ? claimedByOf(change.after)
      : undefined;
  if (actor !== undefined) {
    try {
      assertActorClaimAvailable(writer, {
        actor,
        canvasName: event.canvasName,
        nodeId: event.nodeId,
        taskId: event.entityId,
      });
    } catch (error) {
      throw replicationError(
        event.source.identity.home,
        event.source.identity.sequence,
        "causal-conflict",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (remember) rememberReplicatedEvent(writer, event, receivedAt);
  const identity = {
    eventHome: event.eventHome,
    entityHome: event.homeStation,
    seq: event.seq,
  };
  materializeTaskChange(writer, {
    canvasName: event.canvasName,
    nodeId: event.nodeId,
    entityHome: event.homeStation,
    operation: event.operation,
    originAt: event.originAt,
    receivedAt,
    change,
    event: identity,
  });
  for (const insert of planned.messageInserts) {
    insertTaskMessage(writer, {
      canvasName: event.canvasName,
      nodeId: event.nodeId,
      originAt: event.originAt,
      receivedAt,
      insert,
      event: identity,
    });
  }
};

export class WorkRepository extends Context.Tag("@vellum/WorkRepository")<
  WorkRepository,
  {
    readonly readSnapshot: (
      canvasName: string,
      nodeId: string,
    ) => Effect.Effect<WorkSnapshot, WorkRepositoryError>;
    readonly itemHome: (
      lane: "task" | "request",
      canvasName: string,
      nodeId: string,
      taskId: string,
    ) => Effect.Effect<string | undefined, WorkRepositoryError>;
    readonly snapshotsForCanvas: (
      canvasName: string,
    ) => Effect.Effect<ReadonlyArray<WorkSnapshot>, WorkRepositoryError>;
    readonly mutate: <A>(
      input: WorkMutationInput<A>,
    ) => Effect.Effect<
      WorkMutationResult<A>,
      WorkRepositoryError | WorkError
    >;
    readonly eventsAfter: (
      input: WorkEventsAfterInput,
    ) => Effect.Effect<ReadonlyArray<WorkEvent>, WorkRepositoryError>;
    readonly acceptReplicated: (
      input: AcceptReplicatedWorkInput,
    ) => Effect.Effect<
      AcceptReplicatedWorkResult,
      WorkRepositoryError | WorkReplicationError
    >;
    readonly rejectionsForRoute: (
      entityHome: string,
    ) => Effect.Effect<
      ReadonlyArray<WorkRejection>,
      WorkRepositoryError
    >;
    readonly commandStatus: Effect.Effect<
      WorkCommandStatus,
      WorkRepositoryError
    >;
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

    const notifyChanges = (canvasName: string, nodeId: string): void => {
      for (const listener of listeners) {
        try {
          listener(canvasName, nodeId);
        } catch (error) {
          // The transaction is already committed. A projection subscriber
          // cannot retroactively fail the durable work mutation.
          console.error(
            `[work] change listener failed for ${canvasName}/${nodeId}:`,
            error,
          );
        }
      }
    };

    const readSnapshot = (
      canvasName: string,
      nodeId: string,
    ): Effect.Effect<WorkSnapshot, WorkRepositoryError> =>
      state
        .read("work.readSnapshot", (reader) =>
          loadSnapshot(reader, canvasName, nodeId),
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.readSnapshot", error),
          ),
        );

    const snapshotsForCanvas = (
      canvasName: string,
    ): Effect.Effect<ReadonlyArray<WorkSnapshot>, WorkRepositoryError> =>
      state
        .read("work.snapshotsForCanvas", (reader) =>
          loadSnapshotsForCanvas(reader, canvasName),
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
      taskId: string,
    ): Effect.Effect<string | undefined, WorkRepositoryError> =>
      state
        .read("work.itemHome", (reader) =>
          existingTaskHome(reader, lane, canvasName, nodeId, taskId)
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.itemHome", error)
          ),
        );

    const mutate = <A>(
      input: WorkMutationInput<A>,
    ): Effect.Effect<
      WorkMutationResult<A>,
      WorkRepositoryError | WorkError
    > => {
      const originAt = normalizeTimestamp(input.originAt);
      const receivedAt = normalizeTimestamp(input.receivedAt);
      return state
        .transaction(`work.${input.operation}`, (writer): MutationOutcome<A> => {
          const before = loadSnapshot(
            writer,
            input.canvasName,
            input.nodeId,
          );
          const projected = projectWorkSnapshots(input.authoredDoc, [before]);
          try {
            const transformed = input.transform(projected);
            const after = snapshotFromRuntimeProjection(
              transformed.doc,
              input.canvasName,
              input.nodeId,
            );
            const plan = planMutation(before, after);
            applyMutationPlan(writer, {
              canvasName: input.canvasName,
              nodeId: input.nodeId,
              entityHome: input.entityHome,
              eventHome: input.eventHome,
              materialization: input.materialization ?? "immediate",
              operation: input.operation,
              originAt,
              receivedAt,
              plan,
            });
            const committedSnapshot = loadSnapshot(
              writer,
              input.canvasName,
              input.nodeId,
            );
            const canvasSnapshots = loadSnapshotsForCanvas(
              writer,
              input.canvasName,
            );
            return {
              _tag: "Success",
              value: transformed.value,
              snapshot: committedSnapshot,
              projectedDoc: projectWorkSnapshots(
                input.authoredDoc,
                canvasSnapshots,
              ),
            };
          } catch (error) {
            if (error instanceof WorkError) {
              return { _tag: "DomainFailure", error };
            }
            throw error;
          }
        })
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError(`work.${input.operation}`, error),
          ),
          Effect.flatMap((outcome) =>
            outcome._tag === "Success"
              ? Effect.succeed({
                  value: outcome.value,
                  snapshot: outcome.snapshot,
                  projectedDoc: outcome.projectedDoc,
                  disposition:
                    input.materialization === "on-disposition"
                      ? "queued" as const
                      : "applied" as const,
                })
              : Effect.fail(outcome.error),
          ),
          Effect.tap(() =>
            Effect.sync(() =>
              notifyChanges(input.canvasName, input.nodeId)
            )
          ),
        );
    };

    const eventsAfter = (
      input: WorkEventsAfterInput,
    ): Effect.Effect<ReadonlyArray<WorkEvent>, WorkRepositoryError> =>
      state
        .read("work.eventsAfter", (reader) => {
          const cursor = canonicalSequence(input.afterSeq);
          const boundedLimit = Math.max(
            1,
            Math.min(
              STATION_API_MAX_EVENTS_PER_REPORT,
              Math.floor(input.limit ?? STATION_API_MAX_EVENTS_PER_REPORT),
            ),
          );
          return reader
            .all<WorkEventRow>(
              `
                SELECT
                  event_home,
                  entity_home,
                  seq,
                  canvas_name,
                  node_id,
                  entity_kind,
                  entity_id,
                  operation,
                  origin_at,
                  received_at,
                  payload_json,
                  content_sha256
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
                input.eventHome,
                input.entityHome,
                cursor,
                cursor,
                cursor,
                boundedLimit,
              ],
            )
            .map(workEventFromRow);
        })
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.eventsAfter", error),
          ),
        );

    const rejectionsForRoute = (
      entityHome: string,
    ): Effect.Effect<ReadonlyArray<WorkRejection>, WorkRepositoryError> =>
      state
        .read("work.rejectionsForRoute", (reader) =>
          reader
            .all<WorkRejectionRow>(
              `
                SELECT
                  rejected_event_home,
                  rejected_entity_home,
                  rejected_seq,
                  rejected_content_sha256,
                  reason,
                  message,
                  reported_by,
                  receipt_event_home,
                  receipt_event_seq,
                  received_at
                FROM work_rejections
                WHERE rejected_entity_home = ?
                ORDER BY
                  received_at,
                  reported_by,
                  length(rejected_seq),
                  rejected_seq
              `,
              [entityHome],
            )
            .map(workRejectionFromRow),
        )
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.rejectionsForRoute", error),
          ),
        );

    const commandStatus: Effect.Effect<
      WorkCommandStatus,
      WorkRepositoryError
    > = state
      .read("work.commandStatus", (reader) => {
        const detailLimit = 100;
        const pendingCount = Number(
          reader.get<CountRow>(
            `
              SELECT count(*) AS count
              FROM work_pending_commands
              WHERE status = 'pending'
            `,
          )?.count ?? 0,
        );
        const appliedCount = Number(
          reader.get<CountRow>(
            `
              SELECT count(*) AS count
              FROM work_pending_commands
              WHERE status = 'applied'
            `,
          )?.count ?? 0,
        );
        const rejectionCount = Number(
          reader.get<CountRow>(
            `
              SELECT count(*) AS count
              FROM work_rejections AS rejection
              JOIN work_pending_commands AS command
                ON command.event_home = rejection.rejected_event_home
               AND command.entity_home = rejection.rejected_entity_home
               AND command.seq = rejection.rejected_seq
               AND command.status = 'rejected'
            `,
          )?.count ?? 0,
        );
        const pending = reader
          .all<PendingCommandDetailRow>(
            `
              SELECT
                command.event_home,
                command.entity_home,
                command.seq,
                command.status,
                command.acknowledged_by,
                command.resolved_at,
                event.canvas_name,
                event.node_id,
                event.entity_kind,
                event.entity_id,
                event.operation
              FROM work_pending_commands AS command
              JOIN work_events AS event
                ON event.event_home = command.event_home
               AND event.entity_home = command.entity_home
               AND event.seq = command.seq
              WHERE command.status = 'pending'
              ORDER BY
                command.entity_home,
                length(command.seq),
                command.seq
              LIMIT ?
            `,
            [detailLimit],
          )
          .map((row): WorkPendingCommand => ({
            command: {
              eventHome: row.event_home,
              entityHome: row.entity_home,
              seq: canonicalSequence(row.seq),
            },
            canvasName: row.canvas_name,
            nodeId: row.node_id,
            entityKind: row.entity_kind,
            entityId: row.entity_id,
            operation: row.operation,
          }));
        const rejections = reader
          .all<WorkRejectionRow>(
            `
              SELECT
                rejected_event_home,
                rejected_entity_home,
                rejected_seq,
                rejected_content_sha256,
                reason,
                message,
                reported_by,
                receipt_event_home,
                receipt_event_seq,
                received_at
              FROM work_rejections AS rejection
              JOIN work_pending_commands AS command
                ON command.event_home = rejection.rejected_event_home
               AND command.entity_home = rejection.rejected_entity_home
               AND command.seq = rejection.rejected_seq
               AND command.status = 'rejected'
              ORDER BY
                rejection.received_at DESC,
                rejection.reported_by,
                length(rejection.rejected_seq),
                rejection.rejected_seq
              LIMIT ?
            `,
            [detailLimit],
          )
          .map(workRejectionFromRow);
        return {
          counts: {
            pending: pendingCount,
            applied: appliedCount,
            rejected: rejectionCount,
          },
          pending,
          rejections,
          truncated: {
            pending: pendingCount > pending.length,
            rejections: rejectionCount > rejections.length,
          },
        };
      })
      .pipe(
        Effect.mapError((error) =>
          toRepositoryError("work.commandStatus", error),
        ),
      );

    const acceptReplicated = Effect.fn(
      "WorkRepository.acceptReplicated",
    )(function* (input: AcceptReplicatedWorkInput) {
      if (input.localEventHome === input.eventHome) {
        return yield* replicationError(
          input.eventHome,
          decodeLogicalSequence("0"),
          "event-home-mismatch",
          "an installation cannot accept its own source stream",
        );
      }
      if (input.events.length > STATION_API_MAX_EVENTS_PER_REPORT) {
        return yield* replicationError(
          input.eventHome,
          decodeLogicalSequence("0"),
          "batch-limit",
          `work event batch exceeds ${STATION_API_MAX_EVENTS_PER_REPORT}`,
        );
      }

      const bySequence = new Map<string, DecodedReplicatedWorkEvent>();
      for (const source of input.events) {
        const decoded = decodeReplicatedWorkEvent(
          source,
          input.eventHome,
          input.entityHome,
        );
        if (decoded._tag === "Failure") {
          return yield* decoded.error;
        }
        const admitted = bySequence.get(decoded.event.seq);
        if (
          admitted !== undefined &&
          (
            admitted.contentSha256 !== decoded.event.contentSha256 ||
            admitted.payloadJson !== decoded.event.payloadJson
          )
        ) {
          return yield* replicationError(
            input.eventHome,
            source.identity.sequence,
            "identity-conflict",
            "one source sequence names different work content",
          );
        }
        if (admitted === undefined) {
          bySequence.set(decoded.event.seq, decoded.event);
        }
      }
      const decoded = [...bySequence.values()].sort((left, right) =>
        BigInt(left.seq) < BigInt(right.seq) ? -1 : 1
      );
      const receivedAt = normalizeTimestamp(input.receivedAt);

      const result = yield* state
        .transaction("work.accept-replicated", (writer) => {
          const cursor = writer.get<ReceivedCursorRow>(
            `
              SELECT home, through_sequence
              FROM station_received_cursors
              WHERE home = ?
            `,
            [input.eventHome],
          )?.through_sequence ?? "0";
          let through = cursor;
          let accepted = 0;
          let idempotent = 0;
          let rejected = 0;
          const changed = new Set<string>();

          for (const event of decoded) {
            const quarantined = selectLocalRejection(
              writer,
              event,
              input.localEventHome,
            );
            if (quarantined !== undefined) {
              if (
                quarantined.rejected_content_sha256 !==
                  event.contentSha256
              ) {
                throw replicationError(
                  input.eventHome,
                  event.source.identity.sequence,
                  "identity-conflict",
                  "rejected source sequence was retried with different work",
                );
              }
              idempotent += 1;
              if (BigInt(event.seq) > BigInt(through)) {
                const expected = (BigInt(through) + 1n).toString();
                if (event.seq !== expected) {
                  throw replicationError(
                    input.eventHome,
                    event.source.identity.sequence,
                    "sequence-gap",
                    `expected route sequence ${expected}, received ${event.seq}`,
                  );
                }
                through = event.seq;
              }
              continue;
            }
            const existing = selectWorkEvent(
              writer,
              event.eventHome,
              event.homeStation,
              event.seq,
            );
            if (existing !== undefined) {
              if (
                existing.entity_home !== input.entityHome ||
                existing.payload_json !== event.payloadJson ||
                existing.content_sha256 !== event.contentSha256
              ) {
                throw replicationError(
                  input.eventHome,
                  event.source.identity.sequence,
                  "identity-conflict",
                  "source sequence is already bound to different work",
                );
              }
              idempotent += 1;
              if (BigInt(event.seq) > BigInt(through)) {
                const expected = (BigInt(through) + 1n).toString();
                if (event.seq !== expected) {
                  throw replicationError(
                    input.eventHome,
                    event.source.identity.sequence,
                    "sequence-gap",
                    `expected route sequence ${expected}, received ${event.seq}`,
                  );
                }
                through = event.seq;
              }
            } else {
              if (BigInt(event.seq) <= BigInt(cursor)) {
                throw replicationError(
                  input.eventHome,
                  event.source.identity.sequence,
                  "cursor-regression",
                  "new work event falls behind the durable receive cursor",
                );
              }
              const expected = (BigInt(through) + 1n).toString();
              if (event.seq !== expected) {
                throw replicationError(
                  input.eventHome,
                  event.source.identity.sequence,
                  "sequence-gap",
                  `expected route sequence ${expected}, received ${event.seq}`,
                );
              }
              try {
                materializeReplicatedWorkEvent(writer, event, receivedAt);
                if (
                  input.causalConflict === "reject-command" &&
                  event.entityKind !== "receipt"
                ) {
                  recordCommandDisposition(writer, {
                    event,
                    localEventHome: input.localEventHome,
                    disposition: { _tag: "Applied" },
                    receivedAt,
                  });
                }
                accepted += 1;
                changed.add(`${event.canvasName}\u0000${event.nodeId}`);
              } catch (error) {
                if (
                  error instanceof WorkReplicationError &&
                  error.reason === "causal-conflict" &&
                  input.causalConflict === "reject-command"
                ) {
                  recordCommandDisposition(writer, {
                    event,
                    localEventHome: input.localEventHome,
                    disposition: {
                      _tag: "Rejected",
                      conflict: error,
                    },
                    receivedAt,
                  });
                  rejected += 1;
                } else {
                  throw error;
                }
              }
              through = event.seq;
            }
          }

          if (decoded.length > 0) {
            writer.run(
              `
                INSERT INTO station_received_cursors(
                  home,
                  through_sequence,
                  updated_at
                ) VALUES (?, ?, ?)
                ON CONFLICT(home) DO UPDATE SET
                  through_sequence = excluded.through_sequence,
                  updated_at = excluded.updated_at
              `,
              [input.eventHome, through, receivedAt],
            );
          }
          return {
            accepted,
            idempotent,
            rejected,
            through,
            changed: [...changed],
          };
        })
        .pipe(
          Effect.mapError((error) =>
            error.cause instanceof WorkReplicationError
              ? error.cause
              : toRepositoryError("work.acceptReplicated", error)
          ),
        );

      for (const key of result.changed) {
        const split = key.indexOf("\u0000");
        notifyChanges(key.slice(0, split), key.slice(split + 1));
      }
      return {
        accepted: result.accepted,
        idempotent: result.idempotent,
        rejected: result.rejected,
        acknowledgement: StationEventAck.make({
          home: input.eventHome,
          through: decodeLogicalSequence(result.through),
        }),
      };
    });

    return WorkRepository.of({
      readSnapshot,
      itemHome,
      snapshotsForCanvas,
      mutate,
      eventsAfter,
      acceptReplicated,
      rejectionsForRoute,
      commandStatus,
      subscribeChanges: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  }),
);
