// `junto task` in main (plan 04, cli L2): decode each verb, resolve its task,
// seat and node refs in the caller's reach, and hand each write to the task
// ruler as a ResourceCommand (02). The task store and the ruler are canvas's
// (C4); they reach this file through `TaskPorts`, so the verbs are whole
// before those land and switch over without changing here. A refusal comes
// back in task terms and is mapped onto the work error family here.

import { Effect, Result, Schema } from "effect";
import { parseMentionHref } from "@shared/mention";
import type { Canvas, Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { reaches, seatsInReach } from "@shared/region-reach";
import { refusalError, type ResourceActor, type ResourceCommand } from "@shared/resource-command";
import {
  TASK_ARGS,
  TASK_COMMAND_OPS,
  type TaskCommandOp,
  type TaskControlOp,
  type TaskListArgs,
  type TaskWriteResult,
} from "@shared/task-control";
import {
  formatTaskNumber,
  parseTaskId,
  parseTaskNumber,
  seatNodeId,
  taskNodeId,
  type Reviewer,
  type SeatNodeId,
  type TaskCommand,
  type TaskId,
  type TaskNodeId,
  type TaskNumber,
  type TaskRefusal,
  type TaskRefusalDetail,
  type TaskView,
} from "@shared/task-model";
import type { ThreadSubject } from "@shared/thread-subject";
import type { WorkErrorBody } from "@shared/work-control";
import type { OpId } from "@shared/work-ids";

/** How a task is named once its text is read. */
export type TaskLookup =
  | { readonly kind: "number"; readonly number: TaskNumber }
  | { readonly kind: "id"; readonly taskId: TaskId };

export type TaskQuery = {
  readonly states?: TaskListArgs["state"];
  readonly assignee?: SeatNodeId;
  readonly limit: number;
};

/** What the ruler answers a command. A refusal stays in task terms until it is mapped here. */
export type TaskSubmitOutcome =
  | { readonly kind: "applied"; readonly task: TaskView }
  | { readonly kind: "queued" }
  | { readonly kind: "refused"; readonly refusal: TaskRefusal };

/** What the verbs need from the task store, the ruler and the thread mail. */
export type TaskPorts = {
  /** The canvas's task nodes. */
  readonly nodes: (canvas: Canvas) => ReadonlyArray<Node>;
  readonly list: (canvasName: string, node: TaskNodeId, query: TaskQuery) => Effect.Effect<ReadonlyArray<TaskView>, WorkErrorBody>;
  readonly find: (canvasName: string, lookup: TaskLookup) => Effect.Effect<TaskView | undefined, WorkErrorBody>;
  /** The task with its layers, reviewers, stamps and dependencies, as the seat may see them. */
  readonly show: (canvasName: string, task: TaskView) => Effect.Effect<unknown, WorkErrorBody>;
  readonly submit: (command: ResourceCommand<TaskCommand>) => Effect.Effect<TaskSubmitOutcome, WorkErrorBody>;
  /** Mail in the task's thread (03). */
  readonly comment: (input: {
    readonly canvasName: string;
    readonly actor: TaskCaller["actor"];
    readonly opId: OpId;
    readonly subject: Extract<ThreadSubject, { readonly kind: "task" }>;
    readonly text: string;
  }) => Effect.Effect<{ readonly messageId: string }, WorkErrorBody>;
};

export type TaskCaller = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  readonly actor: Extract<ResourceActor, { readonly kind: "seat" }>;
};

const LIST_DEFAULT_LIMIT = 50;

const notBuilt = (what: string): WorkErrorBody => ({
  type: "InputError",
  message: `${what} is not built in this Junto build yet`,
  details: { reason: "not_available", retryable: false },
});

/**
 * Until canvas C4 lands the task store and its ruler, the task nodes are the
 * canvas's own and every read or write past them refuses as not built.
 */
