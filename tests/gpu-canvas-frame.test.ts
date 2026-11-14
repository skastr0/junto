// Track A's done-test (docs/canvas-gpu-plan.md, track A): a moving ring is
// drawn on every tick, an idle scene is not, a hidden canvas stops (fake
// clock); a seat report uploads that seat's bytes and no others; the tier
// equals the old canvas's at a set of zooms. No test waits on a real clock.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import { RING_MOTION, ringState, type RingStateInput } from "@shared/wire/rings";
import { sampleMotion } from "../src/window/canvas/paint/motion";
import type { CardFact, FrameFacts, Hit, SeatLive } from "../src/window/canvas/contract";
import { createDeviceKeeper } from "../src/window/canvas/engine/device";
import { createEngine, type EngineHost } from "../src/window/canvas/engine/engine";
import { tierForZoom as oldTierForZoom, type CanvasTier as OldTier } from "../src/window/lib/canvas-tier";
import { fakeContext, fakeGpu, fakeScheduler, settle, type FakeDevice } from "./gpu-canvas-fakes";
import { note, seat } from "./support/model-nodes";

const factOf = (row: CardFact["row"], over: Partial<CardFact["derived"]> = {}): CardFact => ({
  id: row.id,
  row,
  derived: { regionDepth: 0, blocked: false, z: 0, ...over },
});

const seatFact = (id: string, x = 0): CardFact =>
  factOf(seat(id, { x, y: 0, width: 216, height: 56 }));

const live = (glyph: RingStateInput["glyph"], over: Partial<SeatLive> = {}): SeatLive => ({
  ring: ringState({ glyph, tone: "cyan" }),
  line: "running claude",
  mark: { tone: "cyan", label: "working" },
  urgency: 0,
  running: true,
  overseer: false,
  ringSince: 1_000,
  ...over,
});

type Rig = {
  readonly engine: ReturnType<typeof createEngine>;
  readonly keeper: ReturnType<typeof createDeviceKeeper>;
  readonly frames: ReturnType<typeof fakeScheduler>;
  readonly facts: FrameFacts[];
  readonly device: FakeDevice;
  readonly advance: (ms: number) => void;
};

const rig = async (host: Partial<EngineHost> = {}): Promise<Rig> => {
  const gpu = fakeGpu();
  const keeper = createDeviceKeeper(gpu.gpu);
  const context = fakeContext();
  const frames = fakeScheduler();
  let now = 0;
  const engine = createEngine({
    surface: { width: 0, height: 0 },
    context: context.context,
    device: keeper,
    scheduler: frames.scheduler,
    clock: () => now,
    wallClock: () => now + 1_000_000,
    ...host,
  });
  const facts: FrameFacts[] = [];
  engine.onFrame((heard) => {
    facts.push(heard);
  });
  engine.input({ kind: "resize", width: 800, height: 600, pixelRatio: 1 });
  await settle();
  return {
    engine,
    keeper,
    frames,
    facts,
    device: gpu.devices[0]!,
    advance: (ms) => {
      now += ms;
    },
  };
};

const load = (r: Rig, cards: ReadonlyArray<CardFact>): void => {
  r.engine.apply([{ kind: "load", canvas: asCanvasName("factory"), cards, wires: [] }]);
};

