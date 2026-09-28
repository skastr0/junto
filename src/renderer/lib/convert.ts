import { MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { CanvasDoc, CanvasEdge, CanvasNode, EdgePhase } from "@shared/canvas";
import {
  deriveExecutionGraph,
  type ExecutionGraphContext,
} from "@shared/execution-graph";
import type { ExecutionSnapshot } from "@shared/ipc";
import { VERB_COLOR_TOKEN, type Verb } from "@shared/physics";
import { regionStack } from "@shared/graph";
import { INSTRUMENT_KINDS, INSTRUMENT_RING_PX, renderedNodeSize, SEAT_RING_PX } from "./node-geometry";
import { regionNameSlot, sameNameSlot, type RegionNameSlot } from "./region-name-slot";
import { evenRingCaps, seatRingCaps, type RoomNode } from "./seat-ring-room";
import { isGitNode, isLabelNode, nodeTitle, searchText } from "./presentation";

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
  /**
   * Regions only: how many regions contain this one. Derived here so GroupNode
   * reads nesting off its own props instead of subscribing to the whole
   * document. Undefined for furniture.
   */
  regionDepth?: number;
  /**
   * Regions only: where the region prints its name when the camera pulls
   * back, clear of the regions and cards inside it (region-name-slot.ts).
   */
  nameSlot?: RegionNameSlot;
  /**
   * Ringed seats only: how far the ring may grow at the far tier without
   * meeting a neighbour, as a multiple of its size (seat-ring-room.ts).
   */
  ringCap?: number;
  /**
   * Agent seats only: the innermost region holding the seat, "" for none.
   * Overview clusters gather seats of one region only (seat-clusters.ts).
   */
  seatRegion?: string;
  /** Regions only: the region directly holding this one, when nested. */
  parentRegion?: string;
};

/** Flow edge data — durable meaning stays on CanvasEdge; paint reads the verb. */
export type EdgeData = {
  edge: CanvasEdge;
  rippling: boolean;
  phase: EdgePhase;
  detail: string;
  /** Focus selection member (stoppage cone or direct connection neighborhood). */
  impact?: "in";
  /** The relationship this wire is — the edge's one authored word. */
  readonly verb?: Verb;
  /** CSS custom-property name carrying that verb's hue. The whole of the paint. */
  readonly colorToken?: string;
  /**
   * Endpoint kinds, stamped once at convert so EtherEdge never walks the
   * document and the identity cache can key on them.
   */
  readonly fromKind?: string;
  readonly toKind?: string;
};

/**
 * Paint facts for one edge. An edge says one thing, so it paints one way: the
 * verb picks a colour token and nothing else varies. Weight, dash, and layer
 * count are constant across every wire on the canvas.
 */
