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
import { automationTargets, seatReachesTaskNode, seatsInReach, type AutomationAuthor } from "@shared/region-reach";
import { rulingContextOf } from "@shared/ruling-context";
import { boardContractOf, evaluateRules, requiredChecks, rulesInForce, type RequiredCheck } from "@shared/rules";
import type { ResourceActor, ResourceCommand, RulingContext } from "@shared/resource-command";
import { pendingUnknownOf, withPendingMark, type PendingMarks } from "@shared/op-control";
import {
  TASK_ARGS,
  TASK_COMMAND_OPS,
  TASK_WAIT_DEFAULT_MS,
  TASK_WAIT_MAX_MS,
  type TaskCommandOp,
  type TaskControlOp,
  type TaskCheckArgs,
  type TaskRulesResult,
  type TaskWaitArgs,
  type TaskWaitResult,
  type TaskWriteResult,
} from "@shared/task-control";
import {
  formatTaskNumber,
  parseTaskId,
  parseTaskNumber,
  reviewerKey,
  seatNodeId,
  TASK_FLOW_VERB,
  taskNodeId,
  CHECK_OUTPUT_TAIL_MAX,
  type CheckResult,
  type CheckRun,
  type Reviewer,
  type SeatNodeId,
  type TaskCommand,
  type TaskId,
  type TaskNodeId,
  type TaskNumber,
  type TaskState,
  type TaskView,
} from "@shared/task-model";
import { currentStamps } from "@shared/task-machine";
import type { SubjectCommentInput, SubjectCommented } from "@shared/subject-comment";
import { taskPeopleOf } from "@shared/task-notices";
import type { WorkErrorBody } from "@shared/work-control";
import { stampDefaultOfContract, type CompletionEvidence } from "@shared/work-model";
import type { OpId } from "@shared/work-ids";
import { operatorActorRef } from "@shared/work-reference";
import type { QueuedCommand } from "@shared/command-row";
import { decodeTaskFacts } from "@shared/task-fact-wire";
import { ResourceSubmit } from "./resource-submit";
import { precheckInput, queuedTaskCommands } from "./queued-commands";
import { MachineRepository } from "../machines/repository";
import { productDisabledError } from "./authz";
import { linkMentionsAt } from "./mention-links";
import { TASKS_ENABLED } from "@shared/features";
import { postSubjectComment, type SubjectCommentContext } from "./subject-comment";
import { noteResourceChanged, onResourceChanged } from "./resource-changes";
import { TaskRepository, type TaskCanvasEnv, type TaskSubmitOutcome } from "./task-repository";
import { WorkService } from "./service";
import { threadSubjectOf } from "@shared/thread-subject";

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
  /** Rule a command here when this machine edits the canvas; otherwise queue it for the machine that does. */
  readonly submit: (command: ResourceCommand<TaskCommand>, context: RulingContext, env: TaskCanvasEnv) => Effect.Effect<TaskWriteOutcome, WorkErrorBody>;
  /**
   * The mark of each item this machine's queued writes touch (`pendingMarksOf`):
   * list and show carry it. Absent, nothing is marked.
   */
  readonly pending?: (canvasName: string, canvas: Canvas) => Effect.Effect<PendingMarks>;
  /** A comment in the task's thread: pty's one write path, `postSubjectComment` (03). */
  readonly comment: (
    input: Extract<SubjectCommentInput, { readonly subject: { readonly kind: "task" } }>,
    context: SubjectCommentContext,
  ) => Effect.Effect<SubjectCommented, WorkErrorBody>;
  /** How many rows the task's thread holds at its node. Absent, show names the thread without a count. */
  readonly threadCount?: (canvasName: string, task: TaskView) => Effect.Effect<number, WorkErrorBody>;
  /** Told each time a canvas's tasks change: what a wait wakes on. */
  readonly changes: (listener: (canvasName: string) => void) => () => void;
  readonly now: () => number;
};

export type TaskCaller = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  readonly actor: Extract<ResourceActor, { readonly kind: "seat" }>;
};

/** Who comments: a seat the work socket admitted, or the operator from a window, who reaches every task. */
export type TaskCommenter = Omit<TaskCaller, "actor"> & {
  readonly actor: Extract<ResourceActor, { readonly kind: "seat" | "operator" }>;
};

const LIST_DEFAULT_LIMIT = 50;

