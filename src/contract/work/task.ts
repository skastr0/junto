/**
 * The work socket's task.* and rulings ops, as one Effect `RpcGroup`: each
 * op's arguments, its answer and its refusal. The core serves the group
 * (`src/core/work-control/task.ts`) and the CLI calls it (`src/cli`), so a
 * change to an op's arguments or answer fails the compile of both, and a
 * missing handler fails the core's.
 *
 * Each op's tag is its v1 name, and the wire stays v1: the arguments are the
 * frame's `args`, the answer its `data`, and the refusal its `error`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { RefusalReason } from "../../shared/resource-command";
import {
  TaskAssignArgs,
  TaskCheckArgs,
  TaskCommentArgs,
  TaskCreateArgs,
  TaskDependArgs,
  TaskEditArgs,
  TaskFinishArgs,
  TaskListArgs,
  TaskOneArgs,
  TaskReviewerArgs,
  TaskRulesArgs,
  TaskShowArgs,
  TaskStampArgs,
  TaskStampPolicyArgs,
  TaskStateWire,
  TaskWaitArgs,
} from "../../shared/task-control";
import { RulingsArgs, WorkErrorBody } from "../../shared/work-control";
import { CompletionEvidence, Rule, Ruling } from "../../shared/work-model";
import { WorkFailure, WorkInputHint } from "./failure";
import { UnlinkedMention } from "./msg";

// ---------------------------------------------------------------------------
// A task as readers show it (`TaskView`, task-model.ts)

const Reviewer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), seat: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("operator") }),
]);

const Stamp = Schema.Struct({
  reviewer: Reviewer,
  verdict: Schema.Literals(["approve", "changes"]),
  epoch: Schema.Number,
  subjectHash: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  at: Schema.Number,
});

/** One check run kept on a layer, at its epoch. */
const CheckResult = Schema.Struct({
  checkId: Schema.String,
  side: Schema.Literals(["outgoing", "incoming"]),
  command: Schema.String,
  exitCode: Schema.Number,
  outputTail: Schema.String,
  epoch: Schema.Number,
  destination: Schema.optionalKey(Schema.String),
  at: Schema.Number,
});

/** The task on the node it sits on now (`TaskCore`). */
const coreFields = {
  state: TaskStateWire,
  node: Schema.String,
  assignee: Schema.optionalKey(Schema.String),
  epoch: Schema.Number,
  stampPolicy: Schema.Struct({ required: Schema.Number }),
  reviewers: Schema.Array(Reviewer),
  stamps: Schema.Array(Stamp),
  checks: Schema.optionalKey(Schema.Array(CheckResult)),
  next: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(CompletionEvidence),
  handoff: Schema.optionalKey(Schema.String),
  archivedFrom: Schema.optionalKey(Schema.Literals(["done", "canceled"])),
};

/** Another task, as a view links it: its id, number and node. */
const TaskLink = Schema.Struct({ taskId: Schema.String, number: Schema.optionalKey(Schema.Number), node: Schema.String });

/**
 * How list and show mark a task one of this machine's queued writes touches
 * (`PendingMark`), with the first of those writes read at risk.
 */
const AtRisk = Schema.Union([
  Schema.Struct({
    opId: Schema.String,
    refusal: Schema.Struct({
      reason: RefusalReason,
      message: Schema.String,
      expected: Schema.optionalKey(Schema.Unknown),
      next_step: Schema.optionalKey(Schema.String),
    }),
  }),
  Schema.Struct({ opId: Schema.String, waiting: Schema.Literal("base_not_pulled"), root: Schema.String }),
]);

/**
 * A task as list and show answer it. `pending` is the op the writing machine
 * still waits on, or `true` with `atRisk` when one of this machine's queued
 * writes touches it.
 */
export const TaskViewAnswer = Schema.Struct({
  taskId: Schema.String,
  number: Schema.optionalKey(Schema.Number),
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  current: Schema.Struct(coreFields),
  layers: Schema.Array(Schema.Struct({ ...coreFields, closedAt: Schema.Number })),
  dependsOn: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  stateSince: Schema.Number,
  pending: Schema.optionalKey(Schema.Union([Schema.Literal(true), Schema.Struct({ opId: Schema.String })])),
  atRisk: Schema.optionalKey(AtRisk),
  derivedFrom: Schema.optionalKey(TaskLink),
  derived: Schema.optionalKey(Schema.Array(TaskLink)),
});

/** Said when this machine's queue could not be read, so no task is marked. */
const pendingUnknown = { pendingUnknown: Schema.optionalKey(Schema.Literal(true)) };

// ---------------------------------------------------------------------------
// Answers

export const TaskListAnswer = Schema.Struct({
  tasks: Schema.Array(TaskViewAnswer),
  more: Schema.Boolean,
  /** When more matched: the `after` of the next page. */
  next: Schema.optionalKey(Schema.String),
  ...pendingUnknown,
});

/** `task show`: the task, and its thread as msg list reads it. */
export const TaskShowAnswer = Schema.Struct({
  task: TaskViewAnswer,
  thread: Schema.Struct({ threadId: Schema.String, comments: Schema.optionalKey(Schema.Number), read: Schema.String }),
  ...pendingUnknown,
});

/** A rule in force, with where it comes from (`RuleInForce`). */
const RuleInForce = Schema.Struct({
  rule: Rule,
  provenance: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("region"), regionId: Schema.String, label: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("board"), boardId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("task"), board: Schema.String }),
  ]),
});

