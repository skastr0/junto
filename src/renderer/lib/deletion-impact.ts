import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import { flowDestinations, isTaskSinkNode } from "@shared/flow-graph";
import {
  boardDeletionImpact,
  flowEdgeRemovalImpact,
} from "@shared/visit-integrity";
import { tasksNodeIdentity } from "@shared/tasks-node-identity";

const count = (value: number, singular: string, plural = `${singular}s`): string =>
  `${value} ${value === 1 ? singular : plural}`;

const quotedTitle = (node: CanvasNode): string =>
  `“${tasksNodeIdentity(node).name}”`;

const boardName = (doc: CanvasDoc, nodeId: string): string => {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  return node ? quotedTitle(node) : "the removed board";
};

/**
 * Specific consequences of deleting Tasks nodes. Empty means the ordinary
 * deletion confirmation is sufficient.
 */
export const tasksNodeDeletionWarnings = (
  doc: CanvasDoc,
  removedNodeIds: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const warnings: string[] = [];
  for (const node of doc.nodes) {
    if (!removedNodeIds.has(node.id) || !isTaskSinkNode(node)) continue;
    const impact = boardDeletionImpact(doc, node.id);
    const liveRows = impact.strandedTasks.filter((task) =>
      task.kinds.includes("home-row"),
    ).length;
    const visitReferences = impact.strandedTasks.filter((task) =>
      task.kinds.some((kind) => kind === "visit" || kind === "defect-target"),
    ).length;
    if (liveRows > 0) {
      warnings.push(`${quotedTitle(node)} holds ${count(liveRows, "live task")}.`);
    }
    if (visitReferences > 0) {
      warnings.push(
        `${count(visitReferences, "live visit")} reference${visitReferences === 1 ? "s" : ""} ${quotedTitle(node)} as a board or send-back target.`,
      );
    }
  }
  return warnings;
};

type SourceRemoval = {
  readonly source: string;
  readonly removedNextBoards: ReadonlySet<string>;
  readonly affectedTasks: ReadonlySet<string>;
};

/**
 * Specific consequences of removing configured task-path edges. The caller
 * supplies every edge that will disappear, including edges removed along with
 * a node, so multi-delete reports the collective path outcome honestly.
 */
export const flowEdgeRemovalWarnings = (
  doc: CanvasDoc,
  removedEdges: ReadonlyArray<CanvasEdge>,
  removedNodeIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  const bySource = new Map<
    string,
    { nextBoards: Set<string>; tasks: Set<string> }
  >();
  for (const edge of removedEdges) {
    // A `feeds` edge is stored in its own direction: fromNode is the earlier
    // board and toNode is its Next board.
    if (edge.ether?.verb !== "feeds") continue;
    const source = edge.fromNode;
    if (removedNodeIds.has(source)) continue;
    const nextBoard = edge.toNode;
    const impact = flowEdgeRemovalImpact(doc, source, nextBoard);
    const entry = bySource.get(source) ?? {
      nextBoards: new Set<string>(),
      tasks: new Set<string>(),
    };
    entry.nextBoards.add(nextBoard);
    for (const task of impact.affectedTasks) entry.tasks.add(task);
    bySource.set(source, entry);
  }

  const removals: SourceRemoval[] = [...bySource].map(([source, value]) => ({
    source,
    removedNextBoards: value.nextBoards,
    affectedTasks: value.tasks,
  }));
  return removals.flatMap(({ source, removedNextBoards, affectedTasks }) => {
    const sourceName = boardName(doc, source);
    const lostNames = [...removedNextBoards].map((board) =>
      boardName(doc, board),
    );
    const remaining = flowDestinations(doc, source).filter(
      (board) => !removedNextBoards.has(board),
    );
    const warnings: string[] = [];
    if (affectedTasks.size > 0) {
      warnings.push(
        `${sourceName} has ${count(affectedTasks.size, "live task")} that will lose ${lostNames.join(" and ")} as ${lostNames.length === 1 ? "its Next board" : "Next boards"}.`,
      );
    }
    if (remaining.length === 0 && removedNextBoards.size > 0) {
      warnings.push(
        `This removes ${sourceName}’s last Next board, so tasks will complete here.`,
      );
    }
    return warnings;
  });
};
