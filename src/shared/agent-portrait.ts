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

export type PortraitShape = (typeof SHAPES)[number];
export type PortraitTopper = (typeof TOPPERS)[number];
export type PortraitEyes = (typeof EYES)[number];
export type PortraitMouth = (typeof MOUTHS)[number];
export type PortraitMarking = (typeof MARKINGS)[number];

/** The character, independent of mode and detail: what a seed decides. */
export interface PortraitGenome {
  readonly bodyHue: string;
  readonly accentHue: string;
  readonly shape: PortraitShape;
  readonly topper: PortraitTopper;
  readonly eyes: PortraitEyes;
  readonly mouth: PortraitMouth;
  readonly marking: PortraitMarking;
  readonly blush: boolean;
  readonly gaze: number; // -1..1, face shift left/right
  readonly tilt: number; // degrees, whole critter
  readonly width: number; // 0..1 body proportion
  readonly eyeGap: number; // 0..1
  readonly eyeSize: number; // 0..1
  readonly wobble: readonly [number, number, number, number];
  readonly salt: number; // free entropy for small placements
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

/** Decide the character for a seed. Stable forever for a given seed. */
export function portraitGenome(seed: string): PortraitGenome {
  const rand = mulberry32(fnv1a(seed.trim() || "agent"));
  const bodyHue = pickWeighted(rand, BODY_HUES);
  let accentHue: string = pick(rand, ACCENT_HUES);
  if (accentHue === bodyHue) accentHue = bodyHue === "cyan" ? "amber" : "cyan";
  return {
    bodyHue,
    accentHue,
    shape: pick(rand, SHAPES),
    topper: pick(rand, TOPPERS),
    eyes: pick(rand, EYES),
    mouth: pick(rand, MOUTHS),
    marking: pick(rand, MARKINGS),
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

function bodyFor(genome: PortraitGenome): Body {
  const [phaseA, phaseB, ampA, ampB] = genome.wobble;
  const spec: Record<PortraitShape, { n: number; w: number; h: number; cy: number }> = {
    round: { n: 2, w: 33, h: 34, cy: 60 },
    bean: { n: 2.2, w: 28, h: 42, cy: 66 },
    mochi: { n: 2.8, w: 38, h: 30, cy: 66 },
    toast: { n: 3.6, w: 31, h: 36, cy: 62 },
    drop: { n: 2, w: 32, h: 36, cy: 62 },
    pear: { n: 2.2, w: 31, h: 38, cy: 64 },
  };
  const base = spec[genome.shape];
  const w = base.w * (0.93 + genome.width * 0.14);
  const { h, cy, n } = base;
  const cx = 50;
  const steps = 30;
  const points: Point[] = [];
  const exponent = 2 / n;
  for (let step = 0; step < steps; step += 1) {
    const t = (step / steps) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    let x = Math.sign(cos) * Math.abs(cos) ** exponent;
    const y = Math.sign(sin) * Math.abs(sin) ** exponent;
    if (genome.shape === "drop" && sin < 0) x *= 1 - 0.55 * (-sin) ** 3;
    if (genome.shape === "pear") x *= 1 + 0.14 * sin;
    const wobble = 1 + 0.028 * ampA * Math.sin(2 * t + phaseA) + 0.022 * ampB * Math.sin(3 * t + phaseB);
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

function topperBehind(genome: PortraitGenome, body: Body, p: PortraitPalette, s: Stroke): string {
  const { cx, top } = body;
  const earY = top + 7;
  const spread = Math.max(10, body.halfWidthAt(earY) - 5);
  const left = cx - spread;
  const right = cx + spread;
  switch (genome.topper) {
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
  switch (genome.topper) {
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
    case "none":
      return "";
  }
}

const GRAIN = `<filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.1 0.62"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;

export interface PortraitRequest {
  readonly seed: string;
  readonly mode: ThemeMode;
  readonly detail: PortraitDetail;
}

/** Build the portrait SVG document for a seed. Pure; callers cache by key. */
export function portraitSvg({ seed, mode, detail }: PortraitRequest): string {
  const genome = portraitGenome(seed);
  const p = paletteFor(genome, mode);
  const s = strokeFor(detail);
  const body = bodyFor(genome);
  const faceX = body.cx + genome.gaze * 4.5;
  const eyeY = body.top + Math.min(body.h * 0.62, 24) + (detail === "glyph" ? 1 : 0);
  const eyeGap = (8.5 + genome.eyeGap * 5) * (detail === "glyph" ? 1.15 : 1);
  const eyeR = (2.5 + genome.eyeSize * 1.3) * s.scale;
  const mouthY = eyeY + 7 + genome.eyeSize * 1.5;
  const showBlush = genome.blush && detail !== "glyph";
  const clipBody = `<clipPath id="b"><path d="${body.path}"/></clipPath>`;
  const marking = detail === "glyph" && genome.marking === "freckles" ? "" : markingSvg(genome, body, p, faceX, eyeY);

  // Glyph sizes crop in on the face so eyes stay a couple of pixels wide.
  const view = detail === "glyph" ? { x: 12, y: 14, s: 76 } : { x: 0, y: 0, s: 100 };
  const frame = `x="${view.x}" y="${view.y}" width="${view.s}" height="${view.s}"`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.x} ${view.y} ${view.s} ${view.s}">`,
    `<defs><clipPath id="t"><rect ${frame} rx="${f(view.s * 0.24)}"/></clipPath>${clipBody}${detail === "rich" ? GRAIN : ""}</defs>`,
    `<g clip-path="url(#t)">`,
    `<rect ${frame} fill="${p.tile}"/>`,
    `<circle cx="${f(50 + genome.gaze * 6)}" cy="44" r="36" fill="${p.halo}"/>`,
    `<g transform="rotate(${f(genome.tilt)} 50 90)">`,
    topperBehind(genome, body, p, s),
    s.offset > 0 ? `<path d="${body.path}" fill="${p.body}" transform="translate(${s.offset} ${s.offset * 0.7})"/>` : `<path d="${body.path}" fill="${p.body}"/>`,
    marking ? `<g clip-path="url(#b)"${s.offset > 0 ? ` transform="translate(${s.offset} ${s.offset * 0.7})"` : ""}>${marking}</g>` : "",
    `<path d="${body.path}" fill="none" stroke="${p.ink}" stroke-width="${s.outline}" stroke-linejoin="round"/>`,
    topperFront(genome, body, p, s),
    showBlush
      ? [-1, 1]
          .map((dir) => `<ellipse cx="${f(faceX + dir * (eyeGap + 5))}" cy="${f(eyeY + 6.5)}" rx="5" ry="3" fill="${p.blush}" opacity="0.55"/>`)
          .join("")
      : "",
    eyeSvg(genome.eyes, faceX - eyeGap, eyeY, eyeR, -1, p, s),
    eyeSvg(genome.eyes, faceX + eyeGap, eyeY, eyeR, 1, p, s),
    mouthSvg(genome.mouth, faceX, mouthY, p, s),
    `</g>`,
    detail === "rich" ? `<rect width="100" height="100" fill="${p.ink}" filter="url(#g)" opacity="0.16"/>` : "",
    `</g></svg>`,
  ];
  return parts.join("");
}

/** The portrait as a data URI, ready for an <img>. */
export const portraitDataUri = (request: PortraitRequest): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(portraitSvg(request))}`;