const noMarks: PendingMarks = new Map();
/** What list and show mark pending (`TaskPorts.pending`). */
const pendingOf = (caller: Pick<TaskCaller, "canvas" | "canvasName">, ports: Pick<TaskPorts, "pending">) =>
  ports.pending === undefined ? Effect.succeed(noMarks) : ports.pending(caller.canvasName, caller.canvas);
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

/** What a task write came to: ruled here or there, or queued for the editing machine (02). */
export type TaskWriteOutcome = TaskSubmitOutcome | { readonly kind: "queued"; readonly opId: OpId };

/**
 * A command queued for the editing machine, as the seat's write answers it.
 * An applied ruling that came back names the task as the editing machine
 * ruled it; that machine owes and sends its mail, so nothing is owed here,
 * and the fold that brought the ruling already told the windows.
 */
const queuedOutcome = (
  submit: ResourceSubmit["Service"],
  command: ResourceCommand<TaskCommand>,
  editor: Parameters<ResourceSubmit["Service"]["queue"]>[1],
) =>
  Effect.flatMap(
    // The wire form of a task op is the op itself: node ids are plain on the wire.
    submit.queue(command as QueuedCommand, editor),
    (outcome): Effect.Effect<TaskWriteOutcome, WorkErrorBody> => {
      switch (outcome.kind) {
        case "queued":
          return Effect.succeed({ kind: "queued", opId: command.opId });
        case "refused":
          return Effect.succeed({ kind: "refused", opId: command.opId, error: outcome.error, root: outcome.root });
        case "applied": {
          const task = decodeTaskFacts(outcome.ruling.facts)?.at(-1)?.task;
          return task === undefined
            ? Effect.fail(storeError({ message: `the ruling of ${command.opId} names no task this build reads` }))
            : Effect.succeed({ kind: "applied", opId: command.opId, task, effects: [], replay: true });
        }
      }
    },
  );

/**
 * A command this machine would queue, refused at once when the ruled tasks
 * held here and this writer's queue already refuse it for good (`precheck`).
 * Answered to the caller only: no row, no ruling, no notice.
 */
const precheckTask = (command: ResourceCommand<TaskCommand>, context: RulingContext, env: TaskCanvasEnv) =>
  Effect.gen(function* () {
    const repo = yield* Effect.serviceOption(TaskRepository);
    const input = yield* precheckInput(command, (commands) => queuedTaskCommands(commands));
    if (Option.isNone(repo) || input === undefined) return Option.none();
    return yield* repo.value.precheck(input.writer, input.queued, input.command, input.refused, context, env).pipe(Effect.mapError(storeError));
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
    changes: (listener) => onResourceChanged((domain, canvasName) => {
      if (domain === "task") listener(canvasName);
    }),
    now: () => Date.now(),
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
      Effect.gen(function* () {
        const remote = yield* Effect.serviceOption(ResourceSubmit);
        const route = Option.isNone(remote) ? ({ kind: "here" } as const) : yield* remote.value.route(command.canvasName);
        if (Option.isSome(remote) && route.kind === "editor") {
          const refused = yield* precheckTask(command, context, env);
          return Option.isSome(refused) ? refused.value : yield* queuedOutcome(remote.value, command, route.editor);
        }
        const machines = yield* Effect.serviceOption(MachineRepository);
        if (Option.isNone(machines)) return yield* Effect.fail(notBuilt("this machine's installation id"));
        return yield* withRepo((repo) =>
          Effect.flatMap(machines.value.installationId, (writer) => repo.submit(writer, command, context, env))).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              if (outcome.kind === "applied" && !outcome.replay) noteResourceChanged("task", command.canvasName);
            })),
        );
      }),
    comment: postSubjectComment,
    threadCount: (canvasName, task) =>
      Effect.serviceOption(WorkService).pipe(
        Effect.flatMap((work) => Option.isNone(work) ? Effect.fail(notBuilt("the work service")) : work.value.readMailbox(canvasName, task.current.node).pipe(Effect.mapError(storeError))),
        Effect.map((rows) => rows.filter((row) => {
          const on = threadSubjectOf(row);
          return on?.kind === "task" && on.nodeId === task.current.node && on.taskId === task.taskId;
        }).length),
      ),
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
export const writeResultOf = (
  outcome: TaskWriteOutcome,
  written: Pick<ResourceCommand<TaskCommand>, "opId" | "target">,
): Effect.Effect<TaskWriteResult, WorkErrorBody> => {
  const opId = written.opId;
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
    // Durable and will be ruled: a success. `junto op show` reads what became of it.
    case "queued":
      return Effect.succeed({ disposition: "queued", opId, taskId: written.target.itemId! });
  }
};

