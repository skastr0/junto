import type { CanvasNode } from "./canvas";
import { workItemsFromDocument } from "./model/from-document";
import type { Task } from "./work-model";

// What shared rules ask of Work. A canvas holds no work, so a rule that needs
// a board's task rows is handed this beside the canvas.

export type WorkRead = {
  /** Every task row on this board, in board order. */
  readonly itemsOf: (board: string) => ReadonlyArray<Task>;
  /** This board's row of a task, when the task has one there. */
  readonly taskAt: (board: string, id: string) => Task | undefined;
};

/** The work a relay reads from the thing it watches. */
export type WatchRead = Pick<WorkRead, "itemsOf"> & {
  /** How many topics and posts a board holds; nothing when it holds none. */
  readonly board: (
    node: string,
  ) => { readonly topics: number; readonly posts: number } | undefined;
  /** How many artifacts an artifacts node holds. */
  readonly artifacts: (node: string) => number;
};

const held = new WeakMap<object, WorkRead>();

/**
 * The work a document carries, for a caller that still reads work out of the
 * document. Worked out once per document object.
 */
export const workReadFromDocument = (doc: {
  readonly nodes: ReadonlyArray<CanvasNode>;
}): WorkRead => {
  const known = held.get(doc);
  if (known !== undefined) return known;
  const itemsOf = workItemsFromDocument(doc);
  const made: WorkRead = {
    itemsOf,
    taskAt: (board, id) => itemsOf(board).find((item) => item.id === id),
  };
  held.set(doc, made);
  return made;
};

const heldWatch = new WeakMap<object, WatchRead>();

/** The same, for what a relay watches. Worked out once per document object. */
export const watchReadFromDocument = (doc: {
  readonly nodes: ReadonlyArray<CanvasNode>;
}): WatchRead => {
  const known = heldWatch.get(doc);
  if (known !== undefined) return known;
  const boards = new Map<string, { readonly topics: number; readonly posts: number }>();
  const artifacts = new Map<string, number>();
  for (const node of doc.nodes) {
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
  const made: WatchRead = {
    itemsOf: workItemsFromDocument(doc),
    board: (node) => boards.get(node),
    artifacts: (node) => artifacts.get(node) ?? 0,
  };
  heldWatch.set(doc, made);
  return made;
};
