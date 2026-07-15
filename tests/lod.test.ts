import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { PulseRecord } from "../src/shared/ipc";
import type { SnapshotState } from "../src/shared/entities";
import { DEFAULT_THRESHOLDS, selectTier } from "../src/renderer/lib/lod/tier";
import { aggregateRegion, partitionRegions } from "../src/renderer/lib/lod/aggregate";
import { clusterItems } from "../src/renderer/lib/lod/cluster";
import { bundleEdges } from "../src/renderer/lib/lod/bundle";
import { projectLod } from "../src/renderer/lib/lod/project";
import type { ClusterItem, KernelLodState } from "../src/renderer/lib/lod/types";
import { EMPTY_KERNEL_LOD } from "../src/renderer/lib/lod/types";
import type { RegionCardData, TitleChipData, ClusterBubbleData } from "../src/renderer/lib/lod/flow-types";

const t = DEFAULT_THRESHOLDS;

// --- tier selection / hysteresis --------------------------------------------

describe("selectTier hysteresis", () => {
  it("holds near until below the mid-enter floor", () => {
    expect(selectTier(1.0, "near")).toBe("near");
    expect(selectTier(t.enterMid + 0.01, "near")).toBe("near");
    expect(selectTier(t.enterMid, "near")).toBe("mid");
  });

  it("holds mid until above the mid-exit ceiling — the boundary never flickers", () => {
    // A viewport parked in the hysteresis band (between enterMid and exitMid)
    // stays whatever tier it already was: near stays near, mid stays mid.
    const band = (t.enterMid + t.exitMid) / 2;
    expect(selectTier(band, "near")).toBe("near");
    expect(selectTier(band, "mid")).toBe("mid");
    expect(selectTier(t.exitMid, "mid")).toBe("near");
    expect(selectTier(t.exitMid - 0.001, "mid")).toBe("mid");
  });

  it("holds far across the mid-far band and only rises past exitFar", () => {
    const band = (t.enterFar + t.exitFar) / 2;
    expect(selectTier(band, "mid")).toBe("mid");
    expect(selectTier(band, "far")).toBe("far");
    expect(selectTier(t.enterFar, "mid")).toBe("far");
    expect(selectTier(t.exitFar, "far")).toBe("mid");
  });

  it("lets a fast zoom skip a tier in either direction", () => {
    expect(selectTier(t.enterFar - 0.05, "near")).toBe("far");
    expect(selectTier(t.exitMid + 0.1, "far")).toBe("near");
  });
});

// --- fixtures ---------------------------------------------------------------

const region = (id: string, x: number, y: number, w = 600, h = 400, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, type: "group", x, y, width: w, height: h, ...extra,
} as CanvasNode);

const member = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, type: "text", text: id, x, y, width: 200, height: 80, ...extra,
} as CanvasNode);

const towerSnapshots = (entries: ReadonlyArray<{ key: string; stats: Record<string, number> }>): SnapshotState => ({
  bundles: [
    {
      source: "tower",
      fetchedAt: "2026-07-15T00:00:00.000Z",
      ok: true,
      entities: entries.map((e) => ({ source: "tower" as const, key: e.key, kind: "project", stats: e.stats, updatedAt: "2026-07-15T00:00:00.000Z" })),
    },
  ],
});

// --- partition + aggregate --------------------------------------------------

describe("partitionRegions", () => {
  it("assigns members by center containment and leaves the rest loose", () => {
    const doc: CanvasDoc = {
      nodes: [
        region("R", 0, 0, 600, 400),
        member("in", 100, 100), // center 200,140 inside R
        member("out", 900, 900), // loose
      ],
      edges: [],
    };
    const { regions, looseNodeIds } = partitionRegions(doc);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.memberIds).toEqual(["in"]);
    expect(looseNodeIds).toEqual(["out"]);
  });
});

