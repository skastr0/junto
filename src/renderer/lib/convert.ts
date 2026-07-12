import { MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import { blockedClosure, blockedEdgeIds } from "@shared/graph";
import { nodeTitle, searchText } from "./presentation";

export type NodeData = {
  node: CanvasNode;
  blocked: boolean;
};

export type EdgeData = {
  edge: CanvasEdge;
  rippling: boolean;
};

export type FlowNode = Node<NodeData>;
export type FlowEdge = Edge<EdgeData>;

export { searchText } from "./presentation";

// CanvasDoc -> React Flow. x/y -> position, width/height -> style, node.type
// selects the custom component, and derived blocked state rides along in data
// so nodes/edges can tint without re-querying the graph.
export const toFlow = (doc: CanvasDoc): { nodes: FlowNode[]; edges: FlowEdge[] } => {
  const closure = blockedClosure(doc);
  const rippling = blockedEdgeIds(doc);

  const nodes: FlowNode[] = doc.nodes.map((node) => {
    const isGroup = node.type === "group";
    return {
      id: node.id,
      type: node.type,
      position: { x: node.x, y: node.y },
      dragHandle: ".vellum-drag-handle",
      data: { node, blocked: closure.has(node.id) },
      style: { width: node.width, height: node.height },
      zIndex: isGroup ? 0 : 1,
      connectable: !isGroup,
      ariaLabel: nodeTitle(node),
      focusable: true,
      selectable: true,
      draggable: true,
    };
  });

  const edges: FlowEdge[] = doc.edges.map((edge) => ({
    id: edge.id,
    source: edge.fromNode,
    target: edge.toNode,
    sourceHandle: `s-${edge.fromSide ?? "right"}`,
    targetHandle: `t-${edge.toSide ?? "left"}`,
    markerStart: edge.fromEnd === "arrow" ? { type: MarkerType.ArrowClosed } : undefined,
    markerEnd: edge.toEnd === "arrow" ? { type: MarkerType.ArrowClosed } : undefined,
    type: "ether",
    data: { edge, rippling: rippling.has(edge.id) },
    zIndex: 2,
  }));

  return { nodes, edges };
};
