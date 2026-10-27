/**
 * Task storage and the local ruler for task commands (plan 04 on 02).
 *
 * Until the editing machine's command channel lands, this machine is the
 * editing machine: `submit` rules a command with the shared task domain
 * (`task-machine.ts`) against every task of the canvas, and writes its
 * ruling (in the shared `resource_rulings`), the task's new head, a closed
 * layer when the task was sent on and the next number when one was minted, in
 * one transaction; reads serve the contract's `TaskView`. A command already
 * ruled (same writer, same opId) returns its first ruling and writes nothing.
 *
 * The ruling's effects (assignment notices, stamp requests, defects) come
 * back to the caller, which owes the mail; a replay owes none.
 */

import { Context, Effect, Layer, Option, Result, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import type { InstallationId } from "@shared/installation-id";
import type { NodeId } from "@shared/physics/schema";
import {
  type CommandKey,
  type PendingEntry,
  type RefusedRuling,
  type ResourceCommand,
  type ResourceRuling,
  type RulingContext,
  commandKey,
  emptyRuled,
  overlay,
  precheck,
  rule,
} from "@shared/resource-command";
import {
  type TaskBoardState,
  type TaskDomainEnv,
  type TaskFact,
  type TaskRecord,
  taskDomain,
  taskRefusalToken,
} from "@shared/task-machine";
import {
  TASK_STATES,
  seatNodeId,
  taskNodeId,
  taskNumber,
  type ClosedTaskLayer,
  type Reviewer,
  type Stamp,
  type TaskCommand,
  type TaskCore,
  type TaskEffect,
  type TaskId,
  type TaskState,
  type TaskLink,
  type TaskView,
} from "@shared/task-model";
import type { WorkErrorBody } from "@shared/work-control";
import { CompletionEvidence } from "@shared/work-model";
import { ItemId, type OpId } from "@shared/work-ids";
import { StateTransactionOperation } from "../state/service";
import type { RulingRecord } from "./resource-rulings";
import { RulingRecorder, type RulingRecordFailed } from "./ruling-recorder";
import { readTaskStamps, writeTaskStamps } from "./task-stamps";

export class TaskPersistenceError extends Schema.TaggedError<TaskPersistenceError>()(
  "TaskPersistenceError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

/**
 * What the ruler reads from the canvas besides tasks; the clock is the
 * repository's. The rules in force and the derives targets are required here,
 * so no caller can rule a finish without them.
 */
export type TaskCanvasEnv = Omit<TaskDomainEnv, "at"> & Required<Pick<TaskDomainEnv, "rulesUnmet" | "checksUnmet" | "derivesTo">>;

export type TaskListQuery = {
  readonly nodeIds: ReadonlyArray<NodeId>;
  /** Omitted: every state but archived. */
  readonly states?: ReadonlyArray<TaskState>;
  readonly limit: number;
};

/**
 * A command's outcome. A replay returns the task as it stands now and owes
 * no mail: the first ruling's effects went out with it.
 */
export type TaskSubmitOutcome =
  | {
    readonly kind: "applied";
    readonly opId: OpId;
    readonly task: TaskRecord;
    readonly effects: ReadonlyArray<TaskEffect>;
    readonly replay: boolean;
  }
  | { readonly kind: "refused"; readonly opId: OpId; readonly error: WorkErrorBody; readonly root: OpId };

export class TaskRepository extends Context.Service<TaskRepository,
  {
    /** Tasks on the given nodes, newest change first; `more` when the limit cut the list. */
    readonly list: (
      canvasName: string,
      query: TaskListQuery,
    ) => Effect.Effect<{ readonly tasks: ReadonlyArray<TaskView>; readonly more: boolean }, TaskPersistenceError>;
    /** One task with its closed layers, oldest first. */
    readonly get: (canvasName: string, taskId: TaskId) => Effect.Effect<Option.Option<TaskView>, TaskPersistenceError>;
    /** Rule one command here and write what it makes. */
    readonly submit: (
      writer: InstallationId,
      command: ResourceCommand<TaskCommand>,
      context: RulingContext,
      env: TaskCanvasEnv,
    ) => Effect.Effect<TaskSubmitOutcome, TaskPersistenceError>;
    /**
     * The writer's check of a command it is about to queue for the editing
     * machine, over the ruled tasks held here, its own unruled `queued`
     * commands and its `refused` rulings held here (`precheck`): the refusal
     * when it is definite, else none. Reads only: no ruling, no row, no notice.
     */
    readonly precheck: (
      writer: InstallationId,
      queued: ReadonlyArray<ResourceCommand<TaskCommand>>,
      command: ResourceCommand<TaskCommand>,
      refused: ReadonlyMap<CommandKey, RefusedRuling>,
      context: RulingContext,
      env: TaskCanvasEnv,
    ) => Effect.Effect<Option.Option<Extract<TaskSubmitOutcome, { readonly kind: "refused" }>>, TaskPersistenceError>;
    /** What this machine reads of its queued commands over the ruled tasks held here (`overlay`, read-your-writes 02). */
    readonly overlay: (
      canvasName: string,
      writer: InstallationId,
      queued: ReadonlyArray<ResourceCommand<TaskCommand>>,
      context: RulingContext,
      env: TaskCanvasEnv,
    ) => Effect.Effect<ReadonlyArray<PendingEntry>, TaskPersistenceError>;
  }>()("@junto/TaskRepository") {}

// ── rows ───────────────────────────────────────────────────────────────────

const HeadRow = Schema.Struct({
  task_id: Schema.String,
  number: Schema.Number,
  node_id: Schema.String,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  assignee_node_id: Schema.NullOr(Schema.String),
  epoch: Schema.Number,
  stamps_required: Schema.Number,
  reviewers_json: Schema.String,
  depends_on_json: Schema.String,
  next_node_id: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  updated_at: Schema.Number,
  state_since: Schema.Number,
  checks_json: Schema.String,
  archived_from: Schema.NullOr(Schema.Literals(["done", "canceled"])),
  evidence_json: Schema.NullOr(Schema.String),
  handoff: Schema.NullOr(Schema.String),
  derived_from: Schema.NullOr(Schema.String),
});
type HeadRow = typeof HeadRow.Type;

const LayerRow = Schema.Struct({ task_id: Schema.String, layer_json: Schema.String, closed_at: Schema.Number });
type LayerRow = typeof LayerRow.Type;

const ReviewerJson = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), seat: Schema.String.pipe(Schema.check(Schema.isMinLength(1))) }),
  Schema.Struct({ kind: Schema.Literal("operator") }),
]);
const decodeReviewers = Schema.decodeUnknownResult(Schema.Array(ReviewerJson));
const CheckResultJson = Schema.Struct({
  checkId: Schema.String,
  side: Schema.Literals(["outgoing", "incoming"]),
  command: Schema.String,
  exitCode: Schema.Int,
  outputTail: Schema.String,
  epoch: Schema.Int,
  destination: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  at: Schema.Number,
});
const decodeChecks = Schema.decodeUnknownResult(Schema.Array(CheckResultJson));
const decodeTaskIds = Schema.decodeUnknownResult(Schema.Array(ItemId));
const decodeEvidence = Schema.decodeUnknownResult(CompletionEvidence);
const isTaskState = (value: string): value is TaskState => (TASK_STATES as ReadonlyArray<string>).includes(value);

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

