import {
  deriveExecutionGraph,
  type ExecutionGraphContext,
} from "@shared/execution-graph";
import type { ExecutionSnapshot } from "@shared/ipc";
import type { Canvas } from "@shared/model/canvas";
import {
  flowEdgesFromModel,
  type ModelEdgeData,
  type ModelFlowEdge,
  type ModelFlowEdgeCache,
} from "./flow-edges";
import {
  flowNodesFromModel,
  type ModelFlowCache,
  type ModelFlowNode,
  type ModelNodeData,
} from "./flow-nodes";

// A canvas as React Flow draws it: its nodes (flow-nodes.ts) and its wires
// (flow-edges.ts), with what the execution graph says of each. A flow node
// carries the canvas, the id and the kind, and no node: a card reads the rest
// from the node store.

export type NodeData = ModelNodeData;
export type EdgeData = ModelEdgeData;
export type FlowNode = ModelFlowNode;
export type FlowEdge = ModelFlowEdge;

// Live overlay from the kernel cycle (the blocked seats). When absent, the
// projection falls back to deriveExecutionGraph(canvas, context), resolving
// task assignees only through compiled actor refs.
export type ExecutionOverlay = Pick<ExecutionSnapshot, "blocked">;

/** Reuses flow nodes and edges across projections while what they show is unchanged. */
export type FlowIdentityCache = {
  readonly nodes: ModelFlowCache;
  readonly edges: ModelFlowEdgeCache;
};

export const createFlowIdentityCache = (): FlowIdentityCache => ({
  nodes: new Map(),
  edges: new Map(),
});

/** Nodes in paint order, lowest first. */
const inPaintOrder = (canvas: Canvas) =>
  [...canvas.nodes.values()].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Project a canvas for React Flow. The kernel's execution overlay, when there
 * is one, says which seats are blocked; without it the same is worked out
 * here. Wires carry no stoppage: each paints its verb.
 */
export const toFlowOfCanvas = (
  canvas: Canvas,
  context: ExecutionGraphContext,
  execution?: ExecutionOverlay | null,
  cache?: FlowIdentityCache,
): { nodes: FlowNode[]; edges: FlowEdge[] } => {
  const blocked = new Set(execution ? execution.blocked : deriveExecutionGraph(canvas, context).blocked);
  return {
    nodes: flowNodesFromModel(canvas, inPaintOrder(canvas), blocked, cache?.nodes),
    edges: flowEdgesFromModel(canvas, cache?.edges),
  };
};
