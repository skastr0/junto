/**
 * The Tasks node's pure parts: which rows the sidebar shows and in what
 * order, the context the ruler is asked in, and how a number, an owner and a
 * layer read.
 */
import { ageLabel } from "../artifacts/artifacts-pane-model";
import type { TaskPendingWrite } from "@shared/resource-ipc";
import type { TaskContext } from "@shared/task-machine";
import {
  formatTaskNumber,
  isOpenTaskState,
  type ClosedTaskLayer,
  type SeatNodeId,
  type StampPolicy,
  type TaskNodeId,
  type TaskCommandWire,
  type TaskId,
  type TaskState,
  type TaskView,
} from "@shared/task-model";

export type StateFilter = "open" | "backlog" | "closed" | "all";

export interface TaskFilter {
  readonly state: StateFilter;
  readonly query: string;
}

/**
 * The order the sidebar lists states in: open work first, as a seat meets it,
 * then the backlog, then what is over. A list order, not an urgency.
 */
const LIST_ORDER = [
  "working",
  "input-required",
  "in-review",
  "assigned",
  "backlog",
  "done",
  "canceled",
  "archived",
] as const satisfies ReadonlyArray<TaskState>;

const listPosition = (state: TaskState): number => LIST_ORDER.indexOf(state);

const matchesState = (state: TaskState, filter: StateFilter): boolean => {
  switch (filter) {
    case "all":
      return state !== "archived";
    case "open":
      return isOpenTaskState(state);
    case "backlog":
      return state === "backlog";
    case "closed":
      return state === "done" || state === "canceled";
  }
};

