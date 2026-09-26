import {
  baseIdentityTable,
  cosmeticEntries,
  findCosmetic,
  identityPalettes,
  identityTable,
  type CosmeticEntry,
  type CosmeticSlot,
  type IdentityTable,
} from "./cosmetics/catalog";
import { BASE_PACK } from "./cosmetics/base-pack";
import { drawLayer, speciesBody, type BodyShape, type CritterGeometry, type DrawStyle } from "./cosmetics/draw";
import type { CosmeticPart, PaletteRole } from "./cosmetics/pack-schema";
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
//
// Species, toppers, patterns, props, and body palettes are cosmetic items
// (./cosmetics): the base cast is the built-in pack, drawn by the same data
// interpreter as any pack the build bundles. Faces and expressions stay here.

export type PortraitDetail = "glyph" | "card" | "rich";

/** Pick the detail tier for a rendered pixel size. */
export const portraitDetailFor = (size: number): PortraitDetail =>
  size < 34 ? "glyph" : size < 72 ? "card" : "rich";

// Which species, ears, patterns, props, and body palettes a seat is born
// with comes from the cosmetic catalog's identity tables (the base pack's, or
// a bundled pack's when it declares them); this file keeps only the rolls and
// their order. Faces are not cosmetics: their draw lists live here.
const ACCENT_HUES = ["amber", "cyan", "violet", "green", "orange", "gold"] as const;
const EYES = ["dot", "shiny", "happy", "sleepy", "oval", "wink", "line", "sparkle"] as const;
const MOUTHS = ["smile", "cat", "o", "flat", "grin", "fang", "none", "wobble"] as const;
// The face lists above are part of the identity draw; their order is frozen
// so every seat keeps its face. Kinds only expressions or the editor reach
// live apart.
const EXPRESSION_EYES = ["squint"] as const;
const EXPRESSION_MOUTHS = ["frown"] as const;
const BROWS = ["none", "level", "raised", "worried", "furrowed", "quizzical"] as const;
const EXTRAS = ["none", "sweat", "sparkle", "zzz", "question"] as const;

/** Catalog keys: a base id ("toast") or a pack item ("<pack>:<item>"). */
export type PortraitShape = string;
export type PortraitTopper = string;
export type PortraitAccessory = string;
export type PortraitEyes = (typeof EYES)[number] | (typeof EXPRESSION_EYES)[number];
export type PortraitMouth = (typeof MOUTHS)[number] | (typeof EXPRESSION_MOUTHS)[number];
export type PortraitMarking = string;
export type PortraitBrows = (typeof BROWS)[number];
export type PortraitExtra = (typeof EXTRAS)[number];

/** Face choices the editor offers, in display order (faces are not cosmetics). */
export const PORTRAIT_FACE_OPTIONS = {
  accentHue: [...ACCENT_HUES],
  eyes: [...EYES, ...EXPRESSION_EYES],
  mouth: [...MOUTHS.filter((mouth) => mouth !== "none"), ...EXPRESSION_MOUTHS, "none"],
  brows: [...BROWS],
} as const satisfies Record<string, ReadonlyArray<string>>;

/** Portrait traits that come from the cosmetic catalog, and their slot. */
export const PORTRAIT_COSMETIC_TRAITS = {
  bodyHue: "palette",
  shape: "species",
  topper: "topper",
  accessory: "accessory",
  marking: "pattern",
} as const;

/**
 * Every option the editor offers right now, base cast first, then each pack
 * the build bundled. Unavailable pack items are listed; they never render.
 */
export const portraitOptions = () => ({
  ...PORTRAIT_FACE_OPTIONS,
  bodyHue: cosmeticEntries("palette").map((entry) => entry.key),
  shape: cosmeticEntries("species").map((entry) => entry.key),
  topper: cosmeticEntries("topper").map((entry) => entry.key),
  accessory: cosmeticEntries("accessory").map((entry) => entry.key),
  marking: cosmeticEntries("pattern").map((entry) => entry.key),
});

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

const weighted = (u: number, items: ReadonlyArray<readonly [string, number]>): string | undefined => {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = u * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return items[0]?.[0];
};

const at = (u: number, items: ReadonlyArray<string>): string | undefined =>
  items.length === 0 ? undefined : items[Math.floor(u * items.length) % items.length];

/**
 * One identity draw from a catalog table. A drawn key this install may not
 * wear falls back to the base pack's table with the same roll, so one locked
 * item never reshuffles any other seat.
 */
const drawn = (slot: CosmeticSlot, table: IdentityTable, u: number): string | undefined => {
  const key = at(u, identityTable(table));
  if (key !== undefined && findCosmetic(slot, key)) return key;
  return at(u, baseIdentityTable(table));
};

