import type { CanvasDoc } from "./canvas";
import { groupMembers, regionStack } from "./graph";
import type { Task } from "./work-model";
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
  doc: CanvasDoc,
  sinkNodeId: string,
): ReadonlySet<string> => {
  // One region is semantically needed here — innermost wins: the tightest
  // containing region is the sink's dependency neighborhood.
  const stack = regionStack(doc, sinkNodeId);
  const innermost = stack[stack.length - 1];
  if (innermost !== undefined) {
    return new Set(groupMembers(doc).get(innermost.id) ?? []);
  }
  // Ungrouped: canvas-wide (no region boundary exists for this sink).
  return new Set(doc.nodes.map((node) => node.id));
};

/**
 * Tasks visible for dependency validate / claim-ready / depStatus for a sink.
 * Includes every task item on every in-scope task sink (same region).
 */
export const dependencyScopeTasks = (
  doc: CanvasDoc,
  sinkNodeId: string,
): ReadonlyArray<Task> => {
  const scope = dependencyScopeNodeIds(doc, sinkNodeId);
  const items: Task[] = [];
  for (const node of doc.nodes) {
    if (!scope.has(node.id)) continue;
    if (node.ether?.entity?.kind !== "task") continue;
    const tasks = node.ether.tasks?.items;
    if (tasks === undefined || tasks.length === 0) continue;
    for (const task of tasks) items.push(task);
  }
  return items;
};

/** Index for claim-ready / validate over the sink's dependency scope. */
export const dependencyScopeIndex = (
  doc: CanvasDoc,
  sinkNodeId: string,
): Map<string, Task> => taskIndexById(dependencyScopeTasks(doc, sinkNodeId));