export const liveTaskPorts: TaskPorts = {
  nodes: (canvas) => [...canvas.nodes.values()].filter((node) => node.kind === "task"),
  list: () => Effect.fail(notBuilt("the task store")),
  find: () => Effect.fail(notBuilt("the task store")),
  show: () => Effect.fail(notBuilt("the task store")),
  submit: () => Effect.fail(notBuilt("the task ruler")),
  comment: () => Effect.fail(notBuilt("task threads")),
};

const decode = <S extends Schema.Top>(schema: S, args: unknown): Effect.Effect<S["Type"], WorkErrorBody> => {
  const decoded = Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(args ?? {});
  return Result.isFailure(decoded)
    ? Effect.fail({
        type: "InputError",
        message: String((decoded.failure as { readonly message?: unknown }).message ?? decoded.failure),
        details: { path: "args", hint: "junto schema show shows this command's input", retryable: false },
      })
    : Effect.succeed(decoded.success as S["Type"]);
};

// ---------------------------------------------------------------------------
// Refusals

const reviewerText = (reviewer: Reviewer): string => (reviewer.kind === "operator" ? "the operator" : reviewer.seat);

/** The sentence and the next step for each task refusal. Exhaustive: a new detail fails tsc here. */
export const describeTaskRefusal = (detail: TaskRefusalDetail): { readonly message: string; readonly next_step?: string; readonly expected?: unknown } => {
  switch (detail.kind) {
    case "illegal-transition":
      return { message: `a task in ${detail.from} cannot ${detail.command}`, next_step: "junto task show <task> prints its state" };
    case "not-assignee":
      return detail.assignee === undefined
        ? { message: "only the assignee moves this task, and it has none", next_step: "junto task assign <task> first" }
        : { message: `only the assignee (${detail.assignee}) moves this task` };
    case "already-assigned":
      return { message: `the task is already assigned to ${detail.assignee}`, next_step: "junto task unassign <task> first" };
    case "seat-busy":
      return { message: `${detail.seat} already holds an open task (${detail.taskId})`, next_step: "finish, pause or unassign that one first" };
    case "not-reviewer":
      return { message: `${reviewerText(detail.reviewer)} is not a reviewer of this task`, next_step: "junto task reviewer add <task> first" };
    case "own-task":
      return { message: "the assignee cannot stamp its own task" };
    case "stale-epoch":
      return { message: "the task changed since that review subject", expected: detail.expected, next_step: "junto task show <task>, then stamp again" };
    case "next-required":
      return { message: "this node sends on to several nodes; name one", expected: detail.choices, next_step: "junto task finish <task> --next <node>" };
    case "next-not-downstream":
      return { message: `${detail.next} is not downstream of this node`, expected: detail.choices };
    case "invalid-policy":
      return { message: `${detail.required} is not a stamp count` };
    case "dependency-cycle":
      return { message: "that dependency would make a cycle", expected: detail.through };
    case "unknown-task":
      return { message: `no task ${detail.taskId}` };
    case "task-exists":
      return { message: `a task ${detail.taskId} already exists`, next_step: "resend with a new opId, or leave --op-id out" };
    case "cannot-review":
      return { message: `an ${detail.actor} does not review tasks; a seat or the operator does` };
    case "target-mismatch":
      return { message: `the command targets ${detail.target} but creates ${detail.taskId}` };
    case "wrong-node":
      return { message: `${detail.nodeId} is not ${detail.expected === "agent" ? "a seat" : "a task node"}` };
  }
};

/** A ruler's refusal as the work error a caller reads, with the write's opId. */
export const taskRefusalError = (refusal: TaskRefusal, opId: OpId): WorkErrorBody => {
  const error = refusalError({ reason: refusal.reason, ...describeTaskRefusal(refusal.detail) });
  return { ...error, details: { ...error.details, opId } };
};

