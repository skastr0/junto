/**
 * The core's handlers for the work socket's task.* and rulings ops
 * (`TaskRpcs`). Each reads the seat its call was admitted as (`WorkSeat`), as
 * `src/core/work-control/msg.ts` does, and refuses with the v1 error body as
 * a `WorkFailure`.
 *
 * The task verbs stay in `handleTaskOp` (`../work/task-control.ts`), called
 * with the ports the control plane built for it. Each handler names the
 * result type task-control gives its op, so a change there that the
 * contract's answer does not describe fails this file's compile.
 */
import { Effect, Result } from "effect";
import { TaskRpcs } from "../../contract/work/task";
import { workFailure } from "../../contract/work/failure";
import { asNodeId } from "@shared/model";
import { TASKS_ENABLED } from "@shared/features";
import { threadSubjectOf } from "@shared/thread-subject";
import { type PendingMark, type PendingUnknown } from "@shared/op-control";
import {
  type TaskControlOp,
  type TaskListResult,
  type TaskRulesResult,
  type TaskWaitResult,
  type TaskWriteResult,
} from "@shared/task-control";
import { type TaskView } from "@shared/task-model";
import { type LinkedText } from "../work/authz";
import { handleTaskOp, liveTaskPorts } from "../work/task-control";
import { pendingMarksOf } from "../work/op-control";
import { mapWorkCode } from "./answers";
import { requireTarget, WorkAdmission, WorkSeat } from "./seat";

/** `task show`: the task with its mark, and its thread as msg list reads it. */
type TaskShowResult = PendingUnknown & {
  readonly task: TaskView & Partial<PendingMark>;
  readonly thread: { readonly threadId: string; readonly comments?: number; readonly read: string };
};

/** `task comment`: the post in the task's thread. */
type TaskCommentResult = {
  readonly disposition: "applied";
  readonly opId: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly notified: ReadonlyArray<string>;
  readonly unlinked?: LinkedText["unlinked"];
};

/**
 * One task verb for the admitted seat, answered as task-control types it. The
 * server encodes the answer with the op's success schema, so an answer field
 * the contract does not name is refused rather than written.
 */
const taskOp = <A>(op: TaskControlOp, args: unknown) =>
  Effect.gen(function* () {
    const { caller, board, actor, mailboxOf } = yield* WorkSeat;
    if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
    const answer = yield* handleTaskOp(op, args, {
      canvas: board,
      canvasName: caller.canvasName,
      actor: { kind: "seat", seatId: actor.success.seatId, nodeId: asNodeId(caller.nodeId) },
    }, {
      ...liveTaskPorts,
      pending: pendingMarksOf("task"),
      // task show counts the task's thread, held in its node's mailbox (03).
      threadCount: (_canvasName, task) =>
        Effect.map(mailboxOf(task.current.node), (rows) => rows.filter((row) => {
          const on = threadSubjectOf(row);
          return on?.kind === "task" && on.nodeId === task.current.node && on.taskId === task.taskId;
        }).length),
    });
    return answer as A;
  }).pipe(Effect.mapError(workFailure));

export const TaskServed = TaskRpcs.middleware(WorkAdmission);

export const TaskHandlers = TaskServed.toLayer(
  TaskServed.of({
    "task.list": (args) => taskOp<TaskListResult>("task.list", args),
    "task.show": (args) => taskOp<TaskShowResult>("task.show", args),
    "task.rules": (args) => taskOp<TaskRulesResult>("task.rules", args),
    "task.wait": (args) => taskOp<TaskWaitResult>("task.wait", args),
    "task.comment": (args) => taskOp<TaskCommentResult>("task.comment", args),
    "task.create": (args) => taskOp<TaskWriteResult>("task.create", args),
    "task.edit": (args) => taskOp<TaskWriteResult>("task.edit", args),
    "task.assign": (args) => taskOp<TaskWriteResult>("task.assign", args),
    "task.unassign": (args) => taskOp<TaskWriteResult>("task.unassign", args),
    "task.start": (args) => taskOp<TaskWriteResult>("task.start", args),
    "task.pause": (args) => taskOp<TaskWriteResult>("task.pause", args),
    "task.resume": (args) => taskOp<TaskWriteResult>("task.resume", args),
    "task.finish": (args) => taskOp<TaskWriteResult>("task.finish", args),
    "task.check": (args) => taskOp<TaskWriteResult>("task.check", args),
    "task.cancel": (args) => taskOp<TaskWriteResult>("task.cancel", args),
    "task.archive": (args) => taskOp<TaskWriteResult>("task.archive", args),
    "task.depend": (args) => taskOp<TaskWriteResult>("task.depend", args),
    "task.undepend": (args) => taskOp<TaskWriteResult>("task.undepend", args),
    "task.reviewer-add": (args) => taskOp<TaskWriteResult>("task.reviewer-add", args),
    "task.reviewer-remove": (args) => taskOp<TaskWriteResult>("task.reviewer-remove", args),
    "task.stamp-policy": (args) => taskOp<TaskWriteResult>("task.stamp-policy", args),
    "task.stamp": (args) => taskOp<TaskWriteResult>("task.stamp", args),
    "rulings": (args) =>
      Effect.gen(function* () {
        const op = "rulings" as const;
        const { work, caller, board } = yield* WorkSeat;
        // Region rulings ride the Tasks gate: a tasks-off build has none to read.
        if (!TASKS_ENABLED) {
          return yield* Effect.fail({
            type: "ScopeError" as const,
            message: "region rulings are disabled in this Junto build",
            details: {
              caller: caller.nodeId,
              hint: "this product surface is turned off in this build",
              next_step: "stop reading rulings; this build carries no region rules",
              retryable: false,
              missing: "feature enabled in this build",
              reason: op,
            },
          });
        }
        // No target: the seat's own region stack — ambient law it already lives
        // under, so no edge is involved. A named task node is admitted by reach.
        const target = args.target;
        if (target !== undefined) {
          const gate = requireTarget(board, caller.nodeId, target, op);
          if ("type" in gate) return yield* Effect.fail(gate);
        }
        return yield* work
          .workRulingsList(caller.canvasName, target ?? caller.nodeId)
          .pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
      }).pipe(Effect.mapError(workFailure)),
  }),
);
