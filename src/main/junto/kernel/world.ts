import type { CanvasDoc } from "@shared/canvas";
import type { Canvas } from "@shared/model/canvas";
import { canvasFromDocument } from "@shared/model/from-document";
import type { Task } from "@shared/work-model";
import type { WatchRead, WorkRead } from "@shared/work-read";

// What the kernel holds of one canvas: what is on it and how it is joined,
// and beside it the work the kernel reads. A canvas holds no work.

export type KernelWork = {
  /** Every task board and requests node with rows, by node id, in lane order. */
  readonly tasks: ReadonlyMap<string, ReadonlyArray<Task>>;
  /** Topic and post counts of each board that has any. */
  readonly boards: ReadonlyMap<
    string,
    { readonly topics: number; readonly posts: number }
  >;
  /** How many artifacts each artifacts node holds. */
  readonly artifacts: ReadonlyMap<string, number>;
};

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

/**
 * The world a document describes, for the kernel while it is still handed
 * documents: the canvas from its nodes and edges, the work from what its
 * nodes carry.
 */
export const worldFromDocument = (name: string, doc: CanvasDoc): World => {
  const tasks = new Map<string, ReadonlyArray<Task>>();
  const boards = new Map<string, { readonly topics: number; readonly posts: number }>();
  const artifacts = new Map<string, number>();
  for (const node of doc.nodes) {
    const kind = node.ether?.entity?.kind;
    if (kind === "task" && !tasks.has(node.id)) {
      tasks.set(node.id, node.ether?.tasks?.items ?? NO_TASKS);
    } else if (kind === "requests" && !tasks.has(node.id)) {
      tasks.set(node.id, node.ether?.requests?.items ?? NO_TASKS);
    }
    const topics = node.ether?.board?.topics;
    if (topics !== undefined && !boards.has(node.id)) {
      boards.set(node.id, {
        topics: topics.length,
        posts: topics.reduce(
          (sum, topic) =>
            sum + (typeof topic.postCount === "number" ? topic.postCount : 0),
          0,
        ),
      });
    }
    const items = node.ether?.artifacts?.items;
    if (items !== undefined && !artifacts.has(node.id)) {
      artifacts.set(node.id, items.length);
    }
  }
  return {
    canvas: canvasFromDocument(name, doc),
    work: { tasks, boards, artifacts },
  };
};
