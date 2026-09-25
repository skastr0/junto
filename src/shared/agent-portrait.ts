import { hexToOklch, oklchToHex, themeRuntime, type Oklch, type ThemeMode } from "./theme";

// Agent portraits: a small, cute critter drawn once per seat identity. Pure and
// deterministic: the same seed, mode, and detail always produce the same SVG
// string, so a portrait needs no storage and caches by key. Every color is
// derived from the theme tokens (hue angle and chroma from a token, lightness
// normalized so the critter reads the same in both modes); nothing here is a
// second palette.
//
// Look: a riso-printed sticker. A hand-wobbled silhouette rises from the
// bottom of a tinted tile (a bust, so the face stays large at 18px), the fill
// sits a hair off its ink outline like a misregistered print, and ink features
// sit on top. `rich` adds a paper grain for large surfaces only; the node-size
// variants stay filter-free so canvas zoom never re-rasterizes a filter.

export type PortraitDetail = "glyph" | "card" | "rich";

/** Pick the detail tier for a rendered pixel size. */
export const portraitDetailFor = (size: number): PortraitDetail =>
  size < 34 ? "glyph" : size < 72 ? "card" : "rich";

// Warm hues lead but identity needs spread, so a board of seats never reads
// as one amber blur. Gold is left out as a body (it reads as amber at pastel
// lightness); crimson is reserved for blockers and never
// used as a body color.
const BODY_HUES: ReadonlyArray<readonly [token: string, weight: number]> = [
  ["amber", 2],
  ["orange", 2],
  ["green", 2],
  ["cyan", 2],
  ["violet", 2],
  ["indigo", 1],
  ["steel", 1],
];
const ACCENT_HUES = ["amber", "cyan", "violet", "green", "orange", "gold"] as const;

const SHAPES = ["round", "bean", "mochi", "toast", "drop", "pear"] as const;
const TOPPERS = ["none", "cat", "bear", "bunny", "antenna", "sprout", "horns", "tuft", "twin"] as const;
const EYES = ["dot", "shiny", "happy", "sleepy", "oval", "wink", "line", "sparkle"] as const;
const MOUTHS = ["smile", "cat", "o", "flat", "grin", "fang", "none", "wobble"] as const;
const MARKINGS = ["none", "belly", "spots", "cap", "freckles", "none"] as const;
// The second cast of characters, drawn from an independent stream so the
// first draw above never moves: a seat keeps its color and face, and some
// seats grow into a new species, new ears, a new pattern, or a hat.
const SHAPES_V2 = ["cloud", "gumdrop", "onigiri", "ghost", "shroom", "peach"] as const;
const TOPPERS_V2 = ["floppy", "mouse", "unicorn", "devil", "gills", "antlers", "flower", "halo", "bow", "crest"] as const;
const MARKINGS_V2 = ["stripes", "patch", "muzzle", "blaze", "stars", "heart"] as const;
const ACCESSORIES = [
  "none",
  "beanie",
  "party",
  "crown",
  "wizard",
  "beret",
  "headphones",
  "glasses",
  "shades",
  "scarf",
  "bowtie",
] as const;
// Shades hide the eyes, and the eyes carry expressions: editor-only.
const DRAWN_ACCESSORIES = ACCESSORIES.filter((item) => item !== "none" && item !== "shades");
const HATS: ReadonlySet<string> = new Set(["beanie", "party", "crown", "wizard", "beret"]);
// Toppers that sit on the crown of the head give way to a hat.
const CROWN_TOPPERS: ReadonlySet<string> = new Set(["antenna", "twin", "sprout", "tuft", "unicorn", "halo", "crest", "bow"]);
const ALL_SHAPES = [...SHAPES, ...SHAPES_V2] as const;
const ALL_TOPPERS = [...TOPPERS, ...TOPPERS_V2] as const;
const ALL_MARKINGS = [...MARKINGS.filter((m, i) => MARKINGS.indexOf(m) === i), ...MARKINGS_V2] as const;
// The pick lists above are the identity draw; their order is frozen so every
// seat keeps its face. Kinds only expressions or the editor reach live apart.
const EXPRESSION_EYES = ["squint"] as const;
const EXPRESSION_MOUTHS = ["frown"] as const;
const BROWS = ["none", "level", "raised", "worried", "furrowed", "quizzical"] as const;
const EXTRAS = ["none", "sweat", "sparkle", "zzz", "question"] as const;

export type PortraitShape = (typeof ALL_SHAPES)[number];
export type PortraitTopper = (typeof ALL_TOPPERS)[number];
export type PortraitAccessory = (typeof ACCESSORIES)[number];
export type PortraitEyes = (typeof EYES)[number] | (typeof EXPRESSION_EYES)[number];
export type PortraitMouth = (typeof MOUTHS)[number] | (typeof EXPRESSION_MOUTHS)[number];
export type PortraitMarking = (typeof ALL_MARKINGS)[number];
export type PortraitBrows = (typeof BROWS)[number];
export type PortraitExtra = (typeof EXTRAS)[number];

/** Every choice the character editor offers, in display order. */
export const PORTRAIT_OPTIONS = {
  bodyHue: BODY_HUES.map(([token]) => token),
  accentHue: [...ACCENT_HUES],
  shape: [...ALL_SHAPES],
  topper: [...ALL_TOPPERS],
  accessory: [...ACCESSORIES],
  eyes: [...EYES, ...EXPRESSION_EYES],
  mouth: [...MOUTHS.filter((mouth) => mouth !== "none"), ...EXPRESSION_MOUTHS, "none"],
  brows: [...BROWS],
  marking: [...ALL_MARKINGS],
} as const satisfies Record<string, ReadonlyArray<string>>;

/** The character, independent of mode and detail: what a seed decides. */
export interface PortraitGenome {
  readonly bodyHue: string;
  readonly accentHue: string;
  readonly shape: PortraitShape;
  readonly topper: PortraitTopper;
  readonly eyes: PortraitEyes;
  readonly mouth: PortraitMouth;
  readonly marking: PortraitMarking;
  readonly accessory: PortraitAccessory;
  readonly blush: boolean;
  readonly gaze: number; // -1..1, face shift left/right
  readonly tilt: number; // degrees, whole critter
  readonly width: number; // 0..1 body proportion
  readonly eyeGap: number; // 0..1
  readonly eyeSize: number; // 0..1
  readonly wobble: readonly [number, number, number, number];
  readonly salt: number; // free entropy for small placements
}

/** A genome plus the traits only customization reaches. */
export interface PortraitCharacter extends PortraitGenome {
  readonly brows: PortraitBrows;
  /** -1 moody .. 0 even .. 1 cheerful: biases dynamic expressions. */
  readonly temperament: number;
}

/**
 * Operator overrides for one seat. Every field is optional; absent means the
 * identity default. Stored as data, so unknown values fall back to default.
 */
export interface PortraitConfig {
  readonly bodyHue?: string;
  readonly accentHue?: string;
  readonly shape?: PortraitShape;
  readonly topper?: PortraitTopper;
  readonly eyes?: PortraitEyes;
  readonly mouth?: PortraitMouth;
  readonly brows?: PortraitBrows;
  readonly marking?: PortraitMarking;
  readonly accessory?: PortraitAccessory;
  readonly blush?: boolean;
  readonly temperament?: number;
}

/**
 * A face an expression paints over the character. `base` keeps the
 * character's own feature, so a seat stays recognizable in every mood.
 */
export interface PortraitFace {
  readonly eyes: PortraitEyes | "base";
  readonly mouth: PortraitMouth | "base";
  readonly brows: PortraitBrows | "base";
  readonly blush: boolean | "base";
  readonly extra: PortraitExtra;
}

// --- deterministic randomness ---------------------------------------------

const fnv1a = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(rand: () => number, items: ReadonlyArray<T>): T =>
  items[Math.floor(rand() * items.length) % items.length] as T;

const pickWeighted = (rand: () => number, items: ReadonlyArray<readonly [string, number]>): string => {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rand() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return items[0]?.[0] ?? "amber";
};

const oneOf = <T extends string>(items: ReadonlyArray<T>, value: unknown): T | undefined =>
  typeof value === "string" && (items as ReadonlyArray<string>).includes(value) ? (value as T) : undefined;

