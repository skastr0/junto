/**
 * Visit referential integrity — what a canvas mutation would break.
 *
 * Task visits and defect logs reference Tasks node ids; flow edges decide
 * where live work can still travel. Deleting a board or a flow edge does not
 * corrupt the append-only visit record, but it strands actions that depend on
 * those ids: defect targeting, sending on, and visit rendering. The rules:
 *
 * - mutations to Tasks nodes and flow edges that live visits reference must
 *   be DETECTABLE before they happen (warn/confirm surfaces read this module);
 * - actions that depend on a missing id fail closed and are shown disabled
 *   with the reason, never half-work.
 *
 * Everything here is a pure projection of the document — computed, not stored.
 */

import type { CanvasDoc } from "./canvas";
import type { Task } from "./work-model";
import { isTerminalTaskState } from "./task";
import { flowDestinations, isTaskSinkNode } from "./flow-graph";
import { taskDefects } from "./rules";

/** How a task references a board. */
export type BoardReferenceKind = "visit" | "defect-target" | "home-row";

export type BoardReference = {
  readonly taskId: string;
  /** Board row the task currently lives on (where the reference was read). */
  readonly rowBoard: string;
  readonly kind: BoardReferenceKind;
};

/** Every task row on the canvas, with the board its row lives on. */
const taskRows = (
  doc: CanvasDoc,
): ReadonlyArray<{ readonly board: string; readonly task: Task }> =>
  doc.nodes.flatMap((node) =>
    (node.ether?.tasks?.items ?? []).map((task) => ({
      board: node.id,
      task,
    })),
  );

/**
 * Boards referenced by LIVE visits, board id -> references. Terminal
 * tasks are history — their references never block a mutation, they only
 * degrade rendering (which renders the bare id and moves on).
 */
export const boardsReferencedByLiveVisits = (
  doc: CanvasDoc,
): ReadonlyMap<string, ReadonlyArray<BoardReference>> => {
  const out = new Map<string, BoardReference[]>();
  // One reference per (task, kind) per board — a board revisited across epochs
  // is still one visit dependency, not two.
  const add = (board: string, reference: BoardReference) => {
    const refs = out.get(board) ?? [];
    if (
      refs.some(
        (existing) =>
          existing.taskId === reference.taskId &&
          existing.kind === reference.kind,
      )
    ) {
      return;
    }
    refs.push(reference);
    out.set(board, refs);
  };
  // The LIVE row is the authority: completed visit rows carry the history only
  // as of their exit, and document order says nothing about which row is live.
  // One live row per task holds by the no-split invariant.
  for (const { board, task } of taskRows(doc)) {
    if (isTerminalTaskState(task.state)) continue;
    add(board, { taskId: task.id, rowBoard: board, kind: "home-row" });
    for (const visit of task.visits ?? []) {
      add(visit.board, {
        taskId: task.id,
        rowBoard: board,
        kind: "visit",
      });
    }
    for (const defect of taskDefects(task)) {
      add(defect.target, {
        taskId: task.id,
        rowBoard: board,
        kind: "defect-target",
      });
    }
  }
  return out;
};

export type DeletionImpact = {
  /** Live tasks whose visits or defect log reference the node. */
  readonly strandedTasks: ReadonlyArray<{
    readonly taskId: string;
    readonly kinds: ReadonlyArray<BoardReferenceKind>;
  }>;
  /** True when any live task's row LIVES on the node (work would vanish). */
  readonly carriesLiveRows: boolean;
};

/**
 * What deleting a Tasks node would strand. Empty impact = free to delete
 * silently; anything else earns the warn/confirm naming exactly this.
 */
export const boardDeletionImpact = (
  doc: CanvasDoc,
  nodeId: string,
): DeletionImpact => {
  const references = boardsReferencedByLiveVisits(doc).get(nodeId) ?? [];
  const byTask = new Map<string, Set<BoardReferenceKind>>();
  let carriesLiveRows = false;
  for (const reference of references) {
    const kinds = byTask.get(reference.taskId) ?? new Set();
    kinds.add(reference.kind);
    byTask.set(reference.taskId, kinds);
    if (reference.kind === "home-row" && reference.rowBoard === nodeId) {
      carriesLiveRows = true;
    }
  }
  return {
    strandedTasks: [...byTask.entries()].map(([taskId, kinds]) => ({
      taskId,
      kinds: [...kinds],
    })),
    carriesLiveRows,
  };
};

export type FlowEdgeImpact = {
  /** Live tasks currently at the earlier board that lose this Next. */
  readonly affectedTasks: ReadonlyArray<string>;
  /** True when this edge is the board's only Next (the board becomes terminal). */
  readonly lastNext: boolean;
};

/** What removing the path edge from one board to its Next would take away. */
export const flowEdgeRemovalImpact = (
  doc: CanvasDoc,
  board: string,
  nextBoard: string,
): FlowEdgeImpact => {
  const nextBoards = flowDestinations(doc, board);
  const remaining = nextBoards.filter((node) => node !== nextBoard);
  const affected = taskRows(doc)
    .filter(
      ({ board: rowBoard, task }) =>
        rowBoard === board && !isTerminalTaskState(task.state),
    )
    .map(({ task }) => task.id);
  return {
    affectedTasks: [...new Set(affected)],
    lastNext: nextBoards.includes(nextBoard) && remaining.length === 0,
  };
};

export type DefectTargetOption = {
  readonly board: string;
  /**
   * False when the board is no longer a Tasks node — deleted, or the node
   * still exists but its kind changed. Defect handling requires a Tasks node,
   * so anything else renders disabled with this reason.
   */
  readonly present: boolean;
};

/**
 * The legal defect targets for a task at `currentBoard`: every visited board
 * except the current one, in first-visit order, each flagged with whether it
 * still exists on the canvas. Pickers render absent boards disabled instead
 * of hiding them — the visit happened either way.
 */
export const defectTargetOptions = (
  doc: CanvasDoc,
  task: Task,
  currentBoard: string,
): ReadonlyArray<DefectTargetOption> => {
  const seen = new Set<string>();
  const out: DefectTargetOption[] = [];
  for (const visit of task.visits ?? []) {
    if (visit.board === currentBoard) continue;
    if (seen.has(visit.board)) continue;
    seen.add(visit.board);
    out.push({
      board: visit.board,
      present: isTaskSinkNode(
        doc.nodes.find((node) => node.id === visit.board),
      ),
    });
  }
  return out;
};
