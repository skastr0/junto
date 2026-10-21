import { asNodeId } from "./model/base";
import type { Placed } from "./model/canvas";
import { nodesOf } from "./model/canvas";
import { onOneLine, positionsOf } from "./region-reach";
import type { Task } from "./work-model";
import type { WorkRead } from "./work-read";
import { taskIndexById } from "./task-deps";

/**
 * Dependency scope for work-plane task prereqs: region reach (01).
 *
 * A task sink's dependencies may sit on any task sink in reach of it: its own
 * region, a region inside it, or a region around it, never a sibling's. A sink
 * outside every region is at the root, on one line with every sink on the
 * canvas. A dependency outside the scope resolves as missing at validate time.
 */

/** Task sink ids whose tasks may satisfy dependsOn for `sinkNodeId`. */
export const dependencyScopeNodeIds = (
  canvas: Placed,
  sinkNodeId: string,
): ReadonlySet<string> => {
  const at = positionsOf(canvas, asNodeId(sinkNodeId));
  if (at === undefined) return new Set();
  const scope = new Set<string>([sinkNodeId]);
  for (const board of nodesOf(canvas, "task")) {
    const there = positionsOf(canvas, board.id);
    if (there !== undefined && onOneLine(canvas, at, there)) scope.add(board.id);
  }
  return scope;
};

/**
 * Tasks visible for dependency validate / claim-ready / depStatus for a sink.
 * Includes every task item on every task sink in reach of it, boards in
 * paint order.
 */
export const dependencyScopeTasks = (
  canvas: Placed,
  work: WorkRead,
  sinkNodeId: string,
): ReadonlyArray<Task> => {
  const scope = dependencyScopeNodeIds(canvas, sinkNodeId);
  const boards = nodesOf(canvas, "task")
    .filter((board) => scope.has(board.id))
    .sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  const items: Task[] = [];
  for (const board of boards) {
    for (const task of work.itemsOf(board.id)) items.push(task);
  }
  return items;
};

/** Index for claim-ready / validate over the sink's dependency scope. */
export const dependencyScopeIndex = (
  canvas: Placed,
  work: WorkRead,
  sinkNodeId: string,
): Map<string, Task> =>
  taskIndexById(dependencyScopeTasks(canvas, work, sinkNodeId));
