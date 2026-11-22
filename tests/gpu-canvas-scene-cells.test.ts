// The scene's side of the atlas interface (#911/#912): a record holds a cell
// only while its quad is live (card near the screen, tier drawn or about to
// be, gate open); the draw list keeps only the tier's quads and is rebuilt
// when the grid cells around the view change; an in-view quad with no image
// is rasterized before the frame is submitted, and counted if it still has
// none.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { MotionPeaks, CardFact, Quad } from "../src/window/canvas/contract";
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

  it("are taken ahead for a tier the zoom travelled while a raster was on its way could reach", () => {
    let zoom = 0.9;
    let now = 0;
    const { scene, atlas } = sceneOf(
      (id) => [text(`${id}.near`, TIER_BIT.near), text(`${id}.mid`, TIER_BIT.mid)],
      [factAt("a", 0)],
      { zoom: () => zoom, now: () => now },
    );
    // Nothing has landed yet: no window, only the drawn tier holds.
    scene.prepare(VIEW, "near");
    expect(atlas.held()).toBe(1);
    expect(scene.blankStats().tierWindowOctaves).toBe(0);
    // A pinch from 0.9 to 0.7 while the near run's raster is on its way.
    for (const [at, next] of [[16, 0.8], [32, 0.7]] as const) {
      now = at;
      zoom = next;
      scene.prepare(VIEW, "near");
    }
    expect(scene.blankStats().tierWindowOctaves).toBe(0);
    // It lands at 100 ms: that resolve needed log2(0.9 / 0.7) octaves, and
    // 0.7 / 2^0.36 is mid, so the mid run is taken ahead and still not drawn.
    now = 100;
    atlas.land();
    scene.prepare(VIEW, "near");
    expect(scene.blankStats().tierWindowOctaves).toBeCloseTo(Math.log2(0.9 / 0.7), 9);
    // The frame after the landing builds with the new window.
    now = 116;
    scene.prepare(VIEW, "near");
    expect(scene.blankStats().latencyMs).toBe(100);
    expect(atlas.held()).toBe(2);
    expect(scene.orderCount).toBe(1);
    // The mid run lands at rest: a screen's worth of landings (one quad
    // here) needed nothing, so the window decays and the run is let go.
    now = 150;
    atlas.land();
    scene.prepare(VIEW, "near");
    scene.prepare(VIEW, "near");
    expect(scene.blankStats().tierWindowOctaves).toBe(0);
    expect(atlas.held()).toBe(1);
  });

  it("hold a margin as wide as the camera travelled while a raster was on its way", () => {
    let now = 0;
    const { scene, atlas } = sceneOf((id) => [text(id, 15)], [factAt("a", 0)], { now: () => now });
    scene.prepare(VIEW, "near");
    expect(scene.blankStats().marginScreenPx).toBe(0);
    // Two 40 px pans at zoom 1 before the raster lands: it needed 80 px.
    now = 16;
    scene.prepare({ ...VIEW, x: VIEW.x + 40 }, "near");
    now = 32;
    scene.prepare({ ...VIEW, x: VIEW.x + 80 }, "near");
    now = 50;
    atlas.land();
    scene.prepare({ ...VIEW, x: VIEW.x + 80 }, "near");
    expect(scene.blankStats().marginScreenPx).toBeCloseTo(80, 9);
    expect(scene.motionPeaks()).toEqual({ marginPx: 80, octaves: 0, latencyMs: 50 });
  });

  it("drop a kept window past the camera's zoom range, and count no cut as travel", () => {
    let now = 0;
    const { scene: kept } = (() => {
      const atlas = fakeAtlas();
      const scene = createScene({
        painter: () => ({ quads: [text("a", 15)], dim: { opacity: 1, saturate: 1 }, lift: 0 }),
        acquire: atlas.acquire,
        release: atlas.release,
        hasImage: atlas.hasImage,
        ensureNow: atlas.ensureNow,
        peaks: { marginPx: 300, octaves: 116, latencyMs: 40 },
      });
      return { scene };
    })();
    // 116 octaves is past the whole zoom range: not a measure, dropped.
    expect(kept.blankStats().tierWindowOctaves).toBe(0);
    kept.prepare(VIEW, "near");
    expect(kept.blankStats().marginScreenPx).toBe(300);
    // An old kept shape (rates, not distances) is no measure either.
    const old = createScene({
      painter: () => ({ quads: [], dim: { opacity: 1, saturate: 1 }, lift: 0 }),
      peaks: { screenSpeed: 2, zoomRate: 0.5, latencyMs: Number.NaN } as unknown as MotionPeaks,
    });
    old.prepare(VIEW, "near");
    expect(old.motionPeaks()).toEqual({ marginPx: 0, octaves: 0, latencyMs: 0 });
    // A cut of more than a whole view while a raster waits adds no travel.
    const { scene, atlas } = sceneOf((id) => [text(id, 15), text(`${id}.b`, 15)], [factAt("a", 0), factAt("b", 1_000)], { now: () => now });
    scene.prepare({ ...VIEW, width: 2_000 }, "near");
    now = 16;
    scene.prepare({ ...VIEW, width: 2_000, x: VIEW.x + 1 }, "near");
    now = 32;
    scene.prepare({ ...VIEW, width: 2_000, x: VIEW.x + 1 + 40_000 }, "near");
    now = 48;
    scene.prepare({ ...VIEW, width: 2_000, x: VIEW.x + 1 }, "near");
    now = 60;
    atlas.land();
    scene.prepare({ ...VIEW, width: 2_000, x: VIEW.x + 1 }, "near");
    expect(scene.blankStats().marginScreenPx).toBeLessThanOrEqual(1);
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

describe("the drawn parts hook", () => {
  it("lists every built quad of a card with its placed rect, cell and image, drawn or not", () => {
    const { scene, atlas } = sceneOf(
      (id) => [text(`${id}.near`, TIER_BIT.near), { ...text(`${id}.far`, TIER_BIT.far), style: { ink: { token: "ink-2" } } }],
      [factAt("a", 40, 10)],
    );
    scene.prepare(VIEW, "near");
    const parts = scene.partsOf("a");
    expect(parts.map((part) => part.key).sort()).toEqual(["a.far", "a.near"]);
    const near = parts.find((part) => part.key === "a.near")!;
    expect(near).toMatchObject({ kind: "text", drawn: true, hasImage: false, rect: { x: 48, y: 22, width: 120, height: 16 } });
    expect(near.cell).toBeDefined();
    const far = parts.find((part) => part.key === "a.far")!;
    expect(far).toMatchObject({ drawn: false, hasImage: false, ink: "ink-2" });
    expect(far.cell).toBeUndefined();
    atlas.land();
    expect(scene.partsOf("a").find((part) => part.key === "a.near")!.hasImage).toBe(true);
    expect(scene.partsOf("nobody")).toEqual([]);
  });
});

describe("the cull grid", () => {
  it("finds cards at any distance, with no cell key collisions past 16 bits", async () => {
    const { RectGrid, CARD_CELL } = await import("../src/window/canvas/engine/grid");
    const grid = new RectGrid(CARD_CELL);
    const far = 32768 * CARD_CELL;
    grid.set(1, { x: 0, y: 0, width: 10, height: 10 });
    grid.set(2, { x: far * 2, y: 0, width: 10, height: 10 });
    grid.set(3, { x: 0, y: -far * 3, width: 10, height: 10 });
    grid.set(4, { x: 2 ** 26 * CARD_CELL, y: 5, width: 10, height: 10 });
    const at = (rect: { x: number; y: number; width: number; height: number }) => {
      const out: number[] = [];
      grid.query(rect, out);
      return out;
    };
    expect(at({ x: -5, y: -5, width: 20, height: 20 })).toEqual([1]);
    expect(at({ x: far * 2 - 5, y: -5, width: 20, height: 20 })).toEqual([2]);
    expect(at({ x: -5, y: -far * 3 - 5, width: 20, height: 20 })).toEqual([3]);
    expect(at({ x: 2 ** 26 * CARD_CELL - 5, y: 0, width: 20, height: 20 })).toEqual([4]);
  });
});

describe("the card grid", () => {
  it("walks only the board it has seen, whatever rectangle it is asked for", async () => {
    const { RectGrid } = await import("../src/window/canvas/engine/grid");
    const grid = new RectGrid(512);
    expect(grid.extent()).toBeUndefined();
    grid.set(1, { x: 0, y: 0, width: 100, height: 100 });
    grid.set(2, { x: 5_000, y: 2_000, width: 100, height: 100 });
    expect(grid.extent()).toEqual({ x: 0, y: 0, width: 512 * 10, height: 512 * 5 });
    // A margin of a trillion board units walks ten by five cells, not 10^18.
    expect(grid.query({ x: -1e12, y: -1e12, width: 2e12, height: 2e12 }, []).sort()).toEqual([1, 2]);
    grid.clear();
    expect(grid.extent()).toBeUndefined();
    expect(grid.query({ x: 0, y: 0, width: 100, height: 100 }, [])).toEqual([]);
  });
});
