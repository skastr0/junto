/**
 * A seat that leaves the canvas lets go of its tasks. A canvas command that
 * removes an agent seat sends each open task it held back to the backlog,
 * through the task ruler's own `unassign`, in the same transaction as the
 * delete, with the operator as actor, and says so in the task's thread. A
 * command that puts the seat back (undo: an Add of the same id) gives each
 * task back to it, as assigned, while no command has ruled on the task since
 * the release; one that changed stays in the backlog, and the command says
 * how many (`tasksKept`).
 *
 * A seat only ever leaves by a Remove that names it: a region delete takes
 * the region alone, and a terminal that exits leaves its node in place. The
 * kernel of this is ModelService.command's own transaction, so either the
 * delete and every release land, or none do. Closed tasks keep their
 * assignee as history.
 */
import { Effect, Layer, Option, Result, Semaphore } from "effect";
import { AUTHORITY_ENABLED } from "@shared/features";
import { SqlClient } from "effect/unstable/sql";
import { nodesOf } from "@shared/model/canvas";
import type { Canvas, Command } from "@shared/model";
import { mintOpId, type ResourceCommand } from "@shared/resource-command";
import { OPEN_TASK_STATES, type SeatNodeId, type TaskCommand, type TaskId, type TaskNodeId } from "@shared/task-model";
import { MachineRepository } from "../machines/repository";
import { ModelRefused, modelError } from "../model/records";
import { ModelService } from "../model/service";
import { afterSqlCommit } from "../state/sql-commit";
import { noteResourceChanged } from "./resource-changes";
import { postSubjectComment } from "./subject-comment";
import { taskCanvasEnv, taskRulingContext } from "./task-control";
import { TaskRepository } from "./task-repository";

/** The line a released task's thread gets. */
export const SEAT_RELEASE_LINE = "Back in the backlog: its seat was removed.";

/** What a canvas command did, and how many tasks it could not give back to a restored seat. */
export type ReleasingCommandResult = { readonly seq: number; readonly tasksKept?: number };

type Released = { readonly node: TaskNodeId; readonly taskId: TaskId };

const SCAN_LIMIT = 10_000;
const operator = { kind: "operator" } as const;

const agentIds = (canvas: Canvas | undefined): ReadonlySet<string> =>
  new Set(canvas === undefined ? [] : nodesOf(canvas, "agent").map((node) => node.id));

const taskNodeIds = (canvas: Canvas) => [...canvas.nodes.values()].filter((node) => node.kind === "task").map((node) => node.id);

const taskCommand = (canvasName: string, node: TaskNodeId, taskId: TaskId, op: TaskCommand): ResourceCommand<TaskCommand> => ({
  opId: mintOpId(),
  canvasName,
  actor: operator,
  target: { kind: "task", nodeId: node, itemId: taskId },
  basis: null,
  after: [],
  op,
});

/** Run a canvas command, releasing the tasks of each seat it removes and giving them back to each seat it restores. */
export const commandReleasingSeats = (command: Command, source: "operator" | "overseer") =>
  AUTHORITY_ENABLED ? commandThenHeal(command, source) : releasingInOneTransaction(command, source);

