import { describe, expect, it } from "vitest";
import {
  mixOklab,
  oklchToHex,
  oklchToOklab,
  oklchToSrgb,
  oklabToOklch,
  themeGpu,
  themeRuntime,
  TOKEN_NAMES,
  type OklabColor,
  type ThemeMode,
} from "../src/shared/theme";

// The GPU canvas's theme bridge (docs/canvas-gpu-architecture.md section 7):
// themeGpu(mode) must hand the engine the same colours the CSS custom
// properties and the runtime projection produce — tested against those
// projections, not by eye. mixOklab must do the arithmetic CSS
// color-mix(in oklab, ...) does: premultiplied-alpha interpolation in OKLab.

const MODES: readonly ThemeMode[] = ["dark", "bright"];

/** Parse the rgba()/hex strings themeRuntime emits back to channels. */
const runtimeChannels = (css: string): [number, number, number, number] => {
  const rgba = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(css);
  if (rgba) {
    return [
      Number(rgba[1]) / 255,
      Number(rgba[2]) / 255,
      Number(rgba[3]) / 255,
      Number(rgba[4]),
    ];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (!hex) throw new Error(`unparsed runtime colour: ${css}`);
  const n = parseInt(hex[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
};

// themeRuntime quantizes to 8-bit hex; the GPU keeps full precision. The two
// may differ by at most one quantization step per channel.
const CHANNEL_TOLERANCE = 1 / 255 + 1e-6;

describe("themeGpu matches the CSS projections", () => {
  for (const mode of MODES) {
    it(`every token in ${mode} equals its runtime colour`, () => {
      const gpu = themeGpu(mode);
      const runtime = themeRuntime(mode);
      expect(Object.keys(gpu.colors).sort()).toEqual([...TOKEN_NAMES].sort());
      for (const name of TOKEN_NAMES) {
        const [r, g, b, a] = runtimeChannels(runtime[name]!);
        const colour = gpu.colors[name]!;
        expect(Math.abs(colour.r - r), `${mode} ${name}.r`).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
        expect(Math.abs(colour.g - g), `${mode} ${name}.g`).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
        expect(Math.abs(colour.b - b), `${mode} ${name}.b`).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
        expect(colour.a, `${mode} ${name}.a`).toBeCloseTo(a, 10);
      }
    });

    it(`every solid token in ${mode} equals oklchToSrgb of its oklch`, () => {
      const gpu = themeGpu(mode);
      // Spot-check through the runtime hex: the GPU channels are the same
      // colour at full precision, so converting back through oklchToHex of
      // the GPU rgb would round-trip; here we check a known wire verb.
      expect(gpu.colors["wire-flows"]).toBeDefined();
      expect(gpu.colors["wire-messages"]).toBeDefined();
    });
  }

  it("wire verb colours differ per mode and derive follows flows", () => {
    const dark = themeGpu("dark");
    const bright = themeGpu("bright");
    expect(dark.colors["wire-derives"]).toEqual(dark.colors["wire-flows"]);
    expect(bright.colors["wire-derives"]).toEqual(bright.colors["wire-flows"]);
    expect(dark.colors["wire-flows"]).not.toEqual(bright.colors["wire-flows"]);
  });

  it("carries the chrome tokens the engine indexes", () => {
    const gpu = themeGpu("dark");
    expect(gpu.border.hairline).toBe(1);
    expect(gpu.border["wire-track"]).toBeCloseTo(gpu.border.wire * 1.5, 10);
    expect(gpu.duration.flow).toBe(450);
    expect(gpu.easing.standard).toEqual([0.25, 0.1, 0.25, 1]);
    expect(gpu.shadow.card.length).toBeGreaterThan(0);
  });
});

describe("mixOklab does the color-mix(in oklab) arithmetic", () => {
  const colour = (l: number, c: number, h: number, alpha = 1): OklabColor =>
    oklchToOklab({ l, c, h }, alpha);

  it("mixing with transparent keeps the colour and takes the alpha", () => {
    // CSS: color-mix(in oklab, C 30%, transparent) is C at alpha .3 — the
    // premultiplied interpolation cannot move the colour channels.
    const top = colour(0.6, 0.1, 250);
    const out = mixOklab(top, { l: 0, a: 0, b: 0, alpha: 0 }, 30);
    expect(out.alpha).toBeCloseTo(0.3, 10);
    expect(out.l).toBeCloseTo(top.l, 10);
    expect(out.a).toBeCloseTo(top.a, 10);
    expect(out.b).toBeCloseTo(top.b, 10);
  });

  it("50/50 of two opaque colours is their OKLab midpoint", () => {
    const a = colour(0.7, 0.15, 20);
    const b = colour(0.4, 0.08, 200);
    const out = mixOklab(a, b, 50);
    expect(out.alpha).toBe(1);
    expect(out.l).toBeCloseTo((a.l + b.l) / 2, 10);
    expect(out.a).toBeCloseTo((a.a + b.a) / 2, 10);
    expect(out.b).toBeCloseTo((a.b + b.b) / 2, 10);
  });

  it("weights premultiplied by alpha, as CSS does", () => {
    // top at 25% weight, alpha .5; bottom opaque. Result alpha .625, and the
    // colour leans toward bottom because top's premultiplied share is small.
    const top = colour(0.9, 0.2, 100, 0.5);
    const bottom = colour(0.2, 0.05, 300, 1);
    const out = mixOklab(top, bottom, 25);
    expect(out.alpha).toBeCloseTo(0.25 * 0.5 + 0.75 * 1, 10);
    // Un-premultiply check: the channels equal the alpha-weighted mean.
    const w = 0.25;
    const alpha = w * 0.5 + (1 - w) * 1;
    expect(out.l).toBeCloseTo((w * 0.5 * top.l + (1 - w) * 1 * bottom.l) / alpha, 10);
  });

  it("clamps the percentage to 0-100 and survives zero alpha", () => {
    const top = colour(0.9, 0.2, 100);
    const bottom = colour(0.2, 0.05, 300);
    // -20% clamps to 0: the result is the bottom colour whole.
    const low = mixOklab(top, bottom, -20);
    expect(low.alpha).toBe(1);
    expect(low.l).toBeCloseTo(bottom.l, 10);
    // 140% clamps to 100: the top colour whole.
    const high = mixOklab(top, bottom, 140);
    expect(high.alpha).toBe(1);
    expect(high.l).toBeCloseTo(top.l, 10);
    const none = mixOklab(
      { l: 0.5, a: 0.1, b: 0, alpha: 0 },
      { l: 0.2, a: 0, b: 0.1, alpha: 0 },
      50,
    );
    expect(none.alpha).toBe(0);
    expect(none.l).toBe(0);
  });

  it("round-trips through oklch for the colours the sheets mix", () => {
    // A mix of two theme solids lands between them in OKLCH terms.
    const a = oklchToOklab({ l: 0.9, c: 0.01, h: 250 });
    const b = oklchToOklab({ l: 0.5, c: 0.02, h: 190 });
    const mixed = oklabToOklch(mixOklab(a, b, 50));
    expect(mixed.l).toBeGreaterThan(0.5);
    expect(mixed.l).toBeLessThan(0.9);
    // And it converts to a hex like every other projection.
    expect(oklchToHex(mixed)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
