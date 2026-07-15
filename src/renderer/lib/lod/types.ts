import type { EtherEdgeKind } from "@shared/canvas";
import type { PulseRecord } from "@shared/ipc";

// LOD (level-of-detail) semantic-zoom types. Everything here is a RENDER-TIME
// projection — nothing is ever persisted to the .canvas document, and every id
// minted below (`region.id` reuse, `cl:*` cluster keys, `${a}=>${b}` bundle
// keys) lives only for the current frame. The four pure modules (tier /
// aggregate / cluster / bundle) never touch React Flow; `project.ts` is the
// thin assembly that maps their output into node/edge shapes.

// A geometric rectangle in flow (world) space. Mirrors @xyflow/system `Rect`
// so a projected extent can be handed straight to `fitBounds`.
export interface WorldRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// The three level-of-detail tiers, from most to least detail.
export type LodTier = "near" | "mid" | "far";

// Kernel projection a region aggregate reads — the same derived, never-stored
// arming/pulse surface the group node already renders, passed as plain data so
// the aggregation stays a pure function.
export interface KernelLodState {
  readonly canvasName: string;
  readonly armed: Readonly<Record<string, boolean>>;
  readonly orphaned: ReadonlyArray<string>; // "canvas::region" keys
  readonly pulseLog: ReadonlyArray<PulseRecord>;
}

export const EMPTY_KERNEL_LOD: KernelLodState = {
  canvasName: "",
  armed: {},
  orphaned: [],
  pulseLog: [],
};

// The compact readout a RegionCard wears — the region collapsed to its own
// quiet emblem: how many nodes it holds, the summed live glyph load of its
// bound projects, its blocker count, and its kernel posture.
export interface RegionAggregate {
  readonly regionId: string;
  readonly title: string;
  readonly memberCount: number;
  readonly activeGlyphs: number;
  readonly doneGlyphs: number;
  readonly blockerCount: number;
  readonly boundCount: number; // members with at least one live binding
  readonly armed: boolean;
  readonly orphaned: boolean;
  readonly lastPulseAt?: number;
  readonly color?: string; // raw JSON Canvas color of the region
  readonly rect: WorldRect; // the region's own document rect (for fitBounds)
}

// One clusterable item at the far tier: a collapsed region or a loose chip.
export interface ClusterItem {
  readonly id: string; // region id or loose node id
  readonly kind: "region" | "loose";
  readonly cx: number; // center x (world)
  readonly cy: number; // center y (world)
  readonly label: string;
  readonly weight: number; // region: memberCount + 1, loose: 1
  readonly rect: WorldRect; // the item's own extent
}

// A map-style cluster bubble: a proximity grouping of items, carrying the
// count, up-to-3 dominant labels, and the bounding extent to dive into.
export interface ClusterBubble {
  readonly id: string; // ephemeral render key, never persisted
  readonly cx: number; // centroid x
  readonly cy: number; // centroid y
  readonly count: number; // items in the cluster
  readonly weight: number; // summed item weight
  readonly regionCount: number;
  readonly looseCount: number;
  readonly labels: ReadonlyArray<string>; // up to 3 dominant, weight-ranked
  readonly memberIds: ReadonlyArray<string>; // constituent item ids
  readonly extent: WorldRect; // bounding box of constituent rects
}

// A bundled edge: many cross-boundary document edges collapsed onto one line
// between two representatives, carrying the merged count and dominant kind.
export interface BundledEdge {
  readonly id: string; // ephemeral `${source}=>${target}` key
  readonly source: string;
  readonly target: string;
  readonly kind: EtherEdgeKind;
  readonly count: number;
}
