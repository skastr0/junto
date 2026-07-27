import { createHash } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
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
type WorkEntityKind = WorkLane | "message" | "artifact";

export class WorkRepositoryError extends Schema.TaggedError<WorkRepositoryError>()(
  "WorkRepositoryError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export type WorkEvent = {
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
  readonly operation: string;
  readonly authoredDoc: CanvasDoc;
  readonly transform: (projectedDoc: CanvasDoc) => {
    readonly doc: CanvasDoc;
    readonly value: A;
  };
  readonly originAt?: string;
  readonly receivedAt?: string;
};

export type WorkMutationResult<A> = {
  readonly value: A;
  readonly snapshot: WorkSnapshot;
  readonly projectedDoc: CanvasDoc;
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
  readonly seq: string;
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
  readonly parent_lane: string | null;
  readonly task_id: string | null;
  readonly position: number;
  readonly message_kind: string;
  readonly home_station: string;
  readonly seq: string;
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
  readonly seq: string;
  readonly name: string | null;
  readonly parts_json: string;
  readonly task_id: string | null;
  readonly metadata_json: string | null;
  readonly origin_at: string;
  readonly received_at: string;
};

type WorkEventRow = StateRow & {
  readonly home_station: string;
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
        parent_lane,
        task_id,
        position,
        message_kind,
        home_station,
        seq,
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
        seq,
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
          parent_lane,
          task_id,
          position,
          message_kind,
          home_station,
          seq,
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
          AND parent_lane IS NULL
          AND task_id IS NULL
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
          seq,
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
      SELECT node_id FROM work_messages WHERE canvas_name = ?
      UNION
      SELECT node_id FROM work_artifacts WHERE canvas_name = ?
      ORDER BY node_id
    `,
    [canvasName, canvasName, canvasName, canvasName],
  );
  return nodes.map((row) => loadSnapshot(reader, canvasName, row.node_id));
};

const canonicalSequence = (raw: string): string => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`invalid persisted work sequence "${raw}"`);
  }
  return raw;
};

const nextSequence = (
  writer: StateWriter,
  homeStation: string,
): string => {
  writer.run(
    `
      INSERT OR IGNORE INTO work_home_sequences(home_station, last_seq)
      VALUES (?, '0')
    `,
    [homeStation],
  );
  const row = writer.get<StateRow & { readonly last_seq: string }>(
    "SELECT last_seq FROM work_home_sequences WHERE home_station = ?",
    [homeStation],
  );
  if (!row) throw new Error(`failed to allocate sequence home "${homeStation}"`);
  const next = (BigInt(canonicalSequence(row.last_seq)) + 1n).toString();
  const updated = writer.run(
    `
      UPDATE work_home_sequences
      SET last_seq = ?
      WHERE home_station = ? AND last_seq = ?
    `,
    [next, homeStation, row.last_seq],
  );
  if (Number(updated.changes) !== 1) {
    throw new Error(`work sequence contention for home "${homeStation}"`);
  }
  return next;
};

const recordEvent = (
  writer: StateWriter,
  input: {
    readonly homeStation: string;
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityKind: WorkEntityKind;
    readonly entityId: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly payload: unknown;
  },
): string => {
  const seq = nextSequence(writer, input.homeStation);
  // StationEvent content identity is semantic: receipt time, origin clock,
  // home, and sequence are envelope metadata and never perturb this hash.
  const payloadJson = canonicalJson({
    schema: "vellum/work-event/v1",
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityKind: input.entityKind,
    entityId: input.entityId,
    operation: input.operation,
    body: input.payload,
  });
  const contentSha256 = createHash("sha256")
    .update(payloadJson, "utf8")
    .digest("hex");
  writer.run(
    `
      INSERT INTO work_events(
        home_station,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.homeStation,
      seq,
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
  return seq;
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
    for (const message of task.history) {
      if (priorMessages.has(message.messageId)) continue;
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
      priorBriefId !== brief.messageId
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
  writer: StateWriter,
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

const insertMessage = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly insert: MessageInsert;
  },
): void => {
  const message = input.insert.message;
  const seq = recordEvent(writer, {
    homeStation: COMMAND_CENTER_WORK_HOME,
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityKind: "message",
    entityId: message.messageId,
    operation: input.operation,
    originAt: input.originAt,
    receivedAt: input.receivedAt,
    payload: {
      lane: input.insert.lane,
      taskId: input.insert.taskId,
      position: input.insert.position,
      messageKind: input.insert.kind,
      message,
    },
  });
  writer.run(
    `
      INSERT INTO work_messages(
        canvas_name,
        node_id,
        message_id,
        parent_lane,
        task_id,
        position,
        message_kind,
        home_station,
        seq,
        role,
        parts_json,
        context_id,
        reference_task_ids_json,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.canvasName,
      input.nodeId,
      message.messageId,
      input.insert.lane,
      input.insert.taskId,
      input.insert.position,
      input.insert.kind,
      COMMAND_CENTER_WORK_HOME,
      seq,
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

const writeTaskChange = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly change: TaskChange;
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
  assertImmutableHome(
    `${change.lane} "${change.after.id}"`,
    existingHome,
    input.entityHome,
  );
  const seq = recordEvent(writer, {
    homeStation: input.entityHome,
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityKind: change.lane,
    entityId: change.after.id,
    operation: input.operation,
    originAt: input.originAt,
    receivedAt: input.receivedAt,
    payload: {
      lane: change.lane,
      task: change.after,
    },
  });

  if (!change.before) {
    writer.run(
      `
        INSERT INTO ${table}(
          canvas_name,
          node_id,
          task_id,
          home_station,
          seq,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        input.canvasName,
        input.nodeId,
        change.after.id,
        input.entityHome,
        seq,
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
          seq = ?,
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
        seq,
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
        input.entityHome,
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
          seq,
          operation,
          from_state,
          to_state,
          origin_at,
          received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        seq,
        input.operation,
        change.before?.state ?? null,
        change.after.state,
        input.originAt,
        input.receivedAt,
      ],
    );
  }
};