const releasingInOneTransaction = (command: Command, source: "operator" | "overseer") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const model = yield* ModelService;
    const tasks = yield* TaskRepository;
    const machines = yield* MachineRepository;
    const services = yield* Effect.context<never>();
    // A command on a whole canvas, or on its authority, moves no seat it could release.
    const seatsMove = command._tag !== "CreateCanvas" && command._tag !== "RemoveCanvas" && command._tag !== "GrantOverseer";
    // Behind the authority this one transaction cannot hold: a judged unassign commits on its own (commandThenHeal).
    // Once structure.changed is logged (0.11/06 F2), the removal and its unassigns become one judged batch,
    // and that bridge goes.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const canvasName = command.canvas;
        const before = seatsMove ? yield* model.canvas(canvasName) : undefined;
        const result = yield* model.command(command, source);
        if (!seatsMove || before === undefined) return result satisfies ReleasingCommandResult;
        const after = yield* model.canvas(canvasName);
        const had = agentIds(before);
        const has = agentIds(after);
        const gone = [...had].filter((id) => !has.has(id));
        const back = [...has].filter((id) => !had.has(id));
        if (gone.length === 0 && back.length === 0) return result satisfies ReleasingCommandResult;
        const writer = yield* machines.installationId;
        // The task's head row as stored: any ruling that writes the task changes it.
        // A whole-row match also means a release made before task_heads gains a
        // column never matches after it: that task stays in the backlog and is
        // counted as kept, which is the safe way to be wrong.
        const headOf = (canvas: string, taskId: string) =>
          Effect.map(
            sql<Record<string, unknown>>`SELECT * FROM task_heads WHERE canvas_name = ${canvas} AND task_id = ${taskId}`,
            ([head]) => (head === undefined ? "null" : JSON.stringify(head)),
          );
        const env = taskCanvasEnv(after);
        const context = taskRulingContext(after);

        // Released: each open task a removed seat held, on a task node still here.
        const released: Released[] = [];
        if (gone.length > 0) {
          const { tasks: open } = yield* tasks.list(canvasName, { nodeIds: taskNodeIds(after), states: OPEN_TASK_STATES, limit: SCAN_LIMIT });
          for (const task of open) {
            const seat = task.current.assignee;
            if (seat === undefined || !gone.includes(seat)) continue;
            const outcome = yield* tasks.submit(writer, taskCommand(canvasName, task.current.node, task.taskId, { kind: "unassign" }), context, env);
            // A release the ruler refuses would leave the task held by a seat that is gone: the delete does not happen.
            if (outcome.kind !== "applied") {
              return yield* Effect.fail(
                new ModelRefused({ rule: `The seat's task ${task.taskId} could not go back to the backlog, so the seat stays: ${outcome.error.message}` }),
              );
            }
            yield* sql`
              INSERT OR REPLACE INTO task_seat_releases (canvas_name, seat_node_id, task_id, released_head)
              VALUES (${canvasName}, ${seat}, ${task.taskId}, ${yield* headOf(canvasName, task.taskId)})`;
            released.push({ node: task.current.node, taskId: task.taskId });
          }
        }

        // Given back: each task a restored seat's delete released, while nothing has ruled on it since.
        let given = 0;
        let kept = 0;
        for (const seat of back) {
          const rows = yield* sql<{ readonly task_id: string; readonly released_head: string }>`
            SELECT task_id, released_head FROM task_seat_releases WHERE canvas_name = ${canvasName} AND seat_node_id = ${seat}`;
          yield* sql`DELETE FROM task_seat_releases WHERE canvas_name = ${canvasName} AND seat_node_id = ${seat}`;
          for (const row of rows) {
            const head = yield* headOf(canvasName, row.task_id);
            const node = (JSON.parse(row.released_head) as { readonly node_id: string }).node_id;
            const outcome = head === row.released_head && after.nodes.has(node as never)
              ? yield* tasks.submit(
                writer,
                taskCommand(canvasName, node as TaskNodeId, row.task_id as TaskId, { kind: "assign", seat: seat as SeatNodeId }),
                context,
                env,
              )
              : undefined;
            if (outcome?.kind === "applied") given += 1;
            else kept += 1;
          }
        }

        if (released.length > 0 || given > 0) {
          yield* afterSqlCommit(sql, () => {
            noteResourceChanged("task", canvasName);
            // The thread line goes once the release is committed; a line that fails leaves the release as it is.
            for (const task of released) {
              void Effect.runPromiseWith(services)(
                postSubjectComment(
                  { subject: { kind: "task", nodeId: task.node, taskId: task.taskId }, text: SEAT_RELEASE_LINE, actor: operator, opId: mintOpId() },
                  { canvas: after, canvasName, people: [] },
                ).pipe(Effect.catchCause((cause) => Effect.logWarning("a released task's thread line was not posted", cause))),
              );
            }
          });
        }
        return (kept > 0 ? { ...result, tasksKept: kept } : result) satisfies ReleasingCommandResult;
      }),
    );
  }).pipe(Effect.mapError((cause) => modelError("seat-release", cause)));

/**
 * Behind the authority, a bridge (0.11/06 F2) until a canvas's structure
 * change and its unassigns are one judged batch: the command commits first,
 * then each owed release is judged on its own. What is owed is read from
 * state, never from memory, so a crash or a failed judgment between the two
 * is healed by the next release and at boot (`healEverySeatRelease`). Run
 * inside a caller's transaction, as an overseer's edit is, the heal waits for
 * that transaction to commit, and the command cannot count what it kept.
 */
