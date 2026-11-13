/**
 * Resolve a contract colour into the plain sRGB numbers a record or a shader
 * uniform holds (docs/canvas-gpu-architecture.md, section 7).
 *
 * Colors are data in the contract: a theme token, a user's stored hex, or a
 * `color-mix`. This is the one place the engine turns one into bytes. Every
 * token sits inside sRGB (a9ef0a3bb), so the encoded value is used as it is:
 * no colour adjustment in canvas code.
 */

import {
  mixOklab,
  oklabToOklch,
  oklchToSrgb,
  srgbToOklab,
  type GpuColor,
  type GpuTheme,
} from "@shared/theme";
import type { ColorRef, FillSpec, QuadStyle } from "../contract";

const TRANSPARENT: GpuColor = { r: 0, g: 0, b: 0, a: 0 };

const parseHex = (hex: string): GpuColor | undefined => {
  const text = hex.trim();
  const short = /^#([0-9a-f]{3,4})$/iu.exec(text);
  if (short !== null) {
    const digits = short[1]!;
    const channel = (index: number): number => parseInt(digits[index]!.repeat(2), 16) / 255;
    return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 4 ? channel(3) : 1 };
  }
  const long = /^#([0-9a-f]{6}([0-9a-f]{2})?)$/iu.exec(text);
  if (long === null) return undefined;
  const digits = long[1]!;
  const channel = (index: number): number => parseInt(digits.slice(index, index + 2), 16) / 255;
  return { r: channel(0), g: channel(2), b: channel(4), a: digits.length === 8 ? channel(6) : 1 };
};

const withAlpha = (color: GpuColor, alpha: number | undefined): GpuColor =>
  alpha === undefined ? color : { ...color, a: color.a * alpha };

export const resolveColor = (ref: ColorRef | undefined, theme: GpuTheme): GpuColor => {
  if (ref === undefined) return TRANSPARENT;
  if ("token" in ref) {
    const base = theme.colors[ref.token];
    return base === undefined ? TRANSPARENT : withAlpha(base, ref.alpha);
  }
  if ("custom" in ref) {
    const parsed = parseHex(ref.custom);
    return parsed === undefined ? TRANSPARENT : withAlpha(parsed, ref.alpha);
  }
  const a = resolveColor(ref.mix[0], theme);
  const b = resolveColor(ref.mix[1], theme);
  const mixed = mixOklab(
    srgbToOklab(a.r, a.g, a.b, a.a),
    srgbToOklab(b.r, b.g, b.b, b.a),
    ref.share,
  );
  const { l, c, h } = oklabToOklch(mixed);
  const [r, g, blue] = oklchToSrgb({ l, c, h });
  return { r, g, b: blue, a: mixed.alpha };
};

export type ResolvedFill = {
  readonly from: GpuColor;
  readonly to: GpuColor;
  readonly angle: number;
};

export const resolveFill = (fill: FillSpec | undefined, theme: GpuTheme): ResolvedFill => {
  if (fill === undefined) return { from: TRANSPARENT, to: TRANSPARENT, angle: 0 };
  if (fill.kind === "gradient") {
    return {
      from: resolveColor(fill.from, theme),
      to: resolveColor(fill.to, theme),
      angle: fill.angle,
    };
  }
  return { from: resolveColor(fill.color, theme), to: TRANSPARENT, angle: 0 };
};

export type ResolvedStyle = ResolvedFill & {
  readonly stroke: GpuColor;
  readonly strokeWidth: number;
  readonly dash: number;
  readonly opacity: number;
  readonly ink: GpuColor;
};

/** Everything a record needs from a style; the style id itself is track B's. */
export const resolveStyle = (style: QuadStyle | undefined, theme: GpuTheme): ResolvedStyle => {
  const fill = resolveFill(style?.fill, theme);
  return {
    ...fill,
    stroke: resolveColor(style?.stroke?.color, theme),
    strokeWidth: style?.stroke?.width ?? 0,
    dash: style?.stroke?.dash === undefined ? 0 : 1,
    opacity: style?.opacity ?? 1,
    ink: resolveColor(style?.ink ?? (style?.fill?.kind === "flat" ? style.fill.color : undefined), theme),
  };
};

export { TRANSPARENT };
