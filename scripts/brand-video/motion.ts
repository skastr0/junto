// Motion helpers for the brand video: pure functions of time, so any frame
// can be rendered alone and the same frame always paints the same pixels.

export const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 0 before `from`, 1 after `from + span`, eased between. */
export const ramp = (t: number, from: number, span: number): number =>
  span <= 0 ? (t >= from ? 1 : 0) : clamp01((t - from) / span);

export const easeInOut = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
export const easeOut = (t: number): number => 1 - (1 - clamp01(t)) ** 3;
export const easeIn = (t: number): number => clamp01(t) ** 3;

/** A soft overshoot that settles: good for a critter popping into place. */
export const springOut = (t: number): number => {
  const x = clamp01(t);
  if (x >= 1) return 1;
  return 1 - Math.exp(-6.5 * x) * Math.cos(x * Math.PI * 2.4);
};

/** A drop that lands and gives one small bounce. */
export const dropOut = (t: number): number => {
  const x = clamp01(t);
  if (x < 0.62) return (x / 0.62) ** 2;
  const b = (x - 0.62) / 0.38;
  return 1 - 0.07 * Math.sin(b * Math.PI) * (1 - b);
};

/** 0 -> 1 -> 0 over the span: a one-shot bump. */
export const bump = (t: number, from: number, span: number): number => {
  const x = (t - from) / span;
  return x <= 0 || x >= 1 ? 0 : Math.sin(x * Math.PI);
};

/** Fade in over `inSpan` from `from`, hold, fade out over `outSpan` ending at `to`. */
export const window01 = (t: number, from: number, to: number, inSpan = 0.35, outSpan = 0.35): number =>
  Math.min(ramp(t, from, inSpan), 1 - ramp(t, to - outSpan, outSpan));

/** Positive modulo. */
export const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** Deterministic hash to [0, 1). */
export const hash01 = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export type Point = { readonly x: number; readonly y: number };

/** Point on a quadratic bezier from a to b bowed by `bow` px to its left. */
export const bowPoint = (a: Point, b: Point, bow: number, t: number): Point => {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = mx - (dy / len) * bow;
  const cy = my + (dx / len) * bow;
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
};

/** Hex colour plus alpha as an rgba() string. */
export const alpha = (hex: string, a: number): string => {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `rgba(${String(r)},${String(g)},${String(b)},${String(Math.max(0, Math.min(1, a)))})`;
};

/** Mix two hex colours in sRGB (enough for tints on a warm ground). */
export const mix = (a: string, b: string, t: number): string => {
  const pa = a.replace("#", "");
  const pb = b.replace("#", "");
  const ch = (p: string, i: number): number => Number.parseInt(p.slice(i, i + 2), 16);
  const c = (i: number): string =>
    Math.round(lerp(ch(pa, i), ch(pb, i), t)).toString(16).padStart(2, "0");
  return `#${c(0)}${c(2)}${c(4)}`;
};