/** Identity default temperament: a mild lean, drawn apart from the genome. */
export const defaultTemperament = (seed: string): number => {
  const rand = mulberry32(fnv1a(`${seed.trim() || "agent"}#temperament`));
  return Math.round((rand() * 2 - 1) * 0.6 * 100) / 100;
};

/** The character for a seat: identity genome with operator overrides laid on. */
export function portraitCharacter(seed: string, config?: PortraitConfig): PortraitCharacter {
  const genome = portraitGenome(seed);
  const c = config ?? {};
  const bodyHue = oneOf(PORTRAIT_OPTIONS.bodyHue, c.bodyHue) ?? genome.bodyHue;
  let accentHue = oneOf(PORTRAIT_OPTIONS.accentHue, c.accentHue) ?? genome.accentHue;
  if (c.accentHue === undefined && accentHue === bodyHue) accentHue = bodyHue === "cyan" ? "amber" : "cyan";
  const temperament =
    typeof c.temperament === "number" && Number.isFinite(c.temperament)
      ? clamp(c.temperament, -1, 1)
      : defaultTemperament(seed);
  return {
    ...genome,
    bodyHue,
    accentHue,
    shape: oneOf(ALL_SHAPES, c.shape) ?? genome.shape,
    topper: oneOf(ALL_TOPPERS, c.topper) ?? genome.topper,
    accessory: oneOf(ACCESSORIES, c.accessory) ?? genome.accessory,
    eyes: oneOf(PORTRAIT_OPTIONS.eyes, c.eyes) ?? genome.eyes,
    mouth: oneOf(PORTRAIT_OPTIONS.mouth, c.mouth) ?? genome.mouth,
    marking: oneOf(ALL_MARKINGS, c.marking) ?? genome.marking,
    blush: typeof c.blush === "boolean" ? c.blush : genome.blush,
    brows: oneOf(BROWS, c.brows) ?? "none",
    temperament,
  };
}

/** Stable key for a config: only fields that differ from absent, sorted. */
export const portraitConfigKey = (config?: PortraitConfig): string =>
  config
    ? Object.entries(config)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(";")
    : "";

/** Decide the character for a seed. Stable forever for a given seed. */
export function portraitGenome(seed: string): PortraitGenome {
  const rand = mulberry32(fnv1a(seed.trim() || "agent"));
  const bodyHue = pickWeighted(rand, BODY_HUES);
  let accentHue: string = pick(rand, ACCENT_HUES);
  if (accentHue === bodyHue) accentHue = bodyHue === "cyan" ? "amber" : "cyan";
  const shape: PortraitShape = pick(rand, SHAPES);
  const topper: PortraitTopper = pick(rand, TOPPERS);
  const eyes = pick(rand, EYES);
  const mouth = pick(rand, MOUTHS);
  const marking: PortraitMarking = pick(rand, MARKINGS);
  // Second cast: fixed draw order, every roll always taken, so each trait's
  // odds stay independent of the others.
  const more = mulberry32(fnv1a(`${seed.trim() || "agent"}#cast-2`));
  const [speciesRoll, species] = [more(), pick(more, SHAPES_V2)];
  const [earsRoll, ears] = [more(), pick(more, TOPPERS_V2)];
  const [patternRoll, pattern] = [more(), pick(more, MARKINGS_V2)];
  const [propRoll, prop] = [more(), pick(more, DRAWN_ACCESSORIES)];
  return {
    bodyHue,
    accentHue,
    shape: speciesRoll < 0.4 ? species : shape,
    topper: earsRoll < 0.4 ? ears : topper,
    eyes,
    mouth,
    marking: patternRoll < 0.4 ? pattern : marking,
    accessory: propRoll < 0.45 ? prop : "none",
    blush: rand() < 0.62,
    gaze: rand() * 2 - 1,
    tilt: (rand() * 2 - 1) * 5,
    width: rand(),
    eyeGap: rand(),
    eyeSize: rand(),
    wobble: [rand() * Math.PI * 2, rand() * Math.PI * 2, rand(), rand()],
    salt: Math.floor(rand() * 1_000_000),
  };
}

// --- palette ----------------------------------------------------------------

