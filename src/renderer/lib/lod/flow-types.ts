import type { Node, Edge } from "@xyflow/react";
import type { EtherEdgeKind, EtherFlag } from "@shared/canvas";
import type { ClusterBubble, RegionAggregate, WorldRect } from "./types";

// The React Flow node/edge shapes the LOD projection renders. Type-only
// @xyflow/react import → erased at transpile, so `project.ts` and its tests
// stay resolvable under vitest without pulling the runtime library.

// These are `type` aliases, not interfaces, on purpose: React Flow constrains
// node/edge `data` to `Record<string, unknown>`, and a type-alias object
// literal satisfies that index signature where an interface does not.
export type RegionCardData = {
  readonly aggregate: RegionAggregate;
};

export type TitleChipData = {
  readonly nodeId: string;
  readonly title: string;
  readonly color?: string;
  readonly flags: ReadonlyArray<EtherFlag>;
  readonly entityKind?: string;
  readonly rect: WorldRect;
};

export type ClusterBubbleData = {
  readonly bubble: ClusterBubble;
};

export type LodBundleEdgeData = {
  readonly kind: EtherEdgeKind;
  readonly count: number;
};

export type LodFlowNode =
  | Node<RegionCardData, "region-card">
  | Node<TitleChipData, "title-chip">
  | Node<ClusterBubbleData, "cluster-bubble">;

export type LodFlowEdge = Edge<LodBundleEdgeData, "lod-edge">;

export interface LodProjection {
  readonly nodes: ReadonlyArray<LodFlowNode>;
  readonly edges: ReadonlyArray<LodFlowEdge>;
}
