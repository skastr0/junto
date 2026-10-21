/**
 * Stand-in for canvas's 0.10 task contract (`src/shared/task.ts`, plan 04).
 * The Tasks UI builds against this file only; when the real contract lands
 * the imports switch over and this file goes. Pure: no I/O.
 *
 * The shape makes misuse fail tsc: a state carries exactly the fields it can
 * have (a `backlog` task has no assignee; every other open state has one),
 * every verb is a closed union, and `taskVerbs` / `nextPhase` match
 * exhaustively.
 */

declare const nodeIdBrand: unique symbol;
declare const taskIdBrand: unique symbol;

/** A canvas node id (seat, tasks node). */
export type NodeId = string & { readonly [nodeIdBrand]: true };
/** The opaque task key. The number below is only for people. */
export type TaskId = string & { readonly [taskIdBrand]: true };

export const nodeId = (value: string): NodeId => value as NodeId;
export const taskId = (value: string): TaskId => value as TaskId;

/** Plan 04 "States". `failed`, `rejected`, `auth-required` are gone. */
export type TaskPhase =
  | "backlog"
  | "assigned"
  | "working"
  | "input-required"
  | "in-review"
  | "done"
  | "canceled"
  | "archived";

export const TASK_PHASES = [
  "backlog",
  "assigned",
  "working",
  "input-required",
  "in-review",
  "done",
  "canceled",
  "archived",
] as const satisfies ReadonlyArray<TaskPhase>;

/** States where the assignee holds the seat's one open task. */
export type OpenAssignedPhase =
  | "assigned"
  | "working"
  | "input-required"
  | "in-review";

export type StampVerdict = "approve" | "changes";

export type Stamp = {
  readonly reviewer: NodeId;
  readonly verdict: StampVerdict;
  readonly epoch: number;
  readonly subjectHash?: string;
  readonly text?: string;
  readonly at: number;
};

/** `required` approvals at the current epoch finish the review. 0 is none. */
export type StampPolicy = { readonly required: number };

/** One layer per node the task passed through (plan 04 "Pipelines and layers"). */
export type TaskLayer = {
  readonly node: NodeId;
  readonly assignee?: NodeId;
  readonly stamps: ReadonlyArray<Stamp>;
  readonly handoffNote?: string;
  /** The layer the task is on now has no `closedAt`. */
  readonly closedAt?: number;
};

type TaskBase = {
  readonly id: TaskId;
  /** `#42`, per canvas, minted by the editing machine. */
  readonly number: number;
  readonly title: string;
  readonly epoch: number;
  readonly policy: StampPolicy;
  readonly reviewers: ReadonlyArray<NodeId>;
  readonly stamps: ReadonlyArray<Stamp>;
  readonly layers: ReadonlyArray<TaskLayer>;
};

export type UnassignedTask = TaskBase & {
  readonly phase: "backlog" | "archived";
  readonly assignee?: undefined;
};

export type AssignedTask = TaskBase & {
  readonly phase: OpenAssignedPhase;
  readonly assignee: NodeId;
};

/** `done` and `canceled` keep the last assignee as a record. */
export type SettledTask = TaskBase & {
  readonly phase: "done" | "canceled";
  readonly assignee?: NodeId;
};

export type TaskRecord = UnassignedTask | AssignedTask | SettledTask;

export const isOpenAssigned = (task: TaskRecord): task is AssignedTask =>
  task.phase === "assigned" ||
  task.phase === "working" ||
  task.phase === "input-required" ||
  task.phase === "in-review";

// ---- Verbs -----------------------------------------------------------------

/** The `junto task` transition verbs the UI offers. */
export type TaskVerb =
  | "assign"
  | "unassign"
  | "start"
  | "pause"
  | "resume"
  | "finish"
  | "cancel";

export const TASK_VERBS = [
  "assign",
  "unassign",
  "start",
  "pause",
  "resume",
  "finish",
  "cancel",
] as const satisfies ReadonlyArray<TaskVerb>;

/** Who is looking: the operator, or a seat. */
export type Viewer =
  | { readonly kind: "operator" }
  | { readonly kind: "seat"; readonly node: NodeId };

const isAssignee = (task: TaskRecord, viewer: Viewer): boolean =>
  viewer.kind === "seat" && task.assignee === viewer.node;

/**
 * Invariant 3: only the assignee transitions its task; anyone in reach may
 * assign an unassigned task, unassign and cancel.
 */
export const taskVerbs = (
  task: TaskRecord,
  viewer: Viewer,
): ReadonlyArray<TaskVerb> => {
  const own = isAssignee(task, viewer);
  switch (task.phase) {
    case "backlog":
      return ["assign", "cancel"];
    case "assigned":
      return own
        ? ["start", "unassign", "cancel"]
        : ["unassign", "cancel"];
    case "working":
      return own
        ? ["pause", "finish", "unassign", "cancel"]
        : ["unassign", "cancel"];
    case "input-required":
      return own
        ? ["resume", "unassign", "cancel"]
        : ["unassign", "cancel"];
    case "in-review":
      return ["unassign", "cancel"];
    case "done":
    case "canceled":
    case "archived":
      return [];
    default:
      return assertNever(task.phase);
  }
};