/** Who wrote each automation, so its reach is the one it had when written (07). None here: the socket serves seats. */
export type AutomationAuthorOf = (automation: NodeId) => AutomationAuthor | undefined;

const noAutomationAuthor: AutomationAuthorOf = () => undefined;

/** The checks a finish from `node` toward `next` needs: its outgoing ones, and the next node's incoming ones. */
export const checksToward = (canvas: Canvas, node: TaskNodeId, next: TaskNodeId | undefined): ReadonlyArray<RequiredCheck> =>
  next === undefined
    ? (boardContractOf(canvas, node)?.outgoing?.checks ?? []).map((check) => ({ check, side: "outgoing" as const }))
    : requiredChecks(canvas, node, next);

export type CheckStatus = "green" | "red" | "missing" | "stale";

/**
 * A required check against the runs at the current epoch: green when its
 * latest run passed with the command the node names now, red when it failed,
 * stale when the node's command has changed since, missing with no run.
 */
export const checkStatusOf = (required: RequiredCheck, runs: ReadonlyArray<CheckResult>, next: TaskNodeId | undefined): CheckStatus => {
  const run = runs.find((candidate) =>
    candidate.checkId === required.check.id && candidate.side === required.side &&
    (required.side === "outgoing" || candidate.destination === next));
  if (run === undefined) return "missing";
  if (run.command !== required.check.command) return "stale";
  return run.exitCode === 0 ? "green" : "red";
};

/** The ruler's view of the canvas: flows downstream, stamp defaults, and seat and automation reach. */
export const taskCanvasEnv = (canvas: Canvas, automationAuthor: AutomationAuthorOf = noAutomationAuthor): TaskCanvasEnv => ({
  downstream: (node) =>
    [...canvas.wires.values()]
      .filter((wire) => wire.verb === TASK_FLOW_VERB && wire.from === node)
      .map((wire) => taskNodeId(wire.to)),
  stampDefaultOf: (node) => stampDefaultOfContract(boardContractOf(canvas, node)),
  seatReaches: (seat, node) => seatReachesTaskNode(canvas, seat, node),
  automationReaches: (automation, node) => {
    const author = automationAuthor(automation);
    return author !== undefined && automationTargets(canvas, automation, author).some((target) => target.id === node);
  },
  // The rules in force on the node: its regions' and its own. A task carries no
  // rules of its own in 0.10, so a waiver answers none of these (04).
  checksUnmet: (node, next, runs) => {
    const statuses = checksToward(canvas, node, next).map((required) => ({ id: required.check.id, status: checkStatusOf(required, runs, next) }));
    const red = statuses.filter((entry) => entry.status === "red").map((entry) => entry.id);
    // A stale run answers a command the node no longer names: as good as none.
    const missing = statuses.filter((entry) => entry.status === "missing" || entry.status === "stale").map((entry) => entry.id);
    return red.length === 0 && missing.length === 0 ? undefined : { red, missing };
  },
  rulesUnmet: (node, _taskId, evidence) => {
    const failure = evaluateRules({ rules: rulesInForce(canvas, node), evidence });
    return failure === undefined
      ? undefined
      : {
        missing: failure.missing,
        message: failure.message,
        nextStep: failure.next_step,
        ...(failure.ruleId === undefined ? {} : { ruleId: failure.ruleId }),
      };
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
  caller: TaskCommenter,
  ports: Pick<TaskPorts, "find">,
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
    const actor = caller.actor;
    const visible = task !== undefined && (actor.kind === "operator" ||
      seatReachesTaskNode(caller.canvas, actor.nodeId, task.current.node) || (assigneeExempt && task.current.assignee === actor.nodeId));
    if (!visible) {
      const missing = unknown(path, text, `no task ${lookup.kind === "number" ? formatTaskNumber(lookup.number) : lookup.taskId} in this seat's reach`);
      return yield* Effect.fail<WorkErrorBody>({ ...missing, details: { ...missing.details, next_step: "run junto task list to see the tasks in reach" } });
    }
    return task;
  });

/**
 * Hold until the task is in the awaited state, or the time runs out. It reads
 * the task again on each change to the canvas's tasks, so a task that leaves
 * the seat's reach fails the wait at once. The subscription opens before each
 * read, so a change between the two still wakes it.
 */
const waitTask = (caller: TaskCaller, ports: TaskPorts, input: TaskWaitArgs): Effect.Effect<TaskWaitResult, WorkErrorBody> =>
  Effect.gen(function* () {
    const waitedMs = input.timeoutMs ?? TASK_WAIT_DEFAULT_MS;
    const deadline = ports.now() + waitedMs;
    for (;;) {
      let changed = false;
      let wake: (() => void) | undefined;
      const off = ports.changes((canvasName) => {
        if (canvasName !== caller.canvasName) return;
        changed = true;
        wake?.();
      });
      const settled = yield* Effect.gen(function* () {
        const task = yield* findTask(caller, ports, input.task);
        if (task.current.state === input.until) {
          return { taskId: task.taskId, state: task.current.state, epoch: task.current.epoch, at: ports.now() } satisfies TaskWaitResult;
        }
        const left = deadline - ports.now();
        if (left <= 0) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "Timeout",
            message: `wait timed out after ${waitedMs}ms; last observed "${task.current.state}"`,
            details: {
              target: input.task,
              from: task.current.state,
              to: input.until,
              hint: `task ${task.taskId} is at epoch ${task.current.epoch}`,
              retryable: true,
              next_step: `re-issue the wait, or raise the timeout up to ${TASK_WAIT_MAX_MS / 1000}s`,
            },
          });
        }
        yield* Effect.callback<void>((resume) => {
          if (changed) return resume(Effect.void);
          // A wake clears the deadline timer itself: the cleanup below runs only on interrupt.
          const timer = setTimeout(() => resume(Effect.void), left);
          wake = () => {
            clearTimeout(timer);
            resume(Effect.void);
          };
          return Effect.sync(() => clearTimeout(timer));
        });
        return undefined;
      }).pipe(Effect.ensuring(Effect.sync(off)));
      if (settled !== undefined) return settled;
    }
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
  ports.nodes(caller.canvas).filter((node) => seatReachesTaskNode(caller.canvas, caller.actor.nodeId, node.id));

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
  const wanted = text?.startsWith("@") ? text.slice(1) : text;
  if (text === undefined || wanted === undefined || wanted === "me") return Effect.succeed(seatNodeId(caller.actor.nodeId));
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
  basis: null,
  // Off the editing machine, ResourceSubmit adds the unruled commands this one builds on.
  after: [],
  op,
});

