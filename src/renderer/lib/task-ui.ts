/**
 * What the Tasks UI offers on the 0.10 model (plan 04). No rule lives here:
 * every offer is asked of canvas's ruler (`ruleTaskCommand`), so the UI can
 * only offer what the editing machine would admit. Pure: no I/O.
 *
 * The operator is not a seat. The ruler gives it assign, unassign, cancel,
 * archive, the reviewer list, the stamp count and, in review, its own stamp
 * (it reviews through the feed, listed or not). Start, pause, resume and
 * finish are the assignee's.
 */
import { asNodeId } from "@shared/model";
import type { StampSlot, StampTally as StampTallyData } from "./resource-visuals";
import {
  currentApprovals,
  currentStamps,
  ruleTaskCommand,
  type TaskContext,
} from "@shared/task-machine";
import {
  reviewerKey,
  seatNodeId,
  type Reviewer,
  type SeatNodeId,
  type Stamp,
  type StampVerdict,
  type TaskActor,
  type TaskCommand,
  type TaskCore,
  type TaskNodeId,
  type TaskRefusalDetail,
  type TaskState,
} from "@shared/task-model";

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

const PROBE_SEAT = seatNodeId(asNodeId("probe-seat"));

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
    return ruling.ok || ruling.refusal.detail.kind === "next-required";
  });

/** Where finishing can lead: the nodes the task's node flows into. More than one needs a choice. */
export const nextChoices = (ctx: TaskContext): ReadonlyArray<TaskNodeId> => ctx.downstream;

/** The stamps the actor may write on this task now. */
export const offeredStamps = (
  task: TaskCore,
  actor: TaskActor,
  ctx: TaskContext,
): ReadonlyArray<StampVerdict> =>
  (["approve", "changes"] as const).filter(
    (verdict) => ruleTaskCommand(task, actor, { kind: "stamp", verdict }, ctx).ok,
  );

export type SeatChoice = { readonly node: SeatNodeId; readonly name: string };

export type AssignChoice = SeatChoice & {
  /** The ruler's reason this seat cannot take the task now. */
  readonly refusal?: TaskRefusalDetail;
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
    return ruling.ok ? seat : { ...seat, refusal: ruling.refusal.detail };
  });

/** Seats that can still be added as reviewers (the ruler refuses the assignee and seats out of reach). */
export const reviewerChoices = (
  task: TaskCore,
  actor: TaskActor,
  ctx: TaskContext,
  seats: ReadonlyArray<SeatChoice>,
): ReadonlyArray<SeatChoice> => {
  const listed = new Set(task.reviewers.map(reviewerKey));
  return seats.filter(
    (seat) =>
      !listed.has(reviewerKey({ kind: "seat", seat: seat.node })) &&
      ruleTaskCommand(
        task,
        actor,
        { kind: "reviewer-add", reviewer: { kind: "seat", seat: seat.node } },
        ctx,
      ).ok,
  );
};

/** Whether the operator can still put itself on the reviewer list. */
export const operatorMayReview = (task: TaskCore, ctx: TaskContext): boolean =>
  !task.reviewers.some((reviewer) => reviewer.kind === "operator") &&
  ruleTaskCommand(
    task,
    { kind: "operator" },
    { kind: "reviewer-add", reviewer: { kind: "operator" } },
    ctx,
  ).ok;

/** A reviewer's stamp at the current epoch, if any. */
export const stampOf = (task: TaskCore, reviewer: Reviewer): Stamp | undefined =>
  currentStamps(task).find((stamp) => reviewerKey(stamp.reviewer) === reviewerKey(reviewer));

/**
 * The tally the ruler counts (`currentApprovals`): once per reviewer at the
 * current epoch, a seat's only while listed, the operator's always. Shaped
 * for the shared StampTally mark; earlier rounds draw as stale caps.
 */
export const reviewTally = (task: TaskCore): StampTallyData => {
  const required = task.stampPolicy.required;
  const approved = currentApprovals(task);
  const changes = currentStamps(task).filter((stamp) => stamp.verdict === "changes").length;
  const stale = task.stamps.filter((stamp) => stamp.epoch !== task.epoch).length;
  const waiting = Math.max(0, required - approved);
  const slots: StampSlot[] = [
    ...Array<StampSlot>(approved).fill("approved"),
    ...Array<StampSlot>(changes).fill("changes"),
    ...Array<StampSlot>(waiting).fill("waiting"),
    ...Array<StampSlot>(stale).fill("stale"),
  ];
  return { required, slots, approved, pending: 0, changes, stale, met: approved >= required };
};

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

/** What a component's command handler answers: nothing when ruled, or why it was refused. */
export type CommandOutcome = void | string | undefined | Promise<void | string | undefined>;
