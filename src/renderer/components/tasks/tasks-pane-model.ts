/**
 * The Tasks node's pure parts: which rows the sidebar shows and in what
 * order, the context the ruler is asked in, and how a number, an owner and a
 * layer read.
 */
import { stampOf } from "../../lib/task-ui";
import { compareView, RegionUrgency } from "@shared/wire/urgency";
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

// ---- The Tasks node on the canvas (docs/node-card-language.md, Spines) ----

/** What a task row on the canvas flags: a seat waits on someone, or the operator owes a stamp. */
export type RowFlag = "blocked" | "needs-you";

export type CardRow = {
  readonly taskId: TaskId;
  /** `#42`, or `queued` while the create waits. */
  readonly number: string;
  readonly title: string;
  readonly state: TaskState;
  readonly flag?: RowFlag;
};

/** The status tag of the node: its worst notable state, or none when idle. */
export type CardStatus = "blocked" | "needs-you" | undefined;

export type TasksCardBody = {
  /** Every task on the board but archived ones, backlog included: the number on the chip. */
  readonly count: number;
  /** The first line of the spine: `1 backlog, 0 open, 0 done`. */
  readonly meta: string;
  /** At most `limit` rows, flagged ones first, then held work, then the backlog. */
  readonly rows: ReadonlyArray<CardRow>;
  /** Rows beyond `limit`, for the `+N more` row. */
  readonly more: number;
  readonly status: CardStatus;
};

const OPERATOR = { kind: "operator" } as const;

const flagOf = (view: TaskView): RowFlag | undefined => {
  const { state, reviewers } = view.current;
  if (state === "input-required") return "blocked";
  if (state === "in-review" && reviewers.some((reviewer) => reviewer.kind === "operator") && stampOf(view.current, OPERATOR) === undefined) {
    return "needs-you";
  }
  return undefined;
};

/** Flagged rows most urgent first, in the region view's order from the one ladder. */
const flagOrder = (a: RowFlag, b: RowFlag): number =>
  compareView(RegionUrgency)(RegionUrgency.group[a], RegionUrgency.group[b]);

/** The card's body: counts, rows with their flags, and the status word, from the board's tasks alone. Pure. */
export const tasksCardBody = (views: ReadonlyArray<TaskView>, limit = 4): TasksCardBody => {
  const live = views.filter((view) => view.current.state !== "archived");
  const backlog = live.filter((view) => view.current.state === "backlog").length;
  const done = live.filter((view) => view.current.state === "done").length;
  const open = live.filter((view) => isOpenTaskState(view.current.state)).length;
  const listed = visibleTasks(
    live.filter((view) => view.current.state !== "done" && view.current.state !== "canceled"),
    { state: "all", query: "" },
  ).map((view): CardRow => {
    const flag = flagOf(view);
    return {
      taskId: view.taskId,
      number: numberLabel(view),
      title: view.title,
      state: view.current.state,
      ...(flag === undefined ? {} : { flag }),
    };
  });
  // Flagged rows first (a seat that waits, then a stamp owed), the rest in the list's own order.
  const ordered = [
    ...listed.filter((row) => row.flag !== undefined).sort((a, b) => flagOrder(a.flag!, b.flag!)),
    ...listed.filter((row) => row.flag === undefined),
  ];
  const flags = ordered.map((row) => row.flag);
  return {
    count: live.length,
    meta: `${backlog} backlog, ${open} open, ${done} done`,
    rows: ordered.slice(0, limit),
    more: Math.max(0, ordered.length - limit),
    status: flags.includes("blocked") ? "blocked" : flags.includes("needs-you") ? "needs-you" : undefined,
  };
};
