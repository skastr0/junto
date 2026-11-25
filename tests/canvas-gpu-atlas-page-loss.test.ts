/**
 * A page the device refuses late is gone in the same step in which it is
 * destroyed: no pending mip pass may begin on it.
 */
import { describe, expect, it } from "vitest";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import type { Quad, QuadStyle, SpriteRef } from "../src/window/canvas/contract";
import { strictDevice } from "./gpu-atlas-strict-device";
import { settle } from "./gpu-canvas-fakes";

const style: QuadStyle = { ink: { token: "ink" } };

const spriteQuad = (key: string): Quad => ({
  key: "q",
  kind: "sprite",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: 8, height: 8 },
  tiers: 0,
  scale: { kind: "board" },
  style,
  sprite: { atlas: "image", key, size: { width: 8, height: 8 } } as SpriteRef,
});

const pixels = (stamp: number): AtlasPixels =>
  ({ width: 8, height: 8, stampAt: () => stamp, close: () => undefined }) as unknown as AtlasPixels;

const drain = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};

/** The next texture made after attach gets an already-answered late out-of-memory scope. */
const refuseNextTextureLate = (device: GPUDevice): (() => void) => {
  const pop = device.popErrorScope.bind(device);
  let refuse = true;
  device.popErrorScope = () => {
    const real = pop();
    if (!refuse) return real;
    refuse = false;
    void real;
    return Promise.resolve({ message: "out of memory" });
  };
  return () => {
    refuse = false;
  };
};

const board = () => {
  const strict = strictDevice();
  const atlas = createGpuAtlas({
    size: 64,
    rasterizeSpriteSync: () => pixels(9),
  });
  atlas.attach(strict.device);
  return { atlas, strict };
};

describe("a page the device refuses late", () => {
  it("takes its pending mip rects with it when it is destroyed", async () => {
    const { atlas, strict } = board();
    refuseNextTextureLate(strict.device);
    const cell = atlas.acquire(spriteQuad("lost"), 1);
    await drain();

    // The out-of-memory answer was already resolved when the page was made,
    // so its callback is queued before the dirty-flush microtask. Without the
    // prune that flush begins a mip pass on the page after it is destroyed.
    expect(atlas.hasImage(cell)).toBe(false);
    expect(strict.errors).toEqual([]);
  });
});
