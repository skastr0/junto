/**
 * The zoom-corruption gate at unit level (operator priority, 2026-11-23).
 *
 * The atlas's read-only `audit()` checks the cell table's invariants. These
 * cases drive the atlas into a compaction with a stand-in waiting on a cell
 * that moves, which is what a zoom in and out does on the factory board, and
 * hold the atlas to what the GPU and the shader need:
 *   - a compaction never copies a texture onto itself (WebGPU rejects a copy
 *     whose source and destination are the same subresource, and the whole
 *     encoder with it);
 *   - a stand-in's row always names its target's current pixels.
 */

import { describe, expect, it } from "vitest";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import type { Quad, TextRun } from "../src/window/canvas/contract";
import { settle } from "./gpu-canvas-fakes";

type Copy = { readonly src: unknown; readonly dst: unknown };

const fakeDevice = () => {
  const textureCopies: Copy[] = [];
  const device = {
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createTexture: (desc: GPUTextureDescriptor) => {
      const size = desc.size as GPUExtent3DDict;
      return { width: size.width, height: size.height, depthOrArrayLayers: 1, format: desc.format, createView: () => ({}), destroy: () => undefined };
    },
    createSampler: () => ({}),
    createCommandEncoder: () => ({
      copyTextureToTexture: (src: { texture: unknown }, dst: { texture: unknown }) => {
        textureCopies.push({ src: src.texture, dst: dst.texture });
      },
      finish: () => ({}),
    }),
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
    queue: {
      copyExternalImageToTexture: () => undefined,
      writeTexture: () => undefined,
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
  } as unknown as GPUDevice;
  return { device, textureCopies };
};

const pixels = (width: number, height: number): AtlasPixels =>
  ({ width, height, close: () => undefined }) as unknown as AtlasPixels;

const run = (text: string): TextRun => ({ text, font: "body", size: 12, weight: 400, truncate: "end", width: 80 });

const textQuad = (text: string): Quad => ({
  key: text,
  kind: "text",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  tiers: 0,
  scale: { kind: "board" },
  style: { ink: { token: "ink" } },
  text: run(text),
});

const drain = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await settle();
};

/**
 * One 1024 coverage page is four 512 plots, each holding four 250 cells.
 * Seven texts at scales 1 (each its floor copy) and 2 fill plots 0 to 2 and
 * half of plot 3. Every plot holds a floor, so nothing can be reclaimed
 * whole. A stand-in for "t0" at 0.9 waits on t0@1. Then a 400 cell asks for
 * a whole plot: the atlas compacts plot 0, moving t0@1 and t1@1 into plot 3
 * of the same page.
 */
const compactedWithStandIn = async () => {
  let releaseWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => {
    releaseWaiting = resolve;
  });
  const atlas = createGpuAtlas({
    size: 1024,
    rasterizeText: async (r, scale) => {
      if (r.text === "big") return pixels(400, 400);
      if (r.text === "t0" && scale === 0.9) await waiting;
      return pixels(250, 250);
    },
    rasterizeSprite: async () => pixels(16, 16),
  });
  const fake = fakeDevice();
  atlas.attach(fake.device);

  const held: number[] = [];
  const zoomed: number[] = [];
  for (let i = 0; i < 7; i += 1) {
    held.push(atlas.acquire(textQuad(`t${String(i)}`), 1));
    zoomed.push(atlas.acquire(textQuad(`t${String(i)}`), 2));
    await drain();
  }
  for (const cell of zoomed) atlas.release(cell);
  expect(atlas.stats().compactions).toBe(0);

  const standIn = atlas.acquire(textQuad("t0"), 0.9);
  expect(atlas.hasImage(standIn)).toBe(true);
  await drain();

  const big = atlas.acquire(textQuad("big"), 1);
  await drain();
  return { atlas, fake, standIn, big, target: held[0]!, releaseWaiting };
};

describe("gpu atlas audit: compaction and stand-ins (zoom corruption)", () => {
  it("the audit is clean before any compaction", async () => {
    const atlas = createGpuAtlas({ size: 1024, rasterizeText: async () => pixels(250, 250), rasterizeSprite: async () => pixels(16, 16) });
    atlas.attach(fakeDevice().device);
    const a = atlas.acquire(textQuad("a"), 1);
    atlas.acquire(textQuad("a"), 2, a);
    await drain();
    expect(atlas.audit().counts).toEqual({});
  });

  it("a whole-plot cell lands on a fragmented page and the audit stays clean", async () => {
    const { atlas, big } = await compactedWithStandIn();
    expect(atlas.hasImage(big)).toBe(true);
    expect(atlas.audit().counts).toEqual({});
  });

  it("the atlas never copies a page texture onto itself (F1)", async () => {
    const { fake } = await compactedWithStandIn();
    const selfCopies = fake.textureCopies.filter((copy) => copy.src === copy.dst).length;
    expect(selfCopies).toBe(0);
  });

  it("a stand-in's row names its target's pixels after the target moves (F2)", async () => {
    const { atlas, standIn, target } = await compactedWithStandIn();
    const cells = atlas.binding.cells;
    const rowOf = (i: number) => Array.from(cells.subarray(i * 8, i * 8 + 5));
    expect(rowOf(standIn)).toEqual(rowOf(target));
    expect(atlas.audit().counts).toEqual({});
  });
});
