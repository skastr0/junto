/**
 * Colours as data, and the quad builder every painter uses. A painter never
 * holds a colour: it names a token (`tok`), a stored custom colour, or a mix.
 * Colour names here are theme token names (`src/shared/theme/semantic.ts`).
 */

import { canvasSwatchFor, normalizeHexColor } from "@shared/canvas-colors";
import type { ActivityTone } from "@shared/wire/rings";
import {
  ALL_TIERS,
  type ColorRef,
  type Point,
  type Quad,
  type QuadStyle,
  type Radii,
  type Rect,
  type ScaleRule,
} from "../contract";

export const tok = (name: string, alpha?: number): ColorRef =>
  alpha === undefined ? { token: name } : { token: name, alpha };

/** `color-mix(in oklab, a share%, b)` with `share` 0 to 1 of `a`. */
export const mixOf = (a: ColorRef, b: ColorRef, share: number): ColorRef => ({ mix: [a, b], share });

/** The same colour at `share` of its own alpha: `color-mix(X N%, transparent)` over any ref. */
export const fade = (ref: ColorRef, share: number): ColorRef => {
  if ("mix" in ref) return mixOf(ref, { token: "ground", alpha: 0 }, share);
  return { ...ref, alpha: (ref.alpha ?? 1) * share };
};

/** A ring tone's hue token (`ACTIVITY_TONE_HEX`). */
export const TONE_HUE: Readonly<Record<ActivityTone, string>> = {
  amber: "amber",
  cyan: "cyan",
  green: "green",
  crimson: "crimson",
  steel: "steel",
};

/** A tone's text form (`TONE_TEXT` in AgentSeatView). */
export const TONE_TEXT: Readonly<Record<ActivityTone, string>> = {
  amber: "amber-fg",
  cyan: "cyan-fg",
  green: "green",
  crimson: "crimson-fg",
  steel: "steel",
};

/** `accentColor(color)`: a palette swatch is its token, any other hex as stored, none is `main`. */
export const accentRef = (color: string | undefined, fallback = "main"): ColorRef => {
  const swatch = canvasSwatchFor(color);
  if (swatch) return tok(swatch.token);
  const hex = color === undefined ? undefined : normalizeHexColor(color);
  return hex === undefined ? tok(fallback) : { custom: hex };
};

/** `withAlpha`: the accent at a share. */
export const accentAt = (color: string | undefined, share: number, fallback = "main"): ColorRef =>
  fade(accentRef(color, fallback), share);

export const BOARD: ScaleRule = { kind: "board" };

export const at = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

type Base = {
  readonly key: string;
  readonly z: number;
  readonly rect: Rect;
};
type Extra = Partial<Omit<Quad, "key" | "z" | "rect" | "kind">> & {
  /** The element a grown quad's radii belong to; defaults to the quad itself. */
  readonly element?: { readonly width: number; readonly height: number };
};

/**
 * The radii CSS actually uses, in tl, tr, br, bl order.
 *
 * `border-radius` never shrinks one corner on its own: when the two radii on
 * any edge would overlap, every radius is multiplied by the same factor
 * (Backgrounds and Borders 3, "Overlapping curves"). So a pill end beside a
 * 12px end is a fully round end beside square corners, never 28 beside 12: the
 * sheet's `999px 12px 12px 999px` on a seat's 216 by 56 shell is 28, 0.34,
 * 0.34, 28. Clamping each radius on its own, as the shader used to guard, is
 * right only when every radius is the same.
 */
export const cssRadii = (radii: Radii, width: number, height: number): Radii => {
  const [tl, tr, br, bl] = typeof radii === "number" ? [radii, radii, radii, radii] : radii;
  if (width <= 0 || height <= 0) return 0;
  const fit = (sum: number, length: number): number => (sum <= length ? 1 : length / sum);
  const f = Math.min(1, fit(tl + tr, width), fit(bl + br, width), fit(tl + bl, height), fit(tr + br, height));
  // A scalar stays a scalar: a pill asks for one radius, not four.
  if (typeof radii === "number") return f === 1 ? radii : radii * f;
  return f === 1 ? [tl, tr, br, bl] : [tl * f, tr * f, br * f, bl * f];
};

const make = (kind: Quad["kind"], base: Base, extra: Extra): Quad => {
  const { element, radii, ...rest } = extra;
  const box = element ?? base.rect;
  return {
    kind,
    band: "cards",
    tiers: ALL_TIERS,
    scale: BOARD,
    style: {},
    ...base,
    ...rest,
    // One site for the corner law: every painter names the radii its sheet
    // names, and the quad carries the values CSS would draw. A grown shadow
    // names its element, because CSS clamps the element's radii, not the
    // glow's larger box.
    ...(radii === undefined ? {} : { radii: cssRadii(radii, box.width, box.height) }),
  };
};

export const shape = (base: Base, style: QuadStyle, extra: Extra = {}): Quad => make("shape", base, { ...extra, style });
export const shadow = (base: Base, style: QuadStyle, extra: Extra = {}): Quad =>
  make("shadow", base, {
    ...extra,
    style,
    ...(extra.hole === undefined
      ? {}
      : { element: { width: Math.max(0, base.rect.width - extra.hole * 2), height: Math.max(0, base.rect.height - extra.hole * 2) } }),
  });
export const sprite = (base: Base, extra: Extra): Quad => make("sprite", base, extra);
export const text = (base: Base, style: QuadStyle, extra: Extra): Quad => make("text", base, { ...extra, style });

export const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

export const grow = (rect: Rect, by: number): Rect => ({
  x: rect.x - by,
  y: rect.y - by,
  width: rect.width + 2 * by,
  height: rect.height + 2 * by,
});