const asReviewer = (reviewer: typeof ReviewerJson.Type): Reviewer =>
  reviewer.kind === "operator" ? reviewer : { kind: "seat", seat: seatNodeId(reviewer.seat as NodeId) };

/**
 * A task's reviewer list as its head stores it, read through the caller's
 * client so the caller's own transaction sees it. Empty when the canvas holds
 * no such task or the list does not decode.
 */
export const readTaskReviewers = (
  client: SqlClient.SqlClient,
  canvasName: string,
  taskId: string,
): Effect.Effect<ReadonlyArray<Reviewer>, SqlError.SqlError> =>
  client<{ readonly reviewers_json: string }>`
    SELECT reviewers_json FROM task_heads WHERE canvas_name = ${canvasName} AND task_id = ${taskId}`.pipe(
    Effect.map((rows) => {
      const decoded = rows[0] === undefined ? undefined : decodeReviewers(parse(rows[0].reviewers_json));
      return decoded === undefined || Result.isFailure(decoded) ? [] : decoded.success.map(asReviewer);
    }),
  );

/**
 * A head row and its stamps (`task-stamps.ts`) as a task record, or nothing
 * when the row, or a stamp of it (`stamps` undefined), does not decode.
 */
export const taskOfRow = (row: HeadRow, stamps: ReadonlyArray<Stamp> | undefined): TaskRecord | undefined => {
  const number = taskNumber(row.number);
  const reviewers = decodeReviewers(parse(row.reviewers_json));
  const dependsOn = decodeTaskIds(parse(row.depends_on_json));
  const checks = decodeChecks(parse(row.checks_json));
  const id = Schema.decodeUnknownOption(ItemId)(row.task_id);
  const evidence = row.evidence_json === null ? undefined : decodeEvidence(parse(row.evidence_json));
  if (
    number === undefined || Option.isNone(id) || !isTaskState(row.state) || Result.isFailure(reviewers) ||
    stamps === undefined || Result.isFailure(dependsOn) || Result.isFailure(checks) ||
    (evidence !== undefined && Result.isFailure(evidence))
  ) {
    return undefined;
  }
  return {
    id: id.value,
    number,
    title: row.title,
    ...(row.body === null ? {} : { body: row.body }),
    dependsOn: dependsOn.success,
    state: row.state,
    node: taskNodeId(row.node_id as NodeId),
    ...(row.assignee_node_id === null ? {} : { assignee: seatNodeId(row.assignee_node_id as NodeId) }),
    epoch: row.epoch,
    stampPolicy: { required: row.stamps_required },
    reviewers: reviewers.success.map(asReviewer),
    stamps,
    ...(checks.success.length === 0
      ? {}
      : {
        checks: checks.success.map(({ destination, ...run }) => ({
          ...run,
          ...(destination === undefined ? {} : { destination: taskNodeId(destination as NodeId) }),
        })),
      }),
    ...(row.next_node_id === null ? {} : { next: taskNodeId(row.next_node_id as NodeId) }),
    ...(row.archived_from === null ? {} : { archivedFrom: row.archived_from }),
    ...(evidence === undefined || Result.isFailure(evidence) ? {} : { evidence: evidence.success }),
    ...(row.handoff === null ? {} : { handoff: row.handoff }),
    ...(row.derived_from === null ? {} : { derivedFrom: row.derived_from as TaskId }),
  };
};