/** The rules in force where a task sits, or on a node; for a task, what its finish must answer. */
export const TaskRulesAnswer = Schema.Struct({
  node: Schema.String,
  rules: Schema.Array(RuleInForce),
  task: Schema.optionalKey(Schema.Struct({
    taskId: Schema.String,
    unanswered: Schema.Array(Schema.Struct({ ruleId: Schema.String, text: Schema.String })),
    checks: Schema.Array(Schema.Struct({
      destination: Schema.optionalKey(Schema.String),
      checks: Schema.Array(Schema.Struct({
        checkId: Schema.String,
        side: Schema.Literals(["outgoing", "incoming"]),
        label: Schema.String,
        command: Schema.String,
        status: Schema.Literals(["green", "red", "missing", "stale"]),
      })),
    })),
  })),
});

/** The task as the wait left it: in the awaited state. */
export const TaskWaitAnswer = Schema.Struct({ taskId: Schema.String, state: TaskStateWire, epoch: Schema.Number, at: Schema.Number });

/** A comment posted in the task's thread. */
export const TaskCommentAnswer = Schema.Struct({
  disposition: Schema.Literal("applied"),
  opId: Schema.String,
  taskId: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  notified: Schema.Array(Schema.String),
  unlinked: Schema.optionalKey(Schema.Array(UnlinkedMention)),
});

/**
 * How a write ended (`TaskWriteResult`): ruled here, with the state it left
 * the task in, or queued for the editing machine with the opId.
 */
export const TaskWriteAnswer = Schema.Union([
  Schema.Struct({
    disposition: Schema.Literal("applied"),
    opId: Schema.String,
    taskId: Schema.String,
    number: Schema.optional(Schema.Number),
    state: TaskStateWire,
    deliveryError: Schema.optionalKey(WorkErrorBody),
  }),
  Schema.Struct({
    disposition: Schema.Literal("queued"),
    opId: Schema.String,
    taskId: Schema.String,
    message: Schema.optionalKey(Schema.String),
  }),
]);

/** Pinned rulings across a node's region stack, outer to inner. */
export const RulingsAnswer = Schema.Struct({
  regions: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, rulings: Schema.Array(Ruling) })),
});

// ---------------------------------------------------------------------------
// Ops

/** A task verb's arguments are refused in the schema's words, pointing at the command's schema, as the verbs always did. */
const TASK_INPUT_HINT = "junto schema show shows this command's input";

const task = <const Tag extends string, P extends Schema.Top, S extends Schema.Top>(tag: Tag, payload: P, success: S) =>
  Rpc.make(tag, { payload, success, error: WorkFailure }).annotate(WorkInputHint, TASK_INPUT_HINT);
const write = <const Tag extends string, P extends Schema.Top>(tag: Tag, payload: P) => task(tag, payload, TaskWriteAnswer);

export const TaskList = task("task.list", TaskListArgs, TaskListAnswer);
export const TaskShow = task("task.show", TaskShowArgs, TaskShowAnswer);
export const TaskRules = task("task.rules", TaskRulesArgs, TaskRulesAnswer);
export const TaskWait = task("task.wait", TaskWaitArgs, TaskWaitAnswer);
export const TaskComment = task("task.comment", TaskCommentArgs, TaskCommentAnswer);
export const TaskCreate = write("task.create", TaskCreateArgs);
export const TaskEdit = write("task.edit", TaskEditArgs);
export const TaskAssign = write("task.assign", TaskAssignArgs);
export const TaskUnassign = write("task.unassign", TaskOneArgs);
export const TaskStart = write("task.start", TaskOneArgs);
export const TaskPause = write("task.pause", TaskOneArgs);
export const TaskResume = write("task.resume", TaskOneArgs);
export const TaskFinish = write("task.finish", TaskFinishArgs);
export const TaskCheck = write("task.check", TaskCheckArgs);
export const TaskCancel = write("task.cancel", TaskOneArgs);
export const TaskArchive = write("task.archive", TaskOneArgs);
export const TaskDepend = write("task.depend", TaskDependArgs);
export const TaskUndepend = write("task.undepend", TaskDependArgs);
export const TaskReviewerAdd = write("task.reviewer-add", TaskReviewerArgs);
export const TaskReviewerRemove = write("task.reviewer-remove", TaskReviewerArgs);
export const TaskStampPolicy = write("task.stamp-policy", TaskStampPolicyArgs);
export const TaskStamp = write("task.stamp", TaskStampArgs);
export const Rulings = Rpc.make("rulings", { payload: RulingsArgs, success: RulingsAnswer, error: WorkFailure });

/** Decoded strictly where the core serves it: an argument or an answer field the contract does not name is refused. */
export const TaskRpcs = RpcGroup.make(
  TaskList,
  TaskShow,
  TaskRules,
  TaskWait,
  TaskComment,
  TaskCreate,
  TaskEdit,
  TaskAssign,
  TaskUnassign,
  TaskStart,
  TaskPause,
  TaskResume,
  TaskFinish,
  TaskCheck,
  TaskCancel,
  TaskArchive,
  TaskDepend,
  TaskUndepend,
  TaskReviewerAdd,
  TaskReviewerRemove,
  TaskStampPolicy,
  TaskStamp,
  Rulings,
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });
