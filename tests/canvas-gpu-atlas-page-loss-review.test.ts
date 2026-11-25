/**
 * canvas-nodes, review of c1ef7ac0a (destroyed page drops its mip rects) and
 * fa5156439 (a new page takes the lowest dead index). What the services tests
 * do not ask: a reused index 0 leaves the reserved texel clear, a reused
 * index next to a live page leaves both audits clean, and a second loss of the
 * same index is reused again.
 */
import { describe, expect, it } from "vitest";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import type { Quad, QuadStyle, SpriteRef } from "../src/window/canvas/contract";
import { strictDevice } from "./gpu-atlas-strict-device";
import { settle } from "./gpu-canvas-fakes";

const style: QuadStyle = { ink: { token: "ink" } };
const spriteQuad = (key: string, size = 8): Quad => ({
  key: "q", kind: "sprite", band: "cards", z: 0, rect: { x: 0, y: 0, width: size, height: size }, tiers: 0, scale: { kind: "board" }, style,
  sprite: { atlas: "image", key, size: { width: size, height: size } } as SpriteRef,
});
const pixels = (size: number, stamp: number): AtlasPixels =>
  ({ width: size, height: size, data: new Uint8Array(size * size * 4).fill(stamp), stampAt: () => stamp, close: () => undefined }) as unknown as AtlasPixels;
const drain = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};
/** The next `count` textures made after this call get an already-answered late out-of-memory scope. */
const refuseNext = (device: GPUDevice, count = 1): void => {
  const pop = device.popErrorScope.bind(device);
  let left = count;
  device.popErrorScope = () => {
    const real = pop();
    if (left <= 0) return real;
    left -= 1;
    void real;
    return Promise.resolve({ message: "out of memory" });
  };
};
const board = () => {
  const strict = strictDevice();
  const atlas = createGpuAtlas({ size: 64, rasterizeSpriteSync: (q) => pixels(Math.ceil(q.rect.width), 9) });
  atlas.attach(strict.device);
  return { atlas, strict };
};

describe("a reused page index", () => {
  it("index 0 keeps the reserved texel clear and the cell off it", async () => {
    const { atlas, strict } = board();
    refuseNext(strict.device);
    const lost = atlas.acquire(spriteQuad("lost"), 1);
    await drain();
    expect(atlas.hasImage(lost)).toBe(false);
    const again = atlas.acquire(spriteQuad("replacement"), 1);
    await drain();
    expect(atlas.hasImage(again)).toBe(true);
    const audit = await atlas.auditTexels(10);
    expect(audit.mismatches).toEqual([]);
    expect(audit.checked).toBe(1);
    expect(atlas.audit().samples).toEqual([]);
    expect(strict.errors).toEqual([]);
  });

  it("index 1 beside a live page 0: two pages, both audits clean, page 0's cell untouched", async () => {
    const { atlas, strict } = board();
    const first = atlas.acquire(spriteQuad("first", 40), 1);
    await drain();
    expect(atlas.hasImage(first)).toBe(true);
    refuseNext(strict.device);
    const lost = atlas.acquire(spriteQuad("lost", 40), 1); // 40 px does not fit beside the first on a 64 px page
    await drain();
    expect(atlas.hasImage(lost)).toBe(false);
    const next = atlas.acquire(spriteQuad("next", 40), 1);
    await drain();
    expect(atlas.hasImage(next)).toBe(true);
    expect(atlas.hasImage(first)).toBe(true);
    expect(atlas.binding.rgbaPages).toHaveLength(2);
    const audit = await atlas.auditTexels(10);
    expect(audit.mismatches).toEqual([]);
    expect(audit.skipped).toEqual({});
    expect(atlas.audit().samples).toEqual([]);
    expect(strict.errors).toEqual([]);
  });

  it("the same index lost twice is reused twice, never a third slot", async () => {
    const { atlas, strict } = board();
    refuseNext(strict.device, 2);
    atlas.acquire(spriteQuad("lost-a"), 1);
    await drain();
    atlas.acquire(spriteQuad("lost-b"), 1);
    await drain();
    const ok = atlas.acquire(spriteQuad("ok"), 1);
    await drain();
    expect(atlas.hasImage(ok)).toBe(true);
    expect(atlas.binding.rgbaPages).toHaveLength(1);
    expect((await atlas.auditTexels(10)).mismatches).toEqual([]);
    expect(strict.errors).toEqual([]);
  });
});
