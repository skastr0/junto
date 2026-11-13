import { describe, expect, it } from "vitest";
import { themeGpu } from "../src/shared/theme";
import { createStyleTable, STYLE_STRIDE } from "../src/window/canvas/engine/styles";
import type { QuadStyle } from "../src/window/canvas/contract";
import {
  clampLines,
  layoutRun,
  truncateHead,
  truncateTail,
  wrapLines,
  type TextRun,
} from "../src/window/canvas/engine/text";
import { createImageAtlas, imageKey } from "../src/window/canvas/engine/images";
import type { Rasterize } from "../src/window/canvas/contract";

// Track B (Look) done-tests that run without a GPU or a DOM:
//   - a theme switch rewrites the style table and no record
//   - text truncation matches the DOM's for the inventory's cases
//   - the image atlas keys by content and size and shares one job per key

const cardBody: QuadStyle = {
  fill: { kind: "flat", color: { token: "ground" } },
  stroke: { color: { token: "ink", alpha: 0.14 }, width: 1 },
  ink: { token: "ink" },
};
const wireFlows: QuadStyle = {
  stroke: { color: { token: "wire-flows" }, width: 1.2 },
};

describe("style table", () => {
  it("a theme switch rewrites the table and no record", () => {
    const dark = themeGpu("dark");
    const bright = themeGpu("bright");
    const table = createStyleTable(dark);
    const card = table.intern(cardBody);
    const wire = table.intern(wireFlows);
    // Structural interning: the same QuadStyle is one slot.
    expect(table.intern({ ...cardBody })).toBe(card);
    expect(table.size).toBe(2);

    const before = table.buffer.slice();
    const darkFill = before.slice(card * STYLE_STRIDE, card * STYLE_STRIDE + 4);

    // A record holds only the index; it does not change across the switch.
    table.setTheme(bright);
    expect(table.size).toBe(2);
    expect(table.buffer.length).toBe(before.length);
    const after = table.buffer.slice();
    const brightFill = after.slice(card * STYLE_STRIDE, card * STYLE_STRIDE + 4);
    expect(Array.from(brightFill)).not.toEqual(Array.from(darkFill));
    // The style id still resolves, now to the bright colour.
    expect(table.intern(cardBody)).toBe(card);
    expect(wire).toBe(1);
    expect(table.buffer[wire * STYLE_STRIDE + 13]).toBeCloseTo(1.2, 5);
  });

  it("resolves ColorRef: token alpha, custom hex, and oklab mixes", () => {
    const table = createStyleTable(themeGpu("dark"));
    const gpu = themeGpu("dark");
    const wash = table.intern({
      fill: { kind: "flat", color: { token: "ink", alpha: 0.07 } },
    });
    const at = wash * STYLE_STRIDE;
    expect(table.buffer[at + 3]).toBeCloseTo(gpu.colors["ink"]!.a * 0.07, 6);
    expect(table.buffer[at]).toBeCloseTo(gpu.colors["ink"]!.r, 6);

    const custom = table.intern({
      fill: { kind: "flat", color: { custom: "#336699", alpha: 0.5 } },
    });
    const ct = custom * STYLE_STRIDE;
    expect(table.buffer[ct]).toBeCloseTo(0x33 / 255, 6);
    expect(table.buffer[ct + 1]).toBeCloseTo(0x66 / 255, 6);
    expect(table.buffer[ct + 2]).toBeCloseTo(0x99 / 255, 6);
    expect(table.buffer[ct + 3]).toBeCloseTo(0.5, 6);

    const blend = table.intern({
      fill: { kind: "flat", color: { mix: [{ token: "ink" }, { token: "ground" }], share: 0.5 } },
    });
    const bt = blend * STYLE_STRIDE;
    // 50/50 of ink and ground in oklab sits between their lightnesses.
    const lInk = gpu.colors["ink"]!;
    const lGround = gpu.colors["ground"]!;
    expect(table.buffer[bt]).toBeGreaterThan(Math.min(lInk.r, lGround.r) - 0.01);
    expect(table.buffer[bt]).toBeLessThan(Math.max(lInk.r, lGround.r) + 0.01);
    expect(table.buffer[bt + 3]).toBe(1);
  });

  it("carries stroke dash/outside, shadow tint and opacity through", () => {
    const table = createStyleTable(themeGpu("dark"));
    const dashed = table.intern({
      stroke: {
        color: { token: "ink" },
        width: 1.8,
        dash: [6, 4],
        outside: true,
      },
      shadow: { name: "card", tint: { token: "ink", alpha: 0.2 } },
      opacity: 0.5,
    });
    const at = dashed * STYLE_STRIDE;
    expect(table.buffer[at + 14]).toBe(6);
    expect(table.buffer[at + 15]).toBe(4);
    expect(table.buffer[at + 16]).toBe(1);
    expect(table.buffer[at + 17]).toBeGreaterThanOrEqual(0);
    expect(table.buffer[at + 22]).toBe(0.5);
    expect(table.shadows[table.buffer[at + 17]!]).toMatchObject({
      name: "card",
    });
  });
});

