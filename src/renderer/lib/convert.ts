import { MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import type { CanvasDoc, CanvasEdge, CanvasNode, EdgePhase } from "@shared/canvas";
import { deriveExecutionGraph } from "@shared/execution-graph";
import type { ExecutionSnapshot } from "@shared/ipc";
import { nodeTitle, searchText } from "./presentation";

export type NodeData = {
  node: CanvasNode;
  blocked: boolean;
};

export type EdgeData = {
  edge: CanvasEdge;
  rippling: boolean;
  phase: EdgePhase;
  detail: string;
};

export type FlowNode = Node<NodeData>;
export type FlowEdge = Edge<EdgeData>;

export { searchText } from "./presentation";

// Live overlay from the kernel cycle (glyph-aware phases + blocked closure).
// When absent, toFlow falls back to pure deriveExecutionGraph(doc) which
// resolves tasks criteria from the document and soft-relates otherwise.
export type ExecutionOverlay = Pick<
  ExecutionSnapshot,
  "phaseByEdgeId" | "detailByEdgeId" | "blocked" | "blockedEdgeIds"
>;

/** Mutable identity cache — reuse FlowNode/FlowEdge objects when inputs are unchanged. */
export type FlowIdentityCache = {
  readonly nodes: Map<string, FlowNode>;
  readonly edges: Map<string, FlowEdge>;
};

export const createFlowIdentityCache = (): FlowIdentityCache => ({
  nodes: new Map(),
  edges: new Map(),
});

// CanvasDoc -> React Flow. Optional kernel execution overlay carries live
// glyph/WIP phase so the canvas does not re-derive with an empty GlyphView.
// Optional identity cache reuses prior FlowNode/FlowEdge objects when the
// doc node ref + blocked (or edge phase/detail/rippling) are unchanged so
// React re-renders only the nodes that actually changed.
export const toFlow = (
  doc: CanvasDoc,
  execution?: ExecutionOverlay | null,
  cache?: FlowIdentityCache,
): { nodes: FlowNode[]; edges: FlowEdge[] } => {
  // Lazy fallback: only derive offline graph when the live overlay is absent
  // (or incomplete for a given edge). Avoids walking the full graph on every
  // kernel tick that already supplies phase/blocked.
  let fallback: ReturnType<typeof deriveExecutionGraph> | null = null;
  const getFallback = () => {
    if (!fallback) fallback = deriveExecutionGraph(doc, new Map());
    return fallback;
  };

  const hasLive = Boolean(execution);
  const blocked = new Set(
    execution?.blocked ?? (hasLive ? [] : getFallback().blocked),
  );
  const blockedEdgeIds = new Set(
    execution?.blockedEdgeIds ?? (hasLive ? [] : getFallback().blockedEdgeIds),
  );
  const phaseOf = (edgeId: string): EdgePhase =>
    (execution?.phaseByEdgeId[edgeId] as EdgePhase | undefined) ??
    getFallback().phaseByEdgeId.get(edgeId) ??
    "relates";
  const detailOf = (edgeId: string): string =>
    execution?.detailByEdgeId[edgeId] ?? getFallback().detailByEdgeId.get(edgeId) ?? "";

  const nextNodeIds = new Set<string>();
  const nodes: FlowNode[] = doc.nodes.map((node) => {
    nextNodeIds.add(node.id);
    const isBlocked = blocked.has(node.id);
    const cached = cache?.nodes.get(node.id);
    if (cached && cached.data.node === node && cached.data.blocked === isBlocked) {
      return cached;
    }
    const isGroup = node.type === "group";
    const flowNode: FlowNode = {
      id: node.id,
      type: node.type,
      position: { x: node.x, y: node.y },
      data: { node, blocked: isBlocked },
      style: { width: node.width, height: node.height },
      zIndex: isGroup ? 0 : 1,
      connectable: !isGroup,
      ariaLabel: nodeTitle(node),
      focusable: true,
      selectable: true,
      draggable: true,
    };
    cache?.nodes.set(node.id, flowNode);
    return flowNode;
  });
  if (cache) {
    for (const id of cache.nodes.keys()) {
      if (!nextNodeIds.has(id)) cache.nodes.delete(id);
    }
  }

  const nextEdgeIds = new Set<string>();
  const edges: FlowEdge[] = doc.edges.map((edge) => {
    nextEdgeIds.add(edge.id);
    const phase = phaseOf(edge.id);
    const detail = detailOf(edge.id);
    const rippling = blockedEdgeIds.has(edge.id);
    const cached = cache?.edges.get(edge.id);
    const cachedData = cached?.data;
    const cachedEdge = cachedData?.edge;
    if (
      cached &&
      cachedData &&
      cachedEdge &&
      cachedEdge.id === edge.id &&
      cachedEdge.fromNode === edge.fromNode &&
      cachedEdge.toNode === edge.toNode &&
      cachedEdge.fromSide === edge.fromSide &&
      cachedEdge.toSide === edge.toSide &&
      cachedEdge.fromEnd === edge.fromEnd &&
      cachedEdge.toEnd === edge.toEnd &&
      cachedEdge.label === edge.label &&
      cachedEdge.ether === edge.ether &&
      cachedData.phase === phase &&
      cachedData.detail === detail &&
      cachedData.rippling === rippling
    ) {
      return cached;
    }
    const projected: CanvasEdge = {
      ...edge,
      ether: { ...edge.ether, kind: phase },
      label: edge.ether?.criteria ? phase : edge.label ?? phase,
    };
    const flowEdge: FlowEdge = {
      id: edge.id,
      source: edge.fromNode,
      target: edge.toNode,
      sourceHandle: `s-${edge.fromSide ?? "right"}`,
      targetHandle: `t-${edge.toSide ?? "left"}`,
      markerStart: edge.fromEnd === "arrow" ? { type: MarkerType.ArrowClosed } : undefined,
      markerEnd: edge.toEnd === "arrow" ? { type: MarkerType.ArrowClosed } : undefined,
      type: "ether",
      data: {
        edge: projected,
        rippling,
        phase,
        detail,
      },
      zIndex: 2,
    };
    cache?.edges.set(edge.id, flowEdge);
    return flowEdge;
  });
  if (cache) {
    for (const id of cache.edges.keys()) {
      if (!nextEdgeIds.has(id)) cache.edges.delete(id);
    }
  }

  return { nodes, edges };
};
