// OKLCH <-> sRGB conversion + WCAG contrast. The theme source is authored in
// OKLCH (perceptually uniform: equal lightness steps look equal); runtime
// consumers that cannot parse oklch() (node canvas, xterm, Three.js) receive
// hex/rgba projections computed here. Standard Bjorn Ottosson math.

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** OKLab cartesian components — what `color-mix(in oklab, ...)` interpolates. */
export interface Oklab {
  l: number;
  a: number;
  b: number;
}

/** OKLab plus alpha: the colour CSS color-mix works on. */
export interface OklabColor extends Oklab {
  alpha: number;
}

const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

const hexToSrgb = (hex: string): [number, number, number] => {
  const c = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
};

/** Encoded sRGB channels (0 to 1, as a canvas buffer holds them) to OKLab
 *  plus alpha — the inverse of oklchToSrgb, for mixing projected colours
 *  the way color-mix does. */
export const srgbToOklab = (
  r: number,
  g: number,
  b: number,
  alpha = 1,
): OklabColor => {
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    l: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
    alpha,
  };
};

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToSrgb(hex).map(srgbToLinear);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(a * a + b2 * b2);
  let h = (Math.atan2(b2, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l, c, h };
}

/** Linear-light sRGB channels, unclamped: outside 0 to 1 means outside sRGB. */
export function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m_ = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s_ = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/**
 * Whether a colour is one every screen can show. A token outside sRGB is
 * drawn two ways: CSS shows it in full on a wide-colour screen, while every
 * hex consumer (ring art, xterm, the canvas) shows it clamped. Tokens stay
 * inside so one name is one colour everywhere (tests/theme-gamut.test.ts).
 */
export const inSrgb = (color: Oklch, slack = 0.0005): boolean =>
  oklchToLinearSrgb(color).every((v) => v >= -slack && v <= 1 + slack);

export function oklchToHex(color: Oklch): string {
  const [r, g, b2] = oklchToLinearSrgb(color);
  const to = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b2)}`;
}

/** OKLCH to sRGB components, transfer-encoded and clamped to [0, 1]: the
 *  values a canvas buffer composites, the same encoded values CSS paints.
 *  Every token sits inside sRGB (tests/theme-gamut.test.ts), so nothing a
 *  projection emits needs gamut handling of its own. */
export const oklchToSrgb = (oklch: Oklch): [number, number, number] => {
  const [r, g, b] = oklchToLinearSrgb(oklch);
  const enc = (v: number): number =>
    Math.min(1, Math.max(0, linearToSrgb(v)));
  return [enc(r), enc(g), enc(b)];
};

/** OKLCH to OKLab cartesian plus alpha (default opaque). */
export const oklchToOklab = ({ l, c, h }: Oklch, alpha = 1): OklabColor => {
  const rad = (h * Math.PI) / 180;
  return { l, a: c * Math.cos(rad), b: c * Math.sin(rad), alpha };
};

/** OKLab cartesian back to OKLCH polar; alpha, when present, is dropped. */
export const oklabToOklch = ({ l, a, b }: Oklab | OklabColor): Oklch => ({
  l,
  c: Math.hypot(a, b),
  h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
});

/** `color-mix(in oklab, top topPct%, bottom)`. CSS interpolates the
 *  premultiplied components in the mixing space and un-premultiplies by the
 *  result's alpha (css-color-4 section 12). With both colours opaque that is
 *  a plain lerp; a colour mixed with `transparent` keeps its colour and
 *  takes the percentage as its alpha, exactly. */
export const mixOklab = (
  top: OklabColor,
  bottom: OklabColor,
  topPct = 50,
): OklabColor => {
  const w = Math.min(100, Math.max(0, topPct)) / 100;
  const alpha = w * top.alpha + (1 - w) * bottom.alpha;
  if (alpha <= 0) return { l: 0, a: 0, b: 0, alpha: 0 };
  const channel = (t: number, b: number): number =>
    (w * t * top.alpha + (1 - w) * b * bottom.alpha) / alpha;
  return {
    l: channel(top.l, bottom.l),
    a: channel(top.a, bottom.a),
    b: channel(top.b, bottom.b),
    alpha,
  };
};

export const formatOklch = ({ l, c, h }: Oklch): string =>
  `oklch(${l.toFixed(5)} ${c.toFixed(5)} ${h.toFixed(2)})`;

const relativeLuminance = (hex: string): number => {
  const [r, g, b] = hexToSrgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function contrastRatio(hexA: string, hexB: string): number {
  const [hi, lo] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort(
    (a, b) => b - a,
  );
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite a solid hex at alpha over itself-as-transparent: the rgba()
 *  string runtime consumers use for mix tokens (canvas, xterm, Three.js). */
export function hexAtAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToSrgb(hex).map((v) => Math.round(v * 255));
  return `rgba(${r},${g},${b},${alpha})`;
}
