// Section 10's motion at the scene and the engine: a ring's moving parts draw
// only while motion runs (its rest pose only while it does not), and a camera
// gesture keeps the raster it already holds instead of re-resolving every
// visible run on every tick (section 8 rule 2).

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import {
  ALL_TIERS,
  type CardFact,
  type CardPaint,
  type Quad,
  type QuadMotion,
} from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { createEngine, type EngineHost } from "../src/window/canvas/engine/engine";
import { NO_ATLAS_CELL, QUAD_FLOATS } from "../src/window/canvas/engine/quad";
import { paintSeat } from "../src/window/canvas/paint/seat";
import { SEAT, SEAT_RING_CENTRE } from "../src/window/canvas/paint/card-spec";
import { agentFact, fakeEnv, seatLive, view } from "./canvas-paint-fixtures";
import { fakeContext, fakeGpu, fakeScheduler, settle } from "./gpu-canvas-fakes";

const VIEW_RECT = { x: -200, y: -200, width: 800, height: 600 };
const RING_RECT = { x: SEAT.rowLeft, y: SEAT.rowTop, width: SEAT.ring, height: SEAT.ring };

const paintCard = (fact: CardFact, live: Parameters<typeof paintSeat>[1], cardView: Parameters<typeof paintSeat>[2]): CardPaint =>
  paintSeat(fact, live, cardView, fakeEnv);

const ringQuadsOf = (): ReadonlyArray<Quad> => {
  const ringScale = { kind: "seat" as const, cap: 1, anchor: SEAT_RING_CENTRE };
  const turn: QuadMotion = { kind: "turn", periodMs: 1_440 };
  const cell = (key: string, z: number, extra: Partial<Quad>): Quad => ({
    key,
    kind: "sprite",
    band: "cards",
    z,
    rect: RING_RECT,
    tiers: ALL_TIERS,
    scale: ringScale,
    style: {},
    sprite: { atlas: "mark", cell: { col: 0, row: 0 } },
    ...extra,
  });
  return [
    cell("ring.rest", 10, { gate: "paused" }),
    cell("ring.base", 10, { gate: "live" }),
    cell("ring.spin", 13, { gate: "live", motion: turn }),
    cell("ring.band", 11, {}),
  ];
};

describe("motion's gate in the scene", () => {
  const sceneWith = (motionLive: () => boolean) => {
    const scene = createScene({
      painter: () => ({ quads: ringQuadsOf(), dim: { opacity: 1, saturate: 1 }, lift: 0 }),
      motionLive,
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [agentFact()], wires: [] });
    return scene;
  };

  it("draws the moving parts while motion runs, and never the rest pose with them", () => {
    const scene = sceneWith(() => true);
    // base, spin and band: the paused rest pose is not in the order at all.
    expect(scene.prepare(VIEW_RECT, "near").visible).toBe(3);
    expect(scene.hasMotion()).toBe(true);
  });

  it("draws the rest pose alone when motion is paused, and stops asking for frames", () => {
    const scene = sceneWith(() => false);
    // rest and band: both live parts are gone, so nothing turns.
    expect(scene.prepare(VIEW_RECT, "near").visible).toBe(2);
    expect(scene.hasMotion()).toBe(false);
  });

  it("rebuilds the order when the gate flips, so the flip needs no repaint", () => {
    let live = true;
    const scene = sceneWith(() => live);
    expect(scene.prepare(VIEW_RECT, "near").visible).toBe(3);
    live = false;
    expect(scene.prepare(VIEW_RECT, "near").visible).toBe(2);
    live = true;
    expect(scene.prepare(VIEW_RECT, "near").visible).toBe(3);
  });

  it("draws exactly the seat ring the painter gates, through the product painter", () => {
    let live = true;
    const scene = createScene({
      painter: (fact, seat, cardView) => paintCard(fact, seat, cardView),
      motionLive: () => live,
    });
    const fact = agentFact();
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact], wires: [] });
    scene.apply({ kind: "seat", id: fact.id, live: seatLive({ glyph: "work", tone: "cyan" }) });
    const moving = scene.prepare(VIEW_RECT, "near").visible;
    expect(scene.hasMotion()).toBe(true);
    live = false;
    const resting = scene.prepare(VIEW_RECT, "near").visible;
    // The rest pose replaces the base and the spin: one quad fewer, nothing else.
    expect(resting).toBe(moving - 1);
    expect(scene.hasMotion()).toBe(false);
  });
});

