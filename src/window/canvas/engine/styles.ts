/**
 * The style table (docs/canvas-gpu-architecture.md section 7, "Styles, not
 * colours"). `paint/` emits `Quad.style` as a `QuadStyle` of `ColorRef`s —
 * never a colour — and the engine interns each distinct style into one slot
 * of this table, structurally: two quads with the same style share an id,
 * the way two elements sharing a CSS class do.
 *
 * The table is computed from themeGpu(mode) into one flat Float32Array the
 * engine uploads. A theme switch rewrites the colour channels in place and
 * no record changes, because ids are stable: intern() returns the same id
 * for the same QuadStyle in either theme.
 *
 * Colours resolve the way the CSS does:
 *   - { token, alpha } is color-mix(in oklab, token N%, transparent): the
 *     token's colour at that alpha share (0 to 1)
 *   - { custom } is a hex a node row stores, painted as stored
 *   - { mix: [a, b], share } is color-mix(in oklab, a share%, b), mixed in
 *     OKLab with premultiplied alpha — mixOklab, the same arithmetic
 */

import {
  mixOklab,
  oklabToOklch,
  oklchToSrgb,
  srgbToOklab,
  themeGpu,
  SHADOW,
  type GpuColor,
  type GpuTheme,
  type ShadowLayer,
} from "@shared/theme";
import type {
  ColorRef,
  FillSpec,
  QuadStyle,
  ShadowSpec as ContractShadowSpec,
  StrokeSpec,
} from "../contract";

export type { ColorRef, QuadStyle } from "../contract";
export type StyleId = number;

// Buffer layout, STYLE_STRIDE floats per style:
//   0-3   fillFrom rgba     4-7   fillTo rgba (a=0: flat fill)
//   8     fillAngle (deg, CSS convention; 0 when flat)
//   9-12  stroke rgba       13    strokeWidth (0: none)
//   14-15 stroke dash, gap (0,0: solid)
//   16    strokeOutside (0/1)
//   17    shadow spec index (-1: none)
//   18-21 ink rgba (a=0: none — coverage glyphs and text take it)
//   22    opacity multiplier (1: unchanged)
//   23    reserved
export const STYLE_STRIDE = 24;
const FILL_FROM = 0;
const FILL_TO = 4;
const FILL_ANGLE = 8;
const STROKE = 9;
const STROKE_W = 13;
const STROKE_DASH = 14;
const STROKE_OUTSIDE = 16;
const SHADOW_ID = 17;
const INK = 18;
const OPACITY = 22;

/** A resolved shadow: the SHADOW recipe's layers plus the tint for the
 *  layers whose colour is chosen at paint time (reach hue, urgency, wire,
 *  cluster rim, zone). */
export interface ShadowSpec {
  readonly name: string;
  readonly layers: readonly ShadowLayer[];
  readonly tint?: GpuColor;
}

export interface StyleTable {
  /** Flat buffer, STYLE_STRIDE floats per style, for the engine to upload. */
  readonly buffer: Float32Array;
  readonly size: number;
  /** Intern a QuadStyle: the same style returns the same id, in either
   *  theme. This is the only way a record names a style. */
  intern(style: QuadStyle): StyleId;
  readonly shadows: readonly ShadowSpec[];
  /** Rebuild every colour channel for a new theme. Ids do not change. */
  setTheme(theme: GpuTheme): void;
}

const hexToSrgb = (hex: string): readonly [number, number, number] => {
  const h = hex.replace("#", "");
  const v = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
  return h.length >= 6 ? [v(0), v(2), v(4)] : [v(0) / 17, v(1) / 17, v(2) / 17];
};

const resolveColour = (
  ref: ColorRef | undefined,
  theme: GpuTheme,
): GpuColor | undefined => {
  if (ref === undefined) return undefined;
  const finish = (c: GpuColor, alpha?: number): GpuColor =>
    alpha === undefined ? c : { ...c, a: c.a * alpha };
  if ("token" in ref) {
    const base = theme.colors[ref.token];
    return base ? finish(base, ref.alpha) : undefined;
  }
  if ("custom" in ref) {
    const [r, g, b] = hexToSrgb(ref.custom);
    return { r, g, b, a: ref.alpha ?? 1 };
  }
  const [top, bottom] = ref.mix;
  const a = resolveColour(top, theme);
  const b = resolveColour(bottom, theme);
  if (!a || !b) return undefined;
  const mixed = mixOklab(
    srgbToOklab(a.r, a.g, a.b, a.a),
    srgbToOklab(b.r, b.g, b.b, b.a),
    ref.share * 100,
  );
  const { l, c, h } = oklabToOklch(mixed);
  const [r, g, b2] = oklchToSrgb({ l, c, h });
  return { r, g, b: b2, a: mixed.alpha };
};

