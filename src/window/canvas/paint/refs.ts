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
type Extra = Partial<Omit<Quad, "key" | "z" | "rect" | "kind">>;

const make = (kind: Quad["kind"], base: Base, extra: Extra): Quad => ({
  kind,
  band: "cards",
  tiers: ALL_TIERS,
  scale: BOARD,
  style: {},
  ...base,
  ...extra,
});

export const shape = (base: Base, style: QuadStyle, extra: Extra = {}): Quad => make("shape", base, { ...extra, style });
export const shadow = (base: Base, style: QuadStyle, extra: Extra = {}): Quad => make("shadow", base, { ...extra, style });
export const sprite = (base: Base, extra: Extra): Quad => make("sprite", base, extra);
export const text = (base: Base, style: QuadStyle, extra: Extra): Quad => make("text", base, { ...extra, style });

export const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

export const grow = (rect: Rect, by: number): Rect => ({
  x: rect.x - by,
  y: rect.y - by,
  width: rect.width + 2 * by,
  height: rect.height + 2 * by,
});