// ---------------------------------------------------------------------------
// Verbs

/**
 * A check report as the ruler takes it: each run carries the command its
 * node names for that check now, and an incoming run answers the next node,
 * named or the only one. A check the node does not name is refused here.
 */
const checkCommandOf = (caller: TaskCaller, task: TaskView, input: TaskCheckArgs): Effect.Effect<TaskCommand, WorkErrorBody> =>
  Effect.gen(function* () {
    const downstream = taskCanvasEnv(caller.canvas).downstream(task.current.node);
    const next = input.next === undefined
      ? (downstream.length === 1 ? downstream[0] : undefined)
      : taskNodeId((yield* findNode(downstream.flatMap((id) => caller.canvas.nodes.get(id) ?? []), input.next, "next", "downstream task node")).id);
    const runs: CheckRun[] = [];
    for (const [index, run] of input.results.entries()) {
      if (run.side === "incoming" && next === undefined) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "an incoming check answers the next node; name it with next",
          details: { path: "next", retryable: false, ...(downstream.length === 0 ? {} : { hint: downstream.join(", ") }) },
        });
      }
      const contract = boardContractOf(caller.canvas, run.side === "outgoing" ? task.current.node : next!);
      const check = (run.side === "outgoing" ? contract?.outgoing?.checks : contract?.incoming?.checks)?.find((entry) => entry.id === run.checkId);
      if (check === undefined) {
        return yield* Effect.fail(unknown(`results.${index}.checkId`, run.checkId, `no ${run.side} check "${run.checkId}" on that node`));
      }
      runs.push({
        checkId: run.checkId,
        side: run.side,
        command: check.command,
        exitCode: run.exitCode,
        outputTail: run.outputTail.slice(-CHECK_OUTPUT_TAIL_MAX),
      });
    }
    return { kind: "check", results: runs, ...(input.next === undefined || next === undefined ? {} : { next }) } satisfies TaskCommand;
  });

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
      const evidence = {
        ...(input.evidence === undefined ? {} : { evidence: input.evidence as CompletionEvidence }),
        ...(input.handoff === undefined ? {} : { handoff: input.handoff as string }),
      };
      return next === undefined
        ? Effect.succeed({ kind, ...evidence })
        // One of the nodes this one flows into; it need not be in reach, since sending on hands the task over (04).
        : Effect.map(
          findNode(
            taskCanvasEnv(caller.canvas).downstream(task.current.node).flatMap((id) => caller.canvas.nodes.get(id) ?? []),
            next,
            "next",
            "downstream task node",
          ),
          (node) => ({ kind, next: taskNodeId(node.id), ...evidence }),
        );
    }
    case "check":
      return checkCommandOf(caller, task, input as unknown as TaskCheckArgs);
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
    // The mail a ruling owes is written with it, by each recipient's own machine (ruling-notices.ts).
    const outcome = yield* ports.submit(written, taskRulingContext(caller.canvas), taskCanvasEnv(caller.canvas));
    return yield* writeResultOf(outcome, written);
  });