const commandThenHeal = (command: Command, source: "operator" | "overseer") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const model = yield* ModelService;
    const services = yield* Effect.context<SqlClient.SqlClient | ModelService | TaskRepository | MachineRepository>();
    const seatsMove = command._tag !== "CreateCanvas" && command._tag !== "RemoveCanvas" && command._tag !== "GrantOverseer";
    const result: ReleasingCommandResult = yield* sql.withTransaction(model.command(command, source));
    if (!seatsMove) return result;
    const heal = healSeatReleases(command.canvas);
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      yield* afterSqlCommit(sql, () => {
        void Effect.runPromiseWith(services)(heal.pipe(Effect.catchCause((cause) => Effect.logWarning("a seat release was left owed", cause))));
      });
      return result;
    }
    const healed = yield* heal;
    return healed.kept > 0 ? { ...result, tasksKept: healed.kept } : result;
  }).pipe(Effect.mapError((cause) => modelError("seat-release", cause)));

/** What one heal did: the tasks it released, gave back, and kept in the backlog. */
export type SeatReleaseHealed = { readonly released: number; readonly given: number; readonly kept: number };

/**
 * Settle what a canvas owes its seats, one judged command each, outside any
 * transaction: each open task whose seat is gone goes back to the backlog,
 * and each task a seat now back on the canvas let go returns to it, while
 * nothing has ruled on it since. A command the ruler refuses is logged and
 * left for the next release or boot; one the authority could not judge
 * stays owed the same way. Each is tried once a heal, so a heal ends.
 *
 * A seat is gone when no node of that id is left on the canvas: an operator
 * may assign a task to any node, and only a removal lets it go. An unassign
 * of a task on a gone seat is refused only when the task is no longer open,
 * or it or its node is gone, between the read and the judgment: then nothing
 * is owed, and the next heal finds nothing.
 *
 * A crash after an unassign applies and before its release row is written
 * loses that task's give-back: it stays in the backlog when the seat comes
 * back, the safe way to be wrong. One heal runs on a canvas at a time, so
 * the boot heal, a release and an overseer's heal never judge a task twice.
 */
export const healSeatReleases = (canvasName: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => healPermit(sql, canvasName).withPermits(1)(healUnheld(canvasName)));

/** One heal at a time per canvas, per store. */
const healing = new WeakMap<SqlClient.SqlClient, Map<string, Semaphore.Semaphore>>();
const healPermit = (sql: SqlClient.SqlClient, canvasName: string): Semaphore.Semaphore => {
  const permits = healing.get(sql) ?? new Map<string, Semaphore.Semaphore>();
  healing.set(sql, permits);
  const permit = permits.get(canvasName) ?? Semaphore.makeUnsafe(1);
  permits.set(canvasName, permit);
  return permit;
};