interface PortraitPalette {
  readonly tile: string;
  readonly halo: string;
  readonly body: string;
  readonly shade: string;
  readonly belly: string;
  readonly accent: string;
  readonly leaf: string;
  readonly ink: string;
  readonly shine: string;
  readonly blush: string;
  readonly drop: string;
  readonly spark: string;
  readonly mute: string;
  readonly accentShade: string;
  readonly wood: string;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const tone = (base: Oklch, l: number, c: number): string => oklchToHex({ l, c: Math.max(0, c), h: base.h });

const paletteCache = new Map<string, PortraitPalette>();
const runtimeCache = new Map<ThemeMode, Record<string, string>>();

const runtimeFor = (mode: ThemeMode): Record<string, string> => {
  let runtime = runtimeCache.get(mode);
  if (!runtime) {
    runtime = themeRuntime(mode);
    runtimeCache.set(mode, runtime);
  }
  return runtime;
};

const tokenOklch = (runtime: Record<string, string>, token: string): Oklch =>
  hexToOklch(runtime[token] ?? runtime.amber ?? "#e8a33d");

function paletteFor(genome: PortraitGenome, mode: ThemeMode): PortraitPalette {
  const key = `${mode}|${genome.bodyHue}|${genome.accentHue}`;
  const cached = paletteCache.get(key);
  if (cached) return cached;
  const runtime = runtimeFor(mode);
  const hue = tokenOklch(runtime, genome.bodyHue);
  const accent = tokenOklch(runtime, genome.accentHue);
  const leaf = tokenOklch(runtime, "green");
  const blush = tokenOklch(runtime, "orange");
  const cyan = tokenOklch(runtime, "cyan");
  const gold = tokenOklch(runtime, "gold");
  // Chroma follows the token but is clamped into a pastel band so steel stays
  // a soft grey critter and the loud hues never go neon.
  const chroma = clamp(hue.c * 0.82, 0.03, 0.12);
  const dark = mode === "dark";
  const palette: PortraitPalette = {
    tile: dark ? tone(hue, 0.265, chroma * 0.34) : tone(hue, 0.905, chroma * 0.3),
    halo: dark ? tone(hue, 0.31, chroma * 0.42) : tone(hue, 0.945, chroma * 0.22),
    body: tone(hue, dark ? 0.81 : 0.815, chroma),
    shade: tone(hue, dark ? 0.7 : 0.71, chroma * 1.05),
    belly: tone(hue, dark ? 0.9 : 0.915, chroma * 0.45),
    accent: tone(accent, 0.74, clamp(accent.c * 0.9, 0.05, 0.14)),
    leaf: tone(leaf, 0.72, clamp(leaf.c, 0.06, 0.12)),
    ink: runtime[dark ? "ground" : "ink"] ?? "#0c0b0a",
    shine: runtime[dark ? "ink" : "raise"] ?? "#ede6da",
    blush: tone(blush, 0.72, clamp(blush.c, 0.1, 0.15)),
    drop: tone(cyan, 0.86, clamp(cyan.c * 0.7, 0.05, 0.09)),
    spark: tone(gold, dark ? 0.84 : 0.72, clamp(gold.c, 0.1, 0.14)),
    mute: runtime.dim ?? "#8a8378",
    accentShade: tone(accent, 0.62, clamp(accent.c * 0.9, 0.05, 0.13)),
    wood: tone(blush, dark ? 0.66 : 0.6, 0.07),
  };
  paletteCache.set(key, palette);
  return palette;
}

// --- geometry ---------------------------------------------------------------

type Point = readonly [number, number];

const f = (value: number): string => (Math.round(value * 10) / 10).toString();

/** Closed Catmull-Rom spline through the points, as cubic Beziers. */
function smoothClosedPath(points: ReadonlyArray<Point>): string {
  const count = points.length;
  const at = (index: number): Point => points[((index % count) + count) % count] as Point;
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let index = 0; index < count; index += 1) {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

interface Body {
  readonly path: string;
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
  readonly top: number;
  /** Silhouette half-width at a given y (approximate, for placing ears). */
  readonly halfWidthAt: (y: number) => number;
}

const BODY_SPEC: Record<PortraitShape, { n: number; w: number; h: number; cy: number }> = {
  round: { n: 2, w: 33, h: 34, cy: 60 },
  bean: { n: 2.2, w: 28, h: 42, cy: 66 },
  mochi: { n: 2.8, w: 38, h: 30, cy: 66 },
  toast: { n: 3.6, w: 31, h: 36, cy: 62 },
  drop: { n: 2, w: 32, h: 36, cy: 62 },
  pear: { n: 2.2, w: 31, h: 38, cy: 64 },
  cloud: { n: 2.3, w: 35, h: 31, cy: 64 },
  gumdrop: { n: 2, w: 32, h: 35, cy: 62 },
  onigiri: { n: 2.6, w: 37, h: 34, cy: 63 },
  ghost: { n: 2, w: 31, h: 38, cy: 60 },
  shroom: { n: 2.2, w: 28, h: 31, cy: 69 },
  peach: { n: 2, w: 34, h: 33, cy: 62 },
};

/** Species outline tweaks on the unit superellipse; the first cast has none. */
const speciesShape = (shape: PortraitShape, t: number, x: number, y: number): readonly [number, number, number] => {
  const sin = Math.sin(t);
  switch (shape) {
    case "cloud":
      // Scalloped top: lobes on the upper half only.
      return [x, y, sin < 0 ? 1 + 0.07 * Math.abs(Math.cos(3.5 * t)) : 1];
    case "gumdrop":
      // Dome over a wide, flat-ish base.
      return sin > 0 ? [Math.sign(x) * Math.abs(x) ** 0.55, y, 1] : [x * (1 - 0.18 * (-sin) ** 2), y, 1];
    case "onigiri":
      return [x * (0.52 + 0.48 * (y + 1) / 2) * 1.08, y, 1];
    case "ghost":
      // Wavy hem along the bottom.
      return sin > 0.55 ? [x, y + 0.05 * Math.sin(9 * t), 1] : [x, y, 1];
    case "peach": {
      // A cleft at the crown.
      const dip = sin < 0 ? 0.13 * Math.exp(-((x / 0.14) ** 2)) : 0;
      return [x, y + dip, 1];
    }
    default:
      return [x, y, 1];
  }
};

function bodyFor(genome: PortraitGenome): Body {
  const [phaseA, phaseB, ampA, ampB] = genome.wobble;
  const base = BODY_SPEC[genome.shape];
  const w = base.w * (0.93 + genome.width * 0.14);
  const { h, cy, n } = base;
  const cx = 50;
  const secondCast = (SHAPES_V2 as ReadonlyArray<string>).includes(genome.shape);
  // The first cast keeps its exact 30-point outline; new species need more
  // points for scallops and hems.
  const steps = secondCast ? 56 : 30;
  const points: Point[] = [];
  const exponent = 2 / n;
  for (let step = 0; step < steps; step += 1) {
    const t = (step / steps) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    let x = Math.sign(cos) * Math.abs(cos) ** exponent;
    let y = Math.sign(sin) * Math.abs(sin) ** exponent;
    if (genome.shape === "drop" && sin < 0) x *= 1 - 0.55 * (-sin) ** 3;
    if (genome.shape === "pear") x *= 1 + 0.14 * sin;
    let lobe = 1;
    if (secondCast) [x, y, lobe] = speciesShape(genome.shape, t, x, y);
    const wobble = (1 + 0.028 * ampA * Math.sin(2 * t + phaseA) + 0.022 * ampB * Math.sin(3 * t + phaseB)) * lobe;
    points.push([cx + x * w * wobble, cy + y * h * wobble]);
  }
  const top = Math.min(...points.map((point) => point[1]));
  return {
    path: smoothClosedPath(points),
    cx,
    cy,
    w,
    h,
    top,
    halfWidthAt: (y) => {
      const v = clamp((y - cy) / h, -1, 1);
      let half = w * (1 - Math.abs(v) ** n) ** (1 / n);
      if (genome.shape === "drop" && v < 0) half *= 1 - 0.55 * (-v) ** 3;
      if (genome.shape === "pear") half *= 1 + 0.14 * v;
      if (genome.shape === "onigiri") half *= (0.52 + 0.48 * (v + 1) / 2) * 1.08;
      return half;
    },
  };
}

// --- drawing ----------------------------------------------------------------

interface Stroke {
  readonly outline: number;
  readonly feature: number;
  readonly scale: number; // feature size multiplier
  readonly offset: number; // misregistration
}

const strokeFor = (detail: PortraitDetail): Stroke =>
  detail === "glyph"
    ? { outline: 4.2, feature: 4.6, scale: 1.3, offset: 0 }
    : detail === "card"
      ? { outline: 3, feature: 3.4, scale: 1.1, offset: 1.4 }
      : { outline: 2.4, feature: 2.8, scale: 1, offset: 1.6 };

/** A shape drawn riso style: fill nudged off its ink outline. */
const inked = (d: string, fill: string, p: PortraitPalette, s: Stroke): string =>
  (s.offset > 0
    ? `<path d="${d}" fill="${fill}" transform="translate(${s.offset} ${s.offset * 0.7})"/>`
    : `<path d="${d}" fill="${fill}"/>`) +
  `<path d="${d}" fill="${s.offset > 0 ? "none" : fill}" stroke="${p.ink}" stroke-width="${s.outline}" stroke-linejoin="round"/>`;

/** A line drawn as a filled stroke with an ink edge: antlers, straps, stems. */
const inkedLine = (d: string, color: string, width: number, p: PortraitPalette, s: Stroke): string =>
  `<path d="${d}" stroke="${p.ink}" stroke-width="${f(width + s.outline * 1.4)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
  `<path d="${d}" stroke="${color}" stroke-width="${f(width)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

/** Which topper actually draws: a hat covers crown toppers, a shroom's cap all of them. */
const drawnTopper = (genome: PortraitGenome): PortraitTopper =>
  genome.shape === "shroom" || (HATS.has(genome.accessory) && CROWN_TOPPERS.has(genome.topper)) ? "none" : genome.topper;

function topperBehind(genome: PortraitGenome, body: Body, p: PortraitPalette, s: Stroke): string {
  const { cx, top } = body;
  const earY = top + 7;
  const spread = Math.max(10, body.halfWidthAt(earY) - 5);
  const left = cx - spread;
  const right = cx + spread;
  switch (drawnTopper(genome)) {
    case "mouse":
      return [left - 2, right + 2]
        .map((x) => `${inked(circlePath(x, top + 1, 11.5), p.body, p, s)}<circle cx="${f(x)}" cy="${f(top + 1)}" r="6.5" fill="${p.blush}" opacity="0.6"/>`)
        .join("");
    case "devil":
      return [left + 7, right - 7]
        .map((x, side) => {
          const dir = side === 0 ? -1 : 1;
          return inked(
            `M${f(x - 4)} ${f(top + 6)}L${f(x + dir * 3)} ${f(top - 9)}L${f(x + 4)} ${f(top + 6)}Z`,
            p.accent,
            p,
            s,
          );
        })
        .join("");
    case "gills":
      return [-1, 1]
        .map((dir) => {
          const x = cx + dir * (body.halfWidthAt(top + 14) - 1);
          return [-14, 0, 14]
            .map((angle, k) => {
              const a = ((dir > 0 ? -35 : -145) + angle * dir) * (Math.PI / 180);
              const len = 11 - Math.abs(k - 1) * 2;
              const x2 = x + Math.cos(a) * len;
              const y2 = top + 14 + k * 4 + Math.sin(a) * len;
              return inkedLine(`M${f(x)} ${f(top + 14 + k * 4)}L${f(x2)} ${f(y2)}`, p.blush, 3.2, p, s);
            })
            .join("");
        })
        .join("");
    case "antlers":
      return [-1, 1]
        .map((dir) => {
          const x = cx + dir * 9;
          const d = `M${f(x)} ${f(top + 4)}L${f(x + dir * 5)} ${f(top - 12)}M${f(x + dir * 3)} ${f(top - 5)}L${f(x + dir * 10)} ${f(top - 9)}M${f(x + dir * 5)} ${f(top - 12)}L${f(x + dir * 2)} ${f(top - 18)}`;
          return inkedLine(d, p.wood, 3, p, s);
        })
        .join("");
    case "cat":
      return [left, right]
        .map((x, side) => {
          const dir = side === 0 ? -1 : 1;
          return inked(
            `M${f(x - 9 * dir)} ${f(earY + 4)}Q${f(x + 2 * dir)} ${f(top - 14)} ${f(x + 5 * dir)} ${f(top - 13)}Q${f(x + 9 * dir)} ${f(top - 4)} ${f(x + 10 * dir)} ${f(earY + 6)}Z`,
            p.body,
            p,
            s,
          );
        })
        .join("");
    case "bear":
      return [left, right]
        .map((x) => `${inked(circlePath(x, top + 3, 8.5), p.body, p, s)}<circle cx="${f(x)}" cy="${f(top + 3)}" r="4" fill="${p.shade}"/>`)
        .join("");
    case "bunny":
      return [left + 5, right - 5]
        .map((x, side) => {
          const lean = side === 0 ? -7 : 7;
          return `<g transform="rotate(${lean} ${f(x)} ${f(top + 6)})">${inked(
            `M${f(x - 6)} ${f(top + 8)}C${f(x - 8)} ${f(top - 16)} ${f(x - 4)} ${f(top - 26)} ${f(x)} ${f(top - 26)}C${f(x + 4)} ${f(top - 26)} ${f(x + 8)} ${f(top - 16)} ${f(x + 6)} ${f(top + 8)}Z`,
            p.body,
            p,
            s,
          )}<path d="M${f(x)} ${f(top - 18)}L${f(x)} ${f(top + 2)}" stroke="${p.shade}" stroke-width="${s.outline + 1.2}" stroke-linecap="round"/></g>`;
        })
        .join("");
    case "horns":
      return [left + 6, right - 6]
        .map((x, side) => {
          const dir = side === 0 ? -1 : 1;
          return inked(
            `M${f(x - 5)} ${f(top + 7)}Q${f(x + 1 * dir)} ${f(top - 6)} ${f(x + 7 * dir)} ${f(top - 10)}Q${f(x + 5 * dir)} ${f(top + 1)} ${f(x + 5)} ${f(top + 8)}Z`,
            p.belly,
            p,
            s,
          );
        })
        .join("");
    default:
      return "";
  }
}

function topperFront(genome: PortraitGenome, body: Body, p: PortraitPalette, s: Stroke): string {
  const { cx, top } = body;
  const cap = `stroke="${p.ink}" stroke-width="${s.outline}" stroke-linecap="round" fill="none"`;
  switch (drawnTopper(genome)) {
    case "antenna": {
      const tipX = cx + 6 + genome.gaze * 4;
      return `<path d="M${f(cx)} ${f(top + 2)}Q${f(cx + 1)} ${f(top - 9)} ${f(tipX)} ${f(top - 13)}" ${cap}/>${inked(circlePath(tipX, top - 15, 5), p.accent, p, s)}`;
    }
    case "twin":
      return [-1, 1]
        .map((dir) => {
          const tipX = cx + dir * 11;
          return `<path d="M${f(cx + dir * 5)} ${f(top + 3)}L${f(tipX)} ${f(top - 10)}" ${cap}/>${inked(circlePath(tipX, top - 12, 3.8), p.accent, p, s)}`;
        })
        .join("");
    case "sprout": {
      const leafL = `M${f(cx)} ${f(top - 8)}C${f(cx - 4)} ${f(top - 18)} ${f(cx - 15)} ${f(top - 17)} ${f(cx - 16)} ${f(top - 13)}C${f(cx - 13)} ${f(top - 6)} ${f(cx - 4)} ${f(top - 5)} ${f(cx)} ${f(top - 8)}Z`;
      const leafR = `M${f(cx)} ${f(top - 10)}C${f(cx + 3)} ${f(top - 20)} ${f(cx + 12)} ${f(top - 22)} ${f(cx + 15)} ${f(top - 19)}C${f(cx + 13)} ${f(top - 11)} ${f(cx + 5)} ${f(top - 8)} ${f(cx)} ${f(top - 10)}Z`;
      return `<path d="M${f(cx)} ${f(top + 3)}L${f(cx)} ${f(top - 10)}" ${cap}/>${inked(leafL, p.leaf, p, s)}${inked(leafR, p.leaf, p, s)}`;
    }
    case "tuft":
      return `<path d="M${f(cx - 6)} ${f(top + 3)}Q${f(cx - 8)} ${f(top - 7)} ${f(cx - 2)} ${f(top - 9)}M${f(cx)} ${f(top + 3)}Q${f(cx + 1)} ${f(top - 10)} ${f(cx + 8)} ${f(top - 8)}" ${cap}/>`;
    case "floppy":
      // Dog ears hang over the sides of the head, in front of the outline.
      return [-1, 1]
        .map((dir) => {
          const x = cx + dir * (body.halfWidthAt(top + 12) - 2);
          return `<g transform="rotate(${dir * 14} ${f(x)} ${f(top + 6)})">${inked(
            `M${f(x - 6.5)} ${f(top + 3)}C${f(x - 9)} ${f(top + 16)} ${f(x - 6)} ${f(top + 29)} ${f(x)} ${f(top + 29)}C${f(x + 6)} ${f(top + 29)} ${f(x + 9)} ${f(top + 16)} ${f(x + 6.5)} ${f(top + 3)}Z`,
            p.shade,
            p,
            s,
          )}</g>`;
        })
        .join("");
    case "unicorn": {
      const d = `M${f(cx - 5)} ${f(top + 4)}L${f(cx + 1)} ${f(top - 20)}L${f(cx + 5)} ${f(top + 4)}Z`;
      return `${inked(d, p.spark, p, s)}<path d="M${f(cx - 3)} ${f(top - 3)}L${f(cx + 3.6)} ${f(top - 6)}M${f(cx - 1.4)} ${f(top - 10)}L${f(cx + 2.6)} ${f(top - 12)}" stroke="${p.ink}" stroke-width="${f(s.outline * 0.6)}" stroke-linecap="round"/>`;
    }
    case "flower": {
      const x = cx + body.halfWidthAt(top + 8) * 0.62;
      const y = top + 4;
      const petals = [0, 72, 144, 216, 288]
        .map((angle) => {
          const a = (angle * Math.PI) / 180;
          return inked(circlePath(x + Math.cos(a) * 4.6, y + Math.sin(a) * 4.6, 3.6), p.shine, p, s);
        })
        .join("");
      return `${petals}${inked(circlePath(x, y, 3), p.spark, p, s)}`;
    }
    case "halo":
      return `<ellipse cx="${f(cx)}" cy="${f(top - 10)}" rx="13" ry="4" fill="none" stroke="${p.ink}" stroke-width="${f(s.outline + 3.4)}"/><ellipse cx="${f(cx)}" cy="${f(top - 10)}" rx="13" ry="4" fill="none" stroke="${p.spark}" stroke-width="3"/>`;
    case "bow": {
      const x = cx + body.halfWidthAt(top + 8) * 0.55;
      const y = top + 3;
      const wing = (dir: number): string =>
        inked(`M${f(x)} ${f(y)}L${f(x + dir * 9)} ${f(y - 6)}Q${f(x + dir * 11)} ${f(y)} ${f(x + dir * 9)} ${f(y + 6)}Z`, p.accent, p, s);
      return `${wing(-1)}${wing(1)}${inked(circlePath(x, y, 2.8), p.accentShade, p, s)}`;
    }
    case "crest":
      return [-7, 0, 7]
        .map((dx, k) =>
          inked(
            `M${f(cx + dx * 0.5 - 2.4)} ${f(top + 4)}Q${f(cx + dx - 3)} ${f(top - 10 - (k === 1 ? 5 : 0))} ${f(cx + dx * 1.3)} ${f(top - 12 - (k === 1 ? 5 : 0))}Q${f(cx + dx + 2)} ${f(top - 3)} ${f(cx + dx * 0.5 + 2.4)} ${f(top + 4)}Z`,
            p.accent,
            p,
            s,
          ),
        )
        .join("");
    default:
      return "";
  }
}

/** Per-species detail over the body: a cap, a nori band, a leaf, sugar. */
function speciesSvg(genome: PortraitGenome, body: Body, p: PortraitPalette, s: Stroke): string {
  const { cx, top, w, h, cy } = body;
  switch (genome.shape) {
    case "shroom": {
      const capW = w * 1.42;
      const d = `M${f(cx - capW)} ${f(top + 13)}C${f(cx - capW)} ${f(top - 16)} ${f(cx + capW)} ${f(top - 16)} ${f(cx + capW)} ${f(top + 13)}Q${f(cx)} ${f(top + 6)} ${f(cx - capW)} ${f(top + 13)}Z`;
      const spots = [
        [-0.5, 0.2, 4.2],
        [0.35, -0.25, 3.4],
        [0.05, 0.55, 2.6],
      ]
        .map(([dx, dy, r]) => `<circle cx="${f(cx + (dx as number) * capW)}" cy="${f(top + (dy as number) * 12)}" r="${f(r as number)}" fill="${p.shine}"/>`)
        .join("");
      return `${inked(d, p.accent, p, s)}${spots}`;
    }
    case "onigiri":
      return `<g clip-path="url(#b)"><rect x="${f(cx - w * 0.42)}" y="${f(cy + h * 0.46)}" width="${f(w * 0.84)}" height="${f(h)}" rx="2" fill="${p.ink}" opacity="0.88"/></g>`;
    case "peach":
      return `<path d="M${f(cx)} ${f(top + 4)}Q${f(cx - 1.5)} ${f(top + 12)} ${f(cx - 4)} ${f(top + 17)}" stroke="${p.shade}" stroke-width="${f(s.outline * 0.9)}" stroke-linecap="round" fill="none"/>${inked(
        `M${f(cx + 1)} ${f(top + 3)}C${f(cx + 4)} ${f(top - 7)} ${f(cx + 13)} ${f(top - 8)} ${f(cx + 15)} ${f(top - 5)}C${f(cx + 12)} ${f(top + 1)} ${f(cx + 5)} ${f(top + 4)} ${f(cx + 1)} ${f(top + 3)}Z`,
        p.leaf,
        p,
        s,
      )}`;
    case "gumdrop":
      return [
        [-0.45, 0.35],
        [0.5, 0.1],
        [0.2, 0.62],
        [-0.15, 0.05],
      ]
        .map(([dx, dy]) => `<rect x="${f(cx + (dx as number) * w - 1.1)}" y="${f(top + (dy as number) * h - 1.1)}" width="2.2" height="2.2" rx="0.5" fill="${p.shine}" opacity="0.8" transform="rotate(20 ${f(cx + (dx as number) * w)} ${f(top + (dy as number) * h)})"/>`)
        .join("");
    default:
      return "";
  }
}

/** Hats sit over everything; face props sit over the eyes; neckwear under the face. */
function accessorySvg(
  layer: "neck" | "face" | "hat",
  genome: PortraitGenome,
  body: Body,
  p: PortraitPalette,
  s: Stroke,
  faceX: number,
  eyeY: number,
  eyeGap: number,
  eyeR: number,
  mouthY: number,
): string {
  const { cx, top } = body;
  const kind = genome.shape === "shroom" && HATS.has(genome.accessory) ? "none" : genome.accessory;
  const neckY = Math.min(mouthY + 12, body.cy + body.h - 4);
  if (layer === "neck") {
    if (kind === "scarf") {
      const half = body.halfWidthAt(neckY) + 1;
      const d = `M${f(cx - half)} ${f(neckY - 3)}Q${f(cx)} ${f(neckY + 3)} ${f(cx + half)} ${f(neckY - 3)}L${f(cx + half)} ${f(neckY + 4)}Q${f(cx)} ${f(neckY + 10)} ${f(cx - half)} ${f(neckY + 4)}Z`;
      const tail = `M${f(cx + half * 0.35)} ${f(neckY + 5)}L${f(cx + half * 0.55)} ${f(neckY + 18)}L${f(cx + half * 0.2)} ${f(neckY + 18)}Z`;
      return `${inked(tail, p.accentShade, p, s)}${inked(d, p.accent, p, s)}`;
    }
    if (kind === "bowtie") {
      const y = neckY;
      const wing = (dir: number): string =>
        inked(`M${f(cx)} ${f(y)}L${f(cx + dir * 8)} ${f(y - 5)}L${f(cx + dir * 8)} ${f(y + 5)}Z`, p.accent, p, s);
      return `${wing(-1)}${wing(1)}${inked(circlePath(cx, y, 2.4), p.accentShade, p, s)}`;
    }
    return "";
  }
  if (layer === "face") {
    const lx = faceX - eyeGap;
    const rx = faceX + eyeGap;
    const r = Math.max(eyeR * 1.7, 5.4);
    if (kind === "glasses") {
      return `<g fill="none" stroke="${p.ink}" stroke-width="${f(s.feature * 0.62)}"><circle cx="${f(lx)}" cy="${f(eyeY)}" r="${f(r)}"/><circle cx="${f(rx)}" cy="${f(eyeY)}" r="${f(r)}"/><path d="M${f(lx + r)} ${f(eyeY - 1)}Q${f(faceX)} ${f(eyeY - 3.5)} ${f(rx - r)} ${f(eyeY - 1)}"/></g>`;
    }
    if (kind === "shades") {
      const lens = (x: number): string =>
        `<rect x="${f(x - r - 0.5)}" y="${f(eyeY - r * 0.75)}" width="${f(r * 2 + 1)}" height="${f(r * 1.55)}" rx="${f(r * 0.6)}" fill="${p.ink}"/><path d="M${f(x - r * 0.5)} ${f(eyeY - r * 0.2)}L${f(x - r * 0.05)} ${f(eyeY - r * 0.45)}" stroke="${p.shine}" stroke-width="1.2" stroke-linecap="round"/>`;
      return `${lens(lx)}${lens(rx)}<path d="M${f(lx + r)} ${f(eyeY - 1)}H${f(rx - r)}" stroke="${p.ink}" stroke-width="${f(s.feature * 0.6)}"/>`;
    }
    return "";
  }
  switch (kind) {
    case "beanie": {
      const half = body.halfWidthAt(top + 9) + 1.5;
      const dome = `M${f(cx - half)} ${f(top + 9)}C${f(cx - half)} ${f(top - 13)} ${f(cx + half)} ${f(top - 13)} ${f(cx + half)} ${f(top + 9)}Z`;
      const brim = `M${f(cx - half - 1.5)} ${f(top + 4)}H${f(cx + half + 1.5)}V${f(top + 11)}H${f(cx - half - 1.5)}Z`;
      return `${inked(dome, p.accent, p, s)}${inked(brim, p.accentShade, p, s)}${inked(circlePath(cx, top - 9, 4.2), p.shine, p, s)}`;
    }
    case "party": {
      const d = `M${f(cx - 10)} ${f(top + 5)}L${f(cx + 4)} ${f(top - 22)}L${f(cx + 11)} ${f(top + 3)}Z`;
      const stripes = `<path d="M${f(cx - 6)} ${f(top - 2)}L${f(cx + 9.5)} ${f(top - 4)}M${f(cx - 1.5)} ${f(top - 11)}L${f(cx + 7.4)} ${f(top - 12)}" stroke="${p.shine}" stroke-width="2.2" stroke-linecap="round"/>`;
      return `${inked(d, p.accent, p, s)}${stripes}${inked(circlePath(cx + 4, top - 23, 3.4), p.spark, p, s)}`;
    }
    case "crown": {
      const y = top + 6;
      const d = `M${f(cx - 13)} ${f(y)}L${f(cx - 15)} ${f(y - 14)}L${f(cx - 7)} ${f(y - 7)}L${f(cx)} ${f(y - 17)}L${f(cx + 7)} ${f(y - 7)}L${f(cx + 15)} ${f(y - 14)}L${f(cx + 13)} ${f(y)}Z`;
      return `${inked(d, p.spark, p, s)}<circle cx="${f(cx)}" cy="${f(y - 4)}" r="2.3" fill="${p.accent}"/>`;
    }
    case "wizard": {
      const brim = `M${f(cx - 22)} ${f(top + 6)}Q${f(cx)} ${f(top - 1)} ${f(cx + 22)} ${f(top + 6)}Q${f(cx)} ${f(top + 11)} ${f(cx - 22)} ${f(top + 6)}Z`;
      const cone = `M${f(cx - 12)} ${f(top + 4)}Q${f(cx - 4)} ${f(top - 16)} ${f(cx + 10)} ${f(top - 26)}Q${f(cx + 4)} ${f(top - 12)} ${f(cx + 12)} ${f(top + 4)}Z`;
      const star = `<path d="M${f(cx + 1)} ${f(top - 11)}l1.2 2.6 2.8 .3-2.1 1.9.6 2.8-2.5-1.4-2.5 1.4.6-2.8-2.1-1.9 2.8-.3z" fill="${p.spark}"/>`;
      return `${inked(cone, p.accent, p, s)}${inked(brim, p.accentShade, p, s)}${star}`;
    }
    case "beret": {
      const d = `M${f(cx - 19)} ${f(top + 6)}Q${f(cx - 16)} ${f(top - 9)} ${f(cx + 4)} ${f(top - 8)}Q${f(cx + 20)} ${f(top - 6)} ${f(cx + 17)} ${f(top + 5)}Q${f(cx)} ${f(top + 9)} ${f(cx - 19)} ${f(top + 6)}Z`;
      return `${inked(d, p.accent, p, s)}${inkedLine(`M${f(cx + 2)} ${f(top - 8)}L${f(cx + 3)} ${f(top - 12)}`, p.accent, 2.2, p, s)}`;
    }
    case "headphones": {
      const y = eyeY - 2;
      const half = body.halfWidthAt(y) + 2;
      const band = `M${f(cx - half + 2)} ${f(y - 4)}C${f(cx - half)} ${f(top - 12)} ${f(cx + half)} ${f(top - 12)} ${f(cx + half - 2)} ${f(y - 4)}`;
      const cup = (x: number): string => inked(`M${f(x - 4)} ${f(y - 7)}H${f(x + 4)}V${f(y + 7)}H${f(x - 4)}Z`, p.accent, p, s);
      return `${inkedLine(band, p.accentShade, 2.6, p, s)}${cup(cx - half)}${cup(cx + half)}`;
    }
    default:
      return "";
  }
}

const circlePath = (x: number, y: number, r: number): string =>
  `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(r * 2)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-r * 2)} 0Z`;

function markingSvg(genome: PortraitGenome, body: Body, p: PortraitPalette, faceX: number, eyeY: number): string {
  const rand = mulberry32(genome.salt);
  switch (genome.marking) {
    case "belly":
      return `<ellipse cx="${f(faceX * 0.3 + body.cx * 0.7)}" cy="${f(body.cy + body.h * 0.62)}" rx="${f(body.w * 0.62)}" ry="${f(body.h * 0.5)}" fill="${p.belly}"/>`;
    case "spots":
      return Array.from({ length: 3 }, (_, index) => {
        const side = index % 2 === 0 ? -1 : 1;
        const x = body.cx + side * body.w * (0.55 + rand() * 0.3);
        const y = body.cy + body.h * (-0.2 + index * 0.35 + rand() * 0.15);
        return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(3.5 + rand() * 4)}" fill="${p.shade}"/>`;
      }).join("");
    case "cap":
      return `<path d="M0 0H100V${f(body.top + body.h * 0.34)}Q50 ${f(body.top + body.h * 0.52)} 0 ${f(body.top + body.h * 0.34)}Z" fill="${p.shade}"/>`;
    case "stripes":
      return [-1, 1]
        .map((dir) =>
          [0, 1, 2]
            .map((k) => {
              const y = body.top + body.h * (0.35 + k * 0.28);
              const x = body.cx + dir * (body.halfWidthAt(y) + 2);
              return `<path d="M${f(x)} ${f(y - 3)}Q${f(x - dir * 9)} ${f(y)} ${f(x)} ${f(y + 3)}Z" fill="${p.shade}"/>`;
            })
            .join(""),
        )
        .join("");
    case "patch": {
      const side = rand() < 0.5 ? -1 : 1;
      return `<ellipse cx="${f(faceX + side * 11)}" cy="${f(eyeY)}" rx="9" ry="8" fill="${p.shade}"/>`;
    }
    case "muzzle":
      return `<ellipse cx="${f(faceX)}" cy="${f(eyeY + 11)}" rx="12" ry="8.5" fill="${p.belly}"/>`;
    case "blaze":
      return `<path d="M${f(faceX - 4)} ${f(body.top - 2)}Q${f(faceX)} ${f(eyeY + 2)} ${f(faceX + 4)} ${f(body.top - 2)}Z" fill="${p.belly}"/>`;
    case "stars":
      return Array.from({ length: 3 }, (_, index) => {
        const side = index % 2 === 0 ? -1 : 1;
        const x = body.cx + side * body.w * (0.5 + rand() * 0.3);
        const y = body.cy + body.h * (-0.35 + index * 0.4);
        const q = 2.6 + rand() * 1.2;
        return `<path d="M${f(x)} ${f(y - q)}Q${f(x + q * 0.2)} ${f(y - q * 0.2)} ${f(x + q)} ${f(y)}Q${f(x + q * 0.2)} ${f(y + q * 0.2)} ${f(x)} ${f(y + q)}Q${f(x - q * 0.2)} ${f(y + q * 0.2)} ${f(x - q)} ${f(y)}Q${f(x - q * 0.2)} ${f(y - q * 0.2)} ${f(x)} ${f(y - q)}Z" fill="${p.shine}" opacity="0.85"/>`;
      }).join("");
    case "heart": {
      const x = body.cx + body.w * 0.42 * (rand() < 0.5 ? -1 : 1);
      const y = body.cy + body.h * 0.42;
      return `<path d="M${f(x)} ${f(y + 3.6)}C${f(x - 6)} ${f(y - 0.6)} ${f(x - 3.4)} ${f(y - 5.4)} ${f(x)} ${f(y - 2.4)}C${f(x + 3.4)} ${f(y - 5.4)} ${f(x + 6)} ${f(y - 0.6)} ${f(x)} ${f(y + 3.6)}Z" fill="${p.blush}"/>`;
    }
    case "freckles":
      return [-1, 1]
        .map((dir) =>
          [0, 1, 2]
            .map((k) => `<circle cx="${f(faceX + dir * (13 + k * 2.6))}" cy="${f(eyeY + 8 + (k % 2) * 2.2)}" r="1" fill="${p.shade}"/>`)
            .join(""),
        )
        .join("");
    default:
      return "";
  }
}

function eyeSvg(kind: PortraitEyes, x: number, y: number, r: number, side: number, p: PortraitPalette, s: Stroke): string {
  const line = `stroke="${p.ink}" stroke-width="${s.feature}" stroke-linecap="round" fill="none"`;
  const shine = (cx: number, cy: number, rr: number): string =>
    s.scale > 1.2 ? "" : `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rr)}" fill="${p.shine}"/>`;
  switch (kind) {
    case "dot":
      return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${p.ink}"/>`;
    case "shiny":
      return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 1.3)}" fill="${p.ink}"/>${shine(x + r * 0.45, y - r * 0.5, r * 0.45)}`;
    case "oval":
      return `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(r * 0.95)}" ry="${f(r * 1.5)}" fill="${p.ink}"/>${shine(x + r * 0.3, y - r * 0.7, r * 0.4)}`;
    case "happy":
      return `<path d="M${f(x - r * 1.2)} ${f(y + r * 0.5)}Q${f(x)} ${f(y - r * 1.4)} ${f(x + r * 1.2)} ${f(y + r * 0.5)}" ${line}/>`;
    case "sleepy":
      return `<path d="M${f(x - r * 1.2)} ${f(y - r * 0.2)}Q${f(x)} ${f(y + r * 1.2)} ${f(x + r * 1.2)} ${f(y - r * 0.2)}" ${line}/>`;
    case "line":
      return `<path d="M${f(x - r * 1.1)} ${f(y)}H${f(x + r * 1.1)}" ${line}/>`;
    case "wink":
      return side < 0
        ? `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 1.15)}" fill="${p.ink}"/>${shine(x + r * 0.4, y - r * 0.45, r * 0.4)}`
        : `<path d="M${f(x - r * 1.2)} ${f(y + r * 0.5)}Q${f(x)} ${f(y - r * 1.4)} ${f(x + r * 1.2)} ${f(y + r * 0.5)}" ${line}/>`;
    case "squint":
      return `<ellipse cx="${f(x)}" cy="${f(y + r * 0.15)}" rx="${f(r * 1.1)}" ry="${f(r * 0.5)}" fill="${p.ink}"/>`;
    case "sparkle": {
      const k = r * 1.5;
      return `<path d="M${f(x)} ${f(y - k)}Q${f(x + k * 0.18)} ${f(y - k * 0.18)} ${f(x + k)} ${f(y)}Q${f(x + k * 0.18)} ${f(y + k * 0.18)} ${f(x)} ${f(y + k)}Q${f(x - k * 0.18)} ${f(y + k * 0.18)} ${f(x - k)} ${f(y)}Q${f(x - k * 0.18)} ${f(y - k * 0.18)} ${f(x)} ${f(y - k)}Z" fill="${p.ink}"/>`;
    }
  }
}

