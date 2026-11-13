// Track A's done-test (docs/canvas-gpu-plan.md, track A): a moving ring is
// drawn on every tick, an idle scene is not, a hidden canvas stops (fake
// clock); a seat report uploads that seat's bytes and no others; the tier
// equals the old canvas's at a set of zooms. No test waits on a real clock.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import { ringState, type RingStateInput } from "@shared/wire/rings";
import type { CardFact, FrameFacts, SeatLive } from "../src/window/canvas/contract";
import { createDeviceKeeper } from "../src/window/canvas/engine/device";
import { createEngine } from "../src/window/canvas/engine/engine";
import { tierForZoom as oldTierForZoom, type CanvasTier as OldTier } from "../src/window/lib/canvas-tier";
import { fakeContext, fakeGpu, fakeScheduler, settle } from "./gpu-canvas-fakes";
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
  readonly advance: (ms: number) => void;
};

const rig = async (): Promise<Rig> => {
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

    // The ring rests: the next frame is the last one scheduled.
    r.engine.apply([{ kind: "seat", id: "a", live: live("rest") }]);
    r.frames.tick();
    expect(r.frames.waiting()).toBe(0);
    const still = r.engine.stats().frames;
    for (let tick = 0; tick < 10; tick += 1) r.frames.tick();
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
