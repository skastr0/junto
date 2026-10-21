import { Option, Schema } from "effect";
import type { NodeId } from "./model/base";
import type { CompletionEvidence } from "./work-model";
import type { DomainVerdict, Refusal, ResourceActor, ResourceCommand, ResourceDomain } from "./resource-command";
import {
  ASSIGNEE_ONLY,
  formatTaskNumber,
  isClosedTaskState,
  isOpenTaskState,
  reachExempt,
  reviewerKey,
  seatNodeId,
  taskNumber,
  taskRefusal,
  type CheckResult,
  type Reviewer,
  type SeatNodeId,
  type Stamp,
  type StampPolicy,
  type TaskActor,
  type TaskCommand,
  type TaskCore,
  type TaskEffect,
  type TaskId,
  type TaskNodeId,
  type TaskNumber,
  type TaskRefusal,
  type TaskRefusalDetail,
  type TaskState,
  TASK_STATES,
  type TaskCommandKind,
} from "./task-model";

// The 0.10 task state machine (plan 04) on the task contract
// (`task-model.ts`). Pure: no I/O; the clock and the canvas come in through
// `TaskDomainEnv`. The editing machine rules every write through
// `taskDomain`; the repository persists the facts it returns and sends the
// mail their effects name.

// ── state ──────────────────────────────────────────────────────────────────

/** One task as the ruler holds it: its current layer plus what is not per layer. */
export type TaskRecord = TaskCore & {
  readonly id: TaskId;
  readonly number: TaskNumber;
  readonly title: string;
  readonly body?: string;
  readonly dependsOn: ReadonlyArray<TaskId>;
};

/** Every task of one canvas, and the next number the ruler mints. */
export type TaskBoardState = {
  readonly tasks: ReadonlyMap<TaskId, TaskRecord>;
  readonly nextNumber: TaskNumber;
};

export const emptyTaskBoard = (): TaskBoardState => ({ tasks: new Map(), nextNumber: taskNumber(1)! });

/** What the ruler knows besides the tasks when it rules one write. */
export type TaskDomainEnv = {
  /** The ruling's time, stamped on stamps. */
  readonly at: number;
  /** Task nodes this node `flows` into, in wire order. */
  readonly downstream: (node: TaskNodeId) => ReadonlyArray<TaskNodeId>;
  /** The stamp default a task node sets for tasks created on or arriving at it. */
  readonly stampDefaultOf: (node: TaskNodeId) => StampPolicy;
  /** Region reach (01) of a seat to a task node: who may be a reviewer, an assignee, or depended on. */
  readonly seatReaches: (seat: SeatNodeId, node: TaskNodeId) => boolean;
  /**
   * Whether a task node is among an automation's targets (`automationTargets`,
   * 01): all it may act on. Absent, an automation reaches nothing.
   */
  readonly automationReaches?: (automation: NodeId, node: TaskNodeId) => boolean;
  /**
   * The first rule in force at a task node that a finish's evidence leaves
   * unanswered (`rulesInForce`, `evaluateRules`), if any; `taskId` finds
   * task-level rules. Without it no rule is checked, as in a preview.
   */
  readonly rulesUnmet?: (node: TaskNodeId, taskId: TaskId, evidence: CompletionEvidence | undefined) => RulesUnmet | undefined;
  /**
   * The checks a finish from `node` toward `next` still needs (the node's
   * outgoing checks and the next node's incoming ones, `requiredChecks`),
   * against the check runs at the current epoch. Without it no check is
   * checked, as in a preview.
   */
  readonly checksUnmet?: (node: TaskNodeId, next: TaskNodeId | undefined, results: ReadonlyArray<CheckResult>) => ChecksUnmet | undefined;
};

/** The required checks a finish found red or never run, by check id, as `checks-unmet` reports them. */
export type ChecksUnmet = { readonly red: ReadonlyArray<string>; readonly missing: ReadonlyArray<string> };

/** A rule a finish's evidence leaves unanswered, as `rules-unmet` reports it. */
export type RulesUnmet = {
  readonly missing: string;
  readonly message: string;
  readonly nextStep: string;
  readonly ruleId?: string;
};