/** One task verb, for a seat the work socket admitted. */
export const handleTaskOp = (
  op: TaskControlOp,
  args: unknown,
  caller: TaskCaller,
  ports: TaskPorts,
): Effect.Effect<unknown, WorkErrorBody> =>
  Effect.gen(function* () {
    if (!TASKS_ENABLED) return yield* Effect.fail(productDisabledError(caller.actor.nodeId, "task", op));
    switch (op) {
      case "task.list": {
        const input = yield* decode(TASK_ARGS[op], args);
        const nodes = input.node === undefined
          ? ports.nodes(caller.canvas).filter((node) => seatReachesTaskNode(caller.canvas, caller.actor.nodeId, node.id))
          : [yield* nodeInReach(caller, ports, input.node, "node")];
        const limit = input.limit ?? LIST_DEFAULT_LIMIT;
        const assignee = input.assignee === undefined
          ? undefined
          : yield* findSeat(caller, caller.actor.nodeId, input.assignee, "assignee");
        const reviewer = input.reviewer === undefined
          ? undefined
          : reviewerKey({ kind: "seat", seat: yield* findSeat(caller, caller.actor.nodeId, input.reviewer, "reviewer") });
        // A review is owed only in review, so a reviewer filter reads that state alone.
        const states = reviewer === undefined ? input.state : (input.state ?? ["in-review"]).filter((state) => state === "in-review");
        if (nodes.length === 0 || states?.length === 0) return { tasks: [], more: false };
        // A filter reads past the limit, so a page is still full.
        const filtered = assignee !== undefined || reviewer !== undefined;
        const listed = yield* ports.list(caller.canvasName, {
          nodeIds: nodes.map((node) => taskNodeId(node.id)),
          limit: filtered ? NUMBER_SCAN_LIMIT : limit,
          ...(states === undefined ? {} : { states }),
        });
        const owed = (task: TaskView) =>
          task.current.reviewers.some((named) => reviewerKey(named) === reviewer) &&
          !currentStamps(task.current).some((stamp) => reviewerKey(stamp.reviewer) === reviewer);
        const tasks = listed.tasks.filter((task) =>
          (assignee === undefined || task.current.assignee === assignee) && (reviewer === undefined || owed(task)));
        // Reviews owed read longest waiting first.
        const ordered = reviewer === undefined ? tasks : [...tasks].sort((a, b) => a.stateSince - b.stateSince);
        const marks = yield* pendingOf(caller, ports);
        return {
          tasks: ordered.slice(0, limit).map((task) => withPendingMark(task, task.taskId, marks)),
          more: listed.more || tasks.length > limit,
          ...pendingUnknownOf(marks),
        };
      }
      case "task.show": {
        const input = yield* decode(TASK_ARGS[op], args);
        const task = yield* findTask(caller, ports, input.task);
        const marks = yield* pendingOf(caller, ports);
        const comments = ports.threadCount === undefined ? undefined : yield* ports.threadCount(caller.canvasName, task);
        // The thread is read with msg list, by the task's node and id.
        const thread = {
          threadId: task.taskId,
          ...(comments === undefined ? {} : { comments }),
          read: `junto msg list '${JSON.stringify({ target: task.current.node, taskId: task.taskId })}'`,
        };
        return { task: withPendingMark(task, task.taskId, marks), thread, ...pendingUnknownOf(marks) };
      }
      case "task.rules": {
        const input = yield* decode(TASK_ARGS[op], args);
        if ("node" in input) {
          const node = yield* nodeInReach(caller, ports, input.node, "node");
          return { node: node.id, rules: rulesInForce(caller.canvas, node.id) } satisfies TaskRulesResult;
        }
        const task = yield* findTask(caller, ports, input.task);
        // The list finish evaluates: none is answered until the finish carries its claims.
        const rules = rulesInForce(caller.canvas, task.current.node);
        const runs = (task.current.checks ?? []).filter((run) => run.epoch === task.current.epoch);
        const downstream = taskCanvasEnv(caller.canvas).downstream(task.current.node);
        const toward = (next: TaskNodeId | undefined) => ({
          ...(next === undefined ? {} : { destination: next }),
          checks: checksToward(caller.canvas, task.current.node, next).map((required) => ({
            checkId: required.check.id,
            side: required.side,
            label: required.check.label,
            command: required.check.command,
            status: checkStatusOf(required, runs, next),
          })),
        });
        return {
          node: task.current.node,
          rules,
          task: {
            taskId: task.taskId,
            unanswered: rules.flatMap(({ rule }) => (rule.kind === "requires-review" ? [] : [{ ruleId: rule.id, text: rule.text }])),
            checks: downstream.length === 0 ? [toward(undefined)] : downstream.map(toward),
          },
        } satisfies TaskRulesResult;
      }
      case "task.wait": {
        const input = yield* decode(TASK_ARGS[op], args);
        return yield* waitTask(caller, ports, input);
      }
      case "task.comment": {
        const { disposition, opId, taskId, threadId, messageId, notified } = yield* commentOnTask(caller, ports, yield* decode(TASK_ARGS[op], args));
        return { disposition, opId, taskId, threadId, messageId, notified };
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

/**
 * A comment in a task's thread, by a seat (`junto task comment`) or by the
 * operator (the window's thread): one path, so the two never disagree. A
 * comment admits by reach alone (03), each @name becomes its mention link,
 * and the task's people are told. Returns the task it found with the post.
 */
export const commentOnTask = (
  caller: TaskCommenter,
  ports: Pick<TaskPorts, "find" | "comment">,
  input: { readonly opId: OpId; readonly task: string; readonly text: string; readonly node?: NodeId },
) =>
  Effect.gen(function* () {
    // The assignee exemption is for moves, not comments.
    const task = yield* findTask(caller, ports, input.task, "task", false);
    // A window names the task node it shows: a task on another is not there.
    if (input.node !== undefined && task.current.node !== input.node) {
      return yield* Effect.fail(unknown("task", input.task, `no task ${input.task} on node ${input.node}`));
    }
    // Each mention becomes its link: in reach of the task, whoever writes (03).
    const callerId = caller.actor.kind === "seat" ? caller.actor.nodeId : operatorActorRef(caller.canvasName).nodeId;
    const text = yield* linkMentionsAt(caller.canvas, caller.canvasName, callerId, input.text, { kind: "comments", nodeId: task.current.node }).pipe(
      Effect.mapError((error): WorkErrorBody => ({ ...error, details: { ...error.details, opId: input.opId } })),
    );
    const sent = yield* ports.comment({
      subject: { kind: "task", nodeId: task.current.node, taskId: task.taskId },
      text,
      actor: caller.actor,
      opId: input.opId,
    }, { canvas: caller.canvas, canvasName: caller.canvasName, people: taskPeopleOf(task.current) }).pipe(
      Effect.mapError((error): WorkErrorBody => ({ ...error, details: { ...error.details, opId: input.opId } })),
    );
    return {
      disposition: "applied" as const,
      opId: input.opId,
      taskId: task.taskId,
      nodeId: task.current.node,
      threadId: sent.threadId,
      messageId: sent.messageId,
      notified: sent.notified,
    };
  });

/**
 * The task `junto msg --task` names, on the task node its target names, each
 * found in the seat's reach as a comment finds them (`commentOnTask`). A task
 * out of reach and an id no task holds are refused alike.
 */
export const taskOnTarget = (
  caller: TaskCaller,
  ports: TaskPorts,
  input: { readonly target: string; readonly task: string },
): Effect.Effect<TaskView, WorkErrorBody> =>
  Effect.gen(function* () {
    const node = yield* nodeInReach(caller, ports, input.target, "target");
    const task = yield* findTask(caller, ports, input.task, "taskId", false);
    if (task.current.node !== node.id) {
      return yield* Effect.fail(unknown("taskId", input.task, `no task ${input.task} on ${titleOf(node)}`));
    }
    return task;
  });
