import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import { flowDestinations, isTaskSinkNode } from "@shared/flow-graph";
import { canvasFromDocument, wireOfDocument, wiresFromDocument } from "@shared/model/from-document";
import type { WorkRead } from "@shared/work-read";
import { asNodeId, type Canvas, type Wire } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { readTaskPolicy } from "./use-work-task-policy";
import { taskPolicyRead } from "./work-task-policy-store";
import {
  boardDeletionImpact,
  flowEdgeRemovalImpact,
} from "@shared/visit-integrity";
import { tasksNodeIdentity } from "@shared/tasks-node-identity";

/** Only task retirement and task-path changes need current task policy. */
export const readDeletionPolicy = (
  canvasName: string,
  doc: CanvasDoc,
  removedNodeIds: ReadonlySet<string>,
  removedEdges: ReadonlyArray<CanvasEdge>,
): WorkRead | Promise<WorkRead> =>
  doc.nodes.some((node) => removedNodeIds.has(node.id) && isTaskSinkNode(node)) ||
  removedEdges.some((edge) => wireOfDocument(edge)?.verb === "feeds")
    ? readTaskPolicy(canvasName)
    : taskPolicyRead([]);

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
  work: WorkRead,
): ReadonlyArray<string> => {
  const warnings: string[] = [];
  for (const node of doc.nodes) {
    if (!removedNodeIds.has(node.id) || !isTaskSinkNode(node)) continue;
    const impact = boardDeletionImpact(canvasFromDocument("", doc), work, node.id);
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
  work: WorkRead,
  removedNodeIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  const bySource = new Map<
    string,
    { nextBoards: Set<string>; tasks: Set<string> }
  >();
  for (const edge of removedEdges) {
    // A `feeds` edge is stored in its own direction: fromNode is the earlier
    // board and toNode is its Next board.
    if (wireOfDocument(edge)?.verb !== "feeds") continue;
    const source = edge.fromNode;
    if (removedNodeIds.has(source)) continue;
    const nextBoard = edge.toNode;
    const impact = flowEdgeRemovalImpact(canvasFromDocument("", doc), work, source, nextBoard);
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
    const remaining = flowDestinations(wiresFromDocument(doc), source).filter(
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

// ── The same questions over the model canvas ────────────────────────────────
// Asked by the wire writers, which read the canvas the store holds. The
// document forms above are still called when nodes are deleted
// (lib/mutations.ts and lib/confirm-delete.ts); they go, with their tests, the
// day those two read the model.

/** Only removing a task board or a task path needs the current task policy. */
export const removalPolicy = (
  canvasName: string,
  canvas: Pick<Canvas, "nodes">,
  removedNodeIds: ReadonlySet<string>,
  removedWires: ReadonlyArray<Wire>,
): WorkRead | Promise<WorkRead> =>
  [...removedNodeIds].some((id) => canvas.nodes.get(asNodeId(id))?.kind === "task") ||
  removedWires.some((wire) => wire.verb === "feeds")
    ? readTaskPolicy(canvasName)
    : taskPolicyRead([]);

const boardNamed = (canvas: Pick<Canvas, "nodes">, nodeId: string): string => {
  const node = canvas.nodes.get(asNodeId(nodeId));
  return node ? `“${titleOf(node)}”` : "the removed board";
};

/**
 * What removing these wires does to tasks on their way. The caller names
 * every wire that will go, so several removed at once are reported together.
 * Empty means the ordinary confirmation is enough.
 */
export const wireRemovalWarnings = (
  canvas: Canvas,
  removedWires: ReadonlyArray<Wire>,
  work: WorkRead,
  removedNodeIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  const bySource = new Map<string, { nextBoards: Set<string>; tasks: Set<string> }>();
  for (const wire of removedWires) {
    // A feeds wire runs from the earlier board to its Next board.
    if (wire.verb !== "feeds" || removedNodeIds.has(wire.from)) continue;
    const impact = flowEdgeRemovalImpact(canvas, work, wire.from, wire.to);
    const entry = bySource.get(wire.from) ?? { nextBoards: new Set<string>(), tasks: new Set<string>() };
    entry.nextBoards.add(wire.to);
    for (const task of impact.affectedTasks) entry.tasks.add(task);
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
