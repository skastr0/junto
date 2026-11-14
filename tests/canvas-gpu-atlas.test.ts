import { describe, expect, it } from "vitest";
import {
  createGpuAtlas,
  type AtlasPixels,
  type GpuAtlasOptions,
} from "../src/window/canvas/engine/gpu-atlas";
import { NO_ATLAS_CELL } from "../src/window/canvas/engine/quad";
import type { Quad, QuadStyle, SpriteRef, TextRun } from "../src/window/canvas/contract";
import { settle } from "./gpu-canvas-fakes";

// Track B atlas done-tests that run without a real GPU: cell assignment for
// text and every SpriteRef kind, UV writes when rasters land, revision bumps,
// pre-attach landings, and per-generation texture replay. The fake device
// records copyExternalImageToTexture calls; nothing here claims pixels draw —
// that proof is the Electron screenshot pass.

const fakeDevice = () => {
  const copies: Array<{ readonly width: number; readonly height: number }> = [];
  let textures = 0;
  const device = {
    createTexture: () => {
      textures += 1;
      return { destroy: () => undefined };
    },
    createSampler: () => ({}),
    queue: {
      copyExternalImageToTexture: (
        _image: unknown,
        _destination: unknown,
        size: { readonly width: number; readonly height: number },
      ) => {
        copies.push(size);
      },
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
  } as unknown as GPUDevice;
  return { device, copies, textures: () => textures };
};

const pixels = (width: number, height: number): AtlasPixels =>
  ({ width, height }) as unknown as AtlasPixels;

const textRun: TextRun = {
  text: "hello",
  font: "body",
  size: 12,
  weight: 400,
  truncate: "end",
  width: 80,
};

const style: QuadStyle = { ink: { token: "ink" } };

const quad = (over: Partial<Quad>): Quad => ({
  key: "q",
  kind: "shape",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  tiers: 0,
  scale: { kind: "board" },
  style,
  ...over,
});

const textQuad = (run: TextRun = textRun): Quad =>
  quad({ kind: "text", text: run });

const spriteQuad = (sprite: SpriteRef): Quad =>
  quad({ kind: "sprite", sprite });

const atlasWith = (over: Partial<GpuAtlasOptions> = {}) => {
  const rasterizeText = over.rasterizeText ?? (async () => pixels(20, 10));
  const rasterizeSprite = over.rasterizeSprite ?? (async () => pixels(16, 16));
  const dirty: Array<number> = [];
  const atlas = createGpuAtlas({
    rasterizeText,
    rasterizeSprite,
    onDirty: () => dirty.push(atlas.revision()),
    ...over,
  });
  return { atlas, dirty };
};

describe("gpu atlas", () => {
  it("gives a text quad a cell whose UVs land after the raster", async () => {
    const { atlas, dirty } = atlasWith();
    const { device } = fakeDevice();
    atlas.attach(device);
    const index = atlas.sourceFor(textQuad(), 2);
    expect(index).not.toBe(NO_ATLAS_CELL);
    // Same run and scale intern to the same cell.
    expect(atlas.sourceFor(textQuad(), 2)).toBe(index);
    // A different raster scale is a different cell.
    expect(atlas.sourceFor(textQuad(), 3)).not.toBe(index);
    await settle();
    await settle();
    const base = index * 4;
    // Texel (0,0) is reserved transparent for failed rasters, so the first
    // cell starts at x = 1 and its UV origin is a hair above zero.
    expect(atlas.binding.cells[base]).toBeGreaterThan(0);
    expect(atlas.binding.cells[base]).toBeLessThan(atlas.binding.cells[base + 2]);
    expect(atlas.binding.cells[base + 1]).toBe(0);
    expect(atlas.binding.cells[base + 2]).toBeGreaterThan(0);
    expect(atlas.binding.cells[base + 3]).toBeGreaterThan(0);
    expect(atlas.revision()).toBeGreaterThan(0);
    expect(dirty.length).toBeGreaterThan(0);
  });

  it("keeps unknown glyphs out of the atlas and interns known glyphs and media", () => {
    const { atlas } = atlasWith();
    // A name no painter emits stays NO_ATLAS_CELL, as the DOM draws nothing.
    expect(atlas.sourceFor(spriteQuad({ atlas: "glyph", name: "x" }), 2)).toBe(NO_ATLAS_CELL);
    // "preamble" is the bubble's plain-voice case: no glyph element in the DOM.
    expect(atlas.sourceFor(spriteQuad({ atlas: "glyph", name: "preamble" }), 2)).toBe(NO_ATLAS_CELL);
    const glyph = atlas.sourceFor(spriteQuad({ atlas: "glyph", name: "plus" }), 2);
    const media = atlas.sourceFor(
      spriteQuad({ atlas: "media", ref: "junto-content://object/abc", fit: "contain" }),
      2,
    );
    expect(glyph).not.toBe(NO_ATLAS_CELL);
    expect(media).not.toBe(NO_ATLAS_CELL);
    expect(glyph).not.toBe(media);
    // The ink is part of the glyph cell's key.
    const otherInk = quad({
      kind: "sprite",
      sprite: { atlas: "glyph", name: "plus" },
      style: { ink: { token: "amber" } },
    });
    expect(atlas.sourceFor(otherInk, 2)).not.toBe(glyph);
  });

  it("gives a text run a different cell per ink, because coverage is per-colour", async () => {
    const { atlas } = atlasWith();
    const base = atlas.sourceFor(textQuad(), 2);
    expect(base).not.toBe(NO_ATLAS_CELL);
    // Skia's mask pre-blend picks its correcting table by paint luminance, so
    // the same run in another ink must not share the coverage cell.
    const otherInk = quad({
      kind: "text",
      text: textRun,
      style: { ink: { token: "amber" } },
    });
    const other = atlas.sourceFor(otherInk, 2);
    expect(other).not.toBe(NO_ATLAS_CELL);
    expect(other).not.toBe(base);
    // Same run, same ink, same scale: the same cell.
    expect(atlas.sourceFor(textQuad(), 2)).toBe(base);
    // And the rasterizer sees the resolved ink, not a colourless run.
    const seen: Array<unknown> = [];
    const inked = atlasWith({
      rasterizeText: async (_run, _scale, ink) => {
        seen.push(ink);
        return pixels(20, 10);
      },
    });
    inked.atlas.sourceFor(textQuad(), 2);
    await settle();
    await settle();
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ r: expect.any(Number), g: expect.any(Number), b: expect.any(Number) });
  });

  it("assigns mark and image sprites cells keyed by mode", async () => {
    const { atlas } = atlasWith();
    const mark = spriteQuad({ atlas: "mark", cell: { col: 1, row: 2 } });
    const image = spriteQuad({
      atlas: "image",
      key: "portrait",
      svg: "<svg/>",
      size: { width: 24, height: 24 },
    });
    const markIndex = atlas.sourceFor(mark, 2);
    const imageIndex = atlas.sourceFor(image, 2);
    expect(markIndex).not.toBe(NO_ATLAS_CELL);
    expect(imageIndex).not.toBe(NO_ATLAS_CELL);
    expect(markIndex).not.toBe(imageIndex);
    // A theme switch repaints the art: new keys, new cells.
    atlas.setMode("bright");
    expect(atlas.sourceFor(mark, 2)).not.toBe(markIndex);
    expect(atlas.sourceFor(image, 2)).not.toBe(imageIndex);
    await settle();
    await settle();
  });

  it("holds landings before attach and replays them on a fresh device", async () => {
    const { atlas } = atlasWith();
    const index = atlas.sourceFor(textQuad(), 2);
    await settle();
    await settle();
    // Landed before attach: pixels held, UVs still zero so nothing samples
    // a region the texture does not have yet.
    expect(atlas.binding.cells[index * 4 + 2]).toBe(0);
    const first = fakeDevice();
    atlas.attach(first.device);
    await settle();
    expect(first.copies.length).toBe(1);
    expect(atlas.binding.cells[index * 4 + 2]).toBeGreaterThan(0);
    // A new device (context loss) gets a fresh texture with the same pixels.
    const second = fakeDevice();
    atlas.attach(second.device);
    await settle();
    expect(second.copies.length).toBe(1);
    expect(second.textures()).toBe(1);
    const third = fakeDevice();
    atlas.attach(third.device);
    await settle();
    expect(third.copies.length).toBe(1);
  });

  it("ignores quads with no text or sprite", () => {
    const { atlas } = atlasWith();
    expect(atlas.sourceFor(quad({}), 2)).toBe(NO_ATLAS_CELL);
  });
});
