/**
 * A seat that leaves the canvas lets go of its task. A canvas command that
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
import { Effect } from "effect";
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
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const model = yield* ModelService;
    const tasks = yield* TaskRepository;
    const machines = yield* MachineRepository;
    const services = yield* Effect.context<never>();
    // A command on a whole canvas, or on its authority, moves no seat it could release.
    const seatsMove = command._tag !== "CreateCanvas" && command._tag !== "RemoveCanvas" && command._tag !== "GrantOverseer";
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const canvasName = command.canvas;
        const before = seatsMove ? yield* model.canvas(canvasName) : undefined;
        const result = yield* model.command(command, source);
        // A removed canvas takes what its seat deletes released with it.
        if (command._tag === "RemoveCanvas") yield* sql`DELETE FROM task_seat_releases WHERE canvas_name = ${canvasName}`;
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
