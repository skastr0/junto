import type { Canvas } from "@shared/model/canvas";
import type { SeatTaskIndex } from "@shared/execution-graph";
import type { Task } from "@shared/work-model";
import type { KernelWork } from "@shared/work-kernel";
import type { WatchRead, WorkRead } from "@shared/work-read";

// What the kernel holds of one canvas: what is on it and how it is joined,
// and beside it the work the work service answers for it and the open task
// each seat holds (`readSeatTaskIndex`). A canvas holds no work.

export type World = {
  readonly canvas: Canvas;
  readonly work: KernelWork;
  readonly seatTasks: SeatTaskIndex;
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