describe("text truncation", () => {
  // A deterministic stand-in for canvas measureText: every glyph 10 wide,
  // the ellipsis 10. The inventory's cases are structural — which string
  // comes out — so a uniform advance exercises the same code paths the DOM's
  // real metrics would.
  const measure = (text: string): number => text.length * 10;
  const run = (over: Partial<TextRun>): TextRun => ({
    text: "",
    font: "mono",
    size: 12,
    weight: 500,
    truncate: "none",
    width: 100,
    ...over,
  });

  it("tail ellipsis keeps text that fits and cuts the rest", () => {
    expect(truncateTail("short", 100, measure)).toBe("short");
    // 50 wide: "hello world" (110) -> budget 40 -> 4 chars + …
    expect(truncateTail("hello world", 50, measure)).toBe("hell…");
    expect(truncateTail("hello", 5, measure)).toBe("…");
  });

  it("head truncation keeps the path's tail, ellipsis first", () => {
    expect(truncateHead("short", 100, measure)).toBe("short");
    // budget 40 -> last 4 chars of "src/window/canvas" survive
    expect(truncateHead("src/window/canvas", 50, measure)).toBe("…nvas");
  });

  it("wraps like the DOM and clamps to two lines with an ellipsis", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const lines = wrapLines(text, 100, measure);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(line.length * 10).toBeLessThanOrEqual(110);
    const clamped = clampLines(text, 100, 2, measure);
    expect(clamped).toHaveLength(2);
    expect(clamped[1]!.endsWith("…")).toBe(true);
    // Nothing is lost that fits: three or fewer lines pass through whole.
    expect(clampLines("one two", 100, 2, measure)).toEqual(["one two"]);
  });

  it("layoutRun dispatches the contract's truncate modes", () => {
    expect(layoutRun(run({ text: "hello world", truncate: "end" }), 50, measure)).toEqual(["hell…"]);
    expect(layoutRun(run({ text: "src/window/canvas", truncate: "head" }), 50, measure)).toEqual(["…nvas"]);
    expect(
      layoutRun(run({ text: "the quick brown fox jumps over the lazy dog", truncate: "clamp2" }), 100, measure),
    ).toHaveLength(2);
    expect(layoutRun(run({ text: "one two", truncate: "none" }), 100, measure)).toEqual(["one two"]);
    // `upper` applies before measuring, as the DOM's text-transform does.
    expect(layoutRun(run({ text: "abc", upper: true, truncate: "end" }), 100, measure)).toEqual(["ABC"]);
  });
});

describe("image atlas", () => {
  const fakeBitmap = { width: 1, height: 1 } as ImageBitmap;
  const rasterize: Rasterize = (source, size) => {
    void source;
    void size;
    return Promise.resolve(fakeBitmap);
  };

  it("keys by content and size, shares one job, evicts least recent", async () => {
    // Each 4x4 cell is 64 bytes; the cap holds three.
    const atlas = createImageAtlas(rasterize, { byteCap: 3 * 64 });
    const src = { key: "portrait:seat-1", svg: "<svg/>" };
    const [a, b] = await Promise.all([
      atlas.want(src, 4, 4),
      atlas.want(src, 4, 4),
    ]);
    expect(a).toBe(b);
    expect(atlas.stats.cells).toBe(1);
    await atlas.want({ key: "icon:x" }, 4, 4);
    await atlas.want({ key: "band:y" }, 4, 4);
    expect(atlas.stats.cells).toBe(3);
    // A fourth overflows the cap and evicts the least recently used.
    await atlas.want({ key: "media:z" }, 4, 4);
    expect(atlas.stats.cells).toBe(3);
    expect(atlas.cell(src, 4, 4)).toBeUndefined();
    expect(atlas.cell({ key: "media:z" }, 4, 4)).toBeDefined();
    expect(imageKey(src, 4, 4)).toBe("portrait:seat-1@4x4");
  });
});
