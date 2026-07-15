import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { SnapshotState } from "@shared/entities";
import { nodeTitle } from "../presentation";
import { aggregateRegion, partitionRegions } from "./aggregate";
import { bundleEdges } from "./bundle";
import { clusterItems, DEFAULT_CLUSTER_CELL } from "./cluster";
import type { ClusterItem, KernelLodState, LodTier } from "./types";
import type { LodFlowEdge, LodFlowNode, LodProjection } from "./flow-types";

// Fixed emblem/chip sizes. Uniform on purpose — a region emblem is the region's
// quiet stamp, not a bar chart, so every card reads the same weight and the
// field becomes a legible constellation rather than a proportional treemap.
const CARD_W = 216;
const CARD_H = 108;
const CHIP_W = 148;
const CHIP_H = 34;

const BUBBLE_MIN = 78;
const BUBBLE_MAX = 210;
const bubbleSize = (weight: number): number =>
  Math.round(Math.min(BUBBLE_MAX, Math.max(BUBBLE_MIN, 66 + Math.sqrt(Math.max(weight, 1)) * 16)));

const center = (node: CanvasNode): { x: number; y: number } => ({
  x: node.x + node.width / 2,
  y: node.y + node.height / 2,
});

// LOD nodes are ephemeral projections: never dragged, connected, deleted, or
// selected (a click dives in via onNodeClick rather than opening the inspector
// on the underlying region — no selection cross-talk with the base graph).
const readOnlyNode = <T extends LodFlowNode>(node: T): T => ({
  ...node,
  draggable: false,
  selectable: false,
  connectable: false,
  focusable: false,
  deletable: false,
});

export interface LodProjectInput {
  readonly doc: CanvasDoc;
  readonly tier: Exclude<LodTier, "near">;
  readonly snapshots: SnapshotState;
  readonly kernel: KernelLodState;
}

// Project a document into its collapsed representation for one tier. Pure:
// doc + live snapshots + derived kernel projection in, React Flow node/edge
// shapes out. Never mutates the document, never persists an id — the emblem
// ids reuse `region.id`, chips reuse the loose node id, bubbles and bundled
// edges mint frame-local keys the assembly discards on the next projection.
export const projectLod = ({ doc, tier, snapshots, kernel }: LodProjectInput): LodProjection => {
  const byId = new Map<string, CanvasNode>(doc.nodes.map((node) => [node.id, node]));
  const { regions, looseNodeIds } = partitionRegions(doc);

  // node id → the region whose emblem now stands for it.
  const memberToRegion = new Map<string, string>();
  for (const { region, memberIds } of regions) {
    for (const id of memberIds) memberToRegion.set(id, region.id);
  }
  const regionIds = new Set(regions.map(({ region }) => region.id));
  const looseSet = new Set(looseNodeIds);

  // What a raw document node folds to at the MID tier: a member → its region
  // emblem, a loose node → its own chip, a region → its own emblem.
  const midRepresentative = (id: string): string | undefined =>
    memberToRegion.get(id) ?? (looseSet.has(id) ? id : regionIds.has(id) ? id : undefined);

  const regionCards: LodFlowNode[] = regions.map(({ region, memberIds }) => {
    const aggregate = aggregateRegion(region, memberIds, byId, snapshots, kernel);
    const c = center(region);
    return readOnlyNode({
      id: region.id,
      type: "region-card",
      position: { x: c.x - CARD_W / 2, y: c.y - CARD_H / 2 },
      data: { aggregate },
      width: CARD_W,
      height: CARD_H,
      style: { width: CARD_W, height: CARD_H },
      zIndex: 2,
    });
  });

  const chips: LodFlowNode[] = looseNodeIds
    .map((id) => byId.get(id))
    .filter((node): node is CanvasNode => node !== undefined)
    .map((node) => {
      const c = center(node);
      return readOnlyNode({
        id: node.id,
        type: "title-chip",
        position: { x: c.x - CHIP_W / 2, y: c.y - CHIP_H / 2 },
        data: {
          nodeId: node.id,
          title: nodeTitle(node),
          color: node.color,
          flags: node.ether?.flags ?? [],
          entityKind: node.ether?.entity?.kind,
          rect: { x: node.x, y: node.y, width: node.width, height: node.height },
        },
        width: CHIP_W,
        height: CHIP_H,
        style: { width: CHIP_W, height: CHIP_H },
        zIndex: 2,
      });
    });

  if (tier === "mid") {
    const edges = toLodEdges(bundleEdges(doc.edges, midRepresentative));
    return { nodes: [...regionCards, ...chips], edges };
  }

  // FAR: cluster the mid-tier emblems + chips into map bubbles.
  const items: ClusterItem[] = [
    ...regions.map(({ region, memberIds }): ClusterItem => {
      const c = center(region);
      return {
        id: region.id,
        kind: "region",
        cx: c.x,
        cy: c.y,
        label: region.label?.trim() || "region",
        weight: memberIds.length + 1,
        rect: { x: region.x, y: region.y, width: region.width, height: region.height },
      };
    }),
    ...looseNodeIds
      .map((id) => byId.get(id))
      .filter((node): node is CanvasNode => node !== undefined)
      .map((node): ClusterItem => {
        const c = center(node);
        return {
          id: node.id,
          kind: "loose",
          cx: c.x,
          cy: c.y,
          label: nodeTitle(node),
          weight: 1,
          rect: { x: node.x, y: node.y, width: node.width, height: node.height },
        };
      }),
  ];

  const clusters = clusterItems(items, DEFAULT_CLUSTER_CELL);
  const itemToCluster = new Map<string, string>();
  for (const cluster of clusters) for (const id of cluster.memberIds) itemToCluster.set(id, cluster.id);

  const bubbleNodes: LodFlowNode[] = clusters.map((bubble) => {
    const size = bubbleSize(bubble.weight);
    return readOnlyNode({
      id: bubble.id,
      type: "cluster-bubble",
      position: { x: bubble.cx - size / 2, y: bubble.cy - size / 2 },
      data: { bubble },
      width: size,
      height: size,
      style: { width: size, height: size },
      zIndex: 2,
    });
  });

  // A raw node folds first to its mid-tier item (region/chip), then to the
  // cluster that item landed in.
  const farRepresentative = (id: string): string | undefined => {
    const item = memberToRegion.get(id) ?? (looseSet.has(id) || regionIds.has(id) ? id : undefined);
    return item ? itemToCluster.get(item) : undefined;
  };
  const edges = toLodEdges(bundleEdges(doc.edges, farRepresentative));
  return { nodes: bubbleNodes, edges };
};

const toLodEdges = (
  bundled: ReturnType<typeof bundleEdges>,
): LodFlowEdge[] =>
  bundled.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "lod-edge",
    data: { kind: edge.kind, count: edge.count },
    zIndex: 1,
    selectable: false,
    focusable: false,
    deletable: false,
  }));
