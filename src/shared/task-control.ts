/**
 * `junto task` wire contract (plan 04, cli track L2): the input each verb
 * takes on the work socket and the result it returns. The CLI mints the
 * opId, and on a create the task id, so a retry with `--op-id` is the same
 * command; main resolves the refs, builds the `ResourceCommand<TaskCommand>`
 * and rules it (`task-model.ts`, canvas C4).
 *
 * Refs stay text on the wire. A task is `#42`, its id, or a `junto://` ref;
 * a seat is `@name`, its name, its id or a ref; a task node is its id, its
 * name or a ref. Main resolves them in the caller's reach (01), so the CLI
 * never guesses what a name means.
 *
 * Pure: effect only.
 */
import { Schema } from "effect";
import type { TaskCommandKind, TaskState, TaskView } from "./task-model";
import { STAMPS_REQUIRED_MAX, TASK_STATES } from "./task-model";
import type { WorkErrorBody } from "./work-control";
import { CompletionEvidence } from "./work-model";
import type { RuleInForce } from "./rules";
import { ItemId, OpId, TaskNumber } from "./work-ids";

export { ItemId, OpId };

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const Ref = (description: string) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))).annotate({ description });

/** A task: `#42`, its id, or a `junto://` ref. */
export const TaskRefText = Ref("A task: #42, its id, or a junto:// ref");
/** A seat: `@name`, its name, its node id, or a `junto://` ref. */
export const SeatRefText = Ref("A seat: @name, its name, its node id, or a junto:// ref");
/** A task node: its id, its name, or a `junto://` ref. */
export const TaskNodeText = Ref("A task node: its id, its name, or a junto:// ref");

/** The model's limits (`TaskCommandWire`), so a verb never takes what the ruler refuses. */
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_BODY_MAX_LENGTH = 20_000;
export const TASK_COMMENT_MAX_LENGTH = 64_000;
export const TASK_LIST_LIMIT_MAX = 200;

const Title = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(TASK_TITLE_MAX_LENGTH)));
const Body = Schema.String.pipe(Schema.check(Schema.isMaxLength(TASK_BODY_MAX_LENGTH)));
const Required = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: STAMPS_REQUIRED_MAX }));

export const TaskStateWire = Schema.Literals(TASK_STATES);

// ---------------------------------------------------------------------------
// Verb inputs (wire)

export const TaskListArgs = Schema.Struct({
  /** One task node; every task node in reach when left out. */
  node: Schema.optionalKey(TaskNodeText),
  state: Schema.optionalKey(Schema.Array(TaskStateWire).pipe(Schema.check(Schema.isMinLength(1)))),
  /** A seat, or `me`. */
  assignee: Schema.optionalKey(SeatRefText),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: TASK_LIST_LIMIT_MAX }))),
}).annotate(strict);
export type TaskListArgs = typeof TaskListArgs.Type;

export const TaskShowArgs = Schema.Struct({ task: TaskRefText }).annotate(strict);
export type TaskShowArgs = typeof TaskShowArgs.Type;

/** The rules in force for a task, at the node it sits on; or a task node's own. */
export const TaskRulesArgs = Schema.Union([
  Schema.Struct({ task: TaskRefText }).annotate(strict),
  Schema.Struct({ node: TaskNodeText }).annotate(strict),
]);
export type TaskRulesArgs = typeof TaskRulesArgs.Type;

/** The states a waiter waits for. */
export const TASK_WAIT_UNTIL = ["done", "input-required", "in-review", "canceled"] as const satisfies ReadonlyArray<TaskState>;
export const TaskWaitUntil = Schema.Literals(TASK_WAIT_UNTIL);
export type TaskWaitUntil = typeof TaskWaitUntil.Type;
/** How long a wait holds when the caller names no timeout, and the most it may. */
export const TASK_WAIT_DEFAULT_MS = 60_000;
export const TASK_WAIT_MAX_MS = 600_000;

export const TaskWaitArgs = Schema.Struct({
  task: TaskRefText,
  until: TaskWaitUntil,
  timeoutMs: Schema.optionalKey(Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(TASK_WAIT_MAX_MS)),
  )),
}).annotate(strict);
export type TaskWaitArgs = typeof TaskWaitArgs.Type;

