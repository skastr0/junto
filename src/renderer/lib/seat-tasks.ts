/**
 * The task each seat holds, canvas-wide, read once for every seat card and
 * terminal (plan 0.10/04). One subscription to the tasks source feeds one
 * observable; a card reads one key of it, so a write elsewhere on the canvas
 * does not wake every seat. A seat holds at most one open task (invariant 2),
 * and the assignee is the seat's node id, so there is no join to make.
 */
import { batch, observable, observe } from "@legendapp/state";
import { buildSeatTaskIndex, type SeatTask } from "@shared/seat-task-index";
import type { TaskView } from "@shared/task-model";
import { getJuntoApi } from "./junto-api";
import { state$ } from "./state";
import { installIpcTasksSource, tasksSource } from "./tasks-source";

export const seatTasks$ = observable<{ bySeat: Record<string, SeatTask | undefined> }>({ bySeat: {} });

/**
 * Every task of the open canvas but the archived, by the task node it sits
 * on, from the same read: what the operator feed's needs count.
 */
export const canvasTasks$ = observable<{ byNode: Record<string, ReadonlyArray<TaskView>> }>({ byNode: {} });

const publishCanvasTasks = (views: ReadonlyArray<TaskView>): void => {
  const byNode: Record<string, TaskView[]> = {};
  for (const view of views) {
    if (view.current.state === "archived") continue;
    (byNode[view.current.node] ??= []).push(view);
  }
  canvasTasks$.byNode.set(byNode);
};

export { buildSeatTaskIndex, type SeatTask };

/** Equal for what a card paints: nothing else reaches the DOM. */
const samePainted = (a: SeatTask | undefined, b: SeatTask | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.taskId === b.taskId &&
    a.label === b.label &&
    a.title === b.title &&
    a.state === b.state &&
    a.node === b.node &&
    a.blocked === b.blocked &&
    a.since === b.since);

/** Write only the keys whose painted projection moved. */
export const publishSeatTaskIndex = (next: Record<string, SeatTask>): void => {
  const previous = seatTasks$.bySeat.peek() as Record<string, SeatTask | undefined>;
  batch(() => {
    for (const [seat, task] of Object.entries(next)) {
      if (!samePainted(previous[seat], task)) seatTasks$.bySeat[seat].set(task);
    }
    for (const seat of Object.keys(previous)) {
      if (next[seat] === undefined && previous[seat] !== undefined) seatTasks$.bySeat[seat].delete();
    }
  });
};

let generation = 0;

/** Read every task of the canvas and publish who holds what. Newest read wins. */
export const refreshSeatTasks = async (canvasName: string): Promise<void> => {
  const mine = ++generation;
  if (canvasName === "") {
    batch(() => {
      publishSeatTaskIndex({});
      publishCanvasTasks([]);
    });
    return;
  }
  const views = await tasksSource().all(canvasName);
  if (mine !== generation) return;
  batch(() => {
    publishSeatTaskIndex(buildSeatTaskIndex(views));
    publishCanvasTasks(views);
  });
};

let stop: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;

export const startSeatTaskStore = (): (() => void) => {
  if (stop === undefined) {
    installIpcTasksSource(getJuntoApi()?.resource?.task);
    unsubscribe = tasksSource().subscribe(() => void refreshSeatTasks(state$.canvasName.peek()));
    stop = observe(() => {
      void refreshSeatTasks(state$.canvasName.get());
    });
  }
  return stopSeatTaskStore;
};

export const stopSeatTaskStore = (): void => {
  stop?.();
  stop = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
};