export const writeResultOf = (outcome: TaskSubmitOutcome, opId: OpId, taskId: TaskId): Effect.Effect<TaskWriteResult, WorkErrorBody> => {
  switch (outcome.kind) {
    case "applied":
      return Effect.succeed({
        disposition: "applied",
        opId,
        taskId: outcome.task.taskId,
        ...(outcome.task.number === undefined ? {} : { number: outcome.task.number }),
        state: outcome.task.current.state,
      });
    case "queued":
      return Effect.succeed({ disposition: "queued", opId, taskId });
    case "refused":
      return Effect.fail(taskRefusalError(outcome.refusal, opId));
  }
};

// ---------------------------------------------------------------------------
// Refs

const unknown = (path: string, received: string, message: string, hint?: string): WorkErrorBody => ({
  type: "UnknownTarget",
  message,
  details: { path, received, retryable: false, ...(hint === undefined ? {} : { hint }) },
});

const outOfReach = (path: string, what: string): WorkErrorBody => ({
  type: "ScopeError",
  message: `${what} is not in this seat's reach`,
  details: { path, reason: "not_in_reach", retryable: false },
});

/** `#42` or `42`, a task id, or a `junto://` ref with its `&item`. */
export const taskLookupOf = (text: string): TaskLookup | undefined => {
  const number = parseTaskNumber(text);
  if (number !== undefined) return { kind: "number", number };
  const taskId = parseTaskId(text.trim());
  if (taskId !== undefined) return { kind: "id", taskId };
  const link = text.trim().startsWith("junto://") ? parseMentionHref(text.trim()) : undefined;
  return link?.item === undefined ? undefined : { kind: "id", taskId: link.item };
};

const findTask = (caller: TaskCaller, ports: TaskPorts, text: string, path = "task"): Effect.Effect<TaskView, WorkErrorBody> =>
  Effect.gen(function* () {
    const lookup = taskLookupOf(text);
    if (lookup === undefined) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "InputError",
        message: `${text} names no task`,
        details: { path, received: text, retryable: false, hint: "a task is #42, its id, or a junto:// ref" },
      });
    }
    const task = yield* ports.find(caller.canvasName, lookup);
    if (task === undefined) {
      return yield* Effect.fail(unknown(path, text, `no task ${lookup.kind === "number" ? formatTaskNumber(lookup.number) : lookup.taskId} on this canvas`));
    }
    return task;
  });

const findNode = (caller: TaskCaller, ports: TaskPorts, text: string, path: string): Effect.Effect<Node, WorkErrorBody> => {
  const nodes = ports.nodes(caller.canvas);
  const link = text.startsWith("junto://") ? parseMentionHref(text) : undefined;
  const named = link !== undefined
    ? nodes.filter((node) => node.id === link.nodeId && link.item === undefined)
    : nodes.filter((node) => node.id === text || titleOf(node) === text);
  if (named.length === 1) return Effect.succeed(named[0]!);
  const names = nodes.map(titleOf).slice(0, 12).join(", ");
  return Effect.fail(
    named.length === 0
      ? unknown(path, text, `no task node ${text} on this canvas`, nodes.length === 0 ? "this canvas has no task node" : `task nodes: ${names}`)
      : { type: "InputError", message: `${named.length} task nodes are named ${text}; name one by its id`, details: { path, received: text, retryable: false } },
  );
};

const nodeInReach = (caller: TaskCaller, ports: TaskPorts, text: string, path: string) =>
  Effect.flatMap(findNode(caller, ports, text, path), (node) =>
    reaches(caller.canvas, caller.actor.nodeId, node.id) ? Effect.succeed(node) : Effect.fail(outOfReach(path, titleOf(node))));

/** The one task node in reach when none is named. */
const onlyNodeInReach = (caller: TaskCaller, ports: TaskPorts): Effect.Effect<Node, WorkErrorBody> => {
  const inReach = ports.nodes(caller.canvas).filter((node) => reaches(caller.canvas, caller.actor.nodeId, node.id));
  if (inReach.length === 1) return Effect.succeed(inReach[0]!);
  return Effect.fail({
    type: "InputError",
    message: inReach.length === 0 ? "no task node is in this seat's reach" : `${inReach.length} task nodes are in reach; name one with node`,
    details: { path: "node", retryable: false, ...(inReach.length === 0 ? {} : { hint: inReach.map(titleOf).join(", ") }) },
  });
};