export const TaskCreateArgs = Schema.Struct({
  opId: OpId,
  taskId: ItemId,
  /** Left out when one task node is in reach. */
  node: Schema.optionalKey(TaskNodeText),
  title: Title,
  body: Schema.optionalKey(Body),
  /** Approvals finishing needs; the node's default when left out. */
  stamps: Schema.optionalKey(Required),
}).annotate(strict);
export type TaskCreateArgs = typeof TaskCreateArgs.Type;

export const TaskEditArgs = Schema.Struct({
  opId: OpId,
  task: TaskRefText,
  title: Schema.optionalKey(Title),
  body: Schema.optionalKey(Body),
}).annotate(strict);
export type TaskEditArgs = typeof TaskEditArgs.Type;

export const TaskAssignArgs = Schema.Struct({
  opId: OpId,
  task: TaskRefText,
  /** The caller when left out. */
  seat: Schema.optionalKey(SeatRefText),
}).annotate(strict);
export type TaskAssignArgs = typeof TaskAssignArgs.Type;

/** unassign, start, pause, resume, cancel and archive name one task. */
export const TaskOneArgs = Schema.Struct({ opId: OpId, task: TaskRefText }).annotate(strict);
export type TaskOneArgs = typeof TaskOneArgs.Type;

export const TaskFinishArgs = Schema.Struct({
  opId: OpId,
  task: TaskRefText,
  /** The downstream node to send it on to, when there are several. */
  next: Schema.optionalKey(TaskNodeText),
  /** What answers the rules in force on the task's node: cited artifacts and commits, and a claim per rule. */
  evidence: Schema.optionalKey(CompletionEvidence),
}).annotate(strict);
export type TaskFinishArgs = typeof TaskFinishArgs.Type;

export const TaskDependArgs = Schema.Struct({
  opId: OpId,
  task: TaskRefText,
  on: TaskRefText,
}).annotate(strict);
export type TaskDependArgs = typeof TaskDependArgs.Type;

export const TaskReviewerArgs = Schema.Struct({
  opId: OpId,
  task: TaskRefText,
  /** A seat, or `operator`; the caller when left out. */
  reviewer: Schema.optionalKey(SeatRefText),
}).annotate(strict);
export type TaskReviewerArgs = typeof TaskReviewerArgs.Type;

export const TaskStampPolicyArgs = Schema.Struct({ opId: OpId, task: TaskRefText, required: Required }).annotate(strict);
export type TaskStampPolicyArgs = typeof TaskStampPolicyArgs.Type;

export const TaskStampVerdict = Schema.Literals(["approve", "changes"]);

export const TaskStampArgs = Schema.Struct({
  opId: OpId,
  task: TaskRefText,
  verdict: TaskStampVerdict,
  /** The review subject hash `task show` printed, when the work has commits. */
  subjectHash: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128)))),
  /** What to change, with `changes`; a note with `approve`. */
  text: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(TASK_BODY_MAX_LENGTH)))),
}).annotate(strict);
export type TaskStampArgs = typeof TaskStampArgs.Type;

/** A comment is mail in the task's thread (03), not a task command. */
export const TaskCommentArgs = Schema.Struct({
  opId: OpId,
  task: TaskRefText,
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(TASK_COMMENT_MAX_LENGTH))),
}).annotate(strict);
export type TaskCommentArgs = typeof TaskCommentArgs.Type;

// ---------------------------------------------------------------------------
// Ops

/**
 * The write verbs, each named for the `TaskCommand` it becomes. `reviewer`
 * is one CLI group with two verbs, so its ops keep the command's names.
 */
export const TASK_COMMAND_OPS = {
  "task.create": "create",
  "task.edit": "edit",
  "task.assign": "assign",
  "task.unassign": "unassign",
  "task.start": "start",
  "task.pause": "pause",
  "task.resume": "resume",
  "task.finish": "finish",
  "task.cancel": "cancel",
  "task.archive": "archive",
  "task.depend": "depend",
  "task.undepend": "undepend",
  "task.reviewer-add": "reviewer-add",
  "task.reviewer-remove": "reviewer-remove",
  "task.stamp-policy": "stamp-policy",
  "task.stamp": "stamp",
} as const satisfies Readonly<Record<string, TaskCommandKind>>;
export type TaskCommandOp = keyof typeof TASK_COMMAND_OPS;

