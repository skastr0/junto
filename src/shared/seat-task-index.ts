/**
 * The task each seat holds, as one pure index over task views (plan 0.10/04).
 * Main (the kernel's execution graph) and the renderer (seat cards, terminals)
 * read the same one, so what a card paints and what the graph derives never
 * drift. A seat holds at most one open task (invariant 2), and the assignee is
 * the seat's node id, so there is no join to make.
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

/** What a seat card paints for the task its seat holds. */
export type SeatTask = {
  readonly taskId: TaskId;
  /** `#42`, or `queued` while the create waits for its number. */
  readonly label: string;
  readonly title: string;
  readonly state: OpenTaskState;
  readonly node: TaskNodeId;
  /** The seat waits on someone else: paused for input (`blocksAssignee`). */
  readonly blocked: boolean;
  /** Epoch ms when the current state began. Absent until the task domain carries `stateSince`. */
  readonly since?: number;
};

/** The open task of each assignee, by seat node id. The first wins if a store ever holds two. */
export const buildSeatTaskIndex = (views: ReadonlyArray<TaskView>): Record<string, SeatTask> => {
  const index: Record<string, SeatTask> = {};
  for (const view of views) {
    const { assignee, state } = view.current;
    if (assignee === undefined || !isOpenTaskState(state) || index[assignee] !== undefined) continue;
    index[assignee] = {
      taskId: view.taskId,
      label: view.number === undefined ? "queued" : formatTaskNumber(view.number),
      title: view.title,
      state,
      node: view.current.node,
      blocked: blocksAssignee(state),
    };
  }
  return index;
};
