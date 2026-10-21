// `junto task` in main (plan 04, cli L2): decode each verb, resolve its task,
// seat and node refs in the caller's reach, and hand each write to the task
// ruler as a ResourceCommand (02). The store and the ruler are canvas's
// (`TaskRepository`, C4) and reach this file through `TaskPorts`. The ruler
// words its own refusals as work errors; this file adds the opId and turns
// what it made into a disposition.

import { Effect, Option, Result, Schema } from "effect";
import { parseMentionHref } from "@shared/mention";
import type { Canvas, Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { automationTargets, reaches, seatsInReach, type AutomationAuthor } from "@shared/region-reach";
import { rulingContextOf } from "@shared/ruling-context";
import type { ResourceActor, ResourceCommand, RulingContext } from "@shared/resource-command";
import {
  TASK_ARGS,
  TASK_COMMAND_OPS,
  type TaskCommandOp,
  type TaskControlOp,
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
  type TaskState,
  type TaskView,
} from "@shared/task-model";
import type { SubjectCommentInput, SubjectCommented } from "@shared/subject-comment";
import { taskPeopleOf } from "@shared/task-notices";
import type { WorkErrorBody } from "@shared/work-control";
import type { OpId } from "@shared/work-ids";
import { MachineRepository } from "../machines/repository";
import { postSubjectComment, type SubjectCommentContext } from "./subject-comment";
import { noteResourceChanged } from "./resource-changes";
import { deliverTaskEffects, type TaskDelivery } from "./task-delivery";
import { TaskRepository, type TaskCanvasEnv, type TaskSubmitOutcome } from "./task-repository";

/** How a task is named once its text is read. */
export type TaskLookup =
  | { readonly kind: "number"; readonly number: TaskNumber }
  | { readonly kind: "id"; readonly taskId: TaskId };

export type TaskListPortQuery = {
  readonly nodeIds: ReadonlyArray<TaskNodeId>;
  readonly states?: ReadonlyArray<TaskState>;
  readonly limit: number;
};

/** What the verbs need from the task store, the ruler and the thread mail. */
export type TaskPorts = {
  /** The canvas's task nodes. */
  readonly nodes: (canvas: Canvas) => ReadonlyArray<Node>;
  readonly list: (canvasName: string, query: TaskListPortQuery) => Effect.Effect<{ readonly tasks: ReadonlyArray<TaskView>; readonly more: boolean }, WorkErrorBody>;
  readonly find: (canvas: Canvas, canvasName: string, lookup: TaskLookup) => Effect.Effect<TaskView | undefined, WorkErrorBody>;
  readonly submit: (command: ResourceCommand<TaskCommand>, context: RulingContext, env: TaskCanvasEnv) => Effect.Effect<TaskSubmitOutcome, WorkErrorBody>;
  /** Mail the ruling owes: assignment notices, stamp requests, defects, sent on (pty P4). */
  readonly deliver: (delivery: TaskDelivery) => Effect.Effect<void, WorkErrorBody>;
  /** A comment in the task's thread: pty's one write path, `postSubjectComment` (03). */
  readonly comment: (
    input: Extract<SubjectCommentInput, { readonly subject: { readonly kind: "task" } }>,
    context: SubjectCommentContext,
  ) => Effect.Effect<SubjectCommented, WorkErrorBody>;
};

export type TaskCaller = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  readonly actor: Extract<ResourceActor, { readonly kind: "seat" }>;
};

const LIST_DEFAULT_LIMIT = 50;
/** How far a number lookup reads before the store answers numbers itself. */
const NUMBER_SCAN_LIMIT = 10_000;

const taskNodes = (canvas: Canvas): ReadonlyArray<Node> => [...canvas.nodes.values()].filter((node) => node.kind === "task");

const storeError = (error: { readonly message: string }): WorkErrorBody => ({
  type: "InternalError",
  message: error.message,
  details: { retryable: true },
});

const notBuilt = (what: string): WorkErrorBody => ({
  type: "InputError",
  message: `${what} is not built in this Junto build yet`,
  details: { reason: "not_available", retryable: false },
});

