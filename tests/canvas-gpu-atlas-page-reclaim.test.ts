/**
 * A page nobody draws from for the idle span is cache, not working memory:
 * its cells are evicted and its texture is given back, while its index stays
 * for the next page to take.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import { ATLAS_CELL_FLOATS } from "../src/window/canvas/engine/types";
import type { Quad, QuadStyle, SpriteRef } from "../src/window/canvas/contract";
import { strictDevice } from "./gpu-atlas-strict-device";
import { settle } from "./gpu-canvas-fakes";

const style: QuadStyle = { ink: { token: "ink" } };

const spriteQuad = (key: string): Quad => ({
  key: "q",
  kind: "sprite",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: 40, height: 40 },
  tiers: 0,
  scale: { kind: "board" },
  style,
  sprite: { atlas: "image", key, size: { width: 40, height: 40 } } as SpriteRef,
});

const pixels = (): AtlasPixels =>
  ({ width: 40, height: 40, stampAt: () => 9, close: () => undefined }) as unknown as AtlasPixels;

const drain = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};

const board = () => {
  const strict = strictDevice();
  const atlas = createGpuAtlas({ size: 64, rasterizeSpriteSync: pixels });
  atlas.attach(strict.device);
  return { atlas, strict };
};

const pass = async (ms: number): Promise<void> => {
  vi.advanceTimersByTime(ms);
  await settle();
};

describe("an idle atlas page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is given back after the idle span, and its index is kept", async () => {
    const { atlas, strict } = board();
    const one = atlas.acquire(spriteQuad("one"), 1);
    const two = atlas.acquire(spriteQuad("two"), 1);
    vi.useRealTimers();
    await drain();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    expect(atlas.stats().pages).toBe(2);

    atlas.release(one);
    atlas.release(two);
    await pass(9_999);
    expect(atlas.stats().pages).toBe(2);
    await pass(1);
    expect(atlas.stats().pages).toBe(0);
    expect(atlas.stats().bytesInUse).toBe(0);
    expect(strict.errors).toEqual([]);

    vi.useRealTimers();
    const replacement = atlas.acquire(spriteQuad("replacement"), 1);
    await drain();
    expect(atlas.hasImage(replacement)).toBe(true);
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.binding.rgbaPages).toHaveLength(2);
    const row = atlas.binding.cells.subarray(atlas.cellIndex(replacement) * ATLAS_CELL_FLOATS, atlas.cellIndex(replacement) * ATLAS_CELL_FLOATS + ATLAS_CELL_FLOATS);
    expect(row[4]).toBe(0);
  });

  it("a held cell keeps its page; another unheld page still goes", async () => {
    const { atlas } = board();
    const held = atlas.acquire(spriteQuad("held"), 1);
    const cached = atlas.acquire(spriteQuad("cached"), 1);
    vi.useRealTimers();
    await drain();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    atlas.release(cached);
    await pass(10_000);
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.hasImage(held)).toBe(true);
  });
});
