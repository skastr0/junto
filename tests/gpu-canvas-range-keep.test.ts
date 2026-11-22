// The order list's range is kept while it still holds the view (issue 915): a
// slow pan or zoom at far used to cross a cell edge nearly every frame, and
// each crossing rebuilt the whole list.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, Quad, Rect } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { seat } from "./support/model-nodes";

const body = (): Quad[] =>
  [{ key: "body", kind: "shape", band: "cards", z: 1, rect: { x: 0, y: 0, width: 200, height: 60 }, tiers: 15, scale: { kind: "board" }, style: {} }] as unknown as Quad[];

const board = (): CardFact[] =>
  Array.from({ length: 400 }, (_, i) => {
    const row = { ...seat(`s${String(i)}`), x: (i % 20) * 900, y: Math.floor(i / 20) * 700 };
    return { id: row.id, row, derived: { regionDepth: 0, blocked: false, z: i } } as CardFact;
  });

const viewAt = (zoom: number, cx: number, cy: number): Rect => {
  const width = 1600 / zoom;
  const height = 1000 / zoom;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
};

describe("the order list's range", () => {
  it("rebuilds a handful of times across a slow far pan and a slow zoom, not each frame", () => {
    let zoom = 0.15;
    const scene = createScene({ painter: () => ({ quads: body(), dim: { opacity: 1, saturate: 1 }, lift: 0 }), zoom: () => zoom });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: board(), wires: [] });
    scene.prepare(viewAt(zoom, 9000, 7000), "far");
    const start = scene.orderStats().rebuilds;
    // Two screen pixels a frame for 200 frames: a quarter of the view.
    for (let frame = 0; frame < 200; frame += 1) scene.prepare(viewAt(zoom, 9000 + (frame * 2) / zoom, 7000), "far");
    const panned = scene.orderStats().rebuilds - start;
    expect(panned).toBeLessThanOrEqual(3);
    // A slow zoom in from 0.15 to 0.2 over 100 frames, still far.
    for (let frame = 0; frame <= 100; frame += 1) {
      zoom = 0.15 * (0.2 / 0.15) ** (frame / 100);
      scene.prepare(viewAt(zoom, 9000, 7000), "far");
    }
    expect(scene.orderStats().rebuilds - start - panned).toBeLessThanOrEqual(3);
  });

  it("always covers the view: every card the view touches is in the list", () => {
    let zoom = 0.15;
    const scene = createScene({ painter: () => ({ quads: body(), dim: { opacity: 1, saturate: 1 }, lift: 0 }), zoom: () => zoom });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: board(), wires: [] });
    for (let frame = 0; frame < 120; frame += 1) {
      zoom = 0.15 * 2 ** Math.sin(frame / 20);
      const view = viewAt(zoom, 4000 + frame * 60, 5000 - frame * 30);
      scene.prepare(view, zoom < 0.3 ? "far" : "overview");
      const touched = board().filter((fact) => fact.row.x < view.x + view.width && fact.row.x + 200 > view.x && fact.row.y < view.y + view.height && fact.row.y + 60 > view.y).length;
      expect(scene.orderCount).toBeGreaterThanOrEqual(touched);
    }
  });
});
