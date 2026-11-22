// The style table appends (issue 915): a new style writes one row, a known one
// none, and the renderer uploads only the rows the GPU does not have yet.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import { themeGpu } from "@shared/theme";
import type { CardFact, Quad, QuadStyle } from "../src/window/canvas/contract";
import { createStyleTable, STYLE_STRIDE } from "../src/window/canvas/engine/styles";
import { createScene } from "../src/window/canvas/engine/scene";
import { createRenderer } from "../src/window/canvas/engine/renderer";
import { seat } from "./support/model-nodes";

const tinted = (index: number): QuadStyle => ({ fill: { kind: "flat", color: { custom: `#${index.toString(16).padStart(6, "0")}` } } });

describe("the style table", () => {
  it("interns structurally, so equal styles share a row and any field tells them apart", () => {
    const table = createStyleTable(themeGpu("dark"));
    const a = table.intern({ fill: { kind: "flat", color: { token: "ink", alpha: 0.5 } }, opacity: 0.72 });
    expect(table.intern({ opacity: 0.72, fill: { kind: "flat", color: { token: "ink", alpha: 0.5 } } })).toBe(a);
    expect(table.intern({ fill: { kind: "flat", color: { token: "ink", alpha: 0.4 } }, opacity: 0.72 })).not.toBe(a);
    expect(table.intern({ fill: { kind: "flat", color: { token: "ink", alpha: 0.5 } } })).not.toBe(a);
    const mix = { kind: "flat", color: { mix: [{ token: "ink" }, { token: "ground" }], share: 0.2 } } as const;
    expect(table.intern({ fill: mix })).toBe(table.intern({ fill: { ...mix } }));
    expect(table.intern({ stroke: { color: { token: "ink" }, width: 1 } })).not.toBe(table.intern({ stroke: { color: { token: "ink" }, width: 1, outside: true } }));
  });

  it("writes a new row in place and leaves the earlier rows as they were, until a theme rewrites them all", () => {
    const table = createStyleTable(themeGpu("dark"));
    for (let index = 0; index < 100; index += 1) table.intern(tinted(index));
    const before = table.buffer.slice(0, 100 * STYLE_STRIDE);
    const epoch = table.themeEpoch;
    table.intern(tinted(100));
    expect(table.buffer.slice(0, 100 * STYLE_STRIDE)).toEqual(before);
    expect(table.themeEpoch).toBe(epoch);
    table.setTheme(themeGpu("bright"));
    expect(table.themeEpoch).toBe(epoch + 1);
    // Custom colours do not follow the theme: the rows are rewritten the same.
    expect(table.buffer.slice(0, 100 * STYLE_STRIDE)).toEqual(before);
  });
});

describe("the style upload", () => {
  it("writes only the rows the GPU lacks, and the whole table after a theme", () => {
    let count = 3;
    const quads = (): Quad[] =>
      Array.from({ length: count }, (_, index) => ({
        key: `q${String(index)}`,
        kind: "shape",
        band: "cards",
        z: index,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        tiers: 15,
        scale: { kind: "board" },
        style: tinted(index),
      })) as unknown as Quad[];
    const scene = createScene({ painter: () => ({ quads: quads(), dim: { opacity: 1, saturate: 1 }, lift: 0 }) });
    const fact: CardFact = { id: "a", row: seat("a"), derived: { regionDepth: 0, blocked: false, z: 0 } };
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact], wires: [] });
    const writes: Array<{ readonly data: unknown; readonly offset: number; readonly elements: number }> = [];
    const device = {
      limits: { maxStorageBufferBindingSize: 2 ** 27, maxBufferSize: 2 ** 28 },
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createSampler: () => ({}),
      createTexture: () => ({ createView: () => ({}), destroy: () => undefined }),
      createBuffer: ({ size }: { size: number }) => ({ size, destroy: () => undefined }),
      pushErrorScope: () => undefined,
      popErrorScope: () => Promise.resolve(null),
      queue: { writeBuffer: (_buffer: unknown, offset: number, data: unknown, _from = 0, elements = 0) => writes.push({ data, offset, elements }) },
    } as unknown as GPUDevice;
    const VIEW = { x: -100, y: -100, width: 800, height: 600 };
    const renderer = createRenderer();
    renderer.configure(device, "bgra8unorm", 1, scene);
    renderer.upload(scene, scene.prepare(VIEW, "near"));
    const rows = () => writes.filter((write) => write.data === scene.styleBuffer);
    const first = scene.styleCount;
    expect(rows().at(-1)).toMatchObject({ offset: 0, elements: first * STYLE_STRIDE });
    // One more quad, one more style: one row, at its own place.
    writes.length = 0;
    count = 4;
    scene.apply({ kind: "card", fact: { ...fact, derived: { ...fact.derived, z: 1 } } });
    renderer.upload(scene, scene.prepare(VIEW, "near"));
    expect(rows()).toEqual([{ data: scene.styleBuffer, offset: first * STYLE_STRIDE * 4, elements: STYLE_STRIDE }]);
    // A theme rewrites every row, so every row goes up.
    writes.length = 0;
    scene.apply({ kind: "theme", mode: "bright" });
    renderer.upload(scene, scene.prepare(VIEW, "near"));
    expect(rows().at(-1)).toMatchObject({ offset: 0, elements: scene.styleCount * STYLE_STRIDE });
  });
});