const fillColours = (
  fill: FillSpec | undefined,
  theme: GpuTheme,
): { from?: GpuColor; to?: GpuColor; angle: number } => {
  if (fill === undefined) return { angle: 0 };
  if (fill.kind === "flat") {
    return { from: resolveColour(fill.color, theme), angle: 0 };
  }
  return {
    from: resolveColour(fill.from, theme),
    to: resolveColour(fill.to, theme),
    angle: fill.angle,
  };
};

const strokeOf = (stroke: StrokeSpec | undefined, theme: GpuTheme) => ({
  color: stroke ? resolveColour(stroke.color, theme) : undefined,
  width: stroke?.width ?? 0,
  dash: stroke?.dash ?? ([0, 0] as const),
  outside: stroke?.outside ?? false,
});

/** Structural key: two QuadStyles that resolve identically share a slot. */
const styleKey = (style: QuadStyle): string => JSON.stringify(style);
const shadowKey = (spec: ContractShadowSpec | undefined): string =>
  spec === undefined ? "" : `${spec.name}${JSON.stringify(spec.tint ?? null)}`;

export const createStyleTable = (initial: GpuTheme = themeGpu("dark")): StyleTable => {
  const slots = new Map<string, StyleId>();
  const order: QuadStyle[] = [];
  const shadows: ShadowSpec[] = [];
  const shadowIds = new Map<string, number>();
  let theme = initial;
  let buffer = new Float32Array(0);

  const shadowSpecOf = (spec: ContractShadowSpec | undefined): ShadowSpec | undefined => {
    if (spec === undefined) return undefined;
    const key = shadowKey(spec);
    const existing = shadowIds.get(key);
    if (existing !== undefined) return shadows[existing];
    const layers = SHADOW[spec.name as keyof typeof SHADOW];
    if (layers === undefined) {
      throw new Error(`style table: unknown shadow "${spec.name}"`);
    }
    const tint = resolveColour(spec.tint, theme);
    const resolved: ShadowSpec = {
      name: spec.name,
      layers,
      ...(tint ? { tint } : {}),
    };
    shadowIds.set(key, shadows.length);
    shadows.push(resolved);
    return resolved;
  };

  const rebuild = (): void => {
    const next = new Float32Array(order.length * STYLE_STRIDE);
    order.forEach((style, i) => {
      const at = i * STYLE_STRIDE;
      const put = (colour: GpuColor | undefined, offset: number): void => {
        if (!colour) return;
        next[at + offset] = colour.r;
        next[at + offset + 1] = colour.g;
        next[at + offset + 2] = colour.b;
        next[at + offset + 3] = colour.a;
      };
      const fill = fillColours(style.fill, theme);
      put(fill.from, FILL_FROM);
      put(fill.to, FILL_TO);
      next[at + FILL_ANGLE] = fill.angle;
      const stroke = strokeOf(style.stroke, theme);
      put(stroke.color, STROKE);
      next[at + STROKE_W] = stroke.width;
      next[at + STROKE_DASH] = stroke.dash[0];
      next[at + STROKE_DASH + 1] = stroke.dash[1];
      next[at + STROKE_OUTSIDE] = stroke.outside ? 1 : 0;
      const shadow = shadowSpecOf(style.shadow);
      next[at + SHADOW_ID] = shadow ? shadowIds.get(shadowKey(style.shadow))! : -1;
      put(resolveColour(style.ink, theme), INK);
      next[at + OPACITY] = style.opacity ?? 1;
    });
    buffer = next;
  };

  rebuild();

  return {
    get buffer() {
      return buffer;
    },
    get size() {
      return order.length;
    },
    intern: (style) => {
      const key = styleKey(style);
      const existing = slots.get(key);
      if (existing !== undefined) return existing;
      const id = order.length;
      slots.set(key, id);
      order.push(style);
      rebuild();
      return id;
    },
    get shadows() {
      return shadows;
    },
    setTheme: (next) => {
      theme = next;
      // Shadow specs re-resolve their tint; names and layers are theme-free,
      // and keys carry no theme data, so ids re-register in the same order.
      shadowIds.clear();
      shadows.length = 0;
      rebuild();
    },
  };
};
