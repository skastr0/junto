/**
 * Reads the canvas feed's observers share: the execution graph's blocked set
 * and each node's innermost region. Both are plain Legend-State reads — call
 * them inside `observe` and every input they touch is tracked.
 */
import type { Node } from "@shared/model";
import { regionIndex } from "@shared/model/canvas";
import type { Region } from "@shared/model";
import { deriveExecutionGraph, type ExecutionGraphContext } from "@shared/execution-graph";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { kernel$ } from "../../lib/kernel-view";
import { seatTasks$ } from "../../lib/seat-tasks";
import { state$ } from "../../lib/state";
import { modelStore } from "../../lib/use-model";

/**
 * Node ids the execution graph holds blocked: the kernel's live overlay when
 * main has pushed one, else the same derivation the flow projection falls
 * back to. Reads `kernel$.execution`, `state$.actorRefs` and `seatTasks$`,
 * so an observer calling this re-runs when any of them move.
 */
export const blockedNodeIds = (canvasName: string): ReadonlySet<string> => {
  const execution = kernel$.execution.get();
  if (execution !== null) return new Set(execution.blocked);
  const context: ExecutionGraphContext = executionGraphContextFromActorRefs(
    canvasName,
    state$.actorRefs.get(),
    seatTasks$.bySeat.get(),
  );
  return deriveExecutionGraph(modelStore.canvasOf(canvasName), context).blocked;
};

/**
 * Every node's innermost containing region, and every region's own parent,
 * from one geometric pass — the same `parentOf` map flow-nodes builds for
 * `seatRegion` / `homeRegion` / `parentRegion`. Reads each node's kind and
 * rect, so an observer calling this re-runs when membership can move.
 */
export const regionParentOf = (canvasName: string): ReadonlyMap<string, string> => {
  const model = modelStore.canvas$(canvasName);
  const ids = model.nodeIds.get();
  const nodes = new Map<string, Node>();
  for (const id of ids) {
    const node$ = model.nodes[id];
    node$.kind.get();
    node$.x.get();
    node$.y.get();
    node$.width.get();
    node$.height.get();
    const node = node$.peek();
    if (node !== undefined) nodes.set(id, node);
  }
  // One index of the board's regions: each node is tested against the
  // regions near it, not every node on the board for regions.
  const index = regionIndex([...nodes.values()].filter((node): node is Region => node.kind === "region"));
  const parentOf = new Map<string, string>();
  for (const node of nodes.values()) {
    const stack = index.stack(node, node.id);
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parentOf.set(node.id, parent.id);
  }
  return parentOf;
};
