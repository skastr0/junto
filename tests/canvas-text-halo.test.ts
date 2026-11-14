// The halo pass (contract `TextRun.halo`, architecture §8): the DOM paints a
// spine row's words with `text-shadow: 0 0 5px var(--color-ground)` twice, a
// soft ground wash behind the glyphs. The engine draws it as a second text
// quad behind the sharp one, in the ground's ink, on a cell grown by the
// halo's padding — one colour per cell, so the text shader's single tint
// stays exact. These tests hold the expansion, the cell key and the padding
// arithmetic that keeps the grown quad's UV stretch pixel for pixel.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, PaintEnv, Quad, TextRun } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import { HALO_BLUR, HALO_PAD, haloPadDevice, runKey } from "../src/window/canvas/engine/text";
import { seat } from "./support/model-nodes";

const fact = (): CardFact => ({ id: "a", row: seat("a"), derived: { regionDepth: 0, blocked: false, z: 0 } });
const env: PaintEnv = { measure: (run) => run.text.length * run.size * 0.6 };

const run: TextRun = {
  text: "fresh next",
  font: "body",
  size: 11,
  weight: 400,
  truncate: "end",
  width: 90,
  halo: true,
};

const words: Quad = {
  key: "words",
  kind: "text",
  band: "cards",
  z: 40,
  rect: { x: 10, y: 20, width: 90, height: 14 },
  tiers: 15,
  scale: { kind: "board" },
  style: { ink: { token: "ink-2" } },
  text: run,
  part: { kind: "body" },
};

const sceneAsks = (quad: Quad, scale = 2) => {
  const asks: Array<{ readonly quad: Quad; readonly scale: number }> = [];
  const scene = createScene({
    painter: () => ({ quads: [quad], dim: { opacity: 1, saturate: 1 }, lift: 0 }),
    source: (asked, at) => {
      asks.push({ quad: asked, scale: at });
      return 7;
    },
    scale: () => scale,
  });
  scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
  return asks;
};

describe("the halo pass", () => {
  it("draws a soft ground copy behind the sharp words", () => {
    const asks = sceneAsks(words);
    expect(asks.map((ask) => ask.quad.key)).toEqual(["halo:words", "words"]);
    const halo = asks[0]!.quad;
    expect(halo.kind).toBe("text");
    // The wash is the ground's, the glyphs keep the paint's ink.
    expect(halo.style.ink).toEqual({ token: "ground" });
    expect(asks[1]!.quad.style.ink).toEqual({ token: "ink-2" });
    // Same words at the same wrap width, only the mask softens.
    expect(halo.text).toEqual({ ...run, halo: false, blur: HALO_BLUR });
    expect(halo.text!.width).toBe(run.width);
    // Under its own glyphs, whatever the key sorts like.
    expect(halo.z).toBeLessThan(asks[1]!.quad.z);
    // The wash is not a target: the words' own box answers the pointer.
    expect(halo.part).toBeUndefined();
    expect(asks[1]!.quad.part).toEqual({ kind: "body" });
  });

  it("grows the quad by exactly the cell's padding, in board units", () => {
    const halo = sceneAsks(words)[0]!.quad;
    expect(haloPadDevice(2)).toBe(2 * HALO_PAD);
    expect(halo.rect).toEqual({
      x: words.rect.x - HALO_PAD,
      y: words.rect.y - HALO_PAD,
      width: words.rect.width + 2 * HALO_PAD,
      height: words.rect.height + 2 * HALO_PAD,
    });
  });

  it("keeps the grown quad on its cell at any fractional raster scale", () => {
    // The scene grows the rect by pad / scale and the rasterizer sizes the
    // cell from the run; the two agree only if the cell's arithmetic is
    // ceil(width * scale) + 2 * pad. A half-pixel here smears every wash.
    for (const scale of [0.0625, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8, 16]) {
      for (const width of [0.4, 12.3, 90, 117.7, 240]) {
        const pad = haloPadDevice(scale);
        const grown = (width + (2 * pad) / scale) * scale;
        // The rasterizer sizes the cell from the run, the shader stretches it
        // across the grown quad: the two are one cell only when the ceiling of
        // the grown width is the ceiling of the run's plus both pads.
        expect(Math.ceil(grown)).toBe(Math.ceil(width * scale) + 2 * pad);
      }
    }
  });

  it("leaves a run without the flag alone", () => {
    const plain: Quad = { ...words, text: { ...run, halo: false } };
    expect(sceneAsks(plain).map((ask) => ask.quad.key)).toEqual(["words"]);
  });
});

describe("the halo cell", () => {
  it("keys apart from the sharp glyphs it sits behind", () => {
    const sharp = runKey(run, 2, 0);
    const halo = runKey({ ...run, halo: false, blur: HALO_BLUR }, 2, 0);
    expect(halo).not.toBe(sharp);
    // A second blur radius is a second cell, not a re-raster of the first.
    expect(runKey({ ...run, halo: false, blur: 3 }, 2, 0)).not.toBe(halo);
  });

  it("gets its own atlas cell, so neither pass overwrites the other", () => {
    const pixels = (width: number, height: number): AtlasPixels => ({ width, height }) as unknown as AtlasPixels;
    const atlas = createGpuAtlas({ rasterizeText: async () => pixels(90, 14) });
    const sharp = atlas.sourceFor({ ...words, text: { ...run, halo: false } }, 2);
    const halo = atlas.sourceFor({ ...words, text: { ...run, halo: false, blur: HALO_BLUR } }, 2);
    const again = atlas.sourceFor({ ...words, text: { ...run, halo: false, blur: HALO_BLUR } }, 2);
    expect(sharp).not.toBe(halo);
    expect(again).toBe(halo);
    expect(atlas.requests).toBe(2);
    atlas.dispose();
  });
});