export function edgePresentationFacts(
  edge: CanvasEdge,
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): Pick<EdgeData, "verb" | "colorToken" | "fromKind" | "toKind"> {
  const fromKind = fromNode?.ether?.entity?.kind;
  const toKind = toNode?.ether?.entity?.kind;
  const verb = edge.ether?.verb;
  if (verb === undefined) return { fromKind, toKind };
  return { verb, colorToken: VERB_COLOR_TOKEN[verb], fromKind, toKind };
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

/** The far ring's scale that region names plan around (canvas-tier.ts farSeatScale at 0.26). */
const FAR_RING_SLOT_SCALE = 3;

/** The ring's diameter for a ringed seat, undefined for any other card. */
const ringPxOf = (node: CanvasNode): number | undefined => {
  const kind = entityKind(node);
  if (kind === "agent") return SEAT_RING_PX;
  if (kind !== undefined && INSTRUMENT_KINDS.has(kind)) return INSTRUMENT_RING_PX;
  return undefined;
};

/** Every card at the size it renders at, ringed seats marked, for seatRingCaps. */
const roomNodes = (doc: CanvasDoc): RoomNode[] =>
  doc.nodes
    .filter((node) => node.type !== "group")
    .map((node) => {
      const size = renderedNodeSize(entityKind(node), node);
      const ringPx = ringPxOf(node);
      return { id: node.id, x: node.x, y: node.y, ...size, ...(ringPx !== undefined ? { ringPx } : {}) };
    });

type RegionFacts = { readonly depth: number; readonly nameSlot: RegionNameSlot };

const within = (outer: CanvasNode, inner: CanvasNode): boolean =>
  outer.id !== inner.id &&
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Name slots by region id, reused while the region's own inputs are unchanged. */
const nameSlotMemo = new Map<string, { readonly key: string; readonly slot: RegionNameSlot }>();

const rectKey = (rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): string =>
  `${String(rect.x)},${String(rect.y)},${String(rect.width)},${String(rect.height)}`;

/**
 * Nesting depth and name slot for every region, in one pass per projection.
 *
 * Only groups can contain, so regionStack over a groups-only document is the
 * identical stack at O(groups²) — the per-node call re-scanned every document
 * node for every region, on every structural rebuild including quiet kernel
 * ticks. The innermost region of a stack is the direct parent; a card's
 * parent is the smallest region holding it. A region's name slot
 * (region-name-slot.ts) avoids its direct children and the cards directly in
 * it, drawn at the size they render at.
 */
const regionFacts = (
  doc: CanvasDoc,
  ringCaps: ReadonlyMap<string, number>,
  parentOf: Map<string, string>,
): ReadonlyMap<string, RegionFacts> => {
  const groups = doc.nodes.filter((node) => node.type === "group");
  const groupsOnly: CanvasDoc = { nodes: groups, edges: [] };
  const depths = new Map<string, number>();
  const children = new Map<string, CanvasNode[]>();
  const members = new Map<string, { x: number; y: number; width: number; height: number }[]>();
  for (const group of groups) {
    const stack = regionStack(groupsOnly, group.id);
    depths.set(group.id, stack.length);
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      children.set(parent.id, [...(children.get(parent.id) ?? []), group]);
      parentOf.set(group.id, parent.id);
    }
  }
  for (const node of doc.nodes) {
    if (node.type === "group") continue;
    let parent: CanvasNode | undefined;
    for (const group of groups) {
      if (within(group, node) && (parent === undefined || group.width * group.height < parent.width * parent.height)) {
        parent = group;
      }
    }
    if (parent === undefined) continue;
    parentOf.set(node.id, parent.id);
    const size = renderedNodeSize(entityKind(node), node);
    const list = members.get(parent.id) ?? [];
    list.push({ x: node.x, y: node.y, width: size.width, height: size.height });
    // A far seat's ring reaches past its card: its name keeps clear of the
    // ring as drawn mid-way through the far tier (40px on screen at 0.26 is
    // 3x a seat ring), or of its room if that is less.
    const ringPx = ringPxOf(node);
    const cap = ringCaps.get(node.id);
    if (ringPx !== undefined && cap !== undefined) {
      const side = ringPx * Math.min(cap, FAR_RING_SLOT_SCALE);
      list.push({ x: node.x + size.width / 2 - side / 2, y: node.y + size.height / 2 - side / 2, width: side, height: side });
    }
    members.set(parent.id, list);
  }
  const facts = new Map<string, RegionFacts>();
  const live = new Set<string>();
  for (const group of groups) {
    const label = group.type === "group" ? (group.label ?? "") : "";
    const kids = children.get(group.id) ?? [];
    const cards = members.get(group.id) ?? [];
    const key = [label, rectKey(group), ...kids.map(rectKey), "|", ...cards.map(rectKey)].join(";");
    const memo = nameSlotMemo.get(group.id);
    const slot = memo?.key === key ? memo.slot : regionNameSlot(group, kids, cards, label);
    if (memo?.key !== key) nameSlotMemo.set(group.id, { key, slot });
    live.add(group.id);
    facts.set(group.id, { depth: depths.get(group.id) ?? 0, nameSlot: slot });
  }
  for (const id of nameSlotMemo.keys()) if (!live.has(id)) nameSlotMemo.delete(id);
  return facts;
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
  const roomCaps = seatRingCaps(roomNodes(doc));
  const parentOf = new Map<string, string>();
  const factsByRegionId = regionFacts(doc, roomCaps, parentOf);
  const ringCaps = evenRingCaps(roomCaps, (id) => parentOf.get(id));
  const nodes: FlowNode[] = doc.nodes.map((node) => {
    nextNodeIds.add(node.id);
    const isBlocked = blocked.has(node.id);
    const isGroup = node.type === "group";
    const facts = isGroup ? factsByRegionId.get(node.id) : undefined;
    const regionDepth = isGroup ? (facts?.depth ?? 0) : undefined;
    const nameSlot = facts?.nameSlot;
    const ringCap = ringCaps.get(node.id);
    const agent = entityKind(node) === "agent";
    const seatRegion = agent ? (parentOf.get(node.id) ?? "") : undefined;
    const parentRegion = isGroup ? parentOf.get(node.id) : undefined;
    const zIndex = isGroup ? GROUP_Z_BASE + (regionDepth ?? 0) : FURNITURE_Z;
    const cached = cache?.nodes.get(node.id);
    // Depth and name slot are part of the key: resizing one region changes
    // the nesting of regions whose own node object never moved, and moving a
    // card moves the name of the region it sits in.
    if (
      cached &&
      cached.data?.node === node &&
      cached.data.blocked === isBlocked &&
      cached.data.regionDepth === regionDepth &&
      sameNameSlot(cached.data.nameSlot, nameSlot) &&
      cached.data.ringCap === ringCap &&
      cached.data.seatRegion === seatRegion &&
      cached.data.parentRegion === parentRegion &&
      cached.zIndex === zIndex
    ) {
      return cached;
    }
    const label = isLabelNode(node);
    const git = isGitNode(node);
    const visualSize = renderedNodeSize(entityKind(node), node);
    const flowNode: FlowNode = {
      id: node.id,
      type: node.type,
      position: { x: node.x, y: node.y },
      data: { node, blocked: isBlocked, regionDepth, ...(nameSlot ? { nameSlot } : {}), ...(ringCap !== undefined ? { ringCap } : {}), ...(seatRegion !== undefined ? { seatRegion } : {}), ...(parentRegion !== undefined ? { parentRegion } : {}) },
      // A ringed seat carries its ring's room to CSS (canvas-lod.css).
      style: ringCap !== undefined ? ({ ...visualSize, "--ring-cap": String(ringCap) } as CSSProperties) : visualSize,
      // Group band (base + nesting depth) behind wires; furniture above edges.
      zIndex,
      // Regions are map furniture: they never grow connectors or participate
      // in React Flow's marquee hit-test. Region chrome still selects them
      // explicitly through GroupNode's label gesture, while the transparent
      // body stays a true marquee surface. Bare labels keep their existing
      // selectable behavior.
      connectable: !isGroup && !label && !git,
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
    // Hit on *source* doc edge ref + live phase inputs. Phase rides the flow
    // data, never a re-minted ether, so the doc edge is the whole identity.
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
    const facts = edgePresentationFacts(edge, fromNode, toNode);
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
        edge,
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