/** One ruled write: the task as it stands after it, and what the ruling owes. */
export type TaskFact = {
  readonly kind: "task";
  readonly task: TaskRecord;
  readonly effects: ReadonlyArray<TaskEffect>;
};

export type TaskRecordRuling =
  | { readonly ok: true; readonly task: TaskRecord; readonly effects: ReadonlyArray<TaskEffect> }
  | { readonly ok: false; readonly refusal: TaskRefusal };

const refuse = (detail: TaskRefusalDetail): TaskRecordRuling => ({ ok: false, refusal: taskRefusal(detail) });

// ── stamps ─────────────────────────────────────────────────────────────────

/** Each reviewer's latest stamp at the task's current epoch. */
export const currentStamps = (task: Pick<TaskCore, "epoch" | "stamps">): ReadonlyArray<Stamp> => {
  const latest = new Map<string, Stamp>();
  for (const stamp of task.stamps) {
    if (stamp.epoch !== task.epoch) continue;
    const key = reviewerKey(stamp.reviewer);
    const held = latest.get(key);
    if (held === undefined || held.at <= stamp.at) latest.set(key, stamp);
  }
  return [...latest.values()];
};

const listed = (reviewers: ReadonlyArray<Reviewer>, reviewer: Reviewer): boolean =>
  reviewers.some((entry) => reviewerKey(entry) === reviewerKey(reviewer));

/**
 * Current approvals, once per reviewer: a seat's while it is on the list, the
 * operator's always (the operator reviews through the feed, listed or not).
 * No seat's approval counts toward work it is assigned, checked here at count
 * time: a reviewer later reassigned the task brings no approval with it.
 */
export const currentApprovals = (task: Pick<TaskCore, "epoch" | "stamps" | "reviewers" | "assignee">): number =>
  currentStamps(task).filter((stamp) =>
    stamp.verdict === "approve" &&
    (stamp.reviewer.kind === "operator" ||
      (listed(task.reviewers, stamp.reviewer) && stamp.reviewer.seat !== task.assignee))
  ).length;

export const stampsMet = (task: Pick<TaskCore, "epoch" | "stamps" | "reviewers" | "stampPolicy" | "assignee">): boolean =>
  currentApprovals(task) >= task.stampPolicy.required;

// ── dependencies ───────────────────────────────────────────────────────────