const insertArtifact = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly artifact: ArtifactValue;
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
  const seq = recordEvent(writer, {
    homeStation: input.entityHome,
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    entityKind: "artifact",
    entityId: input.artifact.artifactId,
    operation: input.operation,
    originAt: input.originAt,
    receivedAt: input.receivedAt,
    payload: { artifact: input.artifact },
  });
  writer.run(
    `
      INSERT INTO work_artifacts(
        canvas_name,
        node_id,
        artifact_id,
        home_station,
        seq,
        name,
        parts_json,
        task_id,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.canvasName,
      input.nodeId,
      input.artifact.artifactId,
      input.entityHome,
      seq,
      input.artifact.name ?? null,
      JSON.stringify(input.artifact.parts),
      input.artifact.taskId ?? null,
      jsonOptional(input.artifact.metadata),
      input.originAt,
      input.receivedAt,
    ],
  );
};

const applyMutationPlan = (
  writer: StateWriter,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly entityHome: string;
    readonly operation: string;
    readonly originAt: string;
    readonly receivedAt: string;
    readonly plan: WorkMutationPlan;
  },
): void => {
  for (const change of input.plan.taskChanges) {
    writeTaskChange(writer, { ...input, change });
  }
  for (const insert of input.plan.messageInserts) {
    insertMessage(writer, { ...input, insert });
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

export class WorkRepository extends Context.Tag("@vellum/WorkRepository")<
  WorkRepository,
  {
    readonly readSnapshot: (
      canvasName: string,
      nodeId: string,
    ) => Effect.Effect<WorkSnapshot, WorkRepositoryError>;
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
      homeStation: string,
      afterSeq: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<WorkEvent>, WorkRepositoryError>;
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
      homeStation: string,
      afterSeq: string,
      limit = 256,
    ): Effect.Effect<ReadonlyArray<WorkEvent>, WorkRepositoryError> =>
      state
        .read("work.eventsAfter", (reader) => {
          const cursor = canonicalSequence(afterSeq);
          const boundedLimit = Math.max(1, Math.min(4096, Math.floor(limit)));
          return reader
            .all<WorkEventRow>(
              `
                SELECT
                  home_station,
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
                WHERE home_station = ?
                  AND (
                    length(seq) > length(?)
                    OR (length(seq) = length(?) AND seq > ?)
                  )
                ORDER BY length(seq), seq
                LIMIT ?
              `,
              [homeStation, cursor, cursor, cursor, boundedLimit],
            )
            .map((row) => ({
              homeStation: row.home_station,
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
            }));
        })
        .pipe(
          Effect.mapError((error) =>
            toRepositoryError("work.eventsAfter", error),
          ),
        );

    return WorkRepository.of({
      readSnapshot,
      snapshotsForCanvas,
      mutate,
      eventsAfter,
      subscribeChanges: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  }),
);