const healUnheld = (canvasName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const model = yield* ModelService;
    const tasks = yield* TaskRepository;
    const machines = yield* MachineRepository;
    const services = yield* Effect.context<never>();
    const canvas = yield* model.canvas(canvasName);
    const seats = agentIds(canvas);
    const nodes: ReadonlySet<string> = new Set(canvas === undefined ? [] : [...canvas.nodes.keys()]);
    const writer = yield* machines.installationId;
    const env = taskCanvasEnv(canvas);
    const context = taskRulingContext(canvas);
    const headOf = (taskId: string) =>
      Effect.map(
        sql<Record<string, unknown>>`SELECT * FROM task_heads WHERE canvas_name = ${canvasName} AND task_id = ${taskId}`,
        ([head]) => (head === undefined ? "null" : JSON.stringify(head)),
      );
    const judged = (taskId: string, command: ResourceCommand<TaskCommand>) =>
      Effect.result(tasks.submit(writer, command, context, env)).pipe(
        Effect.tap((outcome) =>
          Result.isFailure(outcome)
            ? Effect.logWarning(`task ${taskId} on ${canvasName}: its seat release stays owed`, outcome.failure)
            : outcome.success.kind === "refused"
              ? Effect.logWarning(`task ${taskId} on ${canvasName}: its seat release was refused, left for the next release or boot`, outcome.success.error)
              : Effect.void),
        Effect.map((outcome) => Result.isSuccess(outcome) && outcome.success.kind === "applied"),
      );

    // Owed unassigns: each open task held by a seat with no node left on the canvas.
    const released: Released[] = [];
    const { tasks: open } = yield* tasks.list(canvasName, { nodeIds: taskNodeIds(canvas), states: OPEN_TASK_STATES, limit: SCAN_LIMIT });
    for (const task of open) {
      const seat = task.current.assignee;
      if (seat === undefined || nodes.has(seat)) continue;
      if (!(yield* judged(task.taskId, taskCommand(canvasName, task.current.node, task.taskId, { kind: "unassign" })))) continue;
      // Written once the unassign applied, from the head it left: the give-back reads it.
      yield* sql`
        INSERT OR REPLACE INTO task_seat_releases (canvas_name, seat_node_id, task_id, released_head)
        VALUES (${canvasName}, ${seat}, ${task.taskId}, ${yield* headOf(task.taskId)})`;
      released.push({ node: task.current.node, taskId: task.taskId });
    }

    // Owed give-backs: each release row whose seat is on the canvas again. A row goes only once settled.
    let given = 0;
    let kept = 0;
    const rows = yield* sql<{ readonly seat_node_id: string; readonly task_id: string; readonly released_head: string }>`
      SELECT seat_node_id, task_id, released_head FROM task_seat_releases WHERE canvas_name = ${canvasName}`;
    for (const row of rows) {
      if (!seats.has(row.seat_node_id)) continue;
      const settled = sql`DELETE FROM task_seat_releases
        WHERE canvas_name = ${canvasName} AND seat_node_id = ${row.seat_node_id} AND task_id = ${row.task_id}`;
      const node = (JSON.parse(row.released_head) as { readonly node_id: string }).node_id;
      if ((yield* headOf(row.task_id)) !== row.released_head || !canvas.nodes.has(node as never)) {
        yield* settled;
        kept += 1;
        continue;
      }
      const command = taskCommand(canvasName, node as TaskNodeId, row.task_id as TaskId, { kind: "assign", seat: row.seat_node_id as SeatNodeId });
      const outcome = yield* Effect.result(tasks.submit(writer, command, context, env));
      // Not judged: still owed, and the row stays for the next heal.
      if (Result.isFailure(outcome)) {
        yield* Effect.logWarning(`task ${row.task_id} on ${canvasName}: its give-back stays owed`, outcome.failure);
        continue;
      }
      yield* settled;
      if (outcome.success.kind === "applied") given += 1;
      else kept += 1;
    }

    if (released.length > 0 || given > 0) {
      noteResourceChanged("task", canvasName);
      for (const task of released) {
        void Effect.runPromiseWith(services)(
          postSubjectComment(
            { subject: { kind: "task", nodeId: task.node, taskId: task.taskId }, text: SEAT_RELEASE_LINE, actor: operator, opId: mintOpId() },
            { canvas, canvasName, people: [] },
          ).pipe(Effect.catchCause((cause) => Effect.logWarning("a released task's thread line was not posted", cause))),
        );
      }
    }
    return { released: released.length, given, kept } satisfies SeatReleaseHealed;
  });

/**
 * At boot, behind the authority: heal every canvas this machine is an
 * authority of, since a canvas nothing judges would keep tasks on a gone
 * seat. A replica's heal is its authority's: here every judgment would fail.
 * A canvas with no list yet is this machine's when it edits it, as the
 * list's fill (fleet/state-schema.ts) will seed it.
 */
export const healEverySeatRelease = Effect.gen(function* () {
  if (!AUTHORITY_ENABLED) return;
  const sql = yield* SqlClient.SqlClient;
  const self = yield* (yield* MachineRepository).installationId;
  const names = yield* sql<{ readonly canvas_name: string }>`
    SELECT canvas_name FROM canvases c
    WHERE EXISTS (SELECT 1 FROM canvas_authorities a WHERE a.canvas_name = c.canvas_name AND a.installation_id = ${self})
      OR (NOT EXISTS (SELECT 1 FROM canvas_authorities a WHERE a.canvas_name = c.canvas_name)
        AND (c.editor_installation_id IS NULL OR c.editor_installation_id = ${self}))
    ORDER BY canvas_name`;
  for (const { canvas_name } of names) {
    yield* healSeatReleases(canvas_name).pipe(Effect.catchCause((cause) => Effect.logWarning(`the seat releases of ${canvas_name} were not healed`, cause)));
  }
});

/** The boot heal, run beside the product once its stores are up. */
export const SeatReleaseHealLive = Layer.effectDiscard(Effect.forkScoped(healEverySeatRelease));
