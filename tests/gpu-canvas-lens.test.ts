// The magnifier's lens draws the main scene a second time (item 13 of issue
// 915): one scene, one set of buffers, a second draw list at the lens's zoom.
// A seat the main view gathers into a badge at far draws as itself in the
// lens, a card outside the main view draws when the lens looks at it, and a
// closed lens draws nothing.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import { ringState } from "@shared/wire/rings";
import type { CardFact, CardView, Quad, SeatLive } from "../src/window/canvas/contract";
import { ALL_TIERS, LENS_ZOOM } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { agentFact } from "./canvas-paint-fixtures";

const MAIN = { x: -200, y: -200, width: 800, height: 600 };

const oneQuad = (_fact: CardFact, _live: SeatLive | undefined, _view: CardView): { quads: ReadonlyArray<Quad>; dim: { opacity: number; saturate: number }; lift: number } => ({
  quads: [{ key: "body", kind: "shape", band: "cards", z: 1, rect: { x: 0, y: 0, width: 216, height: 56 }, tiers: ALL_TIERS, scale: { kind: "board" }, style: {} }],
  dim: { opacity: 1, saturate: 1 },
  lift: 0,
});

const seat = (id: string, x: number, y: number): CardFact => ({ ...agentFact(), id, row: { ...agentFact().row, id, x, y } }) as CardFact;
const work: SeatLive = {
  ring: ringState({ glyph: "work", tone: "cyan" }),
  line: "running",
  mark: { tone: "cyan", label: "working" },
  urgency: 0,
  running: true,
  overseer: false,
  ringSince: 1_000,
};

const board = (zoom: number) => {
  const scene = createScene({ painter: oneQuad, zoom: () => zoom });
  const facts = [seat("a", 0, 0), seat("b", 40, 0), seat("c", 80, 0), seat("far-away", 3000, 3000)];
  scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: facts, wires: [] });
  for (const fact of facts) scene.apply({ kind: "seat", id: fact.id, live: work });
  return scene;
};

/** The cards a draw list names, by the quads' owners. */
const ownersOf = (scene: ReturnType<typeof createScene>, list: Uint32Array, count: number): Set<number> => {
  const words = new Uint32Array(scene.quadBuffer.f32.buffer);
  const owners = new Set<number>();
  for (let i = 0; i < count; i += 1) owners.add(words[list[i]! * 32 + 15]!);
  return owners;
};

describe("the lens draws the main scene a second time (item 13 of issue 915)", () => {
  it("draws each gathered seat as itself while the main view draws their badge", () => {
    const scene = board(0.3);
    scene.setLens({ view: { x: -100, y: -100, width: 500, height: 300 }, zoom: LENS_ZOOM });
    scene.prepare(MAIN, "far");
    // The main view: one badge where three seats sit.
    expect(scene.clusterAt({ x: 148, y: 28 })).toEqual(["a", "b", "c"]);
    expect(scene.index.cardsAt({ x: 108, y: 28 })).toEqual([]);
    // The lens: all three seat quads, and each seat answers its pick.
    expect(scene.lensCount).toBe(3);
    expect(ownersOf(scene, scene.lensOrder, scene.lensCount).size).toBe(3);
    expect(scene.lensBandEnds[2]).toBe(3);
    expect(scene.lensIndex.cardsAt({ x: 108, y: 28 })).toEqual(["a", "b", "c"]);
  });

  it("draws a card outside the main view when the lens looks at it", () => {
    const scene = board(1);
    scene.prepare(MAIN, "near");
    expect(scene.lensCount).toBe(0);
    const before = scene.lensRevision;
    scene.setLens({ view: { x: 2900, y: 2900, width: 400, height: 300 }, zoom: LENS_ZOOM });
    scene.prepare(MAIN, "near");
    expect(scene.lensCount).toBe(1);
    expect(scene.lensRevision).not.toBe(before);
    // The main list does not take the lens's card.
    expect(scene.orderCount).toBe(3);
  });

  it("draws nothing once the lens closes", () => {
    const scene = board(1);
    scene.setLens({ view: { x: -100, y: -100, width: 500, height: 300 }, zoom: LENS_ZOOM });
    scene.prepare(MAIN, "near");
    expect(scene.lensCount).toBe(3);
    scene.setLens(undefined);
    scene.prepare(MAIN, "near");
    expect(scene.lensCount).toBe(0);
    expect(scene.orderCount).toBe(3);
  });
});
