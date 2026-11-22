// Damage (#915): a frame only motion drives redraws the device pixels its
// in-view movers can reach. These are the scissors it draws through.

import { describe, expect, it } from "vitest";
import { damageRects } from "../src/window/canvas/engine/damage";

const camera = { x: 10, y: 20, zoom: 2 };
const target = { width: 1000, height: 800 };

describe("damage rectangles", () => {
  it("project a board rectangle to device pixels, padded one pixel and snapped outwards", () => {
    // Board (5, 5, 10, 10) at zoom 2 and offset (10, 20) is screen (20, 30, 20, 20); at ratio 2 that is (40, 60, 40, 40).
    expect(damageRects([{ x: 5, y: 5, width: 10, height: 10 }], camera, 2, target)).toEqual([{ x: 39, y: 59, width: 42, height: 42 }]);
    expect(damageRects([{ x: 5.1, y: 5, width: 10, height: 10 }], camera, 2, target)[0]!.x).toBe(39);
  });

  it("clip to the target and drop what lies wholly outside it", () => {
    expect(damageRects([{ x: -20, y: -20, width: 30, height: 30 }], camera, 1, target)).toEqual([{ x: 0, y: 0, width: 31, height: 41 }]);
    expect(damageRects([{ x: 5_000, y: 0, width: 10, height: 10 }], camera, 1, target)).toEqual([]);
  });

  it("merge rectangles that touch, through chains, and keep apart the ones that do not", () => {
    const rects = damageRects(
      [
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 100, y: 0, width: 10, height: 10 },
        // Bridges the first two.
        { x: 9, y: 0, width: 92, height: 4 },
        { x: 0, y: 200, width: 10, height: 10 },
      ],
      { x: 0, y: 0, zoom: 1 },
      1,
      target,
    );
    expect(rects).toEqual([
      { x: 0, y: 0, width: 111, height: 11 },
      { x: 0, y: 199, width: 11, height: 12 },
    ]);
  });

  it("fold into one bounding box past the most it keeps apart", () => {
    const apart = Array.from({ length: 5 }, (_, index) => ({ x: index * 100, y: 0, width: 10, height: 10 }));
    expect(damageRects(apart, { x: 0, y: 0, zoom: 1 }, 1, target, 4)).toEqual([{ x: 0, y: 0, width: 411, height: 11 }]);
    expect(damageRects(apart, { x: 0, y: 0, zoom: 1 }, 1, target, 5)).toHaveLength(5);
  });
});

describe("a frame only motion drives", () => {
  it("redraws the moving card's pixels into the kept frame, and a camera move redraws it whole", async () => {
    const { asCanvasName } = await import("@shared/model");
    const { createDeviceKeeper } = await import("../src/window/canvas/engine/device");
    const { createEngine } = await import("../src/window/canvas/engine/engine");
    const { fakeContext, fakeGpu, fakeScheduler, settle } = await import("./gpu-canvas-fakes");
    const { seat } = await import("./support/model-nodes");
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    const context = fakeContext();
    const frames = fakeScheduler();
    let now = 0;
    const turning = {
      key: "turning",
      kind: "shape",
      band: "cards",
      z: 1,
      rect: { x: 0, y: 0, width: 40, height: 40 },
      tiers: 15,
      scale: { kind: "board" },
      style: {},
      motion: { kind: "turn", periodMs: 1200 },
    };
    const engine = createEngine({
      surface: { width: 0, height: 0 },
      context: context.context,
      device: keeper,
      scheduler: frames.scheduler,
      clock: () => now,
      painter: () => ({ quads: [turning], dim: { opacity: 1, saturate: 1 }, lift: 0 }) as never,
    });
    engine.input({ kind: "resize", width: 400, height: 300, pixelRatio: 2 });
    engine.apply([
      { kind: "load", canvas: asCanvasName("factory"), cards: [{ id: "a", row: seat("a", { x: 20, y: 20 }), derived: { regionDepth: 0, blocked: false, z: 0 } }], wires: [] },
    ]);
    await settle();
    type Frame = { loadOp: string; scissors: Array<[number, number, number, number]>; copies: number; calls: string[] };
    const log: Frame[] = [];
    const device = gpu.devices[0]!.device as unknown as { createCommandEncoder: () => Record<string, unknown> };
    const make = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = () => {
      const encoder = make();
      const frame: Frame = { loadOp: "", scissors: [], copies: 0, calls: [] };
      log.push(frame);
      const begin = encoder["beginRenderPass"] as (descriptor: GPURenderPassDescriptor) => Record<string, unknown>;
      return {
        ...encoder,
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          frame.loadOp = [...descriptor.colorAttachments][0]!.loadOp;
          const pass = begin(descriptor);
          return {
            ...pass,
            setScissorRect: (x: number, y: number, w: number, h: number) => {
              frame.scissors.push([x, y, w, h]);
              frame.calls.push("scissor");
            },
            draw: (vertices: number, instances = 1) => frame.calls.push(`draw ${String(vertices)}x${String(instances)}`),
          };
        },
        copyTextureToTexture: () => {
          frame.copies += 1;
        },
      };
    };
    // Frames until the camera has settled and nothing but the turn is left.
    for (let index = 0; index < 12; index += 1) {
      now += 100;
      frames.tick();
    }
    const first = log[0]!;
    expect(first).toMatchObject({ loadOp: "clear", scissors: [], copies: 1 });
    const last = log.at(-1)!;
    // The kept frame is loaded, and only the turning card's reach is drawn.
    expect(last.loadOp).toBe("load");
    expect(last.copies).toBe(1);
    expect(last.scissors.length).toBe(1);
    // The rectangle is the ground again before anything draws in it: the kept
    // pixels are last frame's, and a translucent fill would blend over itself.
    expect(last.calls.slice(0, 2)).toEqual(["scissor", "draw 3x1"]);
    expect(last.calls.length).toBeGreaterThan(2);
    const [, , w, h] = last.scissors[0]!;
    expect(w * h).toBeLessThan(800 * 600);
    const stats = engine.stats().damage!;
    expect(stats.lastPixels).toBe(w * h);
    // A camera move draws the whole frame again.
    engine.moveCamera({ x: 30, y: 0, zoom: 1 });
    now += 16;
    frames.tick();
    expect(log.at(-1)).toMatchObject({ loadOp: "clear", scissors: [] });
    engine.dispose();
    keeper.dispose();
  });
});