/** Every port through the TaskRepository in the running core. */
export const liveTaskPorts: TaskPorts = (() => {
  const withRepo = <A>(use: (repo: TaskRepository["Service"]) => Effect.Effect<A, { readonly message: string }>) =>
    Effect.serviceOption(TaskRepository).pipe(
      Effect.flatMap((repo) =>
        Option.isNone(repo) ? Effect.fail(notBuilt("the task store")) : use(repo.value).pipe(Effect.mapError(storeError))),
    ) as Effect.Effect<A, WorkErrorBody>;
  return {
    nodes: taskNodes,
    list: (canvasName, query) => withRepo((repo) => repo.list(canvasName, query)),
    find: (canvas, canvasName, lookup) =>
      withRepo((repo) =>
        lookup.kind === "id"
          ? Effect.map(repo.get(canvasName, lookup.taskId), Option.getOrUndefined)
          : Effect.map(
            repo.list(canvasName, {
              nodeIds: taskNodes(canvas).map((node) => node.id),
              states: ["backlog", "assigned", "working", "input-required", "in-review", "done", "canceled", "archived"],
              limit: NUMBER_SCAN_LIMIT,
            }),
            ({ tasks }) => tasks.find((task) => task.number === lookup.number),
          )),
    submit: (command, context, env) =>
      Effect.flatMap(Effect.serviceOption(MachineRepository), (machines) =>
        Option.isNone(machines)
          ? Effect.fail(notBuilt("this machine's installation id"))
          : withRepo((repo) =>
            Effect.flatMap(machines.value.installationId, (writer) => repo.submit(writer, command, context, env)))).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              if (outcome.kind === "applied" && !outcome.replay) noteResourceChanged("task", command.canvasName);
            })),
        ),
    deliver: deliverTaskEffects,
    comment: postSubjectComment,
  };
})();

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
// The ruler's answer

/** What the ruling made, as the caller reads it; a refusal is the ruler's own error with the opId. */
export const writeResultOf = (outcome: TaskSubmitOutcome, opId: OpId): Effect.Effect<TaskWriteResult, WorkErrorBody> => {
  switch (outcome.kind) {
    case "applied":
      return Effect.succeed({
        disposition: "applied",
        opId,
        taskId: outcome.task.id,
        number: outcome.task.number,
        state: outcome.task.state,
      });
    case "refused":
      return Effect.fail({ ...outcome.error, details: { ...outcome.error.details, opId } });
  }
};

/** Who wrote each automation, so its reach is the one it had when written (07). None here: the socket serves seats. */
export type AutomationAuthorOf = (automation: NodeId) => AutomationAuthor | undefined;

const noAutomationAuthor: AutomationAuthorOf = () => undefined;

/** The ruler's view of the canvas: flows downstream, stamp defaults, and seat and automation reach. */
export const taskCanvasEnv = (canvas: Canvas, automationAuthor: AutomationAuthorOf = noAutomationAuthor): TaskCanvasEnv => ({
  downstream: (node) =>
    [...canvas.wires.values()]
      // `feeds` becomes `flows` (TASK_FLOW_VERB) with canvas C4; this line fails tsc when it does.
      .filter((wire) => wire.verb === "feeds" && wire.from === node)
      .map((wire) => taskNodeId(wire.to)),
  // Task nodes set no stamp default yet (04): none is required.
  stampDefaultOf: () => ({ required: 0 }),
  seatReaches: (seat, node) => reaches(canvas, seat, node),
  automationReaches: (automation, node) => {
    const author = automationAuthor(automation);
    return author !== undefined && automationTargets(canvas, automation, author).some((target) => target.id === node);
  },
});

/** Region reach at ruling for every actor kind (01 rule 3). */
export const taskRulingContext = (canvas: Canvas, automationAuthor: AutomationAuthorOf = noAutomationAuthor): RulingContext =>
  rulingContextOf(canvas, automationAuthor);

// ---------------------------------------------------------------------------
// Refs

