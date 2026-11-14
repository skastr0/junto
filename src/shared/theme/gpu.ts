import { BORDER, DURATION, EASING, GLOW, SHADOW } from "./chrome";
import { oklchToSrgb } from "./oklch";
import { resolveSolid, semanticTokens, type ThemeMode } from "./semantic";

// The GPU canvas's theme projection (docs/canvas-gpu-architecture.md §7):
// every semantic token resolved to plain numbers a style table or vertex
// buffer can hold, plus the mode-independent chrome tokens. The engine calls
// themeGpu(mode) once per theme and reads `colors` by token name; a shadow
// or glow layer's `color` names a token resolved through `colors`, while a
// layer with only `cssColor` takes its colour from the painted style (a
// node's accent, a region's hue, a wire's verb).
//
// Colours are sRGB components, transfer-encoded and clamped to [0, 1],
// straight alpha — the engine premultiplies at blend time, as CSS does.
// Every token sits inside sRGB (a9ef0a3bb, tests/theme-gamut.test.ts), so
// the canvas uses the token's colour as it is: the same encoded values the
// CSS custom properties resolve to, with no colour adjustment in canvas
// code (architecture §7, "One colour on every screen").

/** A colour ready for a GPU buffer: sRGB rgb, straight alpha 0 to 1. */
export interface GpuColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface GpuTheme {
  /** Every semantic token by name, resolved for the mode. */
  readonly colors: Readonly<Record<string, GpuColor>>;
  /** Mode-independent paint tokens (chrome.ts), shared by reference. */
  readonly shadow: typeof SHADOW;
  readonly glow: typeof GLOW;
  readonly border: typeof BORDER;
  readonly duration: typeof DURATION;
  readonly easing: typeof EASING;
}

export const themeGpu = (mode: ThemeMode): GpuTheme => {
  const tokens = semanticTokens(mode);
  const colors: Record<string, GpuColor> = {};
  for (const [name, value] of Object.entries(tokens)) {
    if (value.kind === "mix") {
      // color-mix(token pct%, transparent) keeps the token's colour and
      // takes pct as its alpha — the premultiplied arithmetic makes it
      // exact, so the solid's sRGB channels carry over unchanged.
      const [r, g, b] = oklchToSrgb(resolveSolid(tokens, value.token));
      colors[name] = { r, g, b, a: value.pct / 100 };
    } else {
      const [r, g, b] = oklchToSrgb(resolveSolid(tokens, name));
      colors[name] = { r, g, b, a: 1 };
    }
  }
  return {
    colors,
    shadow: SHADOW,
    glow: GLOW,
    border: BORDER,
    duration: DURATION,
    easing: EASING,
  };
};

/**
 * A resolved GpuColor back to a CSS colour string, for the Canvas2D
 * rasterizers that feed the atlas (text coverage, glyph ink, media ground,
 * `var(--color-*)` inside standalone SVG). Hex at full alpha, rgba() below
 * it — the same shapes themeRuntime emits for the DOM projection, so a cell
 * and its DOM twin read the same colour.
 */
export const gpuColorCss = (c: GpuColor): string => {
  const channel = (v: number): number =>
    Math.round(Math.min(1, Math.max(0, v)) * 255);
  if (c.a >= 1) {
    const hex = (v: number): string => channel(v).toString(16).padStart(2, "0");
    return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
  }
  const alpha = Math.min(1, Math.max(0, c.a));
  return `rgba(${channel(c.r)}, ${channel(c.g)}, ${channel(c.b)}, ${alpha})`;
};