/** The path `on` already depends back to `from` through, or undefined. */
const dependencyPath = (
  tasks: ReadonlyMap<TaskId, TaskRecord>,
  on: TaskId,
  from: TaskId,
): ReadonlyArray<TaskId> | undefined => {
  const seen = new Set<TaskId>();
  const walk = (id: TaskId, path: ReadonlyArray<TaskId>): ReadonlyArray<TaskId> | undefined => {
    if (id === from) return path;
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const next of tasks.get(id)?.dependsOn ?? []) {
      const found = walk(next, [...path, next]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(on, [on]);
};

// ── the machine, on one layer ──────────────────────────────────────────────

/** What the ruler knows about the canvas when it rules a write on one task. */
export type TaskContext = {
  readonly taskId: TaskId;
  /** The ruling's time, stamped on stamps. */
  readonly at: number;
  /** The open task a seat holds anywhere on the canvas, if any (invariant 2). */
  readonly openTaskOf: (seat: SeatNodeId) => TaskId | undefined;
  /** Task nodes this task's node `flows` into, in wire order. */
  readonly downstream: ReadonlyArray<TaskNodeId>;
  /** The stamp default a task node sets for tasks that arrive on it. */
  readonly stampDefaultOf: (node: TaskNodeId) => StampPolicy;
  /** Region reach (01) of a seat to this task's node: who may be a reviewer or an assignee. */
  readonly seatReaches: (seat: SeatNodeId) => boolean;
  /** The first rule in force on this task's node a finish's evidence leaves unanswered; absent, none is checked. */
  readonly rulesUnmet?: (evidence: CompletionEvidence | undefined) => RulesUnmet | undefined;
  /** The checks toward `next` still red or not run at the current epoch; absent, none is checked. */
  readonly checksUnmet?: (next: TaskNodeId | undefined, results: ReadonlyArray<CheckResult>) => ChecksUnmet | undefined;
};

/** A ruling on one task that keeps whatever else the task carries. */
export type LayerRuling<T extends TaskCore> =
  | { readonly ok: true; readonly task: T; readonly effects: ReadonlyArray<TaskEffect> }
  | { readonly ok: false; readonly refusal: TaskRefusal };

const resolveNext = (
  downstream: ReadonlyArray<TaskNodeId>,
  named: TaskNodeId | undefined,
): { readonly ok: true; readonly next?: TaskNodeId } | { readonly ok: false; readonly detail: TaskRefusalDetail } => {
  if (named !== undefined) {
    return downstream.includes(named)
      ? { ok: true, next: named }
      : { ok: false, detail: { kind: "next-not-downstream", next: named, choices: downstream } };
  }
  if (downstream.length === 0) return { ok: true };
  if (downstream.length === 1) return { ok: true, next: downstream[0]! };
  return { ok: false, detail: { kind: "next-required", choices: downstream } };
};

/** The task without the keys named, still typed as the task: those keys are optional on it. */
const without = <T extends TaskCore>(task: T, ...keys: ReadonlyArray<"assignee" | "next" | "checks">): T => {
  const rest: Partial<T> = { ...task };
  for (const key of keys) delete rest[key];
  return rest as T;
};

/** The layer alone, as a sent-on effect records it. */
const layerOf = (task: TaskCore): TaskCore => ({
  state: task.state,
  node: task.node,
  ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
  epoch: task.epoch,
  stampPolicy: task.stampPolicy,
  reviewers: task.reviewers,
  stamps: task.stamps,
  ...(task.checks !== undefined ? { checks: task.checks } : {}),
});

/**
 * One task's ruling machinery: refusals, results and the moves every command
 * shares, typed by whatever the task carries besides its layer.
 */
const layerRules = <T extends TaskCore>(ctx: TaskContext) => {
  const refuse = (detail: TaskRefusalDetail): LayerRuling<T> => ({ ok: false, refusal: taskRefusal(detail) });
  const rule = (task: T, effects: ReadonlyArray<TaskEffect> = []): LayerRuling<T> => ({ ok: true, task, effects });
  const illegal = (task: T, command: TaskCommand): LayerRuling<T> =>
    refuse({ kind: "illegal-transition", from: task.state, command: command.kind });
  /**
   * Close the layer: done here, or arrive in backlog, unassigned, on the next
   * node at the next epoch, so no approval from an earlier pass counts there.
   */
  const complete = (task: T): LayerRuling<T> => {
    const closed: T = { ...without(task, "next"), state: "done" };
    if (task.next === undefined) return rule(closed);
    return rule(
      {
        ...without(closed, "assignee", "checks"),
        state: "backlog",
        node: task.next,
        epoch: task.epoch + 1,
        stampPolicy: ctx.stampDefaultOf(task.next),
        reviewers: [],
        stamps: [],
      },
      [{ kind: "sent-on", from: task.node, to: task.next, layer: layerOf(closed) }],
    );
  };
  /** In review with the count met moves on; otherwise it waits. */
  const settle = (task: T): LayerRuling<T> => task.state === "in-review" && stampsMet(task) ? complete(task) : rule(task);
  return { refuse, rule, illegal, complete, settle };
};

const reviewerOf = (actor: TaskActor): Reviewer | undefined => {
  switch (actor.kind) {
    case "operator":
      return { kind: "operator" };
    case "seat":
      return { kind: "seat", seat: actor.seat };
    case "automation":
      return undefined;
  }
};

/**
 * Rule one command on one existing task, on its current layer. Reach is the
 * ruler's, checked before this (`reachExempt` for 01 rule 6); here are the
 * assignment, the transition rules and the stamps. A refusal changes nothing.
 * What lives off the layer (a create, the title and body, dependencies) is
 * the board's (`ruleTaskBoardCommand`): here those commands are only checked
 * against the state.
 */
export const ruleTaskCommand = <T extends TaskCore>(
  task: T,
  actor: TaskActor,
  command: TaskCommand,
  ctx: TaskContext,
): LayerRuling<T> => {
  const { refuse, rule, illegal, complete, settle } = layerRules<T>(ctx);

  if (ASSIGNEE_ONLY[command.kind]) {
    // A closed task is closed for everyone: say so, not that its assignee is someone else.
    if (isClosedTaskState(task.state)) return illegal(task, command);
    const isAssignee = actor.kind === "seat" && actor.seat === task.assignee && isOpenTaskState(task.state);
    if (!isAssignee) return refuse({ kind: "not-assignee", ...(task.assignee ? { assignee: task.assignee } : {}) });
  }

  switch (command.kind) {
    case "create":
      return refuse({ kind: "task-exists", taskId: command.taskId });
    case "edit":
      return task.state === "archived" ? illegal(task, command) : rule(task);
    case "depend":
    case "undepend":
      return isClosedTaskState(task.state) ? illegal(task, command) : rule(task);
    case "assign": {
      if (task.state !== "backlog") {
        return task.assignee !== undefined && isOpenTaskState(task.state)
          ? refuse({ kind: "already-assigned", assignee: task.assignee })
          : illegal(task, command);
      }
      // Only the operator assigns outside reach: no seat or automation hands work, and mail, to a sibling region.
      if (actor.kind !== "operator" && !ctx.seatReaches(command.seat)) return refuse({ kind: "not-in-reach", nodeId: command.seat });
      const held = ctx.openTaskOf(command.seat);
      if (held !== undefined && held !== ctx.taskId) return refuse({ kind: "seat-busy", seat: command.seat, taskId: held });
      return rule({ ...task, state: "assigned", assignee: command.seat }, [{ kind: "assignment-notice", seat: command.seat }]);
    }
    case "unassign":
      return isOpenTaskState(task.state) ? rule({ ...without(task, "assignee", "next"), state: "backlog" }) : illegal(task, command);
    case "start":
      return task.state === "assigned" ? rule({ ...task, state: "working" }) : illegal(task, command);
    case "pause":
      return task.state === "working" ? rule({ ...task, state: "input-required" }) : illegal(task, command);
    case "resume":
      return task.state === "input-required" ? rule({ ...task, state: "working" }) : illegal(task, command);
    case "finish": {
      if (task.state !== "working") return illegal(task, command);
      const next = resolveNext(ctx.downstream, command.next);
      if (!next.ok) return refuse(next.detail);
      // Statement rules need claims; a requires-review rule is left to the stamps.
      const unmet = ctx.rulesUnmet?.(command.evidence);
      if (unmet !== undefined) return refuse({ kind: "rules-unmet", ...unmet });
      // Rules first, then checks: each a refusal of its own.
      const checks = ctx.checksUnmet?.(next.next, (task.checks ?? []).filter((run) => run.epoch === task.epoch));
      if (checks !== undefined) return refuse({ kind: "checks-unmet", ...checks });
      const finished: T = { ...without(task, "next"), ...(next.next ? { next: next.next } : {}), state: "in-review" };
      if (stampsMet(finished)) return complete(finished);
      const stamped = new Set(currentStamps(finished).map((stamp) => reviewerKey(stamp.reviewer)));
      return rule(
        finished,
        finished.reviewers.filter((reviewer) => !stamped.has(reviewerKey(reviewer))).map((reviewer) => ({
          kind: "stamp-request" as const,
          reviewer,
        })),
      );
    }
    case "check": {
      if (task.state !== "working") return illegal(task, command);
      // An incoming run belongs to the node it arrives at: the one named, or the only one.
      const incoming = command.results.some((run) => run.side === "incoming");
      const next = incoming || command.next !== undefined ? resolveNext(ctx.downstream, command.next) : { ok: true as const };
      if (!next.ok) return refuse(next.detail);
      const runs: ReadonlyArray<CheckResult> = command.results.map((run) => ({
        ...run,
        epoch: task.epoch,
        at: ctx.at,
        ...(run.side === "incoming" && next.next !== undefined ? { destination: next.next } : {}),
      }));
      // A newer run of the same check replaces the older; runs of earlier epochs are dropped.
      const key = (run: CheckResult) => `${run.side}:${run.checkId}:${run.destination ?? ""}`;
      const replaced = new Set(runs.map(key));
      const kept = (task.checks ?? []).filter((run) => run.epoch === task.epoch && !replaced.has(key(run)));
      return rule({ ...task, checks: [...kept, ...runs] });
    }
    case "cancel":
      // Closed states stay closed: a done layer may already have been sent on.
      return isClosedTaskState(task.state) ? illegal(task, command) : rule({ ...task, state: "canceled" });
    case "archive":
      return task.state === "done" || task.state === "canceled" ? rule({ ...task, state: "archived" }) : illegal(task, command);
    case "reviewer-add": {
      if (isClosedTaskState(task.state)) return illegal(task, command);
      const { reviewer } = command;
      if (reviewer.kind === "seat") {
        if (reviewer.seat === task.assignee) return refuse({ kind: "own-task", seat: reviewer.seat });
        if (!ctx.seatReaches(reviewer.seat)) return refuse({ kind: "not-reviewer", reviewer });
      }
      if (listed(task.reviewers, reviewer)) return rule(task);
      return rule(
        { ...task, reviewers: [...task.reviewers, reviewer] },
        task.state === "in-review" ? [{ kind: "stamp-request", reviewer }] : [],
      );
    }
    case "reviewer-remove":
      if (isClosedTaskState(task.state)) return illegal(task, command);
      return settle({ ...task, reviewers: task.reviewers.filter((entry) => reviewerKey(entry) !== reviewerKey(command.reviewer)) });
    case "stamp-policy":
      if (!Number.isSafeInteger(command.required) || command.required < 0) {
        return refuse({ kind: "invalid-policy", required: command.required });
      }
      if (isClosedTaskState(task.state)) return illegal(task, command);
      return settle({ ...task, stampPolicy: { required: command.required } });
    case "stamp": {
      const reviewer = reviewerOf(actor);
      if (reviewer === undefined) return refuse({ kind: "cannot-review", actor: actor.kind });
      if (task.state !== "in-review") return illegal(task, command);
      if (reviewer.kind === "seat") {
        if (reviewer.seat === task.assignee) return refuse({ kind: "own-task", seat: reviewer.seat });
        if (!listed(task.reviewers, reviewer)) return refuse({ kind: "not-reviewer", reviewer });
      }
      const stamp: Stamp = {
        reviewer,
        verdict: command.verdict,
        epoch: task.epoch,
        at: ctx.at,
        ...(command.subjectHash !== undefined ? { subjectHash: command.subjectHash } : {}),
        ...(command.text !== undefined ? { text: command.text } : {}),
      };
      const stamped: T = { ...task, stamps: [...task.stamps, stamp] };
      if (command.verdict === "approve") return settle(stamped);
      // Changes asked: back to work on a new epoch, with no checks run; every earlier stamp stops counting.
      const epoch = task.epoch + 1;
      return rule({ ...without(stamped, "next", "checks"), state: "working", epoch }, [
        { kind: "defect", epoch, by: reviewer, ...(command.text !== undefined ? { text: command.text } : {}) },
      ]);
    }
  }
};

// ── the machine, on a canvas's tasks ───────────────────────────────────────

const openTaskOf = (state: TaskBoardState, seat: SeatNodeId): TaskId | undefined => {
  for (const task of state.tasks.values()) {
    if (task.assignee === seat && isOpenTaskState(task.state)) return task.id;
  }
  return undefined;
};

/** The one-task context for a task on this board. */
export const taskContextOf = (state: TaskBoardState, task: Pick<TaskRecord, "id" | "node">, env: TaskDomainEnv): TaskContext => ({
  taskId: task.id,
  at: env.at,
  openTaskOf: (seat) => openTaskOf(state, seat),
  downstream: env.downstream(task.node),
  stampDefaultOf: env.stampDefaultOf,
  seatReaches: (seat) => env.seatReaches(seat, task.node),
  ...(env.rulesUnmet === undefined ? {} : { rulesUnmet: (evidence) => env.rulesUnmet!(task.node, task.id, evidence) }),
  ...(env.checksUnmet === undefined ? {} : { checksUnmet: (next, results) => env.checksUnmet!(task.node, next, results) }),
});

/**
 * Rule one command against every task of a canvas: a create, the record's
 * own fields, dependencies, then the layer through `ruleTaskCommand`.
 */
export const ruleTaskBoardCommand = (
  state: TaskBoardState,
  target: { readonly node: TaskNodeId; readonly taskId: TaskId },
  actor: TaskActor,
  command: TaskCommand,
  env: TaskDomainEnv,
): TaskRecordRuling => {
  if (command.kind === "create") {
    if (state.tasks.has(command.taskId)) return refuse({ kind: "task-exists", taskId: command.taskId });
    const policy = command.stampPolicy ?? env.stampDefaultOf(target.node);
    if (!Number.isSafeInteger(policy.required) || policy.required < 0) {
      return refuse({ kind: "invalid-policy", required: policy.required });
    }
    return {
      ok: true,
      task: {
        id: command.taskId,
        number: state.nextNumber,
        title: command.title,
        ...(command.body !== undefined ? { body: command.body } : {}),
        dependsOn: [],
        state: "backlog",
        node: target.node,
        epoch: 0,
        stampPolicy: { required: policy.required },
        reviewers: [],
        stamps: [],
      },
      effects: [{ kind: "number-minted", number: state.nextNumber }],
    };
  }
  const task = state.tasks.get(target.taskId);
  if (task === undefined || task.node !== target.node) return refuse({ kind: "unknown-task", taskId: target.taskId });
  if (command.kind === "depend") {
    const on = state.tasks.get(command.on);
    if (on === undefined) return refuse({ kind: "unknown-task", taskId: command.on });
    // A seat depends only on tasks its reach sees (01, task-dep-scope), an automation only on its targets; the operator on any.
    const inReach = actor.kind === "operator" ||
      (actor.kind === "seat" ? env.seatReaches(actor.seat, on.node) : env.automationReaches?.(actor.automation, on.node) === true);
    if (!inReach) return refuse({ kind: "not-in-reach", nodeId: on.node });
    const cycle = task.dependsOn.includes(command.on) ? undefined : dependencyPath(state.tasks, command.on, task.id);
    if (cycle !== undefined) return refuse({ kind: "dependency-cycle", through: cycle });
  }
  const ruled = ruleTaskCommand(task, actor, command, taskContextOf(state, task, env));
  if (!ruled.ok) return ruled;
  switch (command.kind) {
    case "edit":
      return {
        ...ruled,
        task: {
          ...ruled.task,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.body !== undefined ? { body: command.body } : {}),
        },
      };
    case "depend":
      return task.dependsOn.includes(command.on) ? ruled : { ...ruled, task: { ...ruled.task, dependsOn: [...task.dependsOn, command.on] } };
    case "undepend":
      return { ...ruled, task: { ...ruled.task, dependsOn: task.dependsOn.filter((id) => id !== command.on) } };
    default:
      return ruled;
  }
};

// ── refusal text ───────────────────────────────────────────────────────────

const choicesText = (choices: ReadonlyArray<NodeId>): string => choices.join(", ");

/** What a refused task command says to whoever sent it. */
/** Each state as a sentence says it, after "This task is". Total, so a new state fails the typecheck until it is worded. */
const TASK_STATE_SPOKEN: Record<TaskState, string> = {
  backlog: "in the backlog",
  assigned: "assigned",
  working: "in progress",
  "input-required": "waiting for input",
  "in-review": "in review",
  done: "done",
  canceled: "canceled",
  archived: "archived",
};

/** What a command could not do, after "so", as a sentence says it. Total, so a new kind fails the typecheck until it is worded. */
const TASK_COMMAND_SPOKEN: Record<TaskCommandKind, string> = {
  create: "it cannot be created again",
  edit: "it cannot be edited",
  assign: "it cannot be assigned",
  unassign: "it cannot be unassigned",
  start: "it cannot be started",
  pause: "it cannot be paused",
  resume: "it cannot be resumed",
  finish: "it cannot be finished",
  check: "its checks cannot be reported",
  cancel: "it cannot be canceled",
  archive: "it cannot be archived",
  depend: "a dependency cannot be added",
  undepend: "a dependency cannot be removed",
  "reviewer-add": "a reviewer cannot be added",
  "reviewer-remove": "a reviewer cannot be removed",
  "stamp-policy": "its stamp policy cannot change",
  stamp: "it cannot be stamped",
};

export const taskRefusalMessage = (detail: TaskRefusalDetail): string => {
  switch (detail.kind) {
    case "illegal-transition":
      return `This task is ${TASK_STATE_SPOKEN[detail.from]}, so ${TASK_COMMAND_SPOKEN[detail.command]}`;
    case "not-assignee":
      return detail.assignee === undefined
        ? "Only the assignee moves this task, and it has none"
        : `Only the assignee, ${detail.assignee}, moves this task`;
    case "already-assigned":
      return `The task is assigned to ${detail.assignee}; unassign it first`;
    case "seat-busy":
      return `${detail.seat} already holds open task ${detail.taskId}`;
    case "not-reviewer":
      return detail.reviewer.kind === "operator"
        ? "The operator is not a reviewer of this task"
        : `${detail.reviewer.seat} is not a reviewer of this task, or is not in its reach`;
    case "own-task":
      return `${detail.seat} is the assignee and cannot review its own task`;
    case "stale-epoch":
      return `The task moved on; its epoch is now ${detail.expected}`;
    case "next-required":
      return `Name the next task node: ${choicesText(detail.choices)}`;
    case "next-not-downstream":
      return `${detail.next} is not downstream of this task node; choose one of: ${choicesText(detail.choices) || "none"}`;
    case "invalid-policy":
      return `A stamp count is a whole number from 0, not ${detail.required}`;
    case "dependency-cycle":
      return `That dependency closes a cycle through ${detail.through.join(", ")}`;
    case "unknown-task":
      return `No task ${detail.taskId} on this task node`;
    case "task-exists":
      return `Task ${detail.taskId} already exists`;
    case "cannot-review":
      return `An ${detail.actor} does not review tasks`;
    case "target-mismatch":
      return `The command names task ${detail.target} but creates ${detail.taskId}`;
    case "wrong-node":
      return `${detail.nodeId} is not ${detail.expected === "agent" ? "a seat" : "a task node"}`;
    case "not-in-reach":
      return `${detail.nodeId} is outside your reach`;
    case "rules-unmet":
      return `${detail.message}. ${detail.nextStep}`;
    case "checks-unmet": {
      const parts = [
        ...(detail.red.length === 0 ? [] : [`red: ${detail.red.join(", ")}`]),
        ...(detail.missing.length === 0 ? [] : [`not run: ${detail.missing.join(", ")}`]),
      ];
      return `Required checks are not green at this epoch (${parts.join("; ")}). Run them and report each with task check`;
    }
  }
};

/**
 * A refusal as the bounded token a ruling row may carry (`from:canceled`,
 * `epoch:7`): the row holds no domain text, so the seat's machine words it
 * again from this and its own command (`taskRefusalWordsOf`).
 */
export const taskRefusalToken = (detail: unknown): string | undefined => {
  if (typeof detail !== "object" || detail === null) return undefined;
  const refusal = detail as TaskRefusalDetail;
  if (refusal.kind === "illegal-transition") return `from:${refusal.from}`;
  if (refusal.kind === "stale-epoch") return `epoch:${refusal.expected}`;
  return undefined;
};

/** The closed set of tokens a task refusal leaves on its row: `from:<TaskState>` and `epoch:<int>`, nothing else. */
export const TaskRefusalToken = Schema.String.pipe(
  Schema.check(Schema.isPattern(new RegExp(`^(?:from:(?:${TASK_STATES.join("|")})|epoch:(?:0|[1-9][0-9]{0,14}))$`))),
);
const decodeTaskRefusalToken = Schema.decodeUnknownOption(TaskRefusalToken);

const isTaskCommandKind = (kind: string): kind is TaskCommandKind => Object.hasOwn(ASSIGNEE_ONLY, kind);

/**
 * The task's own words for a refused command, decoded from its row's token on
 * the reading machine: `from:` for an invalid transition, `epoch:` for a stale
 * one. Undefined for any token outside the closed set, or one that does not
 * match the reason, so the generic words stand.
 */
export const taskRefusalWordsOf = (reason: string, token: string | undefined, command: string): string | undefined => {
  const known = decodeTaskRefusalToken(token);
  if (Option.isNone(known) || !isTaskCommandKind(command)) return undefined;
  const [form, value] = known.value.split(":") as [string, string];
  if (form === "from" && reason === "invalid_transition") {
    return taskRefusalMessage({ kind: "illegal-transition", from: value as TaskState, command });
  }
  if (form === "epoch" && reason === "stale") return taskRefusalMessage({ kind: "stale-epoch", expected: Number(value) });
  return undefined;
};

const toRefusal = ({ reason, detail }: TaskRefusal): Refusal => ({
  reason,
  message: taskRefusalMessage(detail),
  expected: detail,
});

// ── the resource domain ────────────────────────────────────────────────────

/** The task actor a command's resource actor is. */
export const taskActorOf = (actor: ResourceActor): TaskActor => {
  switch (actor.kind) {
    case "operator":
      return { kind: "operator" };
    case "seat":
      return { kind: "seat", seat: seatNodeId(actor.nodeId) };
    case "automation":
      return { kind: "automation", automation: actor.nodeId };
  }
};

const targetOf = (command: ResourceCommand<TaskCommand>): { readonly node: TaskNodeId; readonly taskId: TaskId } | undefined => {
  const taskId = command.op.kind === "create" ? command.op.taskId : command.target.itemId;
  return taskId === undefined ? undefined : { node: command.target.nodeId as TaskNodeId, taskId };
};

/**
 * The task domain for `resource-command.ts`'s ruler. Built per ruling with
 * the canvas and clock it is ruled against; the writing machine builds the
 * same one for its overlay.
 */
export const taskDomain = (env: TaskDomainEnv): ResourceDomain<TaskBoardState, TaskCommand, TaskFact> => ({
  kind: "task",
  rule: (state, command): DomainVerdict<TaskFact> => {
    const target = targetOf(command);
    if (target === undefined) {
      return { kind: "refuse", refusal: { reason: "unknown_target", message: "Name the task this command acts on" } };
    }
    if (command.op.kind === "create" && command.target.itemId !== undefined && command.target.itemId !== command.op.taskId) {
      return { kind: "refuse", refusal: toRefusal(taskRefusal({ kind: "target-mismatch", target: command.target.itemId, taskId: command.op.taskId })) };
    }
    const ruled = ruleTaskBoardCommand(state, target, taskActorOf(command.actor), command.op, env);
    return ruled.ok
      ? { kind: "apply", facts: [{ kind: "task", task: ruled.task, effects: ruled.effects }] }
      : { kind: "refuse", refusal: toRefusal(ruled.refusal) };
  },
  apply: (state, fact) => {
    const minted = fact.effects.some((effect) => effect.kind === "number-minted");
    return {
      tasks: new Map(state.tasks).set(fact.task.id, fact.task),
      nextNumber: minted ? taskNumber(fact.task.number + 1)! : state.nextNumber,
    };
  },
  reachExempt: (state, command) => {
    const target = targetOf(command);
    const task = target === undefined ? undefined : state.tasks.get(target.taskId);
    return task !== undefined && reachExempt(task, taskActorOf(command.actor), command.op);
  },
});

/** How a task reads in a message: its number when it has one. */
export const taskLabel = (task: Pick<TaskRecord, "number">): string => formatTaskNumber(task.number);

// ── canvas invariants ──────────────────────────────────────────────────────

export type OneOpenTaskViolation = {
  readonly seat: SeatNodeId;
  readonly taskIds: ReadonlyArray<TaskId>;
};

/**
 * Seats holding more than one open task across the canvas (invariant 2).
 * Reviews do not count. Empty when the canvas holds; the v28 remap checks it.
 */
export const oneOpenTaskViolations = (
  tasks: Iterable<{ readonly id: TaskId; readonly state: TaskState; readonly assignee?: SeatNodeId }>,
): ReadonlyArray<OneOpenTaskViolation> => {
  const held = new Map<SeatNodeId, TaskId[]>();
  for (const task of tasks) {
    if (task.assignee === undefined || !isOpenTaskState(task.state)) continue;
    const ids = held.get(task.assignee);
    if (ids === undefined) held.set(task.assignee, [task.id]);
    else ids.push(task.id);
  }
  return [...held].filter(([, ids]) => ids.length > 1).map(([seat, taskIds]) => ({ seat, taskIds }));
};
