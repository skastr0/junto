import { MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import type { CanvasDoc, CanvasEdge, CanvasNode, EdgePhase } from "@shared/canvas";
import { deriveExecutionGraph, type GlyphView } from "@shared/execution-graph";
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

// CanvasDoc -> React Flow. x/y -> position, width/height -> style, node.type
// selects the custom component, and derived blocked state rides along in data
// so nodes/edges can tint without re-querying the graph.
// Optional GlyphView (from kernel execution or empty) drives criteria phases.
export const toFlow = (
  doc: CanvasDoc,
  glyphs?: GlyphView,
): { nodes: FlowNode[]; edges: FlowEdge[] } => {
  const graph = deriveExecutionGraph(doc, glyphs ?? new Map());

  const nodes: FlowNode[] = doc.nodes.map((node) => {
    const isGroup = node.type === "group";
    return {
      id: node.id,
      type: node.type,
      position: { x: node.x, y: node.y },
      data: { node, blocked: graph.blocked.has(node.id) },
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
    const phase = graph.phaseByEdgeId.get(edge.id) ?? "relates";
    const detail = graph.detailByEdgeId.get(edge.id) ?? "";
    // Project live phase onto a shallow edge copy so filters / labels see it
    // without mutating the document.
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
        rippling: graph.blockedEdgeIds.has(edge.id),
        phase,
        detail,
      },
      zIndex: 2,
    };
  });

  return { nodes, edges };
};
