import { asNodeId } from "./model/base";
import type { Placed } from "./model/canvas";
import { nodesOf, regionMembers, regionStack } from "./model/canvas";
import type { Task } from "./work-model";
import type { WorkRead } from "./work-read";
import { taskIndexById } from "./task-deps";

/**
 * Same-region dependency scope for work-plane task prereqs.
 *
 * Every task sink co-resident in the author's region is in scope. When the
 * authoring sink is outside every region, all task sinks on the canvas are
 * in scope (there is no region boundary to cross). Cross-region deps resolve
 * as missing at validate time.
 */

/** Node ids whose task sinks may satisfy dependsOn for `sinkNodeId`. */
export const dependencyScopeNodeIds = (
  canvas: Placed,
  sinkNodeId: string,
): ReadonlySet<string> => {
  // One region is semantically needed here — innermost wins: the tightest
  // containing region is the sink's dependency neighborhood.
  const stack = regionStack(canvas, asNodeId(sinkNodeId));
  const innermost = stack[stack.length - 1];
  if (innermost !== undefined) {
    return new Set(regionMembers(canvas, innermost).map((node) => node.id));
  }
  // Ungrouped: canvas-wide (no region boundary exists for this sink).
  return new Set(canvas.nodes.keys());
};

/**
 * Tasks visible for dependency validate / claim-ready / depStatus for a sink.
 * Includes every task item on every in-scope task sink (same region), boards
 * in paint order.
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
