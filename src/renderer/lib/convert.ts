import { MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import type { CanvasDoc, CanvasEdge, CanvasNode, EdgePhase } from "@shared/canvas";
import {
  deriveExecutionGraph,
  type ExecutionGraphContext,
} from "@shared/execution-graph";
import type { ExecutionSnapshot } from "@shared/ipc";
import {
  chipPortsFromOffers,
  edgeMaskAllows,
  familyFromSlot,
  offerPortsForAccessWire,
  offersOf,
  resolveSpec,
  roleOf,
  wirePresentation,
  wireRolePair,
  type WireFamily,
  type WirePresentation,
} from "@shared/physics";
import { regionStack } from "@shared/graph";
import { AGENT_NODE_SIZE } from "./node-geometry";
import { isLabelNode, nodeTitle, searchText } from "./presentation";

// Z bands. Groups render at GROUP_Z_BASE + nesting depth so a nested region
// paints above the region containing it (depth is authoring-warned at
// MAX_REGION_DEPTH = 8, safely below the edge band); every edge sits above
// every group, and furniture (non-group nodes) sits above edges so strokes
// never cover faces.
const GROUP_Z_BASE = 0;
const EDGE_Z = 16;
const FURNITURE_Z = 32;

export type NodeData = {
  node: CanvasNode;
  blocked: boolean;
};

/** Flow edge data — durable meaning stays on CanvasEdge; paint uses wire family. */
export type EdgeData = {
  edge: CanvasEdge;
  rippling: boolean;
  phase: EdgePhase;
  detail: string;
  /** Focus selection member (stoppage cone or direct connection neighborhood). */
  impact?: "in";
  /**
   * Stable wire presentation facts computed once at convert time so EtherEdge
   * never walks the document for endpoint kinds / roles.
   */
  readonly presentation?: WirePresentation;
  readonly wireFamily?: WireFamily;
  readonly fromKind?: string;
  readonly toKind?: string;
  readonly hasMessages?: boolean;
  readonly offeredChipCount?: number;
  readonly activeChipCount?: number | "full";
};

/** Derive paint presentation for one edge without React / store peeks. */
export function edgePresentationFacts(
  edge: CanvasEdge,
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): Pick<
  EdgeData,
  | "presentation"
  | "wireFamily"
  | "fromKind"
  | "toKind"
  | "hasMessages"
  | "offeredChipCount"
  | "activeChipCount"
> {
  const fromKind = fromNode?.ether?.entity?.kind;
  const toKind = toNode?.ether?.entity?.kind;
  const fromSpec = resolveSpec({
    isGroup: fromNode?.type === "group",
    kind: fromKind,
  });
  const toSpec = resolveSpec({
    isGroup: toNode?.type === "group",
    kind: toKind,
  });
  const fromRole = roleOf(fromSpec);
  const toRole = roleOf(toSpec);
  const family =
    familyFromSlot(edge.ether?.slot, wireRolePair(fromRole, toRole)) ??
    (fromRole === "actor" || toRole === "actor" ? ("access" as const) : undefined);
  if (!family) {
    return { fromKind, toKind };
  }
  const offerSet = offerPortsForAccessWire(
    fromRole,
    toRole,
    offersOf(fromSpec),
    offersOf(toSpec),
  );
  const offeredChips = chipPortsFromOffers(offerSet);
  const portsField = edge.ether?.ports;
  const activeChipCount: number | "full" =
    portsField === undefined
      ? "full"
      : offeredChips.filter((port) => edgeMaskAllows(edge, port)).length;
  const hasMessages =
    fromRole === "actor" &&
    toRole === "actor" &&
    edgeMaskAllows(edge, "msg.send");
  const presentation = wirePresentation({
    family,
    ether: edge.ether,
    fromKind,
    toKind,
    hasMessages,
    offeredChipCount: offeredChips.length,
    activeChipCount,
  });
  return {
    presentation,
    wireFamily: family,
    fromKind,
    toKind,
    hasMessages,
    offeredChipCount: offeredChips.length,
    activeChipCount,
  };
}

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
    const isGroup = node.type === "group";
    const zIndex = isGroup
      ? GROUP_Z_BASE + regionStack(doc, node.id).length
      : FURNITURE_Z;
    const cached = cache?.nodes.get(node.id);
    if (
      cached &&
      cached.data?.node === node &&
      cached.data.blocked === isBlocked &&
      cached.zIndex === zIndex
    ) {
      return cached;
    }
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
      // Group band (base + nesting depth) behind wires; furniture above edges.
      zIndex,
      // Regions are map furniture: they never grow connectors or participate
      // in React Flow's marquee hit-test. Region chrome still selects them
      // explicitly through GroupNode's label gesture, while the transparent
      // body stays a true marquee surface. Bare labels keep their existing
      // selectable behavior.
      connectable: !isGroup && !label,
      ariaLabel: nodeTitle(node),
      focusable: true,
      selectable: !isGroup,
      draggable: !isGroup,
      // Region body must read as plain background: the whole wrapper is
      // pointer-transparent so a rubber-band drag can start inside the region
      // and reach the pane. Only the chrome inside GroupNode re-enables
      // pointer events (label drag handle, resizer, toolbar); the handle
      // implements its own drag + click-select since React Flow never sees
      // wrapper events for the node.
      ...(isGroup
        ? { style: { ...visualSize, pointerEvents: "none" as const } }
        : {}),
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
    const fromNode = nodeById.get(edge.fromNode);
    const toNode = nodeById.get(edge.toNode);
    const fromKind = fromNode?.ether?.entity?.kind;
    const toKind = toNode?.ether?.entity?.kind;
    const cached = cache?.edges.get(edge.id);
    // Hit on *source* doc edge ref + live phase inputs — never compare against
    // the projected edge (which always remints ether/label).
    if (
      cached &&
      cached.source === edge &&
      cached.flow.data?.phase === phase &&
      cached.flow.data?.detail === detail &&
      cached.flow.data?.rippling === rippling &&
      cached.flow.data?.fromKind === fromKind &&
      cached.flow.data?.toKind === toKind
    ) {
      return cached.flow;
    }
    const projected: CanvasEdge = {
      ...edge,
      ether: { ...edge.ether, kind: phase },
      // Face text is phase-driven in EtherEdge; never invent "relates"/phase as label.
      label: edge.label,
    };
    const facts = edgePresentationFacts(projected, fromNode, toNode);
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
        ...facts,
      },
      // Above every group band, below furniture. Selected edges may elevate
      // via React Flow.
      zIndex: EDGE_Z,
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