/** A seat that reaches the task's node: `me`, `@name`, its name, its id or a ref. */
const findSeat = (caller: TaskCaller, near: NodeId, text: string | undefined, path: string): Effect.Effect<SeatNodeId, WorkErrorBody> => {
  if (text === undefined || text === "me") return Effect.succeed(seatNodeId(caller.actor.nodeId));
  const wanted = text.startsWith("@") ? text.slice(1) : text;
  const link = wanted.startsWith("junto://") ? parseMentionHref(wanted) : undefined;
  const seats = seatsInReach(caller.canvas, near);
  const named = seats.filter((seat) =>
    link !== undefined ? seat.id === link.nodeId : seat.id === wanted || titleOf(caller.canvas.nodes.get(seat.id)!) === wanted);
  if (named.length === 1) return Effect.succeed(seatNodeId(named[0]!.id));
  return Effect.fail(
    named.length === 0
      ? unknown(path, text, `no seat ${text} reaches this task`)
      : { type: "InputError", message: `${named.length} seats are named ${text}; name one by its id`, details: { path, received: text, retryable: false } },
  );
};

const findReviewer = (caller: TaskCaller, near: NodeId, text: string | undefined): Effect.Effect<Reviewer, WorkErrorBody> =>
  text === "operator"
    ? Effect.succeed({ kind: "operator" })
    : Effect.map(findSeat(caller, near, text, "reviewer"), (seat) => ({ kind: "seat", seat }));

const command = (caller: TaskCaller, opId: OpId, node: NodeId, taskId: TaskId, op: TaskCommand): ResourceCommand<TaskCommand> => ({
  opId,
  canvasName: caller.canvasName,
  actor: caller.actor,
  target: { kind: "task", nodeId: node, itemId: taskId },
  // Basis and the after chain come with remote's pending overlay (R2).
  basis: null,
  after: [],
  op,
});

// ---------------------------------------------------------------------------
// Verbs

/** The command a write verb makes, once its refs are resolved. */
const commandOf = (
  op: Exclude<TaskCommandOp, "task.create">,
  input: Record<string, unknown>,
  caller: TaskCaller,
  ports: TaskPorts,
  task: TaskView,
): Effect.Effect<TaskCommand, WorkErrorBody> => {
  const kind = TASK_COMMAND_OPS[op];
  switch (kind) {
    case "edit": {
      const { title, body } = input as { readonly title?: string; readonly body?: string };
      if (title === undefined && body === undefined) {
        return Effect.fail({ type: "InputError", message: "an edit changes title, body or both", details: { path: "title", retryable: false } });
      }
      return Effect.succeed({ kind, ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }) });
    }
    case "assign":
      return Effect.map(findSeat(caller, task.current.node, input.seat as string | undefined, "seat"), (seat) => ({ kind, seat }));
    case "unassign":
    case "start":
    case "pause":
    case "resume":
    case "cancel":
    case "archive":
      return Effect.succeed({ kind });
    case "finish": {
      const next = input.next as string | undefined;
      return next === undefined
        ? Effect.succeed({ kind })
        // Downstream need not be in reach: sending on hands the task over (04).
        : Effect.map(findNode(caller, ports, next, "next"), (node) => ({ kind, next: taskNodeId(node.id) }));
    }
    case "depend":
    case "undepend":
      return Effect.map(findTask(caller, ports, input.on as string, "on"), (on) => ({ kind, on: on.taskId }));
    case "reviewer-add":
    case "reviewer-remove":
      return Effect.map(findReviewer(caller, task.current.node, input.reviewer as string | undefined), (reviewer) => ({ kind, reviewer }));
    case "stamp-policy":
      return Effect.succeed({ kind, required: input.required as number });
    case "stamp": {
      const { verdict, subjectHash, text } = input as { readonly verdict: "approve" | "changes"; readonly subjectHash?: string; readonly text?: string };
      return Effect.succeed({ kind, verdict, ...(subjectHash === undefined ? {} : { subjectHash }), ...(text === undefined ? {} : { text }) });
    }
  }
};

