import { contrastRatio, hexToOklch, oklchToHex, themeRuntime, type ThemeMode } from "@shared/theme";

/**
 * How much of a region's own colour goes into the words that name it (a feed
 * region chip's name and count), mixed with ink in oklab the way
 * feed-region-strip.css mixes them. These shares hold 4.5:1 for every preset,
 * the main accent and steel, on every fill, in its theme; tests/region-word-ink.test.ts keeps them honest.
 */
export const REGION_WORD_SHARE: Readonly<Record<ThemeMode, number>> = { dark: 72, bright: 43 };

/** The contrast a region's words must keep against the chip they sit on. */
const READABLE = 4.5;

const RUNTIME: Readonly<Record<ThemeMode, Record<string, string>>> = {
  dark: themeRuntime("dark"),
  bright: themeRuntime("bright"),
};

const toOklab = (hex: string): readonly [number, number, number] => {
  const { l, c, h } = hexToOklch(hex);
  return [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
};

const fromOklab = ([l, a, b]: readonly [number, number, number]): string =>
  oklchToHex({ l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 });

/** `color-mix(in oklab, region share%, ink)`. */
const wordColor = (region: string, ink: string, share: number): string => {
  const [r, i] = [toOklab(region), toOklab(ink)];
  const p = share / 100;
  return fromOklab([r[0] * p + i[0] * (1 - p), r[1] * p + i[1] * (1 - p), r[2] * p + i[2] * (1 - p)]);
};

/** A colour at alpha laid over a solid, as the browser composites it. */
const over = (top: string, alpha: number, under: string): string => {
  const channel = (hex: string, at: number): number => parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16);
  const mixed = [0, 1, 2].map((at) => Math.round(channel(top, at) * alpha + channel(under, at) * (1 - alpha)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

/** A mix token's alpha, the last number of its runtime projection. */
const alphaOf = (rgba: string): number => Number(/,([\d.]+)\)$/.exec(rgba)?.[1] ?? 0);

/**
 * The surfaces a chip's words sit on: the chip at rest, hovered, and picked
 * with its region's tint; and the count pill, the tint laid once more over
 * each of those.
 */
const chipFills = (region: string, mode: ThemeMode): ReadonlyArray<string> => {
  const theme = RUNTIME[mode];
  const raise = theme.raise!;
  const chip = [
    over(theme.ink!, alphaOf(theme["overlay-1"]!), raise),
    over(theme.ink!, alphaOf(theme["overlay-2"]!), raise),
    over(region, 0.16, raise),
  ];
  return [...chip, ...chip.map((fill) => over(region, 0.16, fill))];
};

/** Each free hex's share per theme, worked out once. */
const shares = new Map<string, number>();

/**
 * The share of a region colour its words can take in a theme and still read
 * at 4.5:1 on every fill of the chip and its count: the theme's own share, lowered
 * toward ink a point at a time until they do. A preset already holds at the
 * theme's share; a free hex an operator typed, too pale for bright or too
 * dark for dark, gets less of itself and more ink.
 */
export const regionWordShare = (hex: string, mode: ThemeMode): number => {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return REGION_WORD_SHARE[mode];
  const key = `${mode}${hex.toLowerCase()}`;
  const known = shares.get(key);
  if (known !== undefined) return known;
  let share = REGION_WORD_SHARE[mode];
  while (share > 0 && regionWordContrast(hex, mode, share) < READABLE) share -= 1;
  shares.set(key, share);
  return share;
};

/** The words' contrast at a share, worst of the chip's fills; for tests and tuning. */
export const regionWordContrast = (hex: string, mode: ThemeMode, share: number): number => {
  const word = wordColor(hex, RUNTIME[mode].ink!, share);
  return Math.min(...chipFills(hex, mode).map((fill) => contrastRatio(word, fill)));
};
