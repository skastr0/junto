import type { Canvas } from "@shared/model/canvas";
import type { Task } from "@shared/work-model";
import type { KernelWork } from "@shared/work-kernel";
import type { WatchRead, WorkRead } from "@shared/work-read";

// What the kernel holds of one canvas: what is on it and how it is joined,
// and beside it the work the work service answers for it. A canvas holds no
// work.

export type World = {
  readonly canvas: Canvas;
  readonly work: KernelWork;
};

const NO_TASKS: ReadonlyArray<Task> = [];
const heldReads = new WeakMap<KernelWork, WorkRead & WatchRead>();

/** The reads shared rules take, over the work the kernel holds. */
export const workOf = (world: World): WorkRead & WatchRead => {
  const known = heldReads.get(world.work);
  if (known !== undefined) return known;
  const { tasks, boards, artifacts } = world.work;
  const made: WorkRead & WatchRead = {
    itemsOf: (node) => tasks.get(node) ?? NO_TASKS,
    taskAt: (node, id) => tasks.get(node)?.find((task) => task.id === id),
    board: (node) => boards.get(node),
    artifacts: (node) => artifacts.get(node) ?? 0,
  };
  heldReads.set(world.work, made);
  return made;
};

/** The world with one board's row of a task put in place of the row it held. */
export const withTaskRow = (
  world: World,
  boardId: string,
  task: Task,
): World | undefined => {
  const rows = world.work.tasks.get(boardId);
  if (rows === undefined || !rows.some((row) => row.id === task.id)) {
    return undefined;
  }
  const tasks = new Map(world.work.tasks);
  tasks.set(
    boardId,
    rows.map((row) => (row.id === task.id ? task : row)),
  );
  return { canvas: world.canvas, work: { ...world.work, tasks } };
};
