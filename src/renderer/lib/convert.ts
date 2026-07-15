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
// When absent, toFlow falls back to pure deriveExecutionGraph(doc) which still
// resolves tasks criteria and legacy kind pins from the document alone.
export type ExecutionOverlay = Pick<
  ExecutionSnapshot,
  "phaseByEdgeId" | "detailByEdgeId" | "blocked" | "blockedEdgeIds"
>;

// CanvasDoc -> React Flow. Optional kernel execution overlay carries live
// glyph/WIP phase so the canvas does not re-derive with an empty GlyphView.
export const toFlow = (
  doc: CanvasDoc,
  execution?: ExecutionOverlay | null,
): { nodes: FlowNode[]; edges: FlowEdge[] } => {
  const fallback = deriveExecutionGraph(doc, new Map());
  const blocked = new Set(execution?.blocked ?? fallback.blocked);
  const blockedEdgeIds = new Set(execution?.blockedEdgeIds ?? fallback.blockedEdgeIds);
  const phaseOf = (edgeId: string): EdgePhase =>
    (execution?.phaseByEdgeId[edgeId] as EdgePhase | undefined) ??
    fallback.phaseByEdgeId.get(edgeId) ??
    "relates";
  const detailOf = (edgeId: string): string =>
    execution?.detailByEdgeId[edgeId] ?? fallback.detailByEdgeId.get(edgeId) ?? "";

  const nodes: FlowNode[] = doc.nodes.map((node) => {
    const isGroup = node.type === "group";
    return {
      id: node.id,
      type: node.type,
      position: { x: node.x, y: node.y },
      data: { node, blocked: blocked.has(node.id) },
      style: { width: node.width, height: node.height },
      zIndex: isGroup ? 0 : 1,
      connectable: !isGroup,
      ariaLabel: nodeTitle(node),
      focusable: true,
      selectable: true,
      draggable: true,
    };
  });

  const edges: FlowEdge[] = doc.edges.map((edge) => {
    const phase = phaseOf(edge.id);
    const detail = detailOf(edge.id);
    const projected: CanvasEdge = {
      ...edge,
      ether: { ...edge.ether, kind: phase },
      label: edge.ether?.criteria ? phase : edge.label ?? phase,
    };
    return {
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
        rippling: blockedEdgeIds.has(edge.id),
        phase,
        detail,
      },
      zIndex: 2,
    };
  });

  return { nodes, edges };
};
