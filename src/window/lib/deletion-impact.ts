import { flowDestinations } from "@shared/flow-graph";
import { asNodeId, type Canvas, type Node, type Wire } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { isClosedTaskState, type TaskView } from "@shared/task-model";
import { taskName } from "@shared/task-notices";
import type { AgentSignal } from "@shared/agent-signals";
import { signalsCloseLine } from "./canvas-delete";
import { tasksSource } from "./tasks-source";

const count = (value: number, singular: string, plural = `${singular}s`): string =>
  `${value} ${value === 1 ? singular : plural}`;

/** The open tasks on each task node, as a removal reads them. */
export type OpenTasksOf = (nodeId: string) => ReadonlyArray<TaskView>;

const NO_TASKS: ReadonlyArray<TaskView> = [];

/** Open tasks by the node each sits on now: closed ones lose nothing to a removal. */
export const openTasksOf = (views: ReadonlyArray<TaskView>): OpenTasksOf => {
  const byNode = new Map<string, TaskView[]>();
  for (const view of views) {
    if (isClosedTaskState(view.current.state)) continue;
    byNode.set(view.current.node, [...(byNode.get(view.current.node) ?? []), view]);
  }
  return (nodeId) => byNode.get(nodeId) ?? NO_TASKS;
};

/**
 * Only removing a task board, a task path or a seat needs the canvas's tasks, read
 * at the operator's gesture. A read that fails resolves undefined, so the
 * question is still asked and says the tasks are unknown.
 */
export const removalTasks = (
  canvasName: string,
  canvas: Pick<Canvas, "nodes">,
  removedNodeIds: ReadonlySet<string>,
  removedWires: ReadonlyArray<Wire>,
): OpenTasksOf | Promise<OpenTasksOf | undefined> =>
  [...removedNodeIds].some((id) => {
    const kind = canvas.nodes.get(asNodeId(id))?.kind;
    return kind === "task" || kind === "agent";
  }) ||
  removedWires.some((wire) => wire.verb === "flows")
    ? tasksSource().all(canvasName).then(openTasksOf, () => undefined)
    : openTasksOf([]);

/** Said in place of the task warnings when the tasks could not be read. */
export const TASKS_UNREAD_WARNING = "The open tasks here could not be read, so what this removal does to them is unknown.";

/**
 * Every warning a removal of these nodes and wires carries. The wires named
 * are all that go, the nodes' own among them.
 */
export const removalWarnings = (
  canvas: Canvas,
  removedNodeIds: ReadonlySet<string>,
  removedWires: ReadonlyArray<Wire>,
  tasksOf: OpenTasksOf | undefined,
): ReadonlyArray<string> =>
  tasksOf === undefined
    ? [TASKS_UNREAD_WARNING]
    : [
      ...boardRemovalWarnings(canvas, removedNodeIds, tasksOf),
      ...seatRemovalWarnings(canvas, removedNodeIds, tasksOf),
      ...wireRemovalWarnings(canvas, removedWires, tasksOf, removedNodeIds),
    ];

const boardNamed = (canvas: Pick<Canvas, "nodes">, nodeId: string): string => {
  const node = canvas.nodes.get(asNodeId(nodeId));
  return node ? `“${titleOf(node)}”` : "the removed board";
};

/**
 * What removing these nodes does to the open tasks a board among them holds.
 * Empty means the ordinary confirmation is enough.
 */
export const boardRemovalWarnings = (
  canvas: Canvas,
  removedNodeIds: ReadonlySet<string>,
  tasksOf: OpenTasksOf,
): ReadonlyArray<string> => {
  const warnings: string[] = [];
  for (const node of canvas.nodes.values()) {
    if (!removedNodeIds.has(node.id) || node.kind !== "task") continue;
    const live = tasksOf(node.id).length;
    if (live > 0) warnings.push(`${boardNamed(canvas, node.id)} holds ${count(live, "live task")}.`);
  }
  return warnings;
};

