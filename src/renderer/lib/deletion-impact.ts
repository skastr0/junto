import { flowDestinations } from "@shared/flow-graph";
import type { WorkRead } from "@shared/work-read";
import { asNodeId, type Canvas, type Wire } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { readTaskPolicy } from "./use-work-task-policy";
import { taskPolicyRead } from "./work-task-policy-store";
import {
  boardDeletionImpact,
  flowEdgeRemovalImpact,
} from "@shared/visit-integrity";

const count = (value: number, singular: string, plural = `${singular}s`): string =>
  `${value} ${value === 1 ? singular : plural}`;

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
 * What removing these nodes does to the tasks a board among them holds or is
 * named by. Empty means the ordinary confirmation is enough.
 */
export const boardRemovalWarnings = (
  canvas: Canvas,
  removedNodeIds: ReadonlySet<string>,
  work: WorkRead,
): ReadonlyArray<string> => {
  const warnings: string[] = [];
  for (const node of canvas.nodes.values()) {
    if (!removedNodeIds.has(node.id) || node.kind !== "task") continue;
    const impact = boardDeletionImpact(canvas, work, node.id);
    const liveRows = impact.strandedTasks.filter((task) => task.kinds.includes("home-row")).length;
    const visitReferences = impact.strandedTasks.filter((task) =>
      task.kinds.some((kind) => kind === "visit" || kind === "defect-target"),
    ).length;
    const name = boardNamed(canvas, node.id);
    if (liveRows > 0) warnings.push(`${name} holds ${count(liveRows, "live task")}.`);
    if (visitReferences > 0) {
      warnings.push(
        `${count(visitReferences, "live visit")} reference${visitReferences === 1 ? "s" : ""} ${name} as a board or send-back target.`,
      );
    }
  }
  return warnings;
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