describe("the source a moving camera holds", () => {
  it("keeps the cell it has while the camera moves, and resolves every run once at rest", () => {
    let settled = true;
    let scale = 1;
    const asks: number[] = [];
    const scene = createScene({
      painter: () => ({ quads: ringQuadsOf().slice(1, 2), dim: { opacity: 1, saturate: 1 }, lift: 0 }),
      settled: () => settled,
      scale: () => scale,
      source: (_quad, at) => {
        asks.push(at);
        return asks.length;
      },
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [agentFact()], wires: [] });
    // The paint resolves its own cell.
    expect(asks).toHaveLength(1);
    // The first prepared frame lands that cell at its bucket.
    expect(scene.prepare(VIEW_RECT, "near").visible).toBe(1);
    expect(asks).toHaveLength(2);
    // A still camera and an unchanged scene ask for nothing.
    scene.prepare(VIEW_RECT, "near");
    expect(asks).toHaveLength(2);

    // A zoom in flight: five frames at a new raster scale, no new cell asked.
    settled = false;
    scale = 2;
    for (let frame = 0; frame < 5; frame += 1) scene.prepare(VIEW_RECT, "near");
    expect(asks).toHaveLength(2);
    expect(scene.quadBuffer.u32[0 * QUAD_FLOATS + 23]).toBe(2);

    // At rest the record takes the exact cell for the new scale, once.
    settled = true;
    scene.prepare(VIEW_RECT, "near");
    expect(asks).toHaveLength(3);
    expect(asks[2]).toBe(2);
    expect(scene.quadBuffer.u32[0 * QUAD_FLOATS + 23]).toBe(3);
  });

  it("still resolves a record that has no cell yet, so a card arriving mid-gesture is not blank", () => {
    let settled = false;
    const asks: number[] = [];
    const scene = createScene({
      painter: () => ({ quads: ringQuadsOf().slice(1, 2), dim: { opacity: 1, saturate: 1 }, lift: 0 }),
      settled: () => settled,
      source: () => {
        asks.push(1);
        // The atlas has not landed the cell for the first two asks.
        return asks.length < 3 ? NO_ATLAS_CELL : 7;
      },
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [agentFact()], wires: [] });
    expect(scene.quadBuffer.u32[0 * QUAD_FLOATS + 23]).toBe(NO_ATLAS_CELL);
    scene.prepare(VIEW_RECT, "near");
    expect(asks).toHaveLength(2);
    scene.prepare(VIEW_RECT, "near");
    expect(asks).toHaveLength(3);
    expect(scene.quadBuffer.u32[0 * QUAD_FLOATS + 23]).toBe(7);
    settled = true;
  });
});

describe("the engine's zoom gesture", () => {
  const spriteQuad = (): Quad => ({
    key: "sprite",
    kind: "sprite",
    band: "cards",
    z: 1,
    rect: { x: 0, y: 0, width: 52, height: 52 },
    tiers: ALL_TIERS,
    scale: { kind: "board" },
    style: {},
    sprite: { atlas: "mark", cell: { col: 0, row: 0 } },
  });

  it("asks for no new cell between the first wheel tick and the camera's rest", async () => {
    const asks: number[] = [];
    const gpu = fakeGpu();
    const keeper = (await import("../src/window/canvas/engine/device")).createDeviceKeeper(gpu.gpu);
    const frames = fakeScheduler();
    let now = 0;
    const host: EngineHost = {
      surface: { width: 0, height: 0 },
      context: fakeContext().context,
      device: keeper,
      scheduler: frames.scheduler,
      clock: () => now,
      wallClock: () => now + 1_000_000,
      painter: () => ({ quads: [spriteQuad()], dim: { opacity: 1, saturate: 1 }, lift: 0 }),
      sourceOf: () => {
        asks.push(now);
        return asks.length;
      },
    };
    const engine = createEngine(host);
    engine.input({ kind: "resize", width: 800, height: 600, pixelRatio: 1 });
    await settle();
    engine.apply([{ kind: "load", canvas: asCanvasName("factory"), cards: [agentFact()], wires: [] }]);
    frames.tick();
    const settledAsks = asks.length;

    for (let tick = 0; tick < 5; tick += 1) {
      now += 16;
      engine.input({
        kind: "wheel",
        at: { x: 400, y: 300 },
        dx: 0,
        dy: -120,
        deltaMode: 0,
        modifiers: { shift: false, alt: false, ctrl: true, meta: false },
      });
      frames.tick();
    }
    expect(asks.length, "no re-raster inside the gesture").toBe(settledAsks);
    // The camera is still moving, so the loop keeps drawing.
    expect(frames.waiting()).toBe(1);

    now += 200;
    frames.tick();
    expect(asks.length, "one exact pass at rest").toBe(settledAsks + 1);
    engine.dispose();
    keeper.dispose();
  });
});
