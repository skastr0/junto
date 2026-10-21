import type { NodeId } from "./model/base";
import type { WorkErrorType } from "./work-control";
import { isItemId, isTaskNumber, type ItemId, type TaskNumber } from "./work-ids";

export type { TaskNumber } from "./work-ids";

// The 0.10 task model (docs/plans/0.10/04-tasks.md). This is the contract:
// types, closed unions and the few pure facts every layer shares. The state
// machine that rules a command lives in `task-machine.ts` and imports from
// here; the repository, the work-control ops, the CLI and the UI build on the
// same names. It replaces the task part of `work-model.ts` and `task.ts` when
// the old path is deleted.

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

// ── ids ────────────────────────────────────────────────────────────────────

/** A seat node: the one kind of node that is assigned, reviews and stamps. */
export type SeatNodeId = Branded<NodeId, "SeatNodeId">;
/** A task node: a list of tasks on the canvas. */
export type TaskNodeId = Branded<NodeId, "TaskNodeId">;
/**
 * One task: an `ItemId` minted by the caller (the CLI process) on create and
 * kept by the ruling (02). It never changes, across layers and machines. The
 * short number people say (`TaskNumber`, shown as `T-42`) is minted only by
 * the editing machine when it rules the create; a pending task has none.
 */
export type TaskId = ItemId;

/** Narrow a node id the caller has checked is a seat. */
export const seatNodeId = (id: NodeId): SeatNodeId => id as SeatNodeId;
/** Narrow a node id the caller has checked is a task node. */
export const taskNodeId = (id: NodeId): TaskNodeId => id as TaskNodeId;

/** A task id, or undefined when the text is not a ULID. */
export const parseTaskId = (text: string): TaskId | undefined => (isItemId(text) ? text : undefined);

/** A task number, or undefined when it is not a whole number from 1. */
export const taskNumber = (value: number): TaskNumber | undefined =>
  Number.isSafeInteger(value) && isTaskNumber(value) ? value : undefined;

export const formatTaskNumber = (value: TaskNumber): string => `T-${value}`;

/** `T-42` or `42`, as people type it. */
export const parseTaskNumber = (text: string): TaskNumber | undefined => {
  const match = /^(?:T-)?(\d{1,15})$/i.exec(text.trim());
  return match === null ? undefined : taskNumber(Number(match[1]));
};

// ── states ─────────────────────────────────────────────────────────────────

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

/** States a seat holds. At most one per seat across the canvas (invariant 2). */
export const OPEN_TASK_STATES = ["assigned", "working", "input-required", "in-review"] as const satisfies
  ReadonlyArray<TaskState>;
export type OpenTaskState = (typeof OPEN_TASK_STATES)[number];

/** No transition leaves these but archive (and none leaves archived). */
export const CLOSED_TASK_STATES = ["done", "canceled", "archived"] as const satisfies ReadonlyArray<TaskState>;
export type ClosedTaskState = (typeof CLOSED_TASK_STATES)[number];

export const isOpenTaskState = (state: TaskState): state is OpenTaskState =>
  (OPEN_TASK_STATES as ReadonlyArray<TaskState>).includes(state);
export const isClosedTaskState = (state: TaskState): state is ClosedTaskState =>
  (CLOSED_TASK_STATES as ReadonlyArray<TaskState>).includes(state);

/**
 * The seat is blocked: it holds this task and waits on someone else. Only
 * `input-required` blocks. `in-review` does not; the reviewers are mailed.
 */
export const blocksAssignee = (state: TaskState): boolean => state === "input-required";

// ── review ─────────────────────────────────────────────────────────────────

/** How many current approvals finishing needs. 0 means none. */
export type StampPolicy = { readonly required: number };

/** Who reviews: a seat in reach, or the operator, whose approval counts too. */
export type Reviewer =
  | { readonly kind: "seat"; readonly seat: SeatNodeId }
  | { readonly kind: "operator" };

export const reviewerKey = (reviewer: Reviewer): string =>
  reviewer.kind === "operator" ? "operator" : `seat:${reviewer.seat}`;

export type StampVerdict = "approve" | "changes";

export type Stamp = {
  readonly reviewer: Reviewer;
  readonly verdict: StampVerdict;
  /** An approval counts only at the task's current epoch. */
  readonly epoch: number;
  /** The existing review subject hash, when the work has commits. */
  readonly subjectHash?: string;
  readonly text?: string;
  readonly at: number;
};

// ── a task on its current layer ────────────────────────────────────────────

/**
 * What the state machine rules over: the task on the node it sits on now.
 * Sending on closes this layer (its assignee, reviewers and stamps stay on
 * it) and opens a new one in `backlog` on the next node.
 */
export type TaskCore = {
  readonly state: TaskState;
  readonly node: TaskNodeId;
  readonly assignee?: SeatNodeId;
  readonly epoch: number;
  readonly stampPolicy: StampPolicy;
  readonly reviewers: ReadonlyArray<Reviewer>;
  readonly stamps: ReadonlyArray<Stamp>;
  /** The node named at finish, held while the task is in review. */
  readonly next?: TaskNodeId;
};

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