/**
 * The open tasks a removed seat holds go back to the backlog (seat-release.ts
 * in main), each named. A task on a board removed with it is the board's
 * warning, not the seat's. Empty means the ordinary confirmation is enough.
 */
export const seatRemovalWarnings = (
  canvas: Canvas,
  removedNodeIds: ReadonlySet<string>,
  tasksOf: OpenTasksOf,
): ReadonlyArray<string> => {
  const held = new Map<string, TaskView[]>();
  for (const board of canvas.nodes.values()) {
    if (board.kind !== "task" || removedNodeIds.has(board.id)) continue;
    for (const task of tasksOf(board.id)) {
      const seat = task.current.assignee;
      if (seat === undefined || !removedNodeIds.has(seat) || canvas.nodes.get(seat)?.kind !== "agent") continue;
      held.set(seat, [...(held.get(seat) ?? []), task]);
    }
  }
  return [...held].map(([seat, tasks]) => {
    const names = tasks.map((task) => taskName(task));
    const listed = names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return `${boardNamed(canvas, seat)} holds ${listed}; ${tasks.length === 1 ? "it goes" : "they go"} back to the backlog.`;
  });
};

/**
 * What removing these wires does to tasks on their way. The caller names
 * every wire that will go, so several removed at once are reported together.
 * Empty means the ordinary confirmation is enough.
 */
export const wireRemovalWarnings = (
  canvas: Canvas,
  removedWires: ReadonlyArray<Wire>,
  tasksOf: OpenTasksOf,
  removedNodeIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  const bySource = new Map<string, { nextBoards: Set<string>; tasks: Set<string> }>();
  for (const wire of removedWires) {
    // A flows wire runs from the earlier board to its Next board.
    if (wire.verb !== "flows" || removedNodeIds.has(wire.from)) continue;
    const entry = bySource.get(wire.from) ?? { nextBoards: new Set<string>(), tasks: new Set<string>() };
    entry.nextBoards.add(wire.to);
    // Every open task on the earlier board may go on by this wire.
    for (const task of tasksOf(wire.from)) entry.tasks.add(task.taskId);
    bySource.set(wire.from, entry);
  }
  return [...bySource].flatMap(([source, { nextBoards, tasks }]) => {
    const sourceName = boardNamed(canvas, source);
    const lostNames = [...nextBoards].map((board) => boardNamed(canvas, board));
    const remaining = flowDestinations(canvas, source).filter((board) => !nextBoards.has(board));
    const warnings: string[] = [];
    if (tasks.size > 0) {
      warnings.push(
        `${sourceName} has ${count(tasks.size, "live task")} that will lose ${lostNames.join(" and ")} as ${lostNames.length === 1 ? "its Next board" : "Next boards"}.`,
      );
    }
    if (remaining.length === 0 && nextBoards.size > 0) {
      warnings.push(`This removes ${sourceName}’s last Next board, so tasks will complete here.`);
    }
    return warnings;
  });
};

/**
 * Deleting seats closes their open signals (Remote term 5). One line, only when
 * the count is above zero: every signal in state open on a removed node, summed
 * over the nodes, whatever raised it. Empty means no signal is lost.
 */
export const signalRemovalWarnings = (
  removedNodeIds: ReadonlySet<string>,
  signals: Iterable<AgentSignal>,
): ReadonlyArray<string> => {
  let open = 0;
  for (const signal of signals) if (signal.state === "open" && removedNodeIds.has(signal.nodeId)) open += 1;
  const line = signalsCloseLine(open);
  return line === undefined ? [] : [line];
};

const QUESTION_NAME_LIMIT = 52;

/**
 * What a delete confirm calls its subject: one removed node by its title, as
 * the canvas delete names its canvas, else "this node". A node whose title
 * only repeats its kind, or a note with no text, is untitled and says nothing.
 */
export const deleteSubjectName = (node: Node): string => {
  const title = titleOf(node);
  if (title === "untitled" || title === node.kind) return "this node";
  return title.length <= QUESTION_NAME_LIMIT ? title : `${title.slice(0, QUESTION_NAME_LIMIT).trimEnd()}…`;
};
