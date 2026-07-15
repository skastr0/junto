import type { CanvasEdge, EtherEdgeKind } from "@shared/canvas";
import type { BundledEdge } from "./types";

// Edge bundling. At a collapsed tier a document edge no longer connects two
// visible nodes — its endpoints have been folded into a region emblem, a loose
// chip, or a cluster bubble. `represent` is that fold: node id → the id of the
// thing that now stands for it (or `undefined` when the node is not visible at
// this tier). Edges whose two endpoints fold to the SAME representative are
// intra-collapse and vanish; the rest are deduplicated onto one line per
// ordered pair, carrying the merged count and the dominant relationship kind.

// blocks dominates depends dominates relates — the strongest relationship a
// bundle carries decides its colour, so a single blocks edge inside a bundle
// still reads as a blocker.
const KIND_RANK: Record<EtherEdgeKind, number> = { blocks: 3, depends: 2, relates: 1 };
const dominantKind = (a: EtherEdgeKind, b: EtherEdgeKind): EtherEdgeKind =>
  KIND_RANK[a] >= KIND_RANK[b] ? a : b;

export const bundleEdges = (
  edges: ReadonlyArray<CanvasEdge>,
  represent: (nodeId: string) => string | undefined,
): BundledEdge[] => {
  const merged = new Map<string, { source: string; target: string; kind: EtherEdgeKind; count: number }>();
  for (const edge of edges) {
    const source = represent(edge.fromNode);
    const target = represent(edge.toNode);
    if (!source || !target || source === target) continue;
    const kind: EtherEdgeKind = edge.ether?.kind ?? "relates";
    const key = `${source}=>${target}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count += 1;
      existing.kind = dominantKind(existing.kind, kind);
    } else {
      merged.set(key, { source, target, kind, count: 1 });
    }
  }
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => ({ id, ...value } satisfies BundledEdge));
};