const unknown = (path: string, received: string, message: string, hint?: string): WorkErrorBody => ({
  type: "UnknownTarget",
  message,
  details: { path, received, retryable: false, ...(hint === undefined ? {} : { hint }) },
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

/**
 * A task this seat may act on: one in its reach, or its own open task (the
 * assignee's moves need no reach, 01 rule 6). A task out of reach reads as
 * missing, so a probe never learns what lies outside.
 */
const findTask = (
  caller: TaskCaller,
  ports: TaskPorts,
  text: string,
  path = "task",
  assigneeExempt = true,
): Effect.Effect<TaskView, WorkErrorBody> =>
  Effect.gen(function* () {
    const lookup = taskLookupOf(text);
    if (lookup === undefined) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "InputError",
        message: `${text} names no task`,
        details: { path, received: text, retryable: false, hint: "a task is #42, its id, or a junto:// ref" },
      });
    }
    const task = yield* ports.find(caller.canvas, caller.canvasName, lookup);
    const visible = task !== undefined &&
      (reaches(caller.canvas, caller.actor.nodeId, task.current.node) || (assigneeExempt && task.current.assignee === caller.actor.nodeId));
    if (!visible) {
      return yield* Effect.fail(unknown(path, text, `no task ${lookup.kind === "number" ? formatTaskNumber(lookup.number) : lookup.taskId} in this seat's reach`));
    }
    return task;
  });

/** One of `nodes` by id, name or ref. Callers pass only what the seat may see. */
const findNode = (nodes: ReadonlyArray<Node>, text: string, path: string, what: string): Effect.Effect<Node, WorkErrorBody> => {
  const link = text.startsWith("junto://") ? parseMentionHref(text) : undefined;
  const named = link !== undefined
    ? nodes.filter((node) => node.id === link.nodeId && link.item === undefined)
    : nodes.filter((node) => node.id === text || titleOf(node) === text);
  if (named.length === 1) return Effect.succeed(named[0]!);
  return Effect.fail(
    named.length === 0
      ? unknown(path, text, `no ${what} ${text}`, nodes.length === 0 ? undefined : `${what}s: ${nodes.map(titleOf).slice(0, 12).join(", ")}`)
      : { type: "InputError", message: `${named.length} ${what}s are named ${text}; name one by its id`, details: { path, received: text, retryable: false } },
  );
};

const nodesInReach = (caller: TaskCaller, ports: TaskPorts): ReadonlyArray<Node> =>
  ports.nodes(caller.canvas).filter((node) => reaches(caller.canvas, caller.actor.nodeId, node.id));

const nodeInReach = (caller: TaskCaller, ports: TaskPorts, text: string, path: string) =>
  findNode(nodesInReach(caller, ports), text, path, "task node in reach");

/** The one task node in reach when none is named. */
const onlyNodeInReach = (caller: TaskCaller, ports: TaskPorts): Effect.Effect<Node, WorkErrorBody> => {
  const inReach = nodesInReach(caller, ports);
  if (inReach.length === 1) return Effect.succeed(inReach[0]!);
  return Effect.fail({
    type: "InputError",
    message: inReach.length === 0 ? "no task node is in this seat's reach" : `${inReach.length} task nodes are in reach; name one with node`,
    details: { path: "node", retryable: false, ...(inReach.length === 0 ? {} : { hint: inReach.map(titleOf).join(", ") }) },
  });
};

/**
 * A seat among those that reach `near`, and the caller itself: `me`, `@name`,
 * its name, its id or a ref.
 */