/** One task verb, for a seat the work socket admitted. */
export const handleTaskOp = (
  op: TaskControlOp,
  args: unknown,
  caller: TaskCaller,
  ports: TaskPorts,
): Effect.Effect<unknown, WorkErrorBody> =>
  Effect.gen(function* () {
    switch (op) {
      case "task.list": {
        const input = yield* decode(TASK_ARGS[op], args);
        const nodes = input.node === undefined
          ? ports.nodes(caller.canvas).filter((node) => reaches(caller.canvas, caller.actor.nodeId, node.id))
          : [yield* nodeInReach(caller, ports, input.node, "node")];
        const limit = input.limit ?? LIST_DEFAULT_LIMIT;
        const assignee = input.assignee === undefined
          ? undefined
          : yield* findSeat(caller, caller.actor.nodeId, input.assignee, "assignee");
        const tasks: Array<TaskView> = [];
        for (const node of nodes) {
          tasks.push(...(yield* ports.list(caller.canvasName, taskNodeId(node.id), {
            limit: limit + 1,
            ...(input.state === undefined ? {} : { states: input.state }),
            ...(assignee === undefined ? {} : { assignee }),
          })));
        }
        return { tasks: tasks.slice(0, limit), more: tasks.length > limit };
      }
      case "task.show": {
        const input = yield* decode(TASK_ARGS[op], args);
        const task = yield* findTask(caller, ports, input.task);
        if (!reaches(caller.canvas, caller.actor.nodeId, task.current.node)) return yield* Effect.fail(outOfReach("task", formatRef(task)));
        return yield* ports.show(caller.canvasName, task);
      }
      case "task.comment": {
        const input = yield* decode(TASK_ARGS[op], args);
        const task = yield* findTask(caller, ports, input.task);
        if (!reaches(caller.canvas, caller.actor.nodeId, task.current.node)) return yield* Effect.fail(outOfReach("task", formatRef(task)));
        const sent = yield* ports.comment({
          canvasName: caller.canvasName,
          actor: caller.actor,
          opId: input.opId,
          subject: { kind: "task", nodeId: task.current.node, taskId: task.taskId },
          text: input.text,
        });
        return { disposition: "applied", opId: input.opId, taskId: task.taskId, messageId: sent.messageId };
      }
      case "task.create": {
        const input = yield* decode(TASK_ARGS[op], args);
        const node = input.node === undefined ? yield* onlyNodeInReach(caller, ports) : yield* nodeInReach(caller, ports, input.node, "node");
        const outcome = yield* ports.submit(command(caller, input.opId, node.id, input.taskId, {
          kind: "create",
          taskId: input.taskId,
          title: input.title,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.stamps === undefined ? {} : { stampPolicy: { required: input.stamps } }),
        }));
        return yield* writeResultOf(outcome, input.opId, input.taskId);
      }
      default: {
        const input = (yield* decode(TASK_ARGS[op], args)) as { readonly opId: OpId; readonly task: string } & Record<string, unknown>;
        const task = yield* findTask(caller, ports, input.task);
        const op_ = yield* commandOf(op, input, caller, ports, task);
        // Reach is the ruler's to check (01), with the assignee's own moves exempt.
        const outcome = yield* ports.submit(command(caller, input.opId, task.current.node, task.taskId, op_));
        return yield* writeResultOf(outcome, input.opId, task.taskId);
      }
    }
  });

const formatRef = (task: TaskView): string => (task.number === undefined ? task.taskId : formatTaskNumber(task.number));
