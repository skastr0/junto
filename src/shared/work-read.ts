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
