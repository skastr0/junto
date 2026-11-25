/**
 * The texel audit sees every pixel a quad can draw: sprites and text, paged
 * and standalone cells, the reserved clear texel, and the gutters sampling
 * can touch. Cells nobody can draw are counted as undrawn, never skipped.
 */
import { describe, expect, it } from "vitest";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import type { Quad, QuadStyle, SpriteRef } from "../src/window/canvas/contract";
import { strictDevice } from "./gpu-atlas-strict-device";
import { settle } from "./gpu-canvas-fakes";

const style: QuadStyle = { ink: { token: "ink" } };

const spriteQuad = (key: string, width = 8, height = 8): Quad => ({
  key: "q",
  kind: "sprite",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width, height },
  tiers: 0,
  scale: { kind: "board" },
  style,
  sprite: { atlas: "image", key, size: { width, height } } as SpriteRef,
});

const textQuad = (text: string): Quad => ({
  key: "q",
  kind: "text",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  tiers: 0,
  scale: { kind: "board" },
  style,
  text: { text, font: "body", size: 12, weight: 400, truncate: "end", width: 8 },
});

const rgba = (w: number, h: number, stamp: number): Uint8Array => {
  const out = new Uint8Array(w * h * 4);
  out.fill(stamp);
  return out;
};

/** Pixels the atlas uploads through the strict image path and the audit reads back through its carried bytes. */
const spritePixels = (w: number, h: number, stamp: number): AtlasPixels =>
  ({ width: w, height: h, data: rgba(w, h, stamp), stampAt: () => stamp, close: () => undefined }) as unknown as AtlasPixels;

const coveragePixels = (w: number, h: number, stamp: number): AtlasPixels =>
  ({ width: w, height: h, data: new Uint8Array(w * h).fill(stamp) }) as unknown as AtlasPixels;

const drain = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};

const board = (size = 64) => {
  const strict = strictDevice();
  const atlas = createGpuAtlas({
    size,
    rasterizeSpriteSync: (quad) => spritePixels(Math.ceil(quad.rect.width), Math.ceil(quad.rect.height), 9),
    rasterizeTextSync: () => coveragePixels(8, 8, 7),
  });
  atlas.attach(strict.device);
  return { atlas, strict };
};

describe("the texel audit has no drawable blind spot", () => {
  it("compares held sprite and text cells, with no skip and no mismatch", async () => {
    const { atlas, strict } = board();
    const sprite = atlas.acquire(spriteQuad("one"), 1);
    const text = atlas.acquire(textQuad("one"), 1);
    await drain();
    expect(atlas.hasImage(sprite)).toBe(true);
    expect(atlas.hasImage(text)).toBe(true);

    const audit = await atlas.auditTexels(10);
    expect(strict.errors).toEqual([]);
    expect(audit.checked).toBe(2);
    expect(audit.truncated).toBe(false);
    expect(audit.skipped).toEqual({});
    expect(audit.undrawn).toEqual({});
    expect(audit.mismatches).toEqual([]);
  });

  it("counts cells nobody can draw as undrawn, not skipped", async () => {
    const { atlas, strict } = board();
    const kept = atlas.acquire(spriteQuad("kept"), 1);
    const cached = atlas.acquire(spriteQuad("cached"), 1);
    const waiting = atlas.acquire(textQuad("waiting"), 1);
    await drain();
    atlas.release(cached);
    const audit = await atlas.auditTexels(10);
    expect(atlas.hasImage(kept)).toBe(true);
    expect(atlas.hasImage(waiting)).toBe(true);
    expect(strict.errors).toEqual([]);
    expect(audit.skipped).toEqual({});
    expect(audit.undrawn).toEqual({ cached: 1 });
  });

  it("marks the audit truncated only when comparable cells remain past the limit", async () => {
    const { atlas } = board();
    atlas.acquire(spriteQuad("one"), 1);
    atlas.acquire(spriteQuad("two"), 1);
    await drain();
    const audit = await atlas.auditTexels(1);
    expect(audit.truncated).toBe(true);
    expect(audit.skipped).toEqual({ "past-limit": 1 });
    const whole = await atlas.auditTexels(2);
    expect(whole.truncated).toBe(false);
    expect(whole.skipped).toEqual({});
  });

  it("compares a standalone texture layer by layer", async () => {
    const strict = strictDevice({ limits: { maxTextureDimension2D: 16 } });
    const atlas = createGpuAtlas({
      size: 64,
      rasterizeSpriteSync: () => spritePixels(20, 8, 9),
    });
    atlas.attach(strict.device);
    const cell = atlas.acquire(spriteQuad("large", 20, 8), 1);
    await drain();
    expect(atlas.hasImage(cell)).toBe(true);
    const audit = await atlas.auditTexels(10);
    expect(strict.errors).toEqual([]);
    expect(audit.checked).toBe(1);
    expect(audit.skipped).toEqual({});
    expect(audit.mismatches).toEqual([]);
  });

  it("reports a written reserved texel or gutter instead of passing over it", async () => {
    const { atlas, strict } = board();
    const cell = atlas.acquire(spriteQuad("one"), 1);
    await drain();
    expect(atlas.hasImage(cell)).toBe(true);
    const page = strict.textures.find((texture) => texture.width === 64 && texture.format === "rgba8unorm");
    expect(page).toBeDefined();
    page!.texels()![0] = 3;
    const audit = await atlas.auditTexels(10);
    expect(audit.mismatches.some((mismatch) => mismatch.kind === "reserved-texel" && mismatch.cell === -1)).toBe(true);
  });
});