function mouthSvg(kind: PortraitMouth, x: number, y: number, p: PortraitPalette, s: Stroke): string {
  const k = s.scale;
  const line = `stroke="${p.ink}" stroke-width="${s.feature * 0.85}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  switch (kind) {
    case "smile":
      return `<path d="M${f(x - 4 * k)} ${f(y)}Q${f(x)} ${f(y + 4 * k)} ${f(x + 4 * k)} ${f(y)}" ${line}/>`;
    case "cat":
      return `<path d="M${f(x - 5 * k)} ${f(y)}Q${f(x - 2.5 * k)} ${f(y + 3.4 * k)} ${f(x)} ${f(y)}Q${f(x + 2.5 * k)} ${f(y + 3.4 * k)} ${f(x + 5 * k)} ${f(y)}" ${line}/>`;
    case "o":
      return `<ellipse cx="${f(x)}" cy="${f(y + 1.2 * k)}" rx="${f(2.2 * k)}" ry="${f(2.8 * k)}" fill="${p.ink}"/>`;
    case "flat":
      return `<path d="M${f(x - 3 * k)} ${f(y + 1)}H${f(x + 3 * k)}" ${line}/>`;
    case "wobble":
      return `<path d="M${f(x - 5 * k)} ${f(y + 1)}Q${f(x - 2.5 * k)} ${f(y - 1.5 * k)} ${f(x)} ${f(y + 1)}Q${f(x + 2.5 * k)} ${f(y + 3.5 * k)} ${f(x + 5 * k)} ${f(y + 1)}" ${line}/>`;
    case "grin": {
      const w = 5.5 * k;
      const d = `M${f(x - w)} ${f(y - 0.5)}Q${f(x)} ${f(y + 1.2)} ${f(x + w)} ${f(y - 0.5)}Q${f(x + w * 0.8)} ${f(y + 7.5 * k)} ${f(x)} ${f(y + 7.5 * k)}Q${f(x - w * 0.8)} ${f(y + 7.5 * k)} ${f(x - w)} ${f(y - 0.5)}Z`;
      const tongue = s.scale > 1.2 ? "" : `<ellipse cx="${f(x + 0.6)}" cy="${f(y + 5.6 * k)}" rx="${f(3 * k)}" ry="${f(1.9 * k)}" fill="${p.blush}"/>`;
      return `<path d="${d}" fill="${p.ink}"/>${tongue}`;
    }
    case "fang":
      return `<path d="M${f(x - 4.5 * k)} ${f(y)}Q${f(x)} ${f(y + 4 * k)} ${f(x + 4.5 * k)} ${f(y)}" ${line}/><path d="M${f(x + 0.6 * k)} ${f(y + 2 * k)}L${f(x + 2 * k)} ${f(y + 5 * k)}L${f(x + 3.2 * k)} ${f(y + 1.4 * k)}Z" fill="${p.shine}" stroke="${p.ink}" stroke-width="${f(s.feature * 0.45)}" stroke-linejoin="round"/>`;
    case "frown":
      return `<path d="M${f(x - 4 * k)} ${f(y + 3 * k)}Q${f(x)} ${f(y - 0.6 * k)} ${f(x + 4 * k)} ${f(y + 3 * k)}" ${line}/>`;
    case "none":
      return "";
  }
}

/** One brow over an eye. `side` is -1 for the left eye; inner is toward the face centre. */
function browSvg(kind: PortraitBrows, x: number, y: number, r: number, side: number, p: PortraitPalette, s: Stroke): string {
  if (kind === "none") return "";
  const half = r * 1.35 + 1.2;
  const lift = r * 1.1 + 3.2;
  const by = y - lift;
  // Inner and outer end heights (positive is up), then a gentle arch.
  const [inner, outer, arch] =
    kind === "raised"
      ? [2.2, 2.2, 1.6]
      : kind === "worried"
        ? [2.6, -0.6, 0.4]
        : kind === "furrowed"
          ? [-2.4, 1, 0]
          : kind === "quizzical"
            ? side > 0
              ? [2.8, 2.8, 1.8]
              : [0, 0, 0.6]
            : [0, 0, 0.8];
  const innerX = x - side * half;
  const outerX = x + side * half;
  const innerY = by - inner;
  const outerY = by - outer;
  const midX = (innerX + outerX) / 2;
  const midY = (innerY + outerY) / 2 - arch;
  return `<path d="M${f(innerX)} ${f(innerY)}Q${f(midX)} ${f(midY)} ${f(outerX)} ${f(outerY)}" stroke="${p.ink}" stroke-width="${f(s.feature * 0.8)}" stroke-linecap="round" fill="none"/>`;
}

/** A small mood mark beside the head. Placed inside every crop. */
function extraSvg(kind: PortraitExtra, body: Body, faceX: number, eyeY: number, p: PortraitPalette, s: Stroke): string {
  const k = s.scale;
  const sideX = Math.min(82, body.cx + body.halfWidthAt(eyeY - 6) + 1);
  switch (kind) {
    case "sweat": {
      const x = Math.min(78, sideX - 3);
      const y = eyeY - 8;
      const d = `M${f(x)} ${f(y - 5 * k)}Q${f(x + 3.4 * k)} ${f(y)} ${f(x + 3.4 * k)} ${f(y + 1.6 * k)}A${f(3.4 * k)} ${f(3.4 * k)} 0 0 1 ${f(x - 3.4 * k)} ${f(y + 1.6 * k)}Q${f(x - 3.4 * k)} ${f(y)} ${f(x)} ${f(y - 5 * k)}Z`;
      return `<path d="${d}" fill="${p.drop}" stroke="${p.ink}" stroke-width="${f(s.outline * 0.55)}" stroke-linejoin="round"/>`;
    }
    case "sparkle":
      return [
        [Math.max(22, body.cx - body.w * 0.95), eyeY - 14, 4.2],
        [Math.min(80, body.cx + body.w * 0.92), eyeY - 18, 3.2],
      ]
        .map(([x, y, r]) => {
          const q = (r as number) * k;
          const cx = x as number;
          const cy = Math.max(22, y as number);
          return `<path d="M${f(cx)} ${f(cy - q)}Q${f(cx + q * 0.2)} ${f(cy - q * 0.2)} ${f(cx + q)} ${f(cy)}Q${f(cx + q * 0.2)} ${f(cy + q * 0.2)} ${f(cx)} ${f(cy + q)}Q${f(cx - q * 0.2)} ${f(cy + q * 0.2)} ${f(cx - q)} ${f(cy)}Q${f(cx - q * 0.2)} ${f(cy - q * 0.2)} ${f(cx)} ${f(cy - q)}Z" fill="${p.spark}"/>`;
        })
        .join("");
    case "zzz": {
      const x = Math.min(74, sideX - 4);
      const y = Math.max(24, eyeY - 12);
      const z = (zx: number, zy: number, w: number): string =>
        `<path d="M${f(zx)} ${f(zy)}h${f(w)}l${f(-w)} ${f(w)}h${f(w)}" stroke="${p.mute}" stroke-width="${f(s.feature * 0.6)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
      return z(x, y, 4.6 * k) + (s.scale > 1.2 ? "" : z(x + 6, y - 7, 3.4));
    }
    case "question": {
      const x = Math.min(76, sideX - 2);
      const y = Math.max(24, eyeY - 14);
      return `<path d="M${f(x - 2.6 * k)} ${f(y - 1.6 * k)}Q${f(x - 2.4 * k)} ${f(y - 5 * k)} ${f(x + 0.4 * k)} ${f(y - 5 * k)}Q${f(x + 3.2 * k)} ${f(y - 4.8 * k)} ${f(x + 3 * k)} ${f(y - 2 * k)}Q${f(x + 2.8 * k)} ${f(y)} ${f(x)} ${f(y + 1.2 * k)}L${f(x)} ${f(y + 2.4 * k)}" stroke="${p.ink}" stroke-width="${f(s.feature * 0.7)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="${f(x)}" cy="${f(y + 5.2 * k)}" r="${f(s.feature * 0.42)}" fill="${p.ink}"/>`;
    }
    case "none":
      return "";
  }
}

