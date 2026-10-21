// The 0.10 task state machine (plan 04). Pure: no I/O, no clock, no ids
// minted here. The editing machine rules every write through it; the
// repository persists what it returns and sends the notices it names.
//
// Stand-in: the types under "contract" are a local copy of the shape the
// canvas task contract (`src/shared/task.ts`, `src/shared/work-model.ts`)
// declares for 0.10. When the contract lands they are imported from it and
// this section goes.

// ── contract (stand-in) ────────────────────────────────────────────────────

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

/** A seat node on the canvas: the one kind of node that holds a task. */
export type SeatNodeId = Branded<string, "SeatNodeId">;
/** A task node (a list of tasks) on the canvas. */
export type TaskNodeId = Branded<string, "TaskNodeId">;

export const seatNodeId = (id: string): SeatNodeId => id as SeatNodeId;
export const taskNodeId = (id: string): TaskNodeId => id as TaskNodeId;

export const TASK_STATES = [
  "backlog",
  "assigned",
  "working",
  "input-required",
  "in-review",
  "done",
  "canceled",
  "archived",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** States a seat holds: at most one of these per seat across the canvas. */
export type OpenTaskState = Extract<TaskState, "assigned" | "working" | "input-required" | "in-review">;

/** How many current approvals finishing needs; 0 means none. */
export type StampPolicy = { readonly required: number };

export type StampVerdict = "approve" | "changes";

export type Stamp = {
  readonly reviewer: SeatNodeId;
  readonly verdict: StampVerdict;
  readonly epoch: number;
  readonly subjectHash?: string;
  readonly text?: string;
  readonly at: number;
};

/** The part of a task the machine rules over, on its current layer. */
export type TaskCore = {
  readonly state: TaskState;
  /** The task node this layer sits on. */
  readonly node: TaskNodeId;
  readonly assignee?: SeatNodeId;
  readonly epoch: number;
  readonly stampPolicy: StampPolicy;
  readonly reviewers: ReadonlyArray<SeatNodeId>;
  readonly stamps: ReadonlyArray<Stamp>;
  /** Next node named at finish, held while the task is in review. */
  readonly next?: TaskNodeId;
};

// ── states ─────────────────────────────────────────────────────────────────

const OPEN: Readonly<Record<TaskState, boolean>> = {
  backlog: false,
  assigned: true,
  working: true,
  "input-required": true,
  "in-review": true,
  done: false,
  canceled: false,
  archived: false,
};

export const isOpenTaskState = (state: TaskState): state is OpenTaskState => OPEN[state];

/** Done, canceled and archived: no transition but archive leaves them. */
export const isClosedTaskState = (state: TaskState): boolean =>
  state === "done" || state === "canceled" || state === "archived";

// ── commands ───────────────────────────────────────────────────────────────

/**
 * Who writes. The operator, and an overseer carrying its authority, needs no
 * reach. A seat carries whether it reaches the task node at the sequence the
 * write is ruled at (01 rule 3); the assignee's own transitions on its task
 * are admitted by the assignment instead (01 rule 6).
 */
export type TaskActor =
  | { readonly kind: "operator" }
  | { readonly kind: "seat"; readonly seat: SeatNodeId; readonly inReach: boolean };

export type TaskCommand =
  | { readonly kind: "assign"; readonly seat: SeatNodeId }
  | { readonly kind: "unassign" }
  | { readonly kind: "start" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "finish"; readonly next?: TaskNodeId }
  | { readonly kind: "cancel" }
  | { readonly kind: "archive" }
  | { readonly kind: "reviewer-add"; readonly seat: SeatNodeId }
  | { readonly kind: "reviewer-remove"; readonly seat: SeatNodeId }
  | { readonly kind: "stamp-policy"; readonly required: number }
  | {
    readonly kind: "stamp";
    readonly verdict: StampVerdict;
    readonly subjectHash?: string;
    readonly text?: string;
  };

export type TaskCommandKind = TaskCommand["kind"];

/** Commands only the assignee writes (04 invariant 3). */
const ASSIGNEE_ONLY: Readonly<Record<TaskCommandKind, boolean>> = {
  assign: false,
  unassign: false,
  start: true,
  pause: true,
  resume: true,
  finish: true,
  cancel: false,
  archive: false,
  "reviewer-add": false,
  "reviewer-remove": false,
  "stamp-policy": false,
  stamp: false,
};

/** What the ruler knows about the canvas when it rules one write. */
export type TaskContext = {
  readonly taskId: string;
  readonly at: number;
  /** The open task a seat holds anywhere on the canvas, if any (invariant 2). */
  readonly openTaskOf: (seat: SeatNodeId) => string | undefined;
  /** Task nodes this node `flows` into, in wire order. */
  readonly downstream: ReadonlyArray<TaskNodeId>;
  /** The stamp default a task node sets for tasks that arrive on it. */
  readonly stampDefaultOf: (node: TaskNodeId) => StampPolicy;
};

// ── outcome ────────────────────────────────────────────────────────────────

/** Mail and records the ruling owes, for the repository and delivery to carry out. */
export type TaskEffect =
  | { readonly kind: "assignment-notice"; readonly seat: SeatNodeId }
  | { readonly kind: "stamp-request"; readonly reviewer: SeatNodeId }
  | { readonly kind: "defect"; readonly epoch: number; readonly by: SeatNodeId; readonly text?: string }
  | {
    readonly kind: "sent-on";
    readonly from: TaskNodeId;
    readonly to: TaskNodeId;
    /** The layer that closed, as it stood when it closed. */
    readonly layer: TaskCore;
  };

export type TaskRefusal =
  | { readonly reason: "illegal-transition"; readonly from: TaskState; readonly command: TaskCommandKind }
  | { readonly reason: "out-of-reach" }
  | { readonly reason: "not-assignee"; readonly assignee?: SeatNodeId }
  | { readonly reason: "already-assigned"; readonly assignee: SeatNodeId }
  | { readonly reason: "seat-busy"; readonly seat: SeatNodeId; readonly taskId: string }
  | { readonly reason: "not-reviewer"; readonly seat: SeatNodeId }
  | { readonly reason: "own-task"; readonly seat: SeatNodeId }
  | { readonly reason: "operator-cannot-stamp" }
  | { readonly reason: "next-required"; readonly choices: ReadonlyArray<TaskNodeId> }
  | { readonly reason: "next-not-downstream"; readonly next: TaskNodeId; readonly choices: ReadonlyArray<TaskNodeId> }
  | { readonly reason: "invalid-policy"; readonly required: number };

export type TaskRuling =
  | { readonly ok: true; readonly task: TaskCore; readonly effects: ReadonlyArray<TaskEffect> }
  | { readonly ok: false; readonly refusal: TaskRefusal };

const refuse = (refusal: TaskRefusal): TaskRuling => ({ ok: false, refusal });
const rule = (task: TaskCore, effects: ReadonlyArray<TaskEffect> = []): TaskRuling => ({
  ok: true,
  task,
  effects,
});
const illegal = (task: TaskCore, command: TaskCommand): TaskRuling =>
  refuse({ reason: "illegal-transition", from: task.state, command: command.kind });

// ── stamps ─────────────────────────────────────────────────────────────────

/** Each reviewer's latest stamp at the task's current epoch. */
export const currentStamps = (task: Pick<TaskCore, "epoch" | "stamps">): ReadonlyArray<Stamp> => {
  const latest = new Map<SeatNodeId, Stamp>();
  for (const stamp of task.stamps) {
    if (stamp.epoch !== task.epoch) continue;
    const held = latest.get(stamp.reviewer);
    if (held === undefined || held.at <= stamp.at) latest.set(stamp.reviewer, stamp);
  }
  return [...latest.values()];
};

/** Current approvals, counted once per reviewer still on the list. */
export const currentApprovals = (task: Pick<TaskCore, "epoch" | "stamps" | "reviewers">): number =>
  currentStamps(task).filter((stamp) => stamp.verdict === "approve" && task.reviewers.includes(stamp.reviewer))
    .length;

export const stampsMet = (task: Pick<TaskCore, "epoch" | "stamps" | "reviewers" | "stampPolicy">): boolean =>
  currentApprovals(task) >= task.stampPolicy.required;

// ── the machine ────────────────────────────────────────────────────────────

/**
 * Where finishing leads: the one downstream node, the one the assignee named,
 * or nowhere (done). Several downstream nodes need a name.
 */
const resolveNext = (
  downstream: ReadonlyArray<TaskNodeId>,
  named: TaskNodeId | undefined,
): { readonly ok: true; readonly next?: TaskNodeId } | { readonly ok: false; readonly refusal: TaskRefusal } => {
  if (named !== undefined) {
    return downstream.includes(named)
      ? { ok: true, next: named }
      : { ok: false, refusal: { reason: "next-not-downstream", next: named, choices: downstream } };
  }
  if (downstream.length === 0) return { ok: true };
  if (downstream.length === 1) return { ok: true, next: downstream[0]! };
  return { ok: false, refusal: { reason: "next-required", choices: downstream } };
};

/** Close the layer: done here, or arrive in backlog on the next node. */
const complete = (task: TaskCore, ctx: TaskContext, effects: ReadonlyArray<TaskEffect>): TaskRuling => {
  const { next: _held, ...closed } = task;
  if (task.next === undefined) return rule({ ...closed, state: "done" }, effects);
  const layer: TaskCore = { ...closed, state: "done" };
  const { assignee: _assignee, ...unassigned } = closed;
  return rule(
    {
      ...unassigned,
      state: "backlog",
      node: task.next,
      stampPolicy: ctx.stampDefaultOf(task.next),
      reviewers: [],
      stamps: [],
    },
    [...effects, { kind: "sent-on", from: task.node, to: task.next, layer }],
  );
};

/** In review with the count met moves on; otherwise it waits. */
const settle = (task: TaskCore, ctx: TaskContext, effects: ReadonlyArray<TaskEffect> = []): TaskRuling =>
  task.state === "in-review" && stampsMet(task) ? complete(task, ctx, effects) : rule(task, effects);

const withoutAssignee = (task: TaskCore): TaskCore => {
  const { assignee: _assignee, next: _next, ...rest } = task;
  return rest;
};

/**
 * Rule one command on one task. Admission first (reach, assignment), then the
 * transition and its invariants. A refusal changes nothing.
 */
export const ruleTaskCommand = (
  task: TaskCore,
  actor: TaskActor,
  command: TaskCommand,
  ctx: TaskContext,
): TaskRuling => {
  const isAssignee = actor.kind === "seat" && task.assignee !== undefined && actor.seat === task.assignee &&
    isOpenTaskState(task.state);
  if (ASSIGNEE_ONLY[command.kind]) {
    if (!isAssignee) return refuse({ reason: "not-assignee", ...(task.assignee ? { assignee: task.assignee } : {}) });
  } else if (actor.kind === "seat" && !actor.inReach && !isAssignee) {
    return refuse({ reason: "out-of-reach" });
  }

  switch (command.kind) {
    case "assign": {
      if (task.state !== "backlog") {
        return task.assignee !== undefined && isOpenTaskState(task.state)
          ? refuse({ reason: "already-assigned", assignee: task.assignee })
          : illegal(task, command);
      }
      const held = ctx.openTaskOf(command.seat);
      if (held !== undefined && held !== ctx.taskId) {
        return refuse({ reason: "seat-busy", seat: command.seat, taskId: held });
      }
      return rule({ ...task, state: "assigned", assignee: command.seat }, [
        { kind: "assignment-notice", seat: command.seat },
      ]);
    }
    case "unassign":
      return isOpenTaskState(task.state)
        ? rule({ ...withoutAssignee(task), state: "backlog" })
        : illegal(task, command);
    case "start":
      return task.state === "assigned" ? rule({ ...task, state: "working" }) : illegal(task, command);
    case "pause":
      return task.state === "working" ? rule({ ...task, state: "input-required" }) : illegal(task, command);
    case "resume":
      return task.state === "input-required" ? rule({ ...task, state: "working" }) : illegal(task, command);
    case "finish": {
      if (task.state !== "working") return illegal(task, command);
      const next = resolveNext(ctx.downstream, command.next);
      if (!next.ok) return refuse(next.refusal);
      const { next: _old, ...rest } = task;
      const finished: TaskCore = { ...rest, ...(next.next ? { next: next.next } : {}), state: "in-review" };
      if (stampsMet(finished)) return complete(finished, ctx, []);
      const stamped = new Set(currentStamps(finished).map((stamp) => stamp.reviewer));
      return rule(
        finished,
        finished.reviewers.filter((reviewer) => !stamped.has(reviewer)).map((reviewer) => ({
          kind: "stamp-request" as const,
          reviewer,
        })),
      );
    }
    case "cancel":
      return task.state === "canceled" || task.state === "archived"
        ? illegal(task, command)
        : rule({ ...task, state: "canceled" });
    case "archive":
      return task.state === "done" || task.state === "canceled"
        ? rule({ ...task, state: "archived" })
        : illegal(task, command);
    case "reviewer-add":
      if (isClosedTaskState(task.state)) return illegal(task, command);
      if (command.seat === task.assignee) return refuse({ reason: "own-task", seat: command.seat });
      if (task.reviewers.includes(command.seat)) return rule(task);
      return rule({ ...task, reviewers: [...task.reviewers, command.seat] }, task.state === "in-review"
        ? [{ kind: "stamp-request", reviewer: command.seat }]
        : []);
    case "reviewer-remove":
      if (isClosedTaskState(task.state)) return illegal(task, command);
      return settle({ ...task, reviewers: task.reviewers.filter((seat) => seat !== command.seat) }, ctx);
    case "stamp-policy":
      if (!Number.isSafeInteger(command.required) || command.required < 0) {
        return refuse({ reason: "invalid-policy", required: command.required });
      }
      if (isClosedTaskState(task.state)) return illegal(task, command);
      return settle({ ...task, stampPolicy: { required: command.required } }, ctx);
    case "stamp": {
      if (actor.kind !== "seat") return refuse({ reason: "operator-cannot-stamp" });
      if (task.state !== "in-review") return illegal(task, command);
      if (actor.seat === task.assignee) return refuse({ reason: "own-task", seat: actor.seat });
      if (!task.reviewers.includes(actor.seat)) return refuse({ reason: "not-reviewer", seat: actor.seat });
      const stamp: Stamp = {
        reviewer: actor.seat,
        verdict: command.verdict,
        epoch: task.epoch,
        at: ctx.at,
        ...(command.subjectHash !== undefined ? { subjectHash: command.subjectHash } : {}),
        ...(command.text !== undefined ? { text: command.text } : {}),
      };
      const stamped: TaskCore = { ...task, stamps: [...task.stamps, stamp] };
      if (command.verdict === "approve") return settle(stamped, ctx);
      // Changes asked: back to work on a new epoch; every earlier stamp stops counting.
      const { next: _next, ...rest } = stamped;
      const epoch = task.epoch + 1;
      return rule({ ...rest, state: "working", epoch }, [
        { kind: "defect", epoch, by: actor.seat, ...(command.text !== undefined ? { text: command.text } : {}) },
      ]);
    }
  }
};

// ── canvas invariants ──────────────────────────────────────────────────────

export type OneOpenTaskViolation = {
  readonly seat: SeatNodeId;
  readonly taskIds: ReadonlyArray<string>;
};

/**
 * Seats holding more than one open task across the canvas (invariant 2).
 * Reviews do not count. Empty when the canvas holds.
 */
export const oneOpenTaskViolations = (
  tasks: Iterable<{ readonly id: string; readonly state: TaskState; readonly assignee?: SeatNodeId }>,
): ReadonlyArray<OneOpenTaskViolation> => {
  const held = new Map<SeatNodeId, string[]>();
  for (const task of tasks) {
    if (task.assignee === undefined || !isOpenTaskState(task.state)) continue;
    const ids = held.get(task.assignee);
    if (ids === undefined) held.set(task.assignee, [task.id]);
    else ids.push(task.id);
  }
  return [...held].filter(([, ids]) => ids.length > 1).map(([seat, taskIds]) => ({ seat, taskIds }));
};

// ── migration remap (v28) ──────────────────────────────────────────────────

/** The task states before 0.10, as stored rows hold them. */
export type LegacyTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "archived";

/**
 * The 0.10 state of a stored row (04 Questions): submitted is backlog, or
 * assigned when it names an actor; completed is done; rejected and failed are
 * canceled. auth-required had no producer and waits on someone, so it reads as
 * input-required.
 */
export const remapLegacyTaskState = (state: LegacyTaskState, hasAssignee: boolean): TaskState => {
  switch (state) {
    case "submitted":
      return hasAssignee ? "assigned" : "backlog";
    case "working":
      return "working";
    case "input-required":
    case "auth-required":
      return "input-required";
    case "completed":
      return "done";
    case "canceled":
    case "failed":
    case "rejected":
      return "canceled";
    case "archived":
      return "archived";
  }
};
