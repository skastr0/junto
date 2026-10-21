// The kernel evaluation cycle: each canvas's stoppage (the blocked seats and
// why, from the open task each seat holds), derived every cycle and never
// mirrored back into the document.

import {
  deriveExecutionGraph,
  type BlockedReason,
  type ExecutionGraphSnapshot,
} from "@shared/execution-graph";
import type { ActorRefResolver } from "@shared/attention";
import type { World } from "./world";

/** Serializable per-canvas execution graph for renderer projection. */
export type ExecutionSnapshot = ExecutionGraphSnapshot;

// --- module-level state ------------------------------------------------------

let worlds: Map<string, World> = new Map();
let resolveActorRef: ActorRefResolver = () => undefined;

export const __setWorldsForTest = (held: Map<string, World>): void => {
  worlds = held;
};

export const setActorRefResolver = (resolver: ActorRefResolver): void => {
  resolveActorRef = resolver;
};

export const __resetKernelMemoryForTest = (): void => {
  worlds = new Map();
  resolveActorRef = () => undefined;
  executionByCanvas.clear();
};

// Per-canvas derived execution graphs (recomputed each evaluation cycle).
const executionByCanvas = new Map<string, ExecutionSnapshot>();

export const getExecutionByCanvas = (): ReadonlyMap<string, ExecutionSnapshot> =>
  executionByCanvas;

const snapshotFromGraph = (
  canvasName: string,
  world: World,
): ExecutionSnapshot => {
  const graph = deriveExecutionGraph(world.canvas, {
    canvasName,
    resolveActorRef,
    heldBy: world.seatTasks,
  });
  const reasonsByNodeId: Record<string, ReadonlyArray<BlockedReason>> = {};
  for (const [id, reasons] of graph.reasonsByNodeId) reasonsByNodeId[id] = reasons;
  return { blocked: Array.from(graph.blocked), reasonsByNodeId };
};

// --- evaluation cycle (multi-canvas with per-canvas isolation) ---------------

// Exported for tests: drive exactly one evaluation pass.
export const runEvaluationCycle = (): void => {
  for (const [canvasName, world] of worlds.entries()) {
    try {
      executionByCanvas.set(canvasName, snapshotFromGraph(canvasName, world));
    } catch (err) {
      // One bad canvas never stalls the rest.
      console.error(`Kernel evaluation failed for canvas "${canvasName}":`, err);
    }
  }
};

/** The kernel service owns this map and changes it in place. */
export const setWorlds = (held: Map<string, World>): void => {
  worlds = held;
};

// Drops the derived state for a canvas that is gone from authority (deleted
// or renamed).
export const purgeCanvasMemory = (canvasName: string): void => {
  executionByCanvas.delete(canvasName);
};
