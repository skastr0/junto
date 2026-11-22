// The scene's side of the atlas interface (#911/#912): a record holds a cell
// only while its quad is live (card near the screen, tier drawn or about to
// be, gate open); the draw list keeps only the tier's quads and is rebuilt
// when the grid cells around the view change; an in-view quad with no image
// is rasterized before the frame is submitted, and counted if it still has
// none.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, Quad } from "../src/window/canvas/contract";
import { TIER_BIT } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { NO_ATLAS_CELL, QUAD_FLOATS } from "../src/window/canvas/engine/quad";
import { seat } from "./support/model-nodes";

const factAt = (id: string, x: number, y = 0): CardFact => ({
  id,
  row: seat(id, { x, y }),
  derived: { regionDepth: 0, blocked: false, z: 0 },
});

const text = (key: string, tiers: number): Quad => ({
  key,
  kind: "text",
  band: "cards",
  z: 1,
  rect: { x: 8, y: 12, width: 120, height: 16 },
  tiers,
  scale: { kind: "board" },
  style: {},
  text: { text: key, font: "mono", size: 12, weight: 500, truncate: "end", width: 120 },
});

/** A reference-counting atlas: one cell per (text, scale), images land on `land()`. */
const fakeAtlas = () => {
  const cells = new Map<string, number>();
  const refs = new Map<number, number>();
  const landed = new Set<number>();
  const ensured: number[] = [];
  let acquires = 0;
  let releases = 0;
  return {
    acquire: (quad: Quad, scale: number, previous?: number): number => {
      acquires += 1;
      const key = `${quad.text?.text ?? quad.key}@${String(scale)}`;
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = cells.size;
        cells.set(key, cell);
      }
      if (previous !== cell) {
        refs.set(cell, (refs.get(cell) ?? 0) + 1);
        if (previous !== undefined) {
          releases += 1;
          refs.set(previous, (refs.get(previous) ?? 0) - 1);
        }
      }
      return cell;
    },
    release: (cell: number): void => {
      releases += 1;
      refs.set(cell, (refs.get(cell) ?? 0) - 1);
    },
    hasImage: (cell: number): boolean => landed.has(cell),
    ensureNow: (cell: number): void => {
      ensured.push(cell);
    },
    land: (): void => {
      for (const cell of cells.values()) landed.add(cell);
    },
    held: (): number => [...refs.values()].reduce((sum, count) => sum + count, 0),
    ensured,
    counts: () => ({ acquires, releases }),
  };
};

const VIEW = { x: -100, y: -100, width: 800, height: 600 };
const FAR_AWAY = { ...VIEW, x: 60_000 };

const sceneOf = (
  quads: (id: string) => ReadonlyArray<Quad>,
  cards: ReadonlyArray<CardFact>,
  options: { zoom?: () => number; settled?: () => boolean; now?: () => number } = {},
) => {
  const atlas = fakeAtlas();
  const painted: string[] = [];
  const scene = createScene({
    painter: (fact) => {
      painted.push(fact.id);
      return { quads: quads(fact.id), dim: { opacity: 1, saturate: 1 }, lift: 0 };
    },
    acquire: atlas.acquire,
    release: atlas.release,
    hasImage: atlas.hasImage,
    ensureNow: atlas.ensureNow,
    ...options,
  });
  scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards, wires: [] });
  return { scene, atlas, painted };
};

const cell = (scene: ReturnType<typeof createScene>, slot: number): number =>
  scene.quadBuffer.u32[slot * QUAD_FLOATS + 23]!;

