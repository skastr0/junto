/**
 * A burst of quads that ask for one key while each keeps a different last
 * picture still lands that key once. The later slots show the first landing;
 * their own rasters are cancelled or dropped.
 */
import { describe, expect, it } from "vitest";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import { ATLAS_CELL_FLOATS } from "../src/window/canvas/engine/types";
import type { Quad, QuadStyle, SpriteRef } from "../src/window/canvas/contract";
import { strictDevice } from "./gpu-atlas-strict-device";
import { settle } from "./gpu-canvas-fakes";

const style: QuadStyle = { ink: { token: "ink" } };

const quad = (sprite: SpriteRef): Quad => ({
  key: "q",
  kind: "sprite",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: 16, height: 16 },
  tiers: 0,
  scale: { kind: "board" },
  style,
  sprite,
});

const mark = (col: number): Quad => quad({ atlas: "mark", cell: { col, row: 0 } } as SpriteRef);
const portrait = (): Quad => quad({ atlas: "image", key: "portrait", size: { width: 16, height: 16 } } as SpriteRef);

const pixels = (stamp: number): AtlasPixels =>
  ({ width: 16, height: 16, stampAt: () => stamp, close: () => undefined }) as unknown as AtlasPixels;

const drain = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};

describe("a burst of asks for one key", () => {
  it("lands one cell, however different the pictures the askers kept", async () => {
    const strict = strictDevice();
    const decodes: Array<(px: AtlasPixels) => void> = [];
    const atlas = createGpuAtlas({
      size: 64,
      rasterizeSpriteSync: (q) => (q.sprite?.atlas === "mark" ? pixels(3) : undefined),
      rasterizeSprite: () => new Promise<AtlasPixels>((resolve) => decodes.push(resolve)),
    });
    atlas.attach(strict.device);
    const row = (cell: number): number[] =>
      Array.from(atlas.binding.cells.subarray(cell * ATLAS_CELL_FLOATS, cell * ATLAS_CELL_FLOATS + ATLAS_CELL_FLOATS));

    const firstLast = atlas.acquire(mark(1), 1);
    const secondLast = atlas.acquire(mark(2), 1);
    await drain();
    expect(atlas.stats().landed).toBe(2);

    const first = atlas.acquire(portrait(), 1, firstLast);
    const second = atlas.acquire(portrait(), 1, secondLast);
    await drain();
    expect(decodes).toHaveLength(2);

    decodes[0]!(pixels(9));
    await drain();
    expect(atlas.hasImage(first)).toBe(true);
    expect(atlas.hasImage(second)).toBe(true);
    expect(row(second)).toEqual(row(first));
    const firstRow = row(first);

    // The second answer still arrives. Its token is stale now, so it lands nowhere.
    decodes[1]!(pixels(9));
    await drain();
    expect(row(second)).toEqual(firstRow);
    expect(row(first)).toEqual(firstRow);
    expect(atlas.audit().counts).toEqual({});
    expect(strict.errors).toEqual([]);
  });
});
