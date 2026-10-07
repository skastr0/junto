import type { EdgePhase } from "@shared/canvas";
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

// Live overlay from the kernel cycle (derived phases + blocked closure).
// When absent, the projection falls back to deriveExecutionGraph(canvas,
// context), resolving task ownership only through compiled actor refs.
export type ExecutionOverlay = Pick<
  ExecutionSnapshot,
  "phaseByEdgeId" | "detailByEdgeId" | "blocked" | "blockedEdgeIds"
>;

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
 * is one, says which nodes are blocked and what each wire is doing; without
 * it the same is worked out here, and only when something asks.
 */
export const toFlowOfCanvas = (
  canvas: Canvas,
  context: ExecutionGraphContext,
  execution?: ExecutionOverlay | null,
  cache?: FlowIdentityCache,
): { nodes: FlowNode[]; edges: FlowEdge[] } => {
  // Lazy: a kernel tick that already supplies phases never walks the graph.
  let fallback: ReturnType<typeof deriveExecutionGraph> | null = null;
  const getFallback = () => {
    if (!fallback) fallback = deriveExecutionGraph(canvas, context);
    return fallback;
  };
  const hasLive = Boolean(execution);
  const blocked = new Set(execution?.blocked ?? (hasLive ? [] : getFallback().blocked));
  const blockedEdgeIds = new Set(execution?.blockedEdgeIds ?? (hasLive ? [] : getFallback().blockedEdgeIds));
  return {
    nodes: flowNodesFromModel(canvas, inPaintOrder(canvas), blocked, cache?.nodes),
    edges: flowEdgesFromModel(
      canvas,
      {
        phaseOf: (id) =>
          (execution?.phaseByEdgeId[id] as EdgePhase | undefined) ??
          getFallback().phaseByEdgeId.get(id) ??
          "relates",
        detailOf: (id) => execution?.detailByEdgeId[id] ?? getFallback().detailByEdgeId.get(id) ?? "",
        rippling: (id) => blockedEdgeIds.has(id),
      },
      cache?.edges,
    ),
  };
};