describe("cells a record holds", () => {
  it("are taken only for cards near the screen and the tier drawn", () => {
    const { scene, atlas, painted } = sceneOf(
      (id) => [text(`${id}.near`, TIER_BIT.near), text(`${id}.far`, TIER_BIT.far)],
      [factAt("a", 0), factAt("b", 50_000)],
    );
    // A load builds nothing and asks the atlas for nothing.
    expect(painted).toEqual([]);
    expect(atlas.counts().acquires).toBe(0);
    scene.prepare(VIEW, "near");
    expect(painted).toEqual(["a"]);
    // The near run holds a cell; the far run, not drawn and not ahead, holds none.
    expect(atlas.held()).toBe(1);
    expect([cell(scene, 0), cell(scene, 1)].filter((held) => held !== NO_ATLAS_CELL)).toHaveLength(1);
    // Only the tier's own quad is in the draw list.
    expect(scene.orderCount).toBe(1);
  });

  it("are let go when the card leaves the view and taken again when it returns", () => {
    const { scene, atlas } = sceneOf((id) => [text(id, 15)], [factAt("a", 0)]);
    scene.prepare(VIEW, "near");
    expect(atlas.held()).toBe(1);
    scene.prepare(FAR_AWAY, "near");
    expect(atlas.held()).toBe(0);
    expect(scene.orderCount).toBe(0);
    scene.prepare(VIEW, "near");
    expect(atlas.held()).toBe(1);
    expect(scene.orderCount).toBe(1);
  });

  it("are taken ahead for a tier the measured zoom rate could reach before a raster lands", () => {
    let zoom = 0.72;
    let now = 0;
    const { scene, atlas } = sceneOf(
      (id) => [text(`${id}.near`, TIER_BIT.near), text(`${id}.mid`, TIER_BIT.mid)],
      [factAt("a", 0)],
      { zoom: () => zoom, now: () => now },
    );
    // Nothing has moved or landed yet: no window, only the drawn tier holds.
    scene.prepare(VIEW, "near");
    expect(atlas.held()).toBe(1);
    expect(scene.blankStats().tierWindowOctaves).toBe(0);
    // The near run's raster lands 100 ms later: that is the latency.
    now = 100;
    atlas.land();
    scene.prepare(VIEW, "near");
    expect(scene.blankStats().peakLatencyMs).toBe(100);
    // A pinch: log2(0.72 / 0.7) octaves in one 16 ms frame. Over 100 ms that
    // is about a quarter octave, and 0.7 / 2^0.25 is mid: the mid run is
    // taken ahead, and still not drawn.
    now = 116;
    zoom = 0.7;
    scene.prepare(VIEW, "near");
    const window = scene.blankStats().tierWindowOctaves;
    expect(window).toBeCloseTo((Math.log2(0.72 / 0.7) / 16) * 100, 9);
    expect(atlas.held()).toBe(2);
    expect(scene.orderCount).toBe(1);
  });

  it("hold a margin the fastest pan reveals before a raster lands", () => {
    let now = 0;
    const { scene, atlas } = sceneOf((id) => [text(id, 15)], [factAt("a", 0)], { now: () => now });
    scene.prepare(VIEW, "near");
    now = 50;
    atlas.land();
    scene.prepare(VIEW, "near");
    // A 40 px pan in a 16 ms frame at zoom 1: 2.5 px/ms, times 50 ms.
    now = 66;
    scene.prepare({ ...VIEW, x: VIEW.x + 40 }, "near");
    expect(scene.blankStats().marginScreenPx).toBeCloseTo(125, 9);
    // A cut of more than a whole view is not a pan: the margin stands.
    now = 82;
    scene.prepare({ ...VIEW, x: VIEW.x + 40_000 }, "near");
    expect(scene.blankStats().marginScreenPx).toBeCloseTo(125, 9);
  });

  it("are taken for a camera jump's destination before the camera lands, and let go once cleared", () => {
    const { scene, atlas, painted } = sceneOf((id) => [text(id, 15)], [factAt("a", 0), factAt("b", 60_100)]);
    scene.prepare(VIEW, "near");
    expect(atlas.held()).toBe(1);
    scene.prefetch({ view: FAR_AWAY, zoom: 1 });
    scene.prepare(VIEW, "near");
    expect(painted).toContain("b");
    expect(atlas.held()).toBe(2);
    // The destination is not drawn until the camera is there.
    expect(scene.orderCount).toBe(1);
    scene.prefetch(null);
    scene.prepare(VIEW, "near");
    expect(atlas.held()).toBe(1);
  });

  it("all go back to the atlas on a new load", () => {
    const { scene, atlas } = sceneOf((id) => [text(`${id}.1`, 15), text(`${id}.2`, 15)], [factAt("a", 0), factAt("b", 300)]);
    scene.prepare(VIEW, "near");
    expect(atlas.held()).toBe(4);
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [], wires: [] });
    expect(atlas.held()).toBe(0);
  });

  it("follow a repaint that changes the words: the atlas is handed the cell held", () => {
    let words = "first";
    const { scene, atlas } = sceneOf(() => [{ ...text("line", 15), text: { ...text("line", 15).text!, text: words } }], [factAt("a", 0)]);
    scene.prepare(VIEW, "near");
    const before = cell(scene, 0);
    words = "second";
    scene.apply({ kind: "seat", id: "a", live: undefined as never });
    expect(cell(scene, 0)).not.toBe(before);
    expect(atlas.held()).toBe(1);
  });
});

describe("the draw list", () => {
  it("is not rebuilt while the view pans inside the same grid cells", () => {
    const { scene, painted } = sceneOf((id) => [text(id, 15)], [factAt("a", 0)]);
    scene.prepare(VIEW, "near");
    painted.length = 0;
    const panned = scene.prepare({ ...VIEW, x: VIEW.x + 3 }, "near");
    expect(panned.orderChanged).toBe(false);
    expect(painted).toEqual([]);
  });

  it("releases the quads of a card well off screen, and builds them again when it comes back", () => {
    const { scene, painted } = sceneOf((id) => [text(id, 15)], [factAt("a", 0)]);
    scene.prepare(VIEW, "near");
    expect(scene.quadCount).toBe(1);
    scene.prepare(FAR_AWAY, "near");
    painted.length = 0;
    scene.prepare(VIEW, "near");
    expect(painted).toEqual(["a"]);
  });
});

describe("an in-view quad with no image", () => {
  it("is rasterized before the frame is submitted, every frame, and counted while it stays blank", () => {
    const { scene, atlas } = sceneOf((id) => [text(id, 15)], [factAt("a", 0)]);
    scene.prepare(VIEW, "near");
    expect(atlas.ensured).toHaveLength(1);
    expect(scene.blankStats().visibleBlank).toBe(1);
    // A still frame checks again: the guarantee is per presented frame.
    scene.prepare(VIEW, "near");
    expect(atlas.ensured).toHaveLength(2);
    atlas.land();
    scene.prepare(VIEW, "near");
    expect(scene.blankStats().visibleBlank).toBe(0);
    scene.prepare(VIEW, "near");
    expect(atlas.ensured).toHaveLength(2);
  });

  it("is caught when it pans from the margin into the view between rebuilds", () => {
    // The card sits just right of the view, inside the grid cells around it: built and held, not in view.
    const { scene, atlas } = sceneOf((id) => [text(id, 15)], [factAt("a", 720)]);
    scene.prepare(VIEW, "near");
    expect(atlas.held()).toBe(1);
    expect(atlas.ensured).toHaveLength(0);
    expect(scene.blankStats().visibleBlank).toBe(0);
    // A pan small enough to stay in the same cells brings it into view.
    const panned = { ...VIEW, x: VIEW.x + 60 };
    expect(scene.prepare(panned, "near").orderChanged).toBe(false);
    expect(atlas.ensured).toHaveLength(1);
    expect(scene.blankStats().visibleBlank).toBe(1);
  });
});
