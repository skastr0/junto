import type { CanvasDoc, CanvasNode, GroupNode } from "@shared/canvas";
import type { Entity, SnapshotState } from "@shared/entities";
// Runtime (value) cross-package imports MUST be relative: vitest resolves the
// `@shared/*` alias for type-only imports (erased before any resolver runs) but
// not for runtime ones under `bun run test`. Same discipline as
// entity-readout.ts. Type-only imports above keep the alias.
import { groupMembers, isGroup } from "../../../shared/graph";
import { findEntity } from "../../../shared/entities";
import type { KernelLodState, RegionAggregate, WorldRect } from "./types";

// The canvas partitioned into named regions (with their members) and the
// region-less "loose" nodes. Membership is the product's derived rule — center
// containment, recomputed per frame from geometry, never stored — reused from
// shared/graph so the LOD projection and the kernel agree on what a region
// holds.
export interface RegionPartition {
  readonly regions: ReadonlyArray<{ readonly region: GroupNode; readonly memberIds: ReadonlyArray<string> }>;
  readonly looseNodeIds: ReadonlyArray<string>;
}

export const partitionRegions = (doc: CanvasDoc): RegionPartition => {
  const members = groupMembers(doc);
  const claimed = new Set<string>();
  for (const ids of members.values()) for (const id of ids) claimed.add(id);
  const regions = doc.nodes
    .filter(isGroup)
    .map((region) => ({ region, memberIds: members.get(region.id) ?? [] }));
  const looseNodeIds = doc.nodes
    .filter((node) => !isGroup(node) && !claimed.has(node.id))
    .map((node) => node.id);
  return { regions, looseNodeIds };
};

const readNum = (entity: Entity, key: string): number | undefined => {
  const value = entity.stats[key];
  return typeof value === "number" ? value : undefined;
};

// A member's live glyph load, respecting its optional per-node orbit slice —
// exactly the narrowing entity-readout applies to a single card, summed here
// across every member so a RegionCard shows the region's whole load.
const memberGlyphLoad = (
  node: CanvasNode,
  snapshots: SnapshotState,
): { active: number; done: number; bound: boolean } => {
  let active = 0;
  let done = 0;
  let bound = false;
  const orbit = node.ether?.view?.orbit;
  for (const binding of node.ether?.bindings ?? []) {
    const bundle = snapshots.bundles.find((candidate) => candidate.source === binding.source);
    const entity = findEntity(snapshots, binding.source, binding.ref.key);
    if (!entity || !(bundle?.ok ?? false)) continue;
    bound = true;
    if (binding.source !== "tower") continue;
    active += orbit ? readNum(entity, `orbit_${orbit}`) ?? 0 : readNum(entity, "glyphs_active") ?? 0;
    done += readNum(entity, "glyphs_done") ?? 0;
  }
  return { active, done, bound };
};

const regionRect = (region: GroupNode): WorldRect => ({
  x: region.x,
  y: region.y,
  width: region.width,
  height: region.height,
});

// Collapse one region to its aggregate readout. Pure: given the region, its
// members, the live snapshots, and the derived kernel projection, it computes
// the emblem's whole readout without reading React Flow or touching the
// document.
export const aggregateRegion = (
  region: GroupNode,
  memberIds: ReadonlyArray<string>,
  byId: ReadonlyMap<string, CanvasNode>,
  snapshots: SnapshotState,
  kernel: KernelLodState,
): RegionAggregate => {
  let activeGlyphs = 0;
  let doneGlyphs = 0;
  let blockerCount = 0;
  let boundCount = 0;
  for (const id of memberIds) {
    const node = byId.get(id);
    if (!node) continue;
    if (node.ether?.flags?.includes("blocker")) blockerCount += 1;
    const load = memberGlyphLoad(node, snapshots);
    activeGlyphs += load.active;
    doneGlyphs += load.done;
    if (load.bound) boundCount += 1;
  }
  let lastPulseAt: number | undefined;
  for (const record of kernel.pulseLog) {
    if (record.regionId !== region.id) continue;
    if (lastPulseAt === undefined || record.at > lastPulseAt) lastPulseAt = record.at;
  }
  return {
    regionId: region.id,
    title: region.label?.trim() || "region",
    memberCount: memberIds.length,
    activeGlyphs,
    doneGlyphs,
    blockerCount,
    boundCount,
    armed: Boolean(kernel.armed[region.id]),
    orphaned: kernel.orphaned.includes(`${kernel.canvasName}::${region.id}`),
    lastPulseAt,
    color: region.color,
    rect: regionRect(region),
  };
};