export const phaseAfter = (
  task: TaskRecord,
  verb: TaskVerb,
  finishOutcome: FinishOutcome = finishOutcomeOf(task),
): TaskPhase => {
  switch (verb) {
    case "assign":
      return "assigned";
    case "unassign":
      return "backlog";
    case "start":
    case "resume":
      return "working";
    case "pause":
      return "input-required";
    case "finish":
      return finishOutcome === "review" ? "in-review" : "done";
    case "cancel":
      return "canceled";
    default:
      return assertNever(verb);
  }
};

export type FinishOutcome = "review" | "complete";

/** Finish goes to review when stamps are required, else straight to done. */
export const finishOutcomeOf = (task: TaskRecord): FinishOutcome =>
  task.policy.required > 0 ? "review" : "complete";

// ---- The one open task invariant -------------------------------------------

/** Invariant 2: a seat assigns to at most one open task across the canvas. */
export type AssignRefusal =
  | { readonly kind: "not-in-backlog" }
  | { readonly kind: "seat-busy"; readonly holding: TaskRecord };

export const assignRefusal = (
  task: TaskRecord,
  seat: NodeId,
  all: ReadonlyArray<TaskRecord>,
): AssignRefusal | undefined => {
  if (task.phase !== "backlog") return { kind: "not-in-backlog" };
  const holding = all.find(
    (other) => other.id !== task.id && isOpenAssigned(other) && other.assignee === seat,
  );
  return holding ? { kind: "seat-busy", holding } : undefined;
};

// ---- Stamps ----------------------------------------------------------------

export type StampTally = {
  readonly approvals: number;
  readonly changes: number;
  readonly required: number;
  readonly met: boolean;
};

/** Only stamps at the task's current epoch count. */
export const currentStamps = (task: TaskRecord): ReadonlyArray<Stamp> =>
  task.stamps.filter((stamp) => stamp.epoch === task.epoch);

export const stampTally = (task: TaskRecord): StampTally => {
  const current = currentStamps(task);
  const approvals = current.filter((s) => s.verdict === "approve").length;
  return {
    approvals,
    changes: current.filter((s) => s.verdict === "changes").length,
    required: task.policy.required,
    met: approvals >= task.policy.required,
  };
};

export type StampRefusal =
  | { readonly kind: "not-in-review" }
  | { readonly kind: "own-task" }
  | { readonly kind: "not-a-reviewer" }
  | { readonly kind: "already-stamped" };

/** The assignee cannot stamp its own task; one current stamp per reviewer. */
export const stampRefusal = (
  task: TaskRecord,
  reviewer: NodeId,
): StampRefusal | undefined => {
  if (task.phase !== "in-review") return { kind: "not-in-review" };
  if (task.assignee === reviewer) return { kind: "own-task" };
  if (!task.reviewers.includes(reviewer)) return { kind: "not-a-reviewer" };
  if (currentStamps(task).some((s) => s.reviewer === reviewer)) {
    return { kind: "already-stamped" };
  }
  return undefined;
};

/** Reviewers who owe a stamp now (the finish mails one request to each). */
export const reviewersOwing = (task: TaskRecord): ReadonlyArray<NodeId> => {
  const stamped = new Set(currentStamps(task).map((s) => s.reviewer));
  return task.reviewers.filter(
    (reviewer) => reviewer !== task.assignee && !stamped.has(reviewer),
  );
};

/** Seats that may be added as reviewers: not the assignee, not already one. */
export const reviewerCandidates = (
  task: TaskRecord,
  seatsInReach: ReadonlyArray<NodeId>,
): ReadonlyArray<NodeId> =>
  seatsInReach.filter(
    (seat) => seat !== task.assignee && !task.reviewers.includes(seat),
  );

// ---- Display ---------------------------------------------------------------

export const taskNumberLabel = (task: Pick<TaskBase, "number">): string =>
  `#${task.number}`;

export const phaseLabel = (phase: TaskPhase): string => {
  switch (phase) {
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
    default:
      return assertNever(phase);
  }
};

export const verbLabel = (verb: TaskVerb): string => {
  switch (verb) {
    case "assign":
      return "Assign";
    case "unassign":
      return "Unassign";
    case "start":
      return "Start";
    case "pause":
      return "Pause";
    case "resume":
      return "Resume";
    case "finish":
      return "Finish";
    case "cancel":
      return "Cancel";
    default:
      return assertNever(verb);
  }
};

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
