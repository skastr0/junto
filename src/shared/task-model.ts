import type { NodeId } from "./model/base";
import type { RefusalReason } from "./resource-command";
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
 * Who writes, as the ruler hands it to the task domain. Reach (01) is checked
 * by the ruler before the domain rules (`resource-command.ts`), except where
 * `reachExempt` says the assignment admits the command instead (01 rule 6).
 */
export type TaskActor =
  | { readonly kind: "operator" }
  | { readonly kind: "seat"; readonly seat: SeatNodeId }
  | { readonly kind: "automation"; readonly automation: NodeId };

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

/** Why a command was refused, in task terms. Travels under a `RefusalReason`. */
export type TaskRefusalDetail =
  | { readonly kind: "illegal-transition"; readonly from: TaskState; readonly command: TaskCommandKind }
  | { readonly kind: "not-assignee"; readonly assignee?: SeatNodeId }
  | { readonly kind: "already-assigned"; readonly assignee: SeatNodeId }
  | { readonly kind: "seat-busy"; readonly seat: SeatNodeId; readonly taskId: TaskId }
  | { readonly kind: "not-reviewer"; readonly reviewer: Reviewer }
  | { readonly kind: "own-task"; readonly seat: SeatNodeId }
  | { readonly kind: "stale-epoch"; readonly expected: number }
  | { readonly kind: "next-required"; readonly choices: ReadonlyArray<TaskNodeId> }
  | { readonly kind: "next-not-downstream"; readonly next: TaskNodeId; readonly choices: ReadonlyArray<TaskNodeId> }
  | { readonly kind: "invalid-policy"; readonly required: number }
  | { readonly kind: "dependency-cycle"; readonly through: ReadonlyArray<TaskId> }
  | { readonly kind: "unknown-task"; readonly taskId: TaskId }
  | { readonly kind: "task-exists"; readonly taskId: TaskId };

export type TaskRefusalKind = TaskRefusalDetail["kind"];

/**
 * The one closed wire reason each task refusal travels as
 * (`RefusalReason`, `resource-command.ts`), so tasks add no reason of their
 * own. Exhaustive by type.
 */
export const TASK_REFUSAL_REASON = {
  "illegal-transition": "invalid_transition",
  "not-assignee": "invalid_transition",
  "already-assigned": "already_held",
  "seat-busy": "already_held",
  "not-reviewer": "invalid_input",
  "own-task": "reviewer_is_author",
  "stale-epoch": "stale",
  "next-required": "invalid_input",
  "next-not-downstream": "invalid_input",
  "invalid-policy": "invalid_input",
  "dependency-cycle": "invalid_input",
  "unknown-task": "unknown_target",
  "task-exists": "invalid_input",
} as const satisfies Readonly<Record<TaskRefusalKind, RefusalReason>>;

export type TaskRefusal = { readonly reason: RefusalReason; readonly detail: TaskRefusalDetail };

export const taskRefusal = (detail: TaskRefusalDetail): TaskRefusal => ({
  reason: TASK_REFUSAL_REASON[detail.kind],
  detail,
});

/**
 * The assignee's own transitions on its open task are admitted by the
 * assignment, not by reach, so a seat moved away from its task is never stuck
 * holding it (01 rule 6). Everything else needs reach.
 */
export const reachExempt = (task: Pick<TaskCore, "state" | "assignee">, actor: TaskActor, command: TaskCommand): boolean =>
  ASSIGNEE_ONLY[command.kind] && actor.kind === "seat" && actor.seat === task.assignee && isOpenTaskState(task.state);

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
