// OKLCH <-> sRGB conversion + WCAG contrast. The theme source is authored in
// OKLCH (perceptually uniform: equal lightness steps look equal); runtime
// consumers that cannot parse oklch() (node canvas, xterm, Three.js) receive
// hex/rgba projections computed here. Standard Bjorn Ottosson math.

export interface Oklch {
  l: number;
  c: number;
  h: number;
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

export function oklchToHex({ l, c, h }: Oklch): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m_ = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s_ = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3);
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const b2 = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
  const to = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b2)}`;
}

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
