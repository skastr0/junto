/**
 * What the Tasks UI offers on the 0.10 model (plan 04). No rule lives here:
 * every offer is asked of canvas's ruler (`ruleTaskCommand`), so the UI can
 * only offer what the editing machine would admit. Pure: no I/O.
 *
 * The operator is not a seat, so the ruler gives it assign, unassign, cancel,
 * archive, the reviewer list and the stamp count; start, pause, resume and
 * finish are the assignee's, and stamps are a reviewing seat's.
 */
import {
  currentStamps,
  ruleTaskCommand,
  seatNodeId,
  type SeatNodeId,
  type Stamp,
  type TaskActor,
  type TaskCommand,
  type TaskContext,
  type TaskCore,
  type TaskRefusal,
  type TaskState,
} from "@shared/task-machine";

/** A task as the board draws it: the machine's core plus what people read. */
export type TaskView = {
  readonly id: string;
  /** `#42`, per canvas, minted by the editing machine. */
  readonly number: number;
  readonly title: string;
  readonly core: TaskCore;
  /** Layers closed earlier, oldest first; the current one is `core`. */
  readonly layers: ReadonlyArray<TaskCore>;
};

export const taskNumberLabel = (task: Pick<TaskView, "number">): string => `#${task.number}`;

/** The transition verbs drawn as buttons, in drawing order. */
export const TASK_VERBS = [
  "assign",
  "start",
  "resume",
  "pause",
  "finish",
  "unassign",
  "cancel",
  "archive",
] as const;
export type TaskVerb = (typeof TASK_VERBS)[number];

const PROBE_SEAT = seatNodeId("probe-seat");

/** Closed by the type: a verb that is not a command kind fails tsc. */
const probe = (verb: TaskVerb): TaskCommand =>
  verb === "assign" ? { kind: "assign", seat: PROBE_SEAT } : { kind: verb };

/**
 * Verbs the actor can use on this task now, in drawing order. A refusal that
 * only waits on a choice the user has not made (which node to send on to)
 * still counts as an offer.
 */
export const offeredVerbs = (
  task: TaskCore,
  actor: TaskActor,
  ctx: TaskContext,
): ReadonlyArray<TaskVerb> =>
  TASK_VERBS.filter((verb) => {
    const ruling = ruleTaskCommand(task, actor, probe(verb), {
      ...ctx,
      openTaskOf: () => undefined,
    });
    return ruling.ok || ruling.refusal.reason === "next-required";
  });

export type SeatChoice = { readonly node: SeatNodeId; readonly name: string };

export type AssignChoice = SeatChoice & {
  /** The ruler's reason this seat cannot take the task now. */
  readonly refusal?: TaskRefusal;
};

/** Each seat in reach with the ruler's answer to assigning it this task. */
export const assignChoices = (
  task: TaskCore,
  actor: TaskActor,
  ctx: TaskContext,
  seats: ReadonlyArray<SeatChoice>,
): ReadonlyArray<AssignChoice> =>
  seats.map((seat) => {
    const ruling = ruleTaskCommand(task, actor, { kind: "assign", seat: seat.node }, ctx);
    return ruling.ok ? seat : { ...seat, refusal: ruling.refusal };
  });

/** Seats that can still be added as reviewers (the ruler refuses the assignee). */
export const reviewerChoices = (
  task: TaskCore,
  actor: TaskActor,
  ctx: TaskContext,
  seats: ReadonlyArray<SeatChoice>,
): ReadonlyArray<SeatChoice> =>
  seats.filter(
    (seat) =>
      !task.reviewers.includes(seat.node) &&
      ruleTaskCommand(task, actor, { kind: "reviewer-add", seat: seat.node }, ctx).ok,
  );

/** A reviewer's stamp at the current epoch, if any. */
export const stampOf = (task: TaskCore, reviewer: SeatNodeId): Stamp | undefined =>
  currentStamps(task).find((stamp) => stamp.reviewer === reviewer);

export const stateLabel = (state: TaskState): string => {
  switch (state) {
    case "backlog":
      return "Backlog";
    case "assigned":
      return "Assigned";
    case "working":
      return "Working";
    case "input-required":
      return "Paused";
    case "in-review":
      return "In review";
    case "done":
      return "Done";
    case "canceled":
      return "Canceled";
    case "archived":
      return "Archived";
  }
};

export const verbLabel = (verb: TaskVerb): string => {
  switch (verb) {
    case "assign":
      return "Assign";
    case "start":
      return "Start";
    case "resume":
      return "Resume";
    case "pause":
      return "Pause";
    case "finish":
      return "Finish";
    case "unassign":
      return "Unassign";
    case "cancel":
      return "Cancel";
    case "archive":
      return "Archive";
  }
};

/** Plain words for a refusal the UI shows. Exhaustive over the ruler's reasons. */
export const refusalText = (
  refusal: TaskRefusal,
  nameOf: (seat: SeatNodeId) => string,
  numberOf: (taskId: string) => string | undefined,
): string => {
  switch (refusal.reason) {
    case "illegal-transition":
      return `A ${stateLabel(refusal.from).toLowerCase()} task cannot ${refusal.command}.`;
    case "out-of-reach":
      return "Out of reach of this task.";
    case "not-assignee":
      return refusal.assignee
        ? `Only ${nameOf(refusal.assignee)} can do that.`
        : "Only the assignee can do that.";
    case "already-assigned":
      return `Already assigned to ${nameOf(refusal.assignee)}.`;
    case "seat-busy":
      return `${nameOf(refusal.seat)} holds ${numberOf(refusal.taskId) ?? "another task"}.`;
    case "not-reviewer":
      return `${nameOf(refusal.seat)} is not a reviewer.`;
    case "own-task":
      return `${nameOf(refusal.seat)} cannot review its own task.`;
    case "operator-cannot-stamp":
      return "Stamps come from reviewing seats.";
    case "next-required":
      return "Name the next node.";
    case "next-not-downstream":
      return "That node is not downstream.";
    case "invalid-policy":
      return "Approvals required must be zero or more.";
  }
};
