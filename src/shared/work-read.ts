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
