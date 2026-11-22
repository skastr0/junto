// A hover, a selection or a seat report that changes one card's quads splices
// that card's runs into the draw list, instead of rebuilding it (#915).

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, CardView, Quad } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { seat } from "./support/model-nodes";

const VIEW = { x: -100, y: -100, width: 2000, height: 1000 };

const quad = (key: string, band: Quad["band"], x: number, z = 1): Quad =>
  ({ key, kind: "shape", band, z, rect: { x, y: 0, width: 20, height: 20 }, tiers: 15, scale: { kind: "board" }, style: {} }) as unknown as Quad;

/** One quad per card; a hovered card adds a halo below and a lifted plate. */
const painter = (fact: CardFact, _live: unknown, view: CardView) => ({
  quads: view.hovered ? [quad(`${fact.id}.halo`, "cards", 0, 0), quad(`${fact.id}.body`, "cards", 1), quad(`${fact.id}.plate`, "lifted", 2)] : [quad(`${fact.id}.body`, "cards", 1)],
  dim: { opacity: 1, saturate: 1 },
  lift: 0,
});

const facts: CardFact[] = ["a", "b", "c"].map((id, index) => ({ id, row: seat(id, { x: index * 300, y: 0 }), derived: { regionDepth: 0, blocked: false, z: index } }));

const sceneOf = () => {
  const scene = createScene({ painter });
  scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: facts, wires: [] });
  return scene;
};

/** The draw list as what it draws: each record's place and kind, by its owner's placement. */
const picture = (scene: ReturnType<typeof createScene>): string[] => {
  const rows: string[] = [];
  const { f32 } = scene.quadBuffer;
  const words = new Uint32Array(f32.buffer);
  for (let index = 0; index < scene.orderCount; index += 1) {
    const at = scene.orderBuffer[index]! * 32;
    const owner = words[at + 15]!;
    rows.push(`${String(f32[at])},${String(f32[at + 1])},${String(words[at + 14])}@${String(scene.ownerBuffer[owner * 8])}`);
  }
  return rows;
};

describe("one card's repaint", () => {
  it("splices its runs where a rebuild would put them, and rebuilds nothing", () => {
    const scene = sceneOf();
    scene.prepare(VIEW, "near");
    const before = scene.orderStats();
    expect(scene.orderCount).toBe(3);

    scene.setHover("b");
    const hovered = scene.prepare(VIEW, "near");
    expect(hovered.orderChanged).toBe(true);
    expect(scene.orderStats()).toEqual({ rebuilds: before.rebuilds, splices: before.splices + 1 });
    expect(scene.bandEnds).toEqual([0, 4, 5]);

    // The same board with b hovered from the start, built whole.
    const whole = sceneOf();
    whole.setHover("b");
    whole.prepare(VIEW, "near");
    expect(picture(scene)).toEqual(picture(whole));
    expect([...scene.bandEnds]).toEqual([...whole.bandEnds]);

    // Hover moves to c: b shrinks, c grows, both spliced, the list still exact.
    scene.setHover("c");
    scene.prepare(VIEW, "near");
    const toC = sceneOf();
    toC.setHover("c");
    toC.prepare(VIEW, "near");
    expect(picture(scene)).toEqual(picture(toC));
    expect(scene.orderStats().rebuilds).toBe(before.rebuilds);

    // And off: back to the first list.
    scene.setHover(null);
    scene.prepare(VIEW, "near");
    const plain = sceneOf();
    plain.prepare(VIEW, "near");
    expect(picture(scene)).toEqual(picture(plain));
    expect(scene.bandEnds).toEqual([0, 3, 3]);
  });

  it("still rebuilds when the camera's range changes in the same frame", () => {
    const scene = sceneOf();
    scene.prepare(VIEW, "near");
    const before = scene.orderStats();
    scene.setHover("a");
    scene.prepare({ ...VIEW, x: VIEW.x + 5_000 }, "near");
    expect(scene.orderStats().rebuilds).toBe(before.rebuilds + 1);
  });
});