/** What the ruler keeps of a ruling: enough to answer a replay. */
const StoredRuling = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("applied"), taskId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("refused"), error: Schema.Unknown, root: Schema.String }),
]);
const decodeStoredRuling = Schema.decodeUnknownResult(StoredRuling);

/** A closed layer row; written whole from a ruled layer and never changed. */
const layerOfRow = (row: LayerRow): ClosedTaskLayer => ({ ...(parse(row.layer_json) as TaskCore), closedAt: row.closed_at });

/** The read shape of a head and its closed layers. */
const viewOf = (
  row: HeadRow,
  task: TaskRecord,
  layers: ReadonlyArray<ClosedTaskLayer>,
  links: { readonly origin?: TaskLink | undefined; readonly derived: ReadonlyArray<TaskLink> },
): TaskView => {
  const { id, number, title, body, dependsOn, derivedFrom: _origin, ...current } = task;
  return {
    taskId: id,
    number,
    title,
    ...(body === undefined ? {} : { body }),
    current,
    layers,
    dependsOn,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateSince: row.state_since,
    ...(links.origin === undefined ? {} : { derivedFrom: links.origin }),
    ...(links.derived.length === 0 ? {} : { derived: links.derived }),
  };
};

/** A head row as another task's view links to it. */
const linkOfRow = (row: { readonly task_id: string; readonly number: number; readonly node_id: string }): TaskLink => {
  const number = taskNumber(row.number);
  return { taskId: row.task_id as TaskId, ...(number === undefined ? {} : { number }), node: taskNodeId(row.node_id as NodeId) };
};

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | RulingRecordFailed | TaskPersistenceError) =>
  error instanceof TaskPersistenceError ? error : TaskPersistenceError.make({ operation, message: error.message, cause: error });

/** A stored row the ruler cannot read: the write fails rather than rule around it. */
const unreadable = (what: string, taskId: string) =>
  TaskPersistenceError.make({ operation: "submit", message: `${what} ${taskId} does not decode`, cause: taskId });