const drawnPalette = (u: number): string => {
  const key = weighted(u, identityPalettes());
  return key !== undefined && findCosmetic("palette", key) ? key : (weighted(u, BASE_PACK.identity?.palettes ?? []) ?? "amber");
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
  // A cosmetic key that is missing or unavailable falls back to identity.
  const cosmetic = (slot: Parameters<typeof findCosmetic>[0], value: unknown, fallback: string): string =>
    findCosmetic(slot, value)?.key ?? fallback;
  const bodyHue = cosmetic("palette", c.bodyHue, genome.bodyHue);
  let accentHue = oneOf(PORTRAIT_FACE_OPTIONS.accentHue, c.accentHue) ?? genome.accentHue;
  if (c.accentHue === undefined && accentHue === bodyHue) accentHue = bodyHue === "cyan" ? "amber" : "cyan";
  const temperament =
    typeof c.temperament === "number" && Number.isFinite(c.temperament)
      ? clamp(c.temperament, -1, 1)
      : defaultTemperament(seed);
  return {
    ...genome,
    bodyHue,
    accentHue,
    shape: cosmetic("species", c.shape, genome.shape),
    topper: cosmetic("topper", c.topper, genome.topper),
    accessory: cosmetic("accessory", c.accessory, genome.accessory),
    eyes: oneOf(PORTRAIT_FACE_OPTIONS.eyes, c.eyes) ?? genome.eyes,
    mouth: oneOf(PORTRAIT_FACE_OPTIONS.mouth, c.mouth) ?? genome.mouth,
    marking: cosmetic("pattern", c.marking, genome.marking),
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

/**
 * Decide the character for a seed. Stable for a given seed and set of
 * installed packs: the rolls and their order never change, and the catalog's
 * identity tables say what each roll lands on.
 */
export function portraitGenome(seed: string): PortraitGenome {
  const rand = mulberry32(fnv1a(seed.trim() || "agent"));
  const bodyHue = drawnPalette(rand());
  let accentHue: string = pick(rand, ACCENT_HUES);
  if (accentHue === bodyHue) accentHue = bodyHue === "cyan" ? "amber" : "cyan";
  const shape = drawn("species", "species", rand()) ?? "round";
  const topper = drawn("topper", "toppers", rand()) ?? "none";
  const eyes = pick(rand, EYES);
  const mouth = pick(rand, MOUTHS);
  const marking = drawn("pattern", "patterns", rand()) ?? "none";
  // Second cast: fixed draw order, every roll always taken, so each trait's
  // odds stay independent of the others.
  const more = mulberry32(fnv1a(`${seed.trim() || "agent"}#cast-2`));
  const [speciesRoll, species] = [more(), drawn("species", "speciesMore", more())];
  const [earsRoll, ears] = [more(), drawn("topper", "toppersMore", more())];
  const [patternRoll, pattern] = [more(), drawn("pattern", "patternsMore", more())];
  const [propRoll, prop] = [more(), drawn("accessory", "props", more())];
  return {
    bodyHue,
    accentHue,
    shape: speciesRoll < 0.4 && species ? species : shape,
    topper: earsRoll < 0.4 && ears ? ears : topper,
    eyes,
    mouth,
    marking: patternRoll < 0.4 && pattern ? pattern : marking,
    accessory: propRoll < 0.45 && prop ? prop : "none",
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
  // Body palettes are catalog items: a theme hue token, lightly adjusted.
  const bodyPalette = findCosmetic("palette", genome.bodyHue)?.item;
  const hue = tokenOklch(runtime, bodyPalette?.token ?? "amber");
  const accent = tokenOklch(runtime, genome.accentHue);
  const leaf = tokenOklch(runtime, "green");
  const blush = tokenOklch(runtime, "orange");
  const cyan = tokenOklch(runtime, "cyan");
  const gold = tokenOklch(runtime, "gold");
  // Chroma follows the token but is clamped into a pastel band so steel stays
  // a soft grey critter and the loud hues never go neon.
  const chroma = clamp(hue.c * 0.82 * (bodyPalette?.chroma ?? 1), 0.03, 0.14);
  const lift = bodyPalette?.lightness ?? 0;
  const dark = mode === "dark";
  const palette: PortraitPalette = {
    tile: dark ? tone(hue, 0.265, chroma * 0.34) : tone(hue, 0.905, chroma * 0.3),
    halo: dark ? tone(hue, 0.31, chroma * 0.42) : tone(hue, 0.945, chroma * 0.22),
    body: tone(hue, (dark ? 0.81 : 0.815) + lift, chroma),
    shade: tone(hue, (dark ? 0.7 : 0.71) + lift, chroma * 1.05),
    belly: tone(hue, (dark ? 0.9 : 0.915) + lift * 0.5, chroma * 0.45),
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

// --- drawing ----------------------------------------------------------------

const f = (value: number): string => (Math.round(value * 10) / 10).toString();

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

type Body = BodyShape;

/** The cosmetic items a character wears, with the covering rules applied. */
function wornParts(genome: PortraitGenome): {
  readonly body: Body;
  readonly species: ReadonlyArray<CosmeticPart>;
  readonly topper: ReadonlyArray<CosmeticPart>;
  readonly accessory: ReadonlyArray<CosmeticPart>;
  readonly pattern: ReadonlyArray<CosmeticPart>;
  readonly floats: boolean;
} {
  // A character's keys were resolved against the catalog in portraitCharacter;
  // the identity keys always exist in the base pack.
  const species = (findCosmetic("species", genome.shape) ?? findCosmetic("species", "round")) as CosmeticEntry<"species">;
  const topper = findCosmetic("topper", genome.topper)?.item;
  const accessory = findCosmetic("accessory", genome.accessory)?.item;
  const pattern = findCosmetic("pattern", genome.marking)?.item;
  const capped = species.item.coversHats === true;
  const hat = accessory?.hat === true && !capped;
  const topperShown = topper && species.item.coversToppers !== true && !(hat && topper.crown === true);
  return {
    body: speciesBody(species.item, genome.width, genome.wobble),
    species: species.item.parts ?? [],
    topper: topperShown ? topper.parts : [],
    accessory: accessory && !(accessory.hat === true && capped) ? accessory.parts : [],
    pattern: pattern?.parts ?? [],
    floats: species.item.floats === true,
  };
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
  const worn = wornParts(genome);
  const body = worn.body;
  const faceX = body.cx + genome.gaze * 4.5;
  const eyeY = body.top + Math.min(body.h * 0.62, 24) + (detail === "glyph" ? 1 : 0);
  const eyeGap = (8.5 + genome.eyeGap * 5) * (detail === "glyph" ? 1.15 : 1);
  const eyeR = (2.5 + genome.eyeSize * 1.3) * s.scale;
  const mouthY = eyeY + 7 + genome.eyeSize * 1.5;
  const showBlush = blush && detail !== "glyph";
  const clipBody = `<clipPath id="b"><path d="${body.path}"/></clipPath>`;
  const bare = shape === "bare";
  const round = shape === "round";
  const nudge = s.offset > 0 ? ` transform="translate(${s.offset} ${s.offset * 0.7})"` : "";
  const geometry: CritterGeometry = {
    cx: body.cx,
    cy: body.cy,
    w: body.w,
    h: body.h,
    top: body.top,
    halfWidthAt: body.halfWidthAt,
    faceX,
    eyeY,
    eyeGap,
    mouthY,
    neckY: Math.min(mouthY + 12, body.cy + body.h - 4),
  };
  const style: DrawStyle = { outline: s.outline, offset: s.offset, ink: p.ink, color: (role: PaletteRole) => p[role], detail };
  const wornParts_ = [...worn.species, ...worn.topper, ...worn.pattern, ...worn.accessory];
  const layer = (name: Parameters<typeof drawLayer>[0]): string => drawLayer(name, wornParts_, geometry, style);
  const bodyLayer = layer("body");
  // Bare frames stand on two little feet; floating species do not.
  const feet: ReadonlyArray<CosmeticPart> =
    bare && !worn.floats
      ? [
          {
            layer: "behind",
            anchor: { x: "center", y: "bottom", dx: body.w * 0.38, dy: -3 },
            mirror: "sides",
            shapes: [{ kind: "ellipse", cx: 0, cy: 0, rx: 7, ry: 5, paint: "inked", color: "shade" }],
          },
        ]
      : [];

  // The critter, identical in every frame.
  const critter = [
    drawLayer("behind", feet, geometry, style),
    layer("behind"),
    `<path d="${body.path}" fill="${p.body}"${nudge}/>`,
    bodyLayer ? `<g clip-path="url(#b)"${nudge}>${bodyLayer}</g>` : "",
    `<path d="${body.path}" fill="none" stroke="${p.ink}" stroke-width="${s.outline}" stroke-linejoin="round"/>`,
    layer("front"),
    layer("neck"),
    showBlush
      ? [-1, 1]
          .map((dir) => `<ellipse cx="${f(faceX + dir * (eyeGap + 5))}" cy="${f(eyeY + 6.5)}" rx="5" ry="3" fill="${p.blush}" opacity="0.55"/>`)
          .join("")
      : "",
    eyeSvg(eyes, faceX - eyeGap, eyeY, eyeR, -1, p, s),
    eyeSvg(eyes, faceX + eyeGap, eyeY, eyeR, 1, p, s),
    layer("face"),
    browSvg(brows, faceX - eyeGap, eyeY, eyeR, -1, p, s),
    browSvg(brows, faceX + eyeGap, eyeY, eyeR, 1, p, s),
    mouthSvg(mouth, faceX, mouthY, p, s),
    layer("hat"),
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
