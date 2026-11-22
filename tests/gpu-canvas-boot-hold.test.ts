// Ruling 6 (#912): a frame is never held. A sprite whose atlas cell has no
// image yet draws its placeholder (its own shape in its declared colour, at
// full opacity) until the image lands. The measured peaks are handed to the
// host to keep for the next session, and a fresh boot starts from them.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, MotionPeaks, Quad } from "../src/window/canvas/contract";
import { createDeviceKeeper } from "../src/window/canvas/engine/device";
import { createEngine } from "../src/window/canvas/engine/engine";
import { createScene } from "../src/window/canvas/engine/scene";
import { fakeContext, fakeGpu, fakeScheduler, settle } from "./gpu-canvas-fakes";
import { seat } from "./support/model-nodes";

const portrait: Quad = {
  key: "portrait",
  kind: "sprite",
  band: "cards",
  z: 20,
  rect: { x: 8, y: 8, width: 40, height: 40 },
  tiers: 15,
  shape: "disc",
  scale: { kind: "board" },
  style: {},
  sprite: { atlas: "image", key: "portrait.a", svg: "<svg/>", size: { width: 40, height: 40 } },
  placeholder: { token: "indigo" },
};

const card: CardFact = { id: "a", row: seat("a", { x: 20, y: 20 }), derived: { regionDepth: 0, blocked: false, z: 0 } };
const VIEW = { x: -100, y: -100, width: 800, height: 600 };
const KIND_SHAPE = 0;
const KIND_SPRITE = 2;

describe("the cold sprite placeholder", () => {
  it("draws the sprite's shape in its tone while the image is cold, then the image", () => {
    let landed = false;
    const scene = createScene({
      painter: () => ({ quads: [portrait], dim: { opacity: 1, saturate: 1 }, lift: 0 }),
      acquire: () => 5,
      release: () => undefined,
      hasImage: () => landed,
      ensureNow: () => undefined,
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [card], wires: [] });
    scene.prepare(VIEW, "near");
    const record = scene.quadBuffer.u32;
    expect(record[14]).toBe(KIND_SHAPE);
    expect(scene.blankStats()).toMatchObject({ visibleBlank: 0, placeholders: 1 });
    landed = true;
    scene.prepare(VIEW, "near");
    expect(record[14]).toBe(KIND_SPRITE);
    expect(scene.blankStats()).toMatchObject({ visibleBlank: 0, placeholders: 0 });
  });
});

describe("the boot", () => {
  it("presents the first frame at once and keeps the peaks for the next session", async () => {
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    const context = fakeContext();
    const frames = fakeScheduler();
    const saved: MotionPeaks[] = [];
    const engine = createEngine({
      surface: { width: 0, height: 0 },
      context: context.context,
      device: keeper,
      scheduler: frames.scheduler,
      clock: () => 0,
      painter: () => ({ quads: [portrait], dim: { opacity: 1, saturate: 1 }, lift: 0 }),
      cells: { acquire: () => 5, release: () => undefined, hasImage: () => false, ensureNow: () => undefined },
      peaks: { load: () => ({ screenSpeed: 2, zoomRate: 0.001, latencyMs: 40 }), save: (peaks) => saved.push(peaks) },
    });
    engine.input({ kind: "resize", width: 400, height: 300, pixelRatio: 2 });
    engine.apply([{ kind: "load", canvas: asCanvasName("factory"), cards: [card], wires: [] }]);
    await settle();
    frames.tick();
    expect(gpu.devices[0]?.submits()).toBe(1);
    expect(engine.stats().blank).toMatchObject({ visibleBlank: 0, placeholders: 1 });
    // The kept peaks set the margin before anything has moved this session.
    expect(engine.stats().blank?.marginScreenPx).toBe(80);
    expect(saved[0]).toEqual({ screenSpeed: 2, zoomRate: 0.001, latencyMs: 40 });
    engine.dispose();
    keeper.dispose();
  });
});