// ── the repository ─────────────────────────────────────────────────────────

/**
 * The task domain's projection: fold one ruled fact into `task_heads`,
 * `task_layers`, `task_numbers` and its stamps' verdict rows. The ruler writes its facts with it, and a
 * machine that does not edit the canvas folds the editing machine's facts
 * with it (`ruling-projection.ts`), at the ruling's time. The caller owns the
 * transaction.
 */
export const projectTaskFact = (sql: SqlClient.SqlClient, canvas: string, fact: TaskFact, at: number) =>
  Effect.gen(function* () {
    const task = fact.task;
    for (const effect of fact.effects) {
      if (effect.kind === "sent-on") {
        const n = (yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM task_layers WHERE canvas_name = ${canvas} AND task_id = ${task.id}`)[0]?.n ?? 0;
        yield* sql`
          INSERT INTO task_layers (canvas_name, task_id, ordinal, node_id, layer_json, closed_at)
          VALUES (${canvas}, ${task.id}, ${n}, ${effect.from}, ${JSON.stringify(effect.layer)}, ${at})`;
      }
      if (effect.kind === "number-minted") {
        yield* sql`
          INSERT INTO task_numbers (canvas_name, next_number) VALUES (${canvas}, ${effect.number + 1})
          ON CONFLICT (canvas_name) DO UPDATE SET next_number = excluded.next_number`;
      }
    }
    yield* sql`
      INSERT INTO task_heads (canvas_name, task_id, number, node_id, title, body, state, assignee_node_id, epoch, stamps_required, reviewers_json, depends_on_json, next_node_id, created_at, updated_at, state_since, checks_json, archived_from, evidence_json, handoff, derived_from)
      VALUES (${canvas}, ${task.id}, ${task.number}, ${task.node}, ${task.title}, ${task.body ?? null}, ${task.state},
        ${task.assignee ?? null}, ${task.epoch}, ${task.stampPolicy.required}, ${JSON.stringify(task.reviewers)},
        ${JSON.stringify(task.dependsOn)}, ${task.next ?? null}, ${at}, ${at}, ${at}, ${JSON.stringify(task.checks ?? [])},
        ${task.archivedFrom ?? null}, ${task.evidence === undefined ? null : JSON.stringify(task.evidence)}, ${task.handoff ?? null},
        ${task.derivedFrom ?? null})
      ON CONFLICT (canvas_name, task_id) DO UPDATE SET
        -- A write that leaves the state as it is keeps when that state began.
        state_since = CASE WHEN task_heads.state = excluded.state THEN task_heads.state_since ELSE excluded.state_since END,
        node_id = excluded.node_id, title = excluded.title, body = excluded.body, state = excluded.state,
        assignee_node_id = excluded.assignee_node_id, epoch = excluded.epoch,
        stamps_required = excluded.stamps_required, reviewers_json = excluded.reviewers_json,
        depends_on_json = excluded.depends_on_json, checks_json = excluded.checks_json,
        next_node_id = excluded.next_node_id, archived_from = excluded.archived_from,
        evidence_json = excluded.evidence_json, handoff = excluded.handoff, updated_at = excluded.updated_at`;
    yield* writeTaskStamps(sql, canvas, task);
  });

export const TaskRepositoryLive: Layer.Layer<TaskRepository, never, SqlClient.SqlClient | RulingRecorder> = Layer.effect(
  TaskRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const recorder = yield* RulingRecorder;

    const headRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ canvas: Schema.String, id: Schema.String }),
      Result: HeadRow,
      execute: ({ canvas, id }) => sql`
        SELECT task_id, number, node_id, title, body, state, assignee_node_id, epoch, stamps_required, reviewers_json, depends_on_json, next_node_id, created_at, updated_at, state_since, checks_json, archived_from, evidence_json, handoff, derived_from FROM task_heads WHERE canvas_name = ${canvas} AND task_id = ${id}`,
    });

    const canvasRows = SqlSchema.findAll({
      Request: Schema.Struct({ canvas: Schema.String }),
      Result: HeadRow,
      execute: ({ canvas }) => sql`
        SELECT task_id, number, node_id, title, body, state, assignee_node_id, epoch, stamps_required, reviewers_json, depends_on_json, next_node_id, created_at, updated_at, state_since, checks_json, archived_from, evidence_json, handoff, derived_from FROM task_heads WHERE canvas_name = ${canvas} ORDER BY number`,
    });

    const nextNumberRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ canvas: Schema.String }),
      Result: Schema.Struct({ next_number: Schema.Number }),
      execute: ({ canvas }) => sql`SELECT next_number FROM task_numbers WHERE canvas_name = ${canvas}`,
    });

    const rulingRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ canvas: Schema.String, writer: Schema.String, opId: Schema.String }),
      Result: Schema.Struct({ ruling_json: Schema.String }),
      execute: ({ canvas, writer, opId }) => sql`
        SELECT ruling_json FROM resource_rulings
        WHERE canvas_name = ${canvas} AND writer = ${writer} AND op_id = ${opId}`,
    });

    const layerRows = (canvas: string, ids: ReadonlyArray<string>) =>
      ids.length === 0
        ? Effect.succeed<ReadonlyArray<LayerRow>>([])
        : SqlSchema.findAll({
          Request: Schema.Void,
          Result: LayerRow,
          execute: () => sql`
            SELECT task_id, layer_json, closed_at FROM task_layers
            WHERE canvas_name = ${canvas} AND ${sql.in("task_id", ids)}
            ORDER BY task_id, ordinal`,
        })(undefined);

    /** The epoch each task arrived on its node with: one past its last closed layer's. */
    const arrivals = (canvas: string, ids: ReadonlyArray<string>) =>
      ids.length === 0
        ? Effect.succeed(new Map<string, number>())
        : Effect.map(
          sql<{ readonly task_id: string; readonly epoch: number | null }>`
            SELECT task_id, max(json_extract(layer_json, '$.epoch')) AS epoch FROM task_layers
            WHERE canvas_name = ${canvas} AND ${sql.in("task_id", ids)}
            GROUP BY task_id`,
          (rows) => new Map(rows.map((row) => [row.task_id, row.epoch === null ? 0 : row.epoch + 1])),
        );

    /** Head rows with their stamps as task records; undefined where a row does not decode. */
    const recordsOf = (canvas: string, rows: ReadonlyArray<HeadRow>) =>
      Effect.gen(function* () {
        const since = yield* arrivals(canvas, rows.map((row) => row.task_id));
        const { stamps, unreadable } = yield* readTaskStamps(
          sql,
          canvas,
          rows.map((row) => ({ taskId: row.task_id, node: row.node_id, since: since.get(row.task_id) ?? 0 })),
        );
        return rows.map((row) => taskOfRow(row, unreadable.has(row.task_id) ? undefined : (stamps.get(row.task_id) ?? [])));
      });

    /** Views of decodable head rows, each with its closed layers. */
    /** Each row's origin, and the tasks derived from each row, by number. */
    const linksOf = (canvas: string, rows: ReadonlyArray<HeadRow>) =>
      Effect.gen(function* () {
        type LinkRow = { readonly task_id: string; readonly number: number; readonly node_id: string; readonly derived_from: string | null };
        const originIds = [...new Set(rows.flatMap((row) => (row.derived_from === null ? [] : [row.derived_from])))];
        const ids = rows.map((row) => row.task_id);
        const origins = originIds.length === 0 ? [] : yield* sql<LinkRow>`
          SELECT task_id, number, node_id, derived_from FROM task_heads
          WHERE canvas_name = ${canvas} AND ${sql.in("task_id", originIds)}`;
        const derivedRows = ids.length === 0 ? [] : yield* sql<LinkRow>`
          SELECT task_id, number, node_id, derived_from FROM task_heads
          WHERE canvas_name = ${canvas} AND ${sql.in("derived_from", ids)}
          ORDER BY number`;
        const derived = new Map<string, TaskLink[]>();
        for (const row of derivedRows) {
          const held = derived.get(row.derived_from!);
          if (held === undefined) derived.set(row.derived_from!, [linkOfRow(row)]);
          else held.push(linkOfRow(row));
        }
        return { origins: new Map(origins.map((row) => [row.task_id, linkOfRow(row)] as const)), derived };
      });

    const viewsOf = (canvas: string, rows: ReadonlyArray<HeadRow>) =>
      Effect.gen(function* () {
        const records = yield* recordsOf(canvas, rows);
        const layers = new Map<string, ClosedTaskLayer[]>();
        for (const row of yield* layerRows(canvas, rows.map((head) => head.task_id))) {
          const held = layers.get(row.task_id);
          if (held === undefined) layers.set(row.task_id, [layerOfRow(row)]);
          else held.push(layerOfRow(row));
        }
        const links = yield* linksOf(canvas, rows);
        return rows.flatMap((row, i) => {
          const task = records[i];
          return task === undefined ? [] : [viewOf(row, task, layers.get(row.task_id) ?? [], {
            origin: row.derived_from === null ? undefined : links.origins.get(row.derived_from),
            derived: links.derived.get(row.task_id) ?? [],
          })];
        });
      });

    const readTask = (canvas: string, id: TaskId) =>
      Effect.gen(function* () {
        const row = yield* headRow({ canvas, id });
        if (Option.isNone(row)) return Option.none<TaskRecord>();
        return Option.fromNullishOr((yield* recordsOf(canvas, [row.value]))[0]);
      });

    /**
     * Every task of the canvas, for the invariants that span it (dependency
     * cycles), and the next number.
     */
    const readBoard = (canvas: string) =>
      Effect.gen(function* () {
        const tasks = new Map<TaskId, TaskRecord>();
        const rows = yield* canvasRows({ canvas });
        const records = yield* recordsOf(canvas, rows);
        for (const [i, row] of rows.entries()) {
          // Fail closed: a row left out would escape the cycle check and be overwritten by a create.
          const task = records[i];
          if (task === undefined) return yield* Effect.fail(unreadable("task", row.task_id));
          tasks.set(task.id, task);
        }
        const stored = yield* nextNumberRow({ canvas });
        const nextNumber = taskNumber(Option.isSome(stored) ? stored.value.next_number : 1) ?? taskNumber(1)!;
        return { tasks, nextNumber } satisfies TaskBoardState;
      });

    /** Earlier rulings a command's `after` names, so a refused root refuses it too. */
    const priorRulings = (canvas: string, writer: InstallationId, command: ResourceCommand<TaskCommand>) =>
      Effect.gen(function* () {
        const rulings = new Map<CommandKey, ResourceRuling<TaskFact>>();
        for (const opId of command.after) {
          const row = yield* rulingRow({ canvas, writer, opId });
          if (Option.isNone(row)) continue;
          const stored = decodeStoredRuling(parse(row.value.ruling_json));
          if (Result.isSuccess(stored) && stored.success.kind === "refused") {
            rulings.set(commandKey(writer, opId), {
              kind: "refused",
              opId,
              error: stored.success.error as WorkErrorBody,
              root: stored.success.root as OpId,
            });
          }
        }
        return rulings;
      });

    const writeFact = (canvas: string, fact: TaskFact, at: number) => projectTaskFact(sql, canvas, fact, at);

    const list = Effect.fn("tasks.list")(function* (canvasName: string, query: TaskListQuery) {
      if (query.nodeIds.length === 0) return { tasks: [], more: false };
      const states = query.states ?? TASK_STATES.filter((state) => state !== "archived");
      if (states.length === 0) return { tasks: [], more: false };
      const rows = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: HeadRow,
        execute: () => sql`
          SELECT task_id, number, node_id, title, body, state, assignee_node_id, epoch, stamps_required, reviewers_json, depends_on_json, next_node_id, created_at, updated_at, state_since, checks_json, archived_from, evidence_json, handoff, derived_from FROM task_heads
          WHERE canvas_name = ${canvasName}
            AND ${sql.in("node_id", query.nodeIds)}
            AND ${sql.in("state", states)}
          ORDER BY updated_at DESC, task_id DESC
          LIMIT ${query.limit + 1}`,
      })(undefined);
      const tasks = yield* viewsOf(canvasName, rows.slice(0, query.limit));
      return { tasks, more: rows.length > query.limit };
    }, Effect.mapError(persistence("list")));

    const get = Effect.fn("tasks.get")(function* (canvasName: string, taskId: TaskId) {
      const row = yield* headRow({ canvas: canvasName, id: taskId });
      if (Option.isNone(row)) return Option.none<TaskView>();
      return Option.fromNullishOr((yield* viewsOf(canvasName, [row.value]))[0]);
    }, Effect.mapError(persistence("get")));

    const submit = Effect.fn("tasks.submit")(function* (
      writer: InstallationId,
      command: ResourceCommand<TaskCommand>,
      context: RulingContext,
      env: TaskCanvasEnv,
    ) {
      const canvas = command.canvasName;
      const prior = yield* rulingRow({ canvas, writer, opId: command.opId });
      if (Option.isSome(prior)) {
        const stored = decodeStoredRuling(parse(prior.value.ruling_json));
        if (Result.isSuccess(stored)) {
          if (stored.success.kind === "refused") {
            return {
              kind: "refused" as const,
              opId: command.opId,
              error: stored.success.error as WorkErrorBody,
              root: stored.success.root as OpId,
            };
          }
          const task = yield* readTask(canvas, stored.success.taskId as TaskId);
          if (Option.isNone(task)) return yield* Effect.fail(unreadable("the task of applied ruling", command.opId));
          return { kind: "applied" as const, opId: command.opId, task: task.value, effects: [], replay: true };
        }
        return yield* Effect.fail(unreadable("ruling", command.opId));
      }
      const at = Date.now();
      const state = yield* readBoard(canvas);
      const rulings = yield* priorRulings(canvas, writer, command);
      const ruled = rule(taskDomain({ ...env, at }), { state, rulings }, writer, command, context);
      const ruling = ruled.ruling;
      let outcome: TaskSubmitOutcome;
      if (ruling.kind === "applied") {
        for (const fact of ruling.facts) yield* writeFact(canvas, fact, at);
        const last = ruling.facts[ruling.facts.length - 1]!;
        outcome = {
          kind: "applied",
          opId: command.opId,
          task: last.task,
          effects: ruling.facts.flatMap((fact) => fact.effects),
          replay: false,
        };
      } else {
        outcome = { kind: "refused", opId: command.opId, error: ruling.error, root: ruling.root };
      }
      // An applied ruling that brought its task into a state names it, so change triggers read rulings, not snapshots.
      const record: RulingRecord = outcome.kind === "applied"
        ? {
            kind: "applied",
            taskId: outcome.task.id,
            ...(state.tasks.get(outcome.task.id)?.state === outcome.task.state
              ? {}
              : { node: outcome.task.node, became: outcome.task.state }),
          }
        : { kind: "refused", error: outcome.error, root: outcome.root };
      yield* recorder.record({
        canvasName: canvas,
        writer,
        command,
        kind: "task",
        record,
        // The row carries a refusal's detail only as a bounded token, so the seat's machine can word it.
        ruling: ruling.kind === "applied"
          ? ruling
          : { ...ruling, error: { ...ruling.error, details: { ...ruling.error.details, expected: taskRefusalToken(ruling.error.details?.expected) } } },
        at: new Date(at).toISOString(),
      });
      return outcome;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "tasks.submit"), Effect.mapError(persistence("submit")));

    const precheckOf = Effect.fn("tasks.precheck")(function* (
      writer: InstallationId,
      queued: ReadonlyArray<ResourceCommand<TaskCommand>>,
      command: ResourceCommand<TaskCommand>,
      refused: ReadonlyMap<CommandKey, RefusedRuling>,
      context: RulingContext,
      env: TaskCanvasEnv,
    ) {
      const state = yield* readBoard(command.canvasName);
      return Option.fromNullishOr(precheck(taskDomain({ ...env, at: Date.now() }), { state, rulings: refused }, writer, queued, command, context));
    }, Effect.mapError(persistence("precheck")));

    const overlayOf = Effect.fn("tasks.overlay")(function* (
      canvasName: string,
      writer: InstallationId,
      queued: ReadonlyArray<ResourceCommand<TaskCommand>>,
      context: RulingContext,
      env: TaskCanvasEnv,
    ) {
      const state = yield* readBoard(canvasName);
      return overlay(taskDomain({ ...env, at: Date.now() }), emptyRuled<TaskBoardState, TaskFact>(state), writer, queued, context).pending;
    }, Effect.mapError(persistence("overlay")));

    return TaskRepository.of({ list, get, submit, precheck: precheckOf, overlay: overlayOf });
  }),
);
