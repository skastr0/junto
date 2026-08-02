import { MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import type { CanvasDoc, CanvasEdge, CanvasNode, EdgePhase } from "@shared/canvas";
import {
  deriveExecutionGraph,
  type ExecutionGraphContext,
} from "@shared/execution-graph";
import type { ExecutionSnapshot } from "@shared/ipc";
import { edgeMaskAllows } from "@shared/physics";
import { AGENT_NODE_SIZE } from "./node-geometry";
import { isLabelNode, nodeTitle, searchText } from "./presentation";

export type NodeData = {
  node: CanvasNode;
  blocked: boolean;
};

/** Renderer-only edge grammar. Durable edge meaning remains in CanvasEdge. */
export type EdgeVisualRole =
  | "task-flow"
  | "request-flow"
  | "artifact-flow"
  | "scheduler-flow"
  /** Agent↔agent with msg.send granted — collab link (amber, medium weight). */
  | "agent-msg"
  | "soft-relation";

export type EdgeData = {
  edge: CanvasEdge;
  rippling: boolean;
  phase: EdgePhase;
  detail: string;
  visualRole: EdgeVisualRole;
  /** Focus selection member (stoppage cone or direct connection neighborhood). */
  impact?: "in";
};

export type FlowNode = Node<NodeData>;
export type FlowEdge = Edge<EdgeData>;

export { searchText } from "./presentation";

// Live overlay from the kernel cycle (derived phases + blocked closure).
// When absent, toFlow falls back to pure deriveExecutionGraph(doc, context),
// resolving task ownership only through compiled actor refs.
export type ExecutionOverlay = Pick<
  ExecutionSnapshot,
  "phaseByEdgeId" | "detailByEdgeId" | "blocked" | "blockedEdgeIds"
>;

/** Cached edge entry: source doc edge (identity) + projected FlowEdge. */
type CachedFlowEdge = {
  readonly source: CanvasEdge;
  readonly flow: FlowEdge;
};

/** Mutable identity cache — reuse FlowNode/FlowEdge objects when inputs are unchanged. */
export type FlowIdentityCache = {
  readonly nodes: Map<string, FlowNode>;
  readonly edges: Map<string, CachedFlowEdge>;
};

export const createFlowIdentityCache = (): FlowIdentityCache => ({
  nodes: new Map(),
  edges: new Map(),
});

const entityKind = (node: CanvasNode | undefined): string | undefined =>
  node?.ether?.entity?.kind;

/** True when the effective edge mask leaves msg.send available. */
export const edgeHasMsgSend = (edge: CanvasEdge): boolean =>
  edgeMaskAllows(edge, "msg.send");

/**
 * Pair-aware visual projection. This is intentionally not a canvas contract:
 * drawing or deleting the same edge keeps exactly the same product authority.
 */
export const edgeVisualRole = (
  edge: CanvasEdge,
  source: CanvasNode | undefined,
  target: CanvasNode | undefined,
): EdgeVisualRole => {
  const from = entityKind(source);
  const to = entityKind(target);
  const connects = (a: string, b: string): boolean =>
    (from === a && to === b) || (from === b && to === a);
  // Resting construction describes the connected pair, not authored
  // direction. Direction remains meaningful for authority and event travel.
  if (connects("task", "agent")) return "task-flow";
  if (connects("agent", "requests")) return "request-flow";
  if (connects("agent", "artifacts")) return "artifact-flow";
  // Agent↔agent with msg.send is a live collab link — amber presentation only
  // when the effective port is enabled (an explicit mask may attenuate it).
  if (connects("agent", "agent") && edgeHasMsgSend(edge)) return "agent-msg";
  if (
    edge.ether?.effect &&
    (from === "cron" || from === "timer" || from === "gauge" || from === "watcher" || from === "relay")
  ) {
    return "scheduler-flow";
  }
  return "soft-relation";
};

// CanvasDoc -> React Flow. Optional kernel execution overlay carries the
// main-process phase snapshot so the canvas does not re-derive it.
// Optional identity cache reuses prior FlowNode/FlowEdge objects when the
// doc node ref + blocked (or source edge ref + phase/detail/rippling) are
// unchanged so React re-renders only the nodes that actually changed.
export const toFlow = (
  doc: CanvasDoc,
  context: ExecutionGraphContext,
  execution?: ExecutionOverlay | null,
  cache?: FlowIdentityCache,
): { nodes: FlowNode[]; edges: FlowEdge[] } => {
  const nodeById = new Map(doc.nodes.map((node) => [node.id, node] as const));
  // Lazy fallback: only derive offline graph when the live overlay is absent
  // (or incomplete for a given edge). Avoids walking the full graph on every
  // kernel tick that already supplies phase/blocked.
  let fallback: ReturnType<typeof deriveExecutionGraph> | null = null;
  const getFallback = () => {
    if (!fallback) fallback = deriveExecutionGraph(doc, context);
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
    if (cached && cached.data?.node === node && cached.data.blocked === isBlocked) {
      return cached;
    }
    const isGroup = node.type === "group";
    const label = isLabelNode(node);
    const visualSize = entityKind(node) === "agent"
      ? AGENT_NODE_SIZE
      : { width: node.width, height: node.height };
    const flowNode: FlowNode = {
      id: node.id,
      type: node.type,
      position: { x: node.x, y: node.y },
      data: { node, blocked: isBlocked },
      style: visualSize,
      // Groups behind wires; furniture above edges so strokes never cover faces.
      zIndex: isGroup ? 0 : 2,
      // Regions and bare labels never grow connectors.
      connectable: !isGroup && !label,
      ariaLabel: nodeTitle(node),
      focusable: true,
      selectable: true,
      draggable: true,
      // Region body must not steal rubber-band / empty-interior drags — only the
      // chrome handle moves the region (see GroupNode `.region-drag-handle`).
      ...(isGroup ? { dragHandle: ".region-drag-handle" } : {}),
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
    const visualRole = edgeVisualRole(
      edge,
      nodeById.get(edge.fromNode),
      nodeById.get(edge.toNode),
    );
    const cached = cache?.edges.get(edge.id);
    // Hit on *source* doc edge ref + live phase inputs — never compare against
    // the projected edge (which always remints ether/label).
    if (
      cached &&
      cached.source === edge &&
      cached.flow.data?.phase === phase &&
      cached.flow.data?.detail === detail &&
      cached.flow.data?.rippling === rippling &&
      cached.flow.data?.visualRole === visualRole
    ) {
      return cached.flow;
    }
    const projected: CanvasEdge = {
      ...edge,
      ether: { ...edge.ether, kind: phase },
      // Face text is phase-driven in EtherEdge; never invent "relates"/phase as label.
      label: edge.label,
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
        visualRole,
      },
      // Below non-group nodes (z=2). Selected edges may elevate via React Flow.
      zIndex: 1,
    };
    cache?.edges.set(edge.id, { source: edge, flow: flowEdge });
    return flowEdge;
  });
  if (cache) {
    for (const id of cache.edges.keys()) {
      if (!nextEdgeIds.has(id)) cache.edges.delete(id);
    }
  }

  return { nodes, edges };
};
