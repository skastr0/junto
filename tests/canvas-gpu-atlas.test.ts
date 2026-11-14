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
    expect(atlas.binding.cells[base]).toBe(0);
    expect(atlas.binding.cells[base + 1]).toBe(0);
    expect(atlas.binding.cells[base + 2]).toBeGreaterThan(0);
    expect(atlas.binding.cells[base + 3]).toBeGreaterThan(0);
    expect(atlas.revision()).toBeGreaterThan(0);
    expect(dirty.length).toBeGreaterThan(0);
  });

  it("keeps glyph and media sprites out of the atlas for now", () => {
    const { atlas } = atlasWith();
    expect(atlas.sourceFor(spriteQuad({ atlas: "glyph", name: "x" }), 2)).toBe(NO_ATLAS_CELL);
    expect(
      atlas.sourceFor(spriteQuad({ atlas: "media", ref: "r", fit: "cover" }), 2),
    ).toBe(NO_ATLAS_CELL);
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