/**
 * Every `TaskCommand` kind has a verb. A kind canvas adds without one fails
 * here, so the CLI cannot fall behind the model unseen.
 */
type Covered = (typeof TASK_COMMAND_OPS)[TaskCommandOp];
export type TaskCommandsWithoutVerb = Exclude<TaskCommandKind, Covered>;
const everyCommandHasAVerb: [TaskCommandsWithoutVerb] extends [never] ? true : TaskCommandsWithoutVerb = true;
void everyCommandHasAVerb;

export const TASK_READ_OPS = ["task.list", "task.show", "task.rules", "task.wait"] as const;
export const TASK_WRITE_OPS = [...(Object.keys(TASK_COMMAND_OPS) as ReadonlyArray<TaskCommandOp>), "task.comment"] as const;
export type TaskReadOp = (typeof TASK_READ_OPS)[number];
export type TaskWriteOp = TaskCommandOp | "task.comment";
export type TaskControlOp = TaskReadOp | TaskWriteOp;

/** The wire args of each op, so a dispatcher cannot pair an op with another's input. */
export const TASK_ARGS = {
  "task.list": TaskListArgs,
  "task.show": TaskShowArgs,
  "task.rules": TaskRulesArgs,
  "task.wait": TaskWaitArgs,
  "task.create": TaskCreateArgs,
  "task.edit": TaskEditArgs,
  "task.assign": TaskAssignArgs,
  "task.unassign": TaskOneArgs,
  "task.start": TaskOneArgs,
  "task.pause": TaskOneArgs,
  "task.resume": TaskOneArgs,
  "task.finish": TaskFinishArgs,
  "task.cancel": TaskOneArgs,
  "task.archive": TaskOneArgs,
  "task.depend": TaskDependArgs,
  "task.undepend": TaskDependArgs,
  "task.reviewer-add": TaskReviewerArgs,
  "task.reviewer-remove": TaskReviewerArgs,
  "task.stamp-policy": TaskStampPolicyArgs,
  "task.stamp": TaskStampArgs,
  "task.comment": TaskCommentArgs,
} as const satisfies { readonly [Op in TaskControlOp]: Schema.Top };

export const isTaskWriteOp = (op: string): op is TaskWriteOp =>
  op === "task.comment" || Object.hasOwn(TASK_COMMAND_OPS, op);

/** The ops `handleTaskOp` answers; check keeps its own handler. */
export const isTaskControlOp = (op: string): op is TaskControlOp =>
  Object.hasOwn(TASK_ARGS, op);

// ---------------------------------------------------------------------------
// Results

/** The rules in force where a task sits; for a task, the statement rules its finish must answer. */
export type TaskRulesResult = {
  readonly node: string;
  readonly rules: ReadonlyArray<RuleInForce>;
  readonly task?: { readonly taskId: ItemId; readonly unanswered: ReadonlyArray<{ readonly ruleId: string; readonly text: string }> };
};

/** The task as the wait left it: in the awaited state. */
export type TaskWaitResult = {
  readonly taskId: ItemId;
  readonly state: TaskState;
  readonly epoch: number;
  readonly at: number;
};

export type TaskListResult = {
  readonly tasks: ReadonlyArray<TaskView>;
  /** True when more matched than `limit`. */
  readonly more: boolean;
};

/**
 * How a write ended. `applied`: ruled here and readable now, with the state
 * it left the task in. `queued`: the editing machine is away; `junto op show
 * <opId>` reads its ruling later. A refusal is never a result: it is the typed
 * error, with the opId in its details. `deliveryError`: the write was ruled and
 * stands, but the mail it owes (an assignment notice, a stamp request) did not
 * go; a resend replays the ruling and sends nothing.
 */
export type TaskWriteResult =
  | {
      readonly disposition: "applied";
      readonly opId: OpId;
      readonly taskId: ItemId;
      readonly number?: TaskNumber;
      readonly state: TaskState;
      readonly deliveryError?: WorkErrorBody;
    }
  | { readonly disposition: "queued"; readonly opId: OpId; readonly taskId: ItemId };

export type TaskDisposition = TaskWriteResult["disposition"];