/** The task ops of a `ResourceCommand` (02). Closed: add a case here first. */
export type TaskCommand =
  | {
    readonly kind: "create";
    readonly taskId: TaskId;
    readonly title: string;
    readonly body?: string;
    readonly stampPolicy?: StampPolicy;
  }
  | { readonly kind: "edit"; readonly title?: string; readonly body?: string }
  | { readonly kind: "assign"; readonly seat: SeatNodeId }
  | { readonly kind: "unassign" }
  | { readonly kind: "start" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "finish"; readonly next?: TaskNodeId }
  | { readonly kind: "cancel" }
  | { readonly kind: "archive" }
  | { readonly kind: "depend"; readonly on: TaskId }
  | { readonly kind: "undepend"; readonly on: TaskId }
  | { readonly kind: "reviewer-add"; readonly reviewer: Reviewer }
  | { readonly kind: "reviewer-remove"; readonly reviewer: Reviewer }
  | { readonly kind: "stamp-policy"; readonly required: number }
  | {
    readonly kind: "stamp";
    readonly verdict: StampVerdict;
    readonly subjectHash?: string;
    readonly text?: string;
  };

export type TaskCommandKind = TaskCommand["kind"];

/** Commands only the assignee writes (invariant 3). Exhaustive by type. */
export const ASSIGNEE_ONLY = {
  create: false,
  edit: false,
  assign: false,
  unassign: false,
  start: true,
  pause: true,
  resume: true,
  finish: true,
  cancel: false,
  archive: false,
  depend: false,
  undepend: false,
  "reviewer-add": false,
  "reviewer-remove": false,
  "stamp-policy": false,
  stamp: false,
} as const satisfies Readonly<Record<TaskCommandKind, boolean>>;

// ── outcome ────────────────────────────────────────────────────────────────

/**
 * What a ruling owes beyond the new task: mail and records. The actor's own
 * machine writes the mail when its cursor covers the applied ruling (02).
 */
export type TaskEffect =
  | { readonly kind: "number-minted"; readonly number: TaskNumber }
  | { readonly kind: "assignment-notice"; readonly seat: SeatNodeId }
  | { readonly kind: "stamp-request"; readonly reviewer: Reviewer }
  | { readonly kind: "defect"; readonly epoch: number; readonly by: Reviewer; readonly text?: string }
  | {
    readonly kind: "sent-on";
    readonly from: TaskNodeId;
    readonly to: TaskNodeId;
    /** The layer that closed, as it stood when it closed. */
    readonly layer: TaskCore;
  };

/**
 * Why a command was refused. `reason` is the wire's `details.reason`, so it
 * is snake_case like every reason (cli-lead).
 */
export type TaskRefusal =
  | { readonly reason: "illegal_transition"; readonly from: TaskState; readonly command: TaskCommandKind }
  | { readonly reason: "out_of_reach" }
  | { readonly reason: "not_assignee"; readonly assignee?: SeatNodeId }
  | { readonly reason: "already_assigned"; readonly assignee: SeatNodeId }
  | { readonly reason: "seat_busy"; readonly seat: SeatNodeId; readonly taskId: TaskId }
  | { readonly reason: "not_reviewer"; readonly reviewer: Reviewer }
  | { readonly reason: "own_task"; readonly seat: SeatNodeId }
  | { readonly reason: "stale_epoch"; readonly expected: number }
  | { readonly reason: "next_required"; readonly choices: ReadonlyArray<TaskNodeId> }
  | { readonly reason: "next_not_downstream"; readonly next: TaskNodeId; readonly choices: ReadonlyArray<TaskNodeId> }
  | { readonly reason: "invalid_policy"; readonly required: number }
  | { readonly reason: "dependency_cycle"; readonly through: ReadonlyArray<TaskId> }
  | { readonly reason: "unknown_task"; readonly taskId: TaskId }
  | { readonly reason: "task_exists"; readonly taskId: TaskId };

export type TaskRefusalReason = TaskRefusal["reason"];

/** The wire error each refusal travels as. Exhaustive by type. */
export const TASK_REFUSAL_ERROR = {
  illegal_transition: "InvalidTransition",
  out_of_reach: "ScopeError",
  not_assignee: "ScopeError",
  already_assigned: "ClaimConflict",
  seat_busy: "ClaimConflict",
  not_reviewer: "ScopeError",
  own_task: "ReviewerIsAuthor",
  stale_epoch: "Stale",
  next_required: "InputError",
  next_not_downstream: "InputError",
  invalid_policy: "InputError",
  dependency_cycle: "InputError",
  unknown_task: "UnknownTarget",
  task_exists: "InputError",
} as const satisfies Readonly<Record<TaskRefusalReason, WorkErrorType>>;

export type TaskRuling =
  | { readonly ok: true; readonly task: TaskCore; readonly effects: ReadonlyArray<TaskEffect> }
  | { readonly ok: false; readonly refusal: TaskRefusal };

// ── pipelines ──────────────────────────────────────────────────────────────

/** The one verb between task nodes, upstream to downstream (replaces `feeds`). */
export const TASK_FLOW_VERB = "flows" as const;

// ── stored rows before 0.10 ────────────────────────────────────────────────

/** Task states as rows stored before 0.10 hold them. */
export const LEGACY_TASK_STATES = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "auth-required",
  "archived",
] as const;
export type LegacyTaskState = (typeof LEGACY_TASK_STATES)[number];

/**
 * The 0.10 state of a stored row, for the task state remap migration.
 * submitted is backlog, or assigned when the row names an actor; completed is
 * done; rejected and failed are canceled; auth-required waits on someone, so
 * it is input-required.
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