const GRAIN = `<filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.1 0.62"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;

/**
 * `tile` is the rounded-square sticker. `round` is a porthole: circle frame,
 * critter pulled in slightly so ears and antennae survive the curve, sized to
 * sit inside an activity ring drawn by the seat. `bare` is the whole critter
 * on a transparent ground, feet and all, unclipped, for brand, landing, and
 * video work that floats characters over its own backgrounds.
 */
export type PortraitFrame = "tile" | "round" | "bare";

export interface PortraitRequest {
  readonly seed: string;
  readonly mode: ThemeMode;
  readonly detail: PortraitDetail;
  readonly frame?: PortraitFrame;
  /** Operator overrides; absent is the identity character. */
  readonly config?: PortraitConfig;
  /** A mood face over the character; absent is its own resting face. */
  readonly face?: PortraitFace;
}

/** Build the portrait SVG document for a seed. Pure; callers cache by key. */
export function portraitSvg({ seed, mode, detail, frame: shape = "tile", config, face }: PortraitRequest): string {
  const genome = portraitCharacter(seed, config);
  const eyes = face && face.eyes !== "base" ? face.eyes : genome.eyes;
  const mouth = face && face.mouth !== "base" ? face.mouth : genome.mouth;
  const brows = face && face.brows !== "base" ? face.brows : genome.brows;
  const blush = face && face.blush !== "base" ? face.blush : genome.blush;
  const extra = face?.extra ?? "none";
  const p = paletteFor(genome, mode);
  const s = strokeFor(detail);
  const body = bodyFor(genome);
  const faceX = body.cx + genome.gaze * 4.5;
  const eyeY = body.top + Math.min(body.h * 0.62, 24) + (detail === "glyph" ? 1 : 0);
  const eyeGap = (8.5 + genome.eyeGap * 5) * (detail === "glyph" ? 1.15 : 1);
  const eyeR = (2.5 + genome.eyeSize * 1.3) * s.scale;
  const mouthY = eyeY + 7 + genome.eyeSize * 1.5;
  const showBlush = blush && detail !== "glyph";
  const clipBody = `<clipPath id="b"><path d="${body.path}"/></clipPath>`;
  const marking = detail === "glyph" && genome.marking === "freckles" ? "" : markingSvg(genome, body, p, faceX, eyeY);
  const bare = shape === "bare";
  const round = shape === "round";
  const nudge = s.offset > 0 ? ` transform="translate(${s.offset} ${s.offset * 0.7})"` : "";
  const acc = (layer: "neck" | "face" | "hat"): string =>
    accessorySvg(layer, genome, body, p, s, faceX, eyeY, eyeGap, eyeR, mouthY);

  // The critter, identical in every frame.
  const critter = [
    // Bare frames stand on two little feet; the ghost floats on its hem.
    bare && genome.shape !== "ghost"
      ? [-1, 1]
          .map((dir) => inked(`M${f(body.cx + dir * body.w * 0.38 - 7)} ${f(body.cy + body.h - 3)}a7 5 0 1 0 14 0a7 5 0 1 0 -14 0Z`, p.shade, p, s))
          .join("")
      : "",
    topperBehind(genome, body, p, s),
    `<path d="${body.path}" fill="${p.body}"${nudge}/>`,
    marking ? `<g clip-path="url(#b)"${nudge}>${marking}</g>` : "",
    `<path d="${body.path}" fill="none" stroke="${p.ink}" stroke-width="${s.outline}" stroke-linejoin="round"/>`,
    speciesSvg(genome, body, p, s),
    topperFront(genome, body, p, s),
    acc("neck"),
    showBlush
      ? [-1, 1]
          .map((dir) => `<ellipse cx="${f(faceX + dir * (eyeGap + 5))}" cy="${f(eyeY + 6.5)}" rx="5" ry="3" fill="${p.blush}" opacity="0.55"/>`)
          .join("")
      : "",
    eyeSvg(eyes, faceX - eyeGap, eyeY, eyeR, -1, p, s),
    eyeSvg(eyes, faceX + eyeGap, eyeY, eyeR, 1, p, s),
    acc("face"),
    browSvg(brows, faceX - eyeGap, eyeY, eyeR, -1, p, s),
    browSvg(brows, faceX + eyeGap, eyeY, eyeR, 1, p, s),
    mouthSvg(mouth, faceX, mouthY, p, s),
    acc("hat"),
    extraSvg(extra, body, faceX, eyeY, p, s),
  ].join("");

  if (bare) {
    // A square around the whole critter, headroom for hats and ears.
    const bottom = body.cy + body.h + 6;
    const topY = body.top - 30;
    const side = Math.max(bottom - topY, body.w * 2 + 44);
    const x0 = body.cx - side / 2;
    const y0 = bottom - side;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x0)} ${f(y0)} ${f(side)} ${f(side)}">`,
      `<defs>${clipBody}</defs>`,
      `<g transform="rotate(${f(genome.tilt)} 50 90)">${critter}</g>`,
      `</svg>`,
    ].join("");
  }

  // Glyph sizes crop in on the face so eyes stay a couple of pixels wide.
  const view =
    detail === "glyph" ? (round ? { x: 14, y: 17, s: 72 } : { x: 12, y: 14, s: 76 }) : { x: 0, y: 0, s: 100 };
  const frame = `x="${view.x}" y="${view.y}" width="${view.s}" height="${view.s}"`;
  const half = view.s / 2;
  const clipFrame = round
    ? `<circle cx="${f(view.x + half)}" cy="${f(view.y + half)}" r="${f(half)}"/>`
    : `<rect ${frame} rx="${f(view.s * 0.24)}"/>`;
  // The porthole pulls the critter in toward the face so toppers clear the curve.
  const inset = round ? ` transform="translate(50 60) scale(${detail === "glyph" ? 1 : 0.88}) translate(-50 -60)"` : "";
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.x} ${view.y} ${view.s} ${view.s}">`,
    `<defs><clipPath id="t">${clipFrame}</clipPath>${clipBody}${detail === "rich" ? GRAIN : ""}</defs>`,
    `<g clip-path="url(#t)">`,
    `<rect ${frame} fill="${p.tile}"/>`,
    `<circle cx="${f(50 + genome.gaze * 6)}" cy="44" r="36" fill="${p.halo}"/>`,
    `<g${inset}><g transform="rotate(${f(genome.tilt)} 50 90)">`,
    critter,
    `</g></g>`,
    detail === "rich" ? `<rect width="100" height="100" fill="${p.ink}" filter="url(#g)" opacity="0.16"/>` : "",
    `</g></svg>`,
  ];
  return parts.join("");
}

/** The portrait as a data URI, ready for an <img>. */
export const portraitDataUri = (request: PortraitRequest): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(portraitSvg(request))}`;