const findSeat = (caller: TaskCaller, near: NodeId, text: string | undefined, path: string): Effect.Effect<SeatNodeId, WorkErrorBody> => {
  if (text === undefined || text === "me") return Effect.succeed(seatNodeId(caller.actor.nodeId));
  const wanted = text.startsWith("@") ? text.slice(1) : text;
  const link = wanted.startsWith("junto://") ? parseMentionHref(wanted) : undefined;
  const ids = new Set<NodeId>([caller.actor.nodeId, ...seatsInReach(caller.canvas, near).map((seat) => seat.id)]);
  const seats = [...ids].flatMap((id) => caller.canvas.nodes.get(id) ?? []);
  const named = seats.filter((seat) =>
    link !== undefined ? seat.id === link.nodeId : seat.id === wanted || titleOf(seat) === wanted);
  if (named.length === 1) return Effect.succeed(seatNodeId(named[0]!.id));
  return Effect.fail(
    named.length === 0
      ? unknown(path, text, `no seat ${text} in reach`)
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
        // One of the nodes this one flows into; it need not be in reach, since sending on hands the task over (04).
        : Effect.map(
          findNode(
            taskCanvasEnv(caller.canvas).downstream(task.current.node).flatMap((id) => caller.canvas.nodes.get(id) ?? []),
            next,
            "next",
            "downstream task node",
          ),
          (node) => ({ kind, next: taskNodeId(node.id) }),
        );
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

const submitted = (caller: TaskCaller, ports: TaskPorts, written: ResourceCommand<TaskCommand>) =>
  Effect.gen(function* () {
    const outcome = yield* ports.submit(written, taskRulingContext(caller.canvas), taskCanvasEnv(caller.canvas));
    const result = yield* writeResultOf(outcome, written.opId);
    if (outcome.kind !== "applied" || outcome.replay) return result;
    // The ruling is committed: a lost notice must not turn an applied write
    // into a retry, whose replay owes no mail and would never send it. The
    // write stands, and the seat is told its mail did not go.
    const delivered = yield* Effect.result(ports.deliver({
      canvas: caller.canvas,
      canvasName: caller.canvasName,
      actor: written.actor,
      opId: written.opId,
      task: outcome.task,
      effects: outcome.effects,
    }));
    return Result.isFailure(delivered) ? { ...result, deliveryError: delivered.failure } : result;
  });

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
        if (nodes.length === 0) return { tasks: [], more: false };
        // An assignee filter reads past the limit, so a page is still full.
        const listed = yield* ports.list(caller.canvasName, {
          nodeIds: nodes.map((node) => taskNodeId(node.id)),
          limit: assignee === undefined ? limit : NUMBER_SCAN_LIMIT,
          ...(input.state === undefined ? {} : { states: input.state }),
        });
        const tasks = assignee === undefined ? listed.tasks : listed.tasks.filter((task) => task.current.assignee === assignee);
        return { tasks: tasks.slice(0, limit), more: listed.more || tasks.length > limit };
      }
      case "task.show": {
        const input = yield* decode(TASK_ARGS[op], args);
        const task = yield* findTask(caller, ports, input.task);
        return { task };
      }
      case "task.comment": {
        const input = yield* decode(TASK_ARGS[op], args);
        // A comment admits by reach alone (03): the assignee exemption is for moves.
        const task = yield* findTask(caller, ports, input.task, "task", false);
        const sent = yield* ports.comment({
          subject: { kind: "task", nodeId: task.current.node, taskId: task.taskId },
          text: input.text,
          actor: caller.actor,
          opId: input.opId,
        }, { canvas: caller.canvas, canvasName: caller.canvasName, people: taskPeopleOf(task.current) }).pipe(
          Effect.mapError((error): WorkErrorBody => ({ ...error, details: { ...error.details, opId: input.opId } })),
        );
        return { disposition: "applied", opId: input.opId, taskId: task.taskId, threadId: sent.threadId, messageId: sent.messageId };
      }
      case "task.create": {
        const input = yield* decode(TASK_ARGS[op], args);
        const node = input.node === undefined ? yield* onlyNodeInReach(caller, ports) : yield* nodeInReach(caller, ports, input.node, "node");
        return yield* submitted(caller, ports, command(caller, input.opId, node.id, input.taskId, {
          kind: "create",
          taskId: input.taskId,
          title: input.title,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.stamps === undefined ? {} : { stampPolicy: { required: input.stamps } }),
        }));
      }
      default: {
        const input = (yield* decode(TASK_ARGS[op], args)) as { readonly opId: OpId; readonly task: string } & Record<string, unknown>;
        const task = yield* findTask(caller, ports, input.task);
        const made = yield* commandOf(op, input, caller, ports, task);
        // Reach is the ruler's to check (01), with the assignee's own moves exempt.
        return yield* submitted(caller, ports, command(caller, input.opId, task.current.node, task.taskId, made));
      }
    }
  });