/** The rows the sidebar lists: by state group, by a case-blind match on number or title, open work first. */
export const visibleTasks = (
  views: ReadonlyArray<TaskView>,
  filter: TaskFilter,
): ReadonlyArray<TaskView> => {
  const query = filter.query.trim().toLowerCase();
  return views
    .filter(
      (view) =>
        matchesState(view.current.state, filter.state) &&
        (query.length === 0 ||
          view.title.toLowerCase().includes(query) ||
          numberLabel(view).toLowerCase().includes(query.replace(/^#?/, "#"))),
    )
    .sort(
      (a, b) =>
        listPosition(a.current.state) - listPosition(b.current.state) ||
        (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER),
    );
};

/**
 * The sidebar rows with the open detail among them. The detail stays on what
 * you acted on while it is on this node, so a task the filter now hides (you
 * cancelled it) is still listed, first, and list and detail never disagree.
 */
export const listedTasks = (
  visible: ReadonlyArray<TaskView>,
  selected: TaskView | null,
): ReadonlyArray<TaskView> =>
  selected === null || visible.some((view) => view.taskId === selected.taskId)
    ? visible
    : [selected, ...visible];

/** `#42`, or `queued` while the create waits for its ruling and has no number yet. */
export const numberLabel = (view: Pick<TaskView, "number">): string =>
  view.number === undefined ? "queued" : formatTaskNumber(view.number);

export const openCount = (views: ReadonlyArray<TaskView>): number =>
  views.filter((view) => isOpenTaskState(view.current.state)).length;

/** The task a seat holds anywhere on the canvas, if any (invariant 2). */
export const openTaskOfSeat = (
  views: ReadonlyArray<TaskView>,
  seat: SeatNodeId,
): TaskView | undefined =>
  views.find((view) => view.current.assignee === seat && isOpenTaskState(view.current.state));

/** What the canvas tells the ruler besides the tasks. */
export type TaskCanvasFacts = {
  readonly downstream: (node: TaskNodeId) => ReadonlyArray<TaskNodeId>;
  readonly stampDefaultOf: (node: TaskNodeId) => StampPolicy;
  readonly seatReaches: (seat: SeatNodeId, node: TaskNodeId) => boolean;
};

/** The context the ruler is asked in for one task: the same one it rules the write in. */
export const taskContextFor = (
  view: TaskView,
  all: ReadonlyArray<TaskView>,
  facts: TaskCanvasFacts,
  at: number,
): TaskContext => ({
  taskId: view.taskId,
  at,
  openTaskOf: (seat) => openTaskOfSeat(all, seat)?.taskId,
  downstream: facts.downstream(view.current.node),
  stampDefaultOf: facts.stampDefaultOf,
  seatReaches: (seat) => facts.seatReaches(seat, view.current.node),
});

/** `#42` for a task id among the canvas's tasks, to say which task keeps a seat busy. */
export const numberOfTask = (
  all: ReadonlyArray<TaskView>,
  taskId: string,
): string | undefined => {
  const view = all.find((candidate) => candidate.taskId === taskId);
  return view === undefined ? undefined : numberLabel(view);
};

export type LayerSummary = {
  readonly node: TaskNodeId;
  readonly assignee: SeatNodeId | undefined;
  readonly approvals: number;
  readonly required: number;
  readonly closedAt: number;
};

/** One closed layer, as the onion timeline lists it. */
export const layerSummary = (layer: ClosedTaskLayer): LayerSummary => ({
  node: layer.node,
  assignee: layer.assignee,
  approvals: layer.stamps.filter(
    (stamp) => stamp.verdict === "approve" && stamp.epoch === layer.epoch,
  ).length,
  required: layer.stampPolicy.required,
  closedAt: layer.closedAt,
});

/** How long ago, said as a phrase: "just now", "5m ago", "3d ago", or "on Oct 3" past a week. */
export const agoLabel = (at: number, now: number): string => {
  const label = ageLabel(at, now);
  if (label === "now") return "just now";
  return /^\d+[mhd]$/.test(label) ? `${label} ago` : `on ${label}`;
};

/** A write this machine has queued, said as the act it will be when ruled. Exhaustive over the wire. */
export const queuedWords = (command: TaskCommandWire, nameOf: (id: string) => string): string => {
  switch (command.kind) {
    case "create":
      return `Create "${command.title}"`;
    case "edit":
      return "Edit title or details";
    case "assign":
      return `Assign to ${nameOf(command.seat)}`;
    case "unassign":
      return "Unassign";
    case "start":
      return "Start";
    case "pause":
      return "Pause";
    case "resume":
      return "Resume";
    case "finish":
      return command.next === undefined ? "Finish" : `Finish, send on to ${nameOf(command.next)}`;
    case "check":
      return `Report ${command.results.length} check ${command.results.length === 1 ? "run" : "runs"}`;
    case "cancel":
      return "Cancel";
    case "archive":
      return "Archive";
    case "depend":
      return "Add a dependency";
    case "undepend":
      return "Remove a dependency";
    case "reviewer-add":
      return `Add reviewer ${command.reviewer.kind === "operator" ? "you" : nameOf(command.reviewer.seat)}`;
    case "reviewer-remove":
      return `Remove reviewer ${command.reviewer.kind === "operator" ? "you" : nameOf(command.reviewer.seat)}`;
    case "stamp-policy":
      return `Require ${command.required} ${command.required === 1 ? "approval" : "approvals"}`;
    case "stamp":
      return command.verdict === "approve" ? "Approve" : "Ask for changes";
  }
};

/** The queued writes of each task, in queue order. */
export const pendingByTask = (writes: ReadonlyArray<TaskPendingWrite>): ReadonlyMap<TaskId, ReadonlyArray<TaskPendingWrite>> => {
  const by = new Map<TaskId, TaskPendingWrite[]>();
  for (const write of writes) by.set(write.taskId, [...(by.get(write.taskId) ?? []), write]);
  return by;
};

export type QueuedCreate = { readonly taskId: TaskId; readonly title: string };

/** Tasks whose create is queued and which the list does not hold yet: shown, dashed, where they will land. */
export const queuedCreates = (
  tasks: ReadonlyArray<TaskView>,
  writes: ReadonlyArray<TaskPendingWrite>,
): ReadonlyArray<QueuedCreate> =>
  writes.flatMap((write) =>
    write.command.kind === "create" && !tasks.some((view) => view.taskId === write.taskId)
      ? [{ taskId: write.taskId, title: write.command.title }]
      : [],
  );

export type TasksGlance = {
  /** Assigned, working or in review: held by a seat and moving. */
  readonly open: number;
  /** Paused for input: held by a seat that waits on someone. */
  readonly needsInput: number;
  readonly done: number;
  /** The rows the card lists: what is held first, else what waits in the backlog. At most `limit`. */
  readonly rows: ReadonlyArray<TaskView>;
};

/** What the Tasks node's card on the canvas shows: counts and the few tasks that matter now. */
export const tasksGlance = (views: ReadonlyArray<TaskView>, limit = 4): TasksGlance => {
  const count = (states: ReadonlyArray<TaskState>): number =>
    views.filter((view) => states.includes(view.current.state)).length;
  const held = visibleTasks(views, { state: "open", query: "" });
  return {
    open: count(["assigned", "working", "in-review"]),
    needsInput: count(["input-required"]),
    done: count(["done"]),
    rows: (held.length > 0 ? held : visibleTasks(views, { state: "backlog", query: "" })).slice(0, limit),
  };
};
