/**
 * The tasks each seat holds, as one pure index over task views (plan 0.10/04).
 * Main (the kernel's execution graph) and the renderer (seat cards, terminals)
 * read the same one, so what a card paints and what the graph derives never
 * drift. A seat may hold any number of open tasks, and the assignee is the
 * seat's node id, so there is no join to make.
 */
import {
  blocksAssignee,
  formatTaskNumber,
  isOpenTaskState,
  type OpenTaskState,
  type TaskId,
  type TaskNodeId,
  type TaskView,
} from "./task-model";

/** One open task a seat holds, as a seat card paints it. */
export type HeldTask = {
  readonly taskId: TaskId;
  /** `#42`, or `queued` while the create waits for its number. */
  readonly label: string;
  readonly title: string;
  readonly state: OpenTaskState;
  readonly node: TaskNodeId;
  /** The seat waits on someone else: paused for input (`blocksAssignee`). */
  readonly blocked: boolean;
  /** Epoch ms when the current state began (`TaskView.stateSince`): how long the seat has been in it. */
  readonly since?: number;
};

/**
 * What a seat holds: its lead task's fields, and every open task it holds in
 * `tasks`, lead first. A blocked task leads, so `blocked` says whether any is.
 */
export type SeatTask = HeldTask & {
  readonly tasks: ReadonlyArray<HeldTask>;
};

const heldTaskOf = (view: TaskView, state: OpenTaskState): HeldTask => ({
  taskId: view.taskId,
  label: view.number === undefined ? "queued" : formatTaskNumber(view.number),
  title: view.title,
  state,
  node: view.current.node,
  blocked: blocksAssignee(state),
  since: view.stateSince,
});

/** Blocked first, then the latest to change state, then by id: the same order whatever order the views come in. */
const leadFirst = (a: HeldTask, b: HeldTask): number =>
  Number(b.blocked) - Number(a.blocked) || (b.since ?? 0) - (a.since ?? 0) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);

/** Every open task of each assignee, by seat node id. */
export const buildSeatTaskIndex = (views: ReadonlyArray<TaskView>): Record<string, SeatTask> => {
  const held = new Map<string, HeldTask[]>();
  for (const view of views) {
    const { assignee, state } = view.current;
    if (assignee === undefined || !isOpenTaskState(state)) continue;
    const tasks = held.get(assignee);
    if (tasks === undefined) held.set(assignee, [heldTaskOf(view, state)]);
    else tasks.push(heldTaskOf(view, state));
  }
  const index: Record<string, SeatTask> = {};
  for (const [seat, tasks] of held) {
    tasks.sort(leadFirst);
    index[seat] = { ...tasks[0]!, tasks };
  }
  return index;
};