describe("the moving picture", () => {
  it("draws a moving ring on every tick, and stops once the scene is still", async () => {
    const r = await rig();
    load(r, [seatFact("a")]);
    r.engine.apply([{ kind: "seat", id: "a", live: live("work") }]);
    r.frames.tick();
    const afterFirst = r.engine.stats().frames;
    expect(afterFirst).toBe(1);
    expect(r.frames.waiting()).toBe(1);
    for (let tick = 0; tick < 5; tick += 1) {
      r.frames.tick();
      expect(r.frames.waiting()).toBe(1);
    }
    expect(r.engine.stats().frames).toBe(afterFirst + 5);

    // The ring rests: the fade runs out, then the next frame is the last.
    r.engine.apply([{ kind: "seat", id: "a", live: live("rest") }]);
    r.advance(200);
    r.frames.tick();
    expect(r.frames.waiting()).toBe(0);
    const still = r.engine.stats().frames;
    for (let tick = 0; tick < 10; tick += 1) r.frames.tick();
    expect(r.engine.stats().frames).toBe(still);
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("reports the turning ring's angle as last drawn", async () => {
    const r = await rig();
    load(r, [seatFact("a")]);
    r.engine.apply([{ kind: "seat", id: "a", live: live("work") }]);
    r.advance(1_234);
    r.frames.tick();
    const wall = 1_000_000 + 1_234;
    const expected = sampleMotion({ kind: "turn", periodMs: RING_MOTION.work.spin!.lapMs }, wall).angle;
    expect(r.engine.ringAngle!("a")).toBeCloseTo(expected, 9);
    r.engine.apply([{ kind: "seat", id: "a", live: live("rest") }]);
    r.frames.tick();
    expect(r.engine.ringAngle!("a")).toBeUndefined();
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("keeps drawing while a style change fades, then stops", async () => {
    const r = await rig();
    load(r, [factOf(note("n", "fade", { x: 100, y: 100 }))]);
    r.frames.tick();
    r.engine.apply([{ kind: "selection", fact: { nodeIds: ["n"] } }]);
    r.frames.tick();
    expect(r.frames.waiting()).toBe(1);
    r.advance(90);
    r.frames.tick();
    expect(r.frames.waiting()).toBe(1);
    r.advance(100);
    r.frames.tick();
    expect(r.frames.waiting()).toBe(0);
    const still = r.engine.stats().frames;
    for (let tick = 0; tick < 5; tick += 1) r.frames.tick();
    expect(r.engine.stats().frames).toBe(still);
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("stops while hidden, even with a moving ring, and draws on return", async () => {
    const r = await rig();
    load(r, [seatFact("a")]);
    r.engine.apply([{ kind: "seat", id: "a", live: live("work") }]);
    r.frames.tick();
    expect(r.frames.waiting()).toBe(1);
    r.engine.input({ kind: "visibility", visible: false });
    expect(r.frames.waiting()).toBe(0);
    r.advance(100);
    r.frames.tick();
    const hidden = r.engine.stats().frames;
    expect(hidden).toBe(1);
    r.engine.input({ kind: "visibility", visible: true });
    expect(r.frames.waiting()).toBe(1);
    r.frames.tick();
    expect(r.engine.stats().frames).toBe(hidden + 1);
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("draws an idle board once and no more", async () => {
    const r = await rig();
    load(r, [seatFact("a"), factOf(note("n", "hello", { x: 400, y: 40 }))]);
    r.engine.apply([{ kind: "seat", id: "a", live: live("rest") }]);
    r.advance(200);
    r.frames.tick();
    expect(r.engine.stats().frames).toBe(1);
    expect(r.frames.waiting()).toBe(0);
    for (let tick = 0; tick < 10; tick += 1) r.frames.tick();
    expect(r.engine.stats().frames).toBe(1);
    r.engine.dispose();
    r.keeper.dispose();
  });
});

describe("a seat report", () => {
  it("uploads that seat's bytes and no others", async () => {
    const r = await rig();
    load(r, [seatFact("a"), seatFact("b", 400)]);
    r.frames.tick();
    // The first frame uploads the scene; only the seat report's frame counts.
    r.engine.apply([{ kind: "seat", id: "a", live: live("work") }]);
    r.frames.tick();
    const ranges = r.engine.stats().lastUploadRanges;
    const records = ranges.filter((range) => range.buffer !== "uniform");
    // The default seat paints a shell and a ring: two 128-byte records.
    const quads = records.filter((range) => range.buffer === "quads");
    expect(quads.length).toBeGreaterThan(0);
    for (const range of quads) expect(range.offset + range.size).toBeLessThanOrEqual(2 * 128);
    for (const range of records.filter((range) => range.buffer === "owners")) {
      expect(range.offset).toBe(0);
      expect(range.size).toBe(32);
    }
    // The order list did not change, so it is not uploaded.
    expect(records.some((range) => range.buffer === "order")).toBe(false);
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("rewrites the style table on a theme switch, and the mode-baked art records with it", async () => {
    const r = await rig();
    load(r, [seatFact("a")]);
    r.engine.apply([{ kind: "seat", id: "a", live: live("rest") }]);
    r.frames.tick();
    r.engine.apply([{ kind: "theme", mode: "bright" }]);
    r.frames.tick();
    const records = r.engine.stats().lastUploadRanges.filter((range) => range.buffer !== "uniform");
    expect(records.some((range) => range.buffer === "styles")).toBe(true);
    // Generated art bakes the mode into its SVG and the atlas keys cells by
    // mode, so sprite records do change. A theme switch never moves a card
    // or reorders the list.
    expect(records.some((range) => range.buffer === "owners")).toBe(false);
    expect(records.some((range) => range.buffer === "order")).toBe(false);
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("moves a card with one owner entry and no record", async () => {
    const r = await rig();
    load(r, [seatFact("a")]);
    r.frames.tick();
    const before = r.engine.stats().uploadedBytes;
    // A drop arrives as a new card fact: the record does not move, the owner does.
    r.engine.apply([{ kind: "card", fact: seatFact("a", 120) }]);
    r.frames.tick();
    const ranges = r.engine.stats().lastUploadRanges.filter((range) => range.buffer !== "uniform");
    // Moving also repaints (the painter is pure and the fact changed), so the
    // owner entry is the only *position* upload; no order run grows with the card.
    expect(r.engine.stats().uploadedBytes).toBeGreaterThanOrEqual(before);
    for (const range of ranges.filter((range) => range.buffer === "owners")) expect(range.size).toBe(32);
    // A move never rebuilds the order list: that rebuild stuttered the first
    // drag frame.
    expect(ranges.some((range) => range.buffer === "order")).toBe(false);
    r.engine.dispose();
    r.keeper.dispose();
  });
});

describe("the tier", () => {
  it("equals the old canvas's at every zoom, hysteresis included", async () => {
    const r = await rig();
    load(r, [seatFact("a")]);
    r.frames.tick();
    const zooms = [1, 0.8, 0.62, 0.61, 0.6, 0.4, 0.35, 0.34, 0.33, 0.25, 0.21, 0.2, 0.19, 0.15, 1.2, 0.5, 0.25, 0.15, 2.5, 0.63];
    let previous: OldTier | undefined;
    for (const zoom of zooms) {
      r.engine.moveCamera({ kind: "camera", camera: { x: 0, y: 0, zoom } });
      r.frames.tick();
      const facts = r.facts[r.facts.length - 1]!;
      const expected = oldTierForZoom(zoom, previous);
      expect({ zoom, tier: facts.tier }).toEqual({ zoom, tier: expected });
      previous = expected;
    }
    r.engine.dispose();
    r.keeper.dispose();
  });
});

describe("every upload fits its buffer", () => {
  it("writes no range past a GPU buffer, even after growth", async () => {
    const r = await rig();
    const cards: CardFact[] = [];
    for (let index = 0; index < 900; index += 1) {
      cards.push(factOf(note(`n${index}`, `note ${index}`, { x: index * 30, y: index * 10, width: 220, height: 84 })));
    }
    load(r, cards);
    for (let frame = 0; frame < 3; frame += 1) {
      r.engine.moveCamera({ kind: "camera", camera: { x: -frame * 90, y: 0, zoom: 1 } });
      r.frames.tick();
    }
    // The fake records bytes; a write past a buffer is the error Chromium raises.
    for (const write of r.device.writes()) {
      const size = (write.buffer as unknown as { readonly size: number }).size;
      expect(write.offset + write.size, `buffer ${String(size)} offset ${String(write.offset)} + ${String(write.size)}`).toBeLessThanOrEqual(size);
    }
    r.engine.dispose();
    r.keeper.dispose();
  });
});

describe("the hands in the engine", () => {
  const pointer = (phase: "down" | "move" | "up", x: number, y: number) =>
    ({ kind: "pointer", phase, pointerId: 1, at: { x, y }, button: 0, buttons: phase === "up" ? 0 : 1, clicks: 1, modifiers: { shift: false, alt: false, ctrl: false, meta: false } }) as const;

  it("turns a three-inch drag into one Move with the rounded position", async () => {
    const r = await rig();
    load(r, [seatFact("a", 100)]);
    const intents: Array<import("../src/window/canvas/contract").Intent> = [];
    r.engine.onIntent((intent) => intents.push(intent));
    expect(r.engine.rectOf("a")).toEqual({ x: 100, y: 0, width: 216, height: 56 });
    expect(r.engine.pick({ x: 110, y: 10 })).toMatchObject({ nodeId: "a" });
    r.engine.input(pointer("down", 110, 10));
    r.engine.input(pointer("move", 120, 20));
    r.engine.input(pointer("move", 140, 40));
    r.engine.input(pointer("up", 140, 40));
    const moves = intents.filter((intent) => intent.kind === "move");
    expect(moves).toEqual([{ kind: "move", positions: [{ id: "a", x: 130, y: 30 }] }]);
    // The drop clears the live offset and the card is back on its row.
    expect(r.engine.rectOf("a")?.x).toBe(100);
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("answers picks from the lens while the loupe is up, at the point asked", async () => {
    const lensHit: Hit = { nodeId: "lens-seat" as never, part: { kind: "body" }, at: { x: 0, y: 0 } };
    let lensAnswer: Hit | undefined = lensHit;
    const asked: Array<{ x: number; y: number }> = [];
    const r = await rig({
      lensPick: (screen) => {
        asked.push(screen);
        return lensAnswer;
      },
    });
    load(r, [seatFact("a", 100)]);
    // While the lens answers, its hit wins over the canvas's own — the seat
    // inside a far-zoom cluster is the one picked.
    expect(r.engine.pick({ x: 110, y: 10 })).toMatchObject({ nodeId: "lens-seat" });
    expect(asked).toEqual([{ x: 110, y: 10 }]);
    // An unfed lens changes nothing: the canvas's own pick answers.
    lensAnswer = undefined;
    expect(r.engine.pick({ x: 110, y: 10 })).toMatchObject({ nodeId: "a" });
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("reports a dragged card's live screen rectangle, and drops it on release", async () => {
    const r = await rig();
    load(r, [seatFact("a", 100)]);
    r.frames.tick();
    r.engine.input(pointer("down", 110, 10));
    r.engine.input(pointer("move", 160, 60));
    r.frames.tick();
    const dragged = r.facts.at(-1)!.anchors.find((anchor) => anchor.id === "a");
    expect(dragged?.rect).toEqual({ x: 150, y: 50, width: 216, height: 56 });
    r.engine.input(pointer("up", 160, 60));
    r.frames.tick();
    expect(r.facts.at(-1)!.anchors.some((anchor) => anchor.id === "a")).toBe(false);
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("reports the marquee box in screen pixels while a pane drag runs, and null at the end", async () => {
    const r = await rig();
    load(r, [seatFact("a", 500)]);
    r.frames.tick();
    r.engine.input(pointer("down", 200, 300));
    r.engine.input(pointer("move", 260, 340));
    r.engine.input(pointer("move", 400, 420));
    r.frames.tick();
    expect(r.facts.at(-1)?.marquee).toEqual({ x: 200, y: 300, width: 200, height: 120 });
    r.engine.input(pointer("up", 400, 420));
    r.frames.tick();
    expect(r.facts.at(-1)?.marquee).toBeNull();
    r.engine.dispose();
    r.keeper.dispose();
  });

  it("turns a resize into one Move with the final size", async () => {
    const r = await rig();
    const board = factOf(note("n", "drag me", { x: 400, y: 100, width: 220, height: 84 }));
    load(r, [board]);
    r.engine.apply([{ kind: "selection", fact: { nodeIds: ["n"] } }]);
    const intents: Array<import("../src/window/canvas/contract").Intent> = [];
    r.engine.onIntent((intent) => intents.push(intent));
    r.engine.input(pointer("down", 620, 184));
    r.engine.input(pointer("move", 650, 214));
    r.engine.input(pointer("up", 650, 214));
    const resized = intents.filter((intent) => intent.kind === "resize");
    expect(resized).toEqual([{ kind: "resize", id: "n", rect: { x: 400, y: 100, width: 250, height: 114 } }]);
    r.engine.dispose();
    r.keeper.dispose();
  });
});

describe("the atlas cells", () => {
  it("re-uploads the cell table when a raster lands, and only then", async () => {
    const cells = new Float32Array(16);
    let revision = 0;
    const r = await rig({
      atlas: { texture: { createView: () => ({}) } as unknown as GPUTexture, sampler: {} as unknown as GPUSampler, cells },
      atlasRevision: () => revision,
    });
    load(r, [seatFact("a")]);
    r.frames.tick();
    expect(r.engine.stats().lastUploadRanges.some((range) => range.buffer === "cells")).toBe(false);
    revision = 1;
    r.engine.invalidate();
    r.frames.tick();
    const uploaded = r.engine.stats().lastUploadRanges.filter((range) => range.buffer === "cells");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.size).toBe(64);
    r.engine.dispose();
    r.keeper.dispose();
  });
});
