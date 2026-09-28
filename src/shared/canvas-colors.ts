/**
 * The colours a card or region can wear, in hue order.
 *
 * "1" to "6" are the JSON Canvas presets and stay as digits, so a file keeps
 * meaning red or cyan in any JSON Canvas reader. The rest are stored as hex
 * (the only other colour JSON Canvas has), and Junto paints each one with its
 * theme token, so a yellow region is tuned for dark and for bright instead of
 * one fixed shade. Each hex is the token's dark value; tests keep them equal.
 *
 * Any other hex is a custom colour, painted as stored.
 */
export type CanvasSwatch = {
  /** What the node stores: a preset digit or a lowercase `#rrggbb`. */
  readonly value: string;
  readonly label: string;
  /** Theme token the colour paints with (`--color-<token>`). */
  readonly token: string;
};

export const CANVAS_SWATCHES: readonly CanvasSwatch[] = [
  { value: "1", label: "red", token: "crimson" },
  { value: "2", label: "orange", token: "orange" },
  { value: "3", label: "gold", token: "gold" },
  { value: "#f1d438", label: "yellow", token: "yellow" },
  { value: "#9ed24d", label: "lime", token: "lime" },
  { value: "4", label: "green", token: "green" },
  { value: "5", label: "cyan", token: "cyan" },
  { value: "#509de8", label: "blue", token: "blue" },
  { value: "6", label: "violet", token: "violet" },
  { value: "#e97ab2", label: "pink", token: "pink" },
  { value: "#8fa3b0", label: "slate", token: "steel" },
];

const SWATCH_BY_VALUE = new Map(CANVAS_SWATCHES.map((swatch) => [swatch.value, swatch]));

/** The palette swatch a stored colour names, if it is one (hex in any case). */
export const canvasSwatchFor = (color: string | undefined): CanvasSwatch | undefined =>
  color === undefined ? undefined : SWATCH_BY_VALUE.get(color.trim().toLowerCase());

/**
 * `#rgb`, `rgb`, `#rrggbb` or `rrggbb`, any case, to lowercase `#rrggbb`;
 * undefined for anything else.
 */
export const normalizeHexColor = (raw: string): string | undefined => {
  const digits = raw.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(digits)) return `#${digits}`;
  if (/^[0-9a-f]{3}$/.test(digits)) {
    return `#${[...digits].map((digit) => digit + digit).join("")}`;
  }
  return undefined;
};

/** Custom colours the picker keeps beside the palette. */
export const RECENT_COLORS_MAX = 6;

/**
 * Newest first, deduplicated, palette colours left out (they already have a
 * swatch), at most RECENT_COLORS_MAX.
 */
export const sanitizeRecentColors = (colors: ReadonlyArray<string>): string[] => {
  const kept: string[] = [];
  for (const raw of colors) {
    const color = normalizeHexColor(raw);
    if (!color || canvasSwatchFor(color) || kept.includes(color)) continue;
    kept.push(color);
    if (kept.length === RECENT_COLORS_MAX) break;
  }
  return kept;
};

export const rememberCustomColor = (
  recent: ReadonlyArray<string> | undefined,
  color: string,
): string[] => sanitizeRecentColors([color, ...(recent ?? [])]);
