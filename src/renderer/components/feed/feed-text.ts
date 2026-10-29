/**
 * A feed card's sentence, cut into its words and the tasks it names (0.11.4,
 * task 378). A seat writing "#42" is how work is named everywhere else in
 * Junto, so the feed reads the same number: where the canvas has that task,
 * the words around it stay words and the number becomes a chip that opens it.
 * A number the canvas does not hold stays a word, so nothing is ever invented.
 *
 * Pure, and given the tasks by its caller: the feed passes the canvas's own,
 * the kit and the tour pass none and every piece stays words.
 */

/** What a named task is, for the chip: its board, the task, and its title. */
export type FeedTaskRef = {
  readonly nodeId: string;
  readonly taskId: string;
  readonly title: string;
};

export type FeedTextPiece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "task"; readonly number: number; readonly task: FeedTaskRef };

/** `#42`, at the start of the sentence or after a space or punctuation, never inside a word or a link. */
const TASK_NUMBER = /(^|[^\w#/])#(\d{1,9})(?![\w])/gu;

export const feedTextPieces = (
  text: string,
  taskByNumber: ReadonlyMap<number, FeedTaskRef> | undefined,
): ReadonlyArray<FeedTextPiece> => {
  if (taskByNumber === undefined || taskByNumber.size === 0) return text === "" ? [] : [{ kind: "text", text }];
  const pieces: FeedTextPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(TASK_NUMBER)) {
    const task = taskByNumber.get(Number(match[2]));
    if (task === undefined) continue;
    const start = match.index + match[1]!.length;
    if (start > at) pieces.push({ kind: "text", text: text.slice(at, start) });
    pieces.push({ kind: "task", number: Number(match[2]), task });
    at = match.index + match[0].length;
  }
  if (at < text.length) pieces.push({ kind: "text", text: text.slice(at) });
  return pieces;
};

/**
 * The canvas's tasks by the number their seats write. A number is the task's
 * own on its canvas, so the only repeat is a create still waiting for its
 * ruling, and the first one read stands.
 */
export const feedTasksByNumber = (
  tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly number?: number | undefined;
    readonly title: string;
    readonly current: { readonly node: string };
  }>,
): ReadonlyMap<number, FeedTaskRef> => {
  const out = new Map<number, FeedTaskRef>();
  for (const task of tasks) {
    if (task.number === undefined || out.has(task.number)) continue;
    out.set(task.number, { nodeId: task.current.node, taskId: task.taskId, title: task.title });
  }
  return out;
};