describe("aggregateRegion", () => {
  const doc: CanvasDoc = {
    nodes: [
      region("R", 0, 0, 800, 600, { label: "  Ops  ", color: "3" }),
      member("a", 100, 100, {
        ether: { entity: { kind: "project" }, bindings: [{ source: "tower", ref: { type: "project", key: "prism" } }] },
      }),
      member("b", 300, 100, {
        ether: { entity: { kind: "project" }, bindings: [{ source: "tower", ref: { type: "project", key: "beacon" } }], view: { orbit: "forge" } },
      }),
      member("c", 100, 300, { ether: { flags: ["blocker"] } }),
    ],
    edges: [],
  };
  const snapshots = towerSnapshots([
    { key: "prism", stats: { glyphs_active: 12, glyphs_done: 40 } },
    { key: "beacon", stats: { glyphs_active: 99, orbit_forge: 3, glyphs_done: 7 } },
  ]);

  it("sums live glyph load, respecting each member's orbit slice", () => {
    const { regions } = partitionRegions(doc);
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const agg = aggregateRegion(regions[0]!.region, regions[0]!.memberIds, byId, snapshots, EMPTY_KERNEL_LOD);
    expect(agg.title).toBe("Ops"); // trimmed
    expect(agg.memberCount).toBe(3);
    // prism global 12 + beacon sliced to orbit_forge (3), NOT its global 99.
    expect(agg.activeGlyphs).toBe(15);
    expect(agg.doneGlyphs).toBe(47);
    expect(agg.blockerCount).toBe(1);
    expect(agg.boundCount).toBe(2);
    expect(agg.color).toBe("3");
    expect(agg.rect).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("reads armed / orphaned / last-pulse from the kernel projection only", () => {
    const { regions } = partitionRegions(doc);
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const pulse = (at: number): PulseRecord => ({ id: `p${at}`, at, canvasName: "demo", sourceNodeId: "a", regionId: "R", kind: "manual", summary: "", delivered: [], dry: false });
    const kernel: KernelLodState = {
      canvasName: "demo",
      armed: { R: true },
      orphaned: ["demo::R"],
      pulseLog: [pulse(1000), pulse(5000), { ...pulse(9000), regionId: "OTHER" }],
    };
    const agg = aggregateRegion(regions[0]!.region, regions[0]!.memberIds, byId, snapshots, kernel);
    expect(agg.armed).toBe(true);
    expect(agg.orphaned).toBe(true);
    expect(agg.lastPulseAt).toBe(5000); // newest for THIS region; the OTHER one ignored
  });
});

// --- clustering -------------------------------------------------------------

describe("clusterItems", () => {
  const item = (id: string, cx: number, cy: number, kind: "region" | "loose" = "region", weight = 1): ClusterItem => ({
    id, kind, cx, cy, label: id, weight, rect: { x: cx - 50, y: cy - 50, width: 100, height: 100 },
  });

  it("buckets nearby items and separates distant ones", () => {
    const clusters = clusterItems([
      item("a", 100, 100),
      item("b", 200, 150), // same 900-cell as a
      item("c", 5000, 5000), // far away
    ], 900);
    expect(clusters).toHaveLength(2);
    const big = clusters.find((c) => c.count === 2)!;
    expect([...big.memberIds]).toEqual(["a", "b"]);
    expect(big.extent.width).toBeGreaterThan(100); // union spans both rects
  });

  it("ranks up to three dominant labels by weight then name, and is deterministic", () => {
    const items = [
      item("light", 100, 100, "loose", 1),
      item("heavy", 150, 120, "region", 9),
      item("mid", 120, 140, "region", 4),
      item("tiny", 160, 110, "loose", 1),
    ];
    const [cluster] = clusterItems(items, 900);
    expect(cluster!.labels).toEqual(["heavy", "mid", "light"]); // weight desc, ties by name
    expect(cluster!.regionCount).toBe(2);
    expect(cluster!.looseCount).toBe(2);
    // Re-running yields byte-identical output.
    expect(clusterItems(items, 900)).toEqual(clusterItems([...items].reverse(), 900));
  });
});

// --- bundling ---------------------------------------------------------------

describe("bundleEdges", () => {
  const rep = new Map<string, string>([["a1", "A"], ["a2", "A"], ["b1", "B"], ["b2", "B"]]);
  const represent = (id: string): string | undefined => rep.get(id);

  it("drops intra-representative edges and dedupes cross edges with a count", () => {
    const bundled = bundleEdges([
      { id: "e1", fromNode: "a1", toNode: "a2", ether: { kind: "relates" } }, // intra A → dropped
      { id: "e2", fromNode: "a1", toNode: "b1", ether: { kind: "relates" } },
      { id: "e3", fromNode: "a2", toNode: "b2", ether: { kind: "depends" } }, // same A→B pair
      { id: "e4", fromNode: "a1", toNode: "zzz" }, // zzz not represented → dropped
    ], represent);
    expect(bundled).toHaveLength(1);
    expect(bundled[0]!.source).toBe("A");
    expect(bundled[0]!.target).toBe("B");
    expect(bundled[0]!.count).toBe(2);
    expect(bundled[0]!.kind).toBe("depends"); // dominant over relates
  });

  it("lets a single blocks edge dominate a bundle's colour", () => {
    const bundled = bundleEdges([
      { id: "e1", fromNode: "a1", toNode: "b1", ether: { kind: "relates" } },
      { id: "e2", fromNode: "a2", toNode: "b2", ether: { kind: "blocks" } },
    ], represent);
    expect(bundled[0]!.kind).toBe("blocks");
  });
});

// --- projection assembly ----------------------------------------------------

const demoDoc: CanvasDoc = {
  nodes: [
    region("R1", 0, 0, 600, 400, { label: "Alpha" }),
    member("m1", 100, 100),
    member("m2", 300, 100),
    region("R2", 2000, 0, 600, 400, { label: "Beta" }),
    member("m3", 2100, 100),
    member("loose1", 5000, 5000), // far loose node
  ],
  edges: [
    { id: "x1", fromNode: "m1", toNode: "m2", ether: { kind: "relates" } }, // intra R1
    { id: "x2", fromNode: "m1", toNode: "m3", ether: { kind: "depends" } }, // R1 → R2
    { id: "x3", fromNode: "m2", toNode: "m3", ether: { kind: "blocks" } }, // R1 → R2 again
  ],
};

describe("projectLod", () => {
  it("mid tier: emblems + chips, member nodes gone, cross edges bundled with count", () => {
    const { nodes, edges } = projectLod({ doc: demoDoc, tier: "mid", snapshots: { bundles: [] }, kernel: EMPTY_KERNEL_LOD });
    const cards = nodes.filter((n) => n.type === "region-card");
    const chips = nodes.filter((n) => n.type === "title-chip");
    expect(cards.map((c) => c.id).sort()).toEqual(["R1", "R2"]); // emblem id === region id
    expect(chips.map((c) => c.id)).toEqual(["loose1"]);
    expect(nodes.every((n) => n.draggable === false && n.connectable === false)).toBe(true);
    // R1↔R2 collapses from two document edges into one bundled line, count 2,
    // blocks dominating; the intra-R1 edge is gone.
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe("R1");
    expect(edges[0]!.target).toBe("R2");
    expect(edges[0]!.data!.count).toBe(2);
    expect(edges[0]!.data!.kind).toBe("blocks");
    // The emblem centers on the region and carries a fitBounds rect.
    const alpha = cards.find((c) => c.id === "R1")!;
    expect((alpha.data as RegionCardData).aggregate.rect).toEqual({ x: 0, y: 0, width: 600, height: 400 });
    expect((chips[0]!.data as TitleChipData).title).toBe("loose1");
  });

  it("far tier: proximity bubbles carrying counts, labels, and a dive extent", () => {
    const { nodes } = projectLod({ doc: demoDoc, tier: "far", snapshots: { bundles: [] }, kernel: EMPTY_KERNEL_LOD });
    expect(nodes.every((n) => n.type === "cluster-bubble")).toBe(true);
    // R1+R2 sit within one 900-cell span apart? R1 center ~300, R2 center ~2300
    // → different cells; loose1 at 5000 → a third. Expect 3 bubbles.
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    const withCount = nodes.map((n) => (n.data as ClusterBubbleData).bubble);
    for (const bubble of withCount) {
      expect(bubble.count).toBeGreaterThanOrEqual(1);
      expect(bubble.extent.width).toBeGreaterThan(0);
      expect(bubble.labels.length).toBeGreaterThanOrEqual(1);
    }
  });
});
