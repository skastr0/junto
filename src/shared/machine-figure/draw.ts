import { portraitSvg, type PortraitConfig } from "../agent-portrait";
import { hexToOklch, oklchToHex, themeRuntime, type Oklch, type ThemeMode } from "../theme";

// The machine figure: a machine as a printed solid. Each form is a handful of
// slabs in three dimensions, projected by one fixed camera and painted the
// way the cast is painted: one round ink outline, three flat tones, the fill
// a hair off its outline. Pure and deterministic: the same request always
// produces the same SVG string, so callers cache by key and nothing animates.

export type MachineForm = "macbook" | "mac-mini" | "mac-studio" | "linux-box" | "server";
export type MachineDetail = "glyph" | "card" | "rich";
export type MachineFrame = "tile" | "bare";

export const MACHINE_FORMS: ReadonlyArray<MachineForm> = ["macbook", "mac-mini", "mac-studio", "linux-box", "server"];

/** State is painted over identity and never changes it. */
export interface MachineFigureState {
  /** Junto has been sent to this machine; absent means yes. */
  readonly setUp?: boolean;
  readonly reach: "reachable" | "unreachable" | "unknown";
  readonly install: "idle" | "sending" | "updating" | "needs-update";
  /** Installer transitions passed, 0 to 5, while sending or updating. */
  readonly step?: number;
  readonly missingHarness: boolean;
  readonly missingSecrets: number;
  /** Seats running on the machine. */
  readonly seats: number;
}

export interface MachineFigureRequest {
  /** The machine's short name: the identity seed. */
  readonly name: string;
  readonly form: MachineForm;
  readonly isThisMachine: boolean;
  readonly state: MachineFigureState;
  readonly mode: ThemeMode;
  readonly detail: MachineDetail;
  readonly frame?: MachineFrame;
  /** Turn about the vertical axis, in degrees from the resting pose. */
  readonly turn?: number;
  /** The seats running there, to stand on the roof at the large size. */
  readonly crew?: ReadonlyArray<{ readonly seed: string; readonly config?: PortraitConfig }>;
  /** Operator's hue choice (a theme hue token); absent is seeded from the name. */
  readonly hue?: string;
}

export const machineDetailFor = (size: number): MachineDetail => (size < 34 ? "glyph" : size < 72 ? "card" : "rich");

// --- identity ---------------------------------------------------------------

const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number) => {
  let a = seed;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const BODY_HUES = ["steel", "amber", "green", "violet", "cyan", "indigo", "pink", "blue", "gold"] as const;
const ACCENT_HUES = ["amber", "cyan", "violet", "green", "orange", "gold"] as const;

export interface MachineGenome {
  readonly bodyHue: string;
  readonly accentHue: string;
  /** Degrees the sticker sits askew. */
  readonly tilt: number;
  readonly mark: "dot" | "stripe" | "ring";
}

export function machineGenome(name: string, hue?: string): MachineGenome {
  const rand = mulberry32(fnv1a(`${name.trim().toLowerCase() || "machine"}#body`));
  const bodyHue = BODY_HUES[Math.floor(rand() * BODY_HUES.length)] ?? "steel";
  const accents = ACCENT_HUES.filter((accent) => accent !== (hue ?? bodyHue));
  return {
    bodyHue: hue ?? bodyHue,
    accentHue: accents[Math.floor(rand() * accents.length)] ?? "amber",
    tilt: Math.round((rand() * 2 - 1) * 2.2 * 10) / 10,
    mark: (["dot", "stripe", "ring"] as const)[Math.floor(rand() * 3)] ?? "dot",
  };
}

// --- palette ----------------------------------------------------------------

interface Palette {
  readonly top: string;
  readonly front: string;
  readonly side: string;
  readonly glass: string;
  readonly glassLit: string;
  readonly shine: string;
  readonly accent: string;
  readonly ink: string;
  readonly mute: string;
  readonly tile: string;
  readonly halo: string;
  readonly ledOn: string;
  readonly ledOff: string;
  readonly pip: string;
  readonly pipShade: string;
  readonly leaf: string;
  readonly badge: string;
  readonly paper: string;
}

type Role = keyof Palette;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const tone = (base: Oklch, l: number, c: number): string => oklchToHex({ l, c: Math.max(0, c), h: base.h });

function paletteFor(genome: MachineGenome, mode: ThemeMode, drained: boolean): Palette {
  const runtime = themeRuntime(mode);
  const token = (name: string): Oklch => hexToOklch(runtime[name] ?? runtime.amber ?? "#e8a33d");
  const hue = token(genome.bodyHue);
  const accent = token(genome.accentHue);
  const amber = token("amber");
  const green = token("green");
  const dark = mode === "dark";
  // The cast's pastel band: steel stays a soft grey machine, loud hues never go neon.
  const chroma = clamp(hue.c * 0.82, 0.03, 0.14);
  const body = drained
    ? dark
      ? { top: tone(hue, 0.58, 0.012), front: tone(hue, 0.49, 0.012), side: tone(hue, 0.4, 0.012) }
      : { top: tone(hue, 0.955, 0.01), front: tone(hue, 0.9, 0.012), side: tone(hue, 0.82, 0.014) }
    : { top: tone(hue, 0.905, chroma * 0.5), front: tone(hue, 0.815, chroma), side: tone(hue, 0.705, chroma * 1.05) };
  return {
    ...body,
    glass: dark ? tone(hue, 0.2, 0.012) : tone(hue, 0.3, 0.02),
    glassLit: tone(hue, dark ? 0.34 : 0.4, clamp(chroma * 0.6, 0.02, 0.06)),
    shine: runtime[dark ? "ink" : "raise"] ?? "#ede6da",
    accent: drained ? body.side : tone(accent, 0.74, clamp(accent.c * 0.9, 0.05, 0.14)),
    ink: runtime[dark ? "ground" : "ink"] ?? "#0c0b0a",
    mute: runtime.dim ?? "#8a8378",
    tile: dark ? tone(hue, 0.265, chroma * 0.34) : tone(hue, 0.905, chroma * 0.3),
    halo: dark ? tone(hue, 0.31, chroma * 0.42) : tone(hue, 0.945, chroma * 0.22),
    ledOn: tone(green, 0.8, 0.14),
    ledOff: drained ? body.side : tone(hue, 0.45, 0.02),
    pip: drained ? body.front : tone(amber, 0.815, 0.115),
    pipShade: drained ? body.side : tone(amber, 0.71, 0.12),
    leaf: drained ? body.top : tone(green, 0.72, 0.11),
    badge: tone(amber, 0.8, 0.13),
    paper: runtime[dark ? "raise" : "raise"] ?? "#16130f",
  };
}

/** The ground a machine stands on when it is given room: its own tile and halo. */
export function machineStage(name: string, mode: ThemeMode, hue?: string): { readonly tile: string; readonly halo: string } {
  const palette = paletteFor(machineGenome(name, hue), mode, false);
  return { tile: palette.tile, halo: palette.halo };
}

// --- geometry ---------------------------------------------------------------

type V3 = readonly [number, number, number];
type P2 = readonly [number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];

/** A plane to draw on: origin, two in-plane axes, and the outward normal. */
interface Plane {
  readonly o: V3;
  readonly u: V3;
  readonly v: V3;
  readonly n: V3;
}

type Shape =
  | { readonly kind: "rrect"; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly r: number }
  | { readonly kind: "circle"; readonly x: number; readonly y: number; readonly r: number }
  | { readonly kind: "line"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };

interface Decal {
  readonly on: Plane;
  readonly shape: Shape;
  readonly fill?: Role;
  /** Ink line width as a share of the outline; absent is no line. */
  readonly line?: number;
  readonly lineRole?: Role;
  readonly opacity?: number;
  readonly minDetail?: MachineDetail;
}

/** A rounded-rectangle footprint in a plane, extruded `h` along the normal. */
interface Slab extends Plane {
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly r: number;
  readonly decals?: ReadonlyArray<Decal>;
}

const UP: V3 = [0, 0, 1];
const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];

const box = (center: V3, w: number, d: number, h: number, r: number): Omit<Slab, "decals"> => ({ o: center, u: X, v: Y, n: UP, w, d, h, r });
const capOf = (s: Omit<Slab, "decals">): Plane => ({ o: add(s.o, mul(s.n, s.h)), u: s.u, v: s.v, n: s.n });
const frontOf = (s: Omit<Slab, "decals">): Plane => ({ o: add(add(s.o, mul(s.v, -s.d / 2)), mul(s.n, s.h / 2)), u: s.u, v: s.n, n: neg(s.v) });
const rightOf = (s: Omit<Slab, "decals">): Plane => ({ o: add(add(s.o, mul(s.u, s.w / 2)), mul(s.n, s.h / 2)), u: s.v, v: s.n, n: s.u });

function footprint(w: number, d: number, r: number, steps: number): P2[] {
  const radius = Math.min(r, w / 2, d / 2);
  if (radius <= 0.01) return [[w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2]];
  const points: P2[] = [];
  const corners: ReadonlyArray<readonly [number, number, number]> = [[1, -1, -90], [1, 1, 0], [-1, 1, 90], [-1, -1, 180]];
  for (const [sx, sy, start] of corners) {
    for (let step = 0; step <= steps; step += 1) {
      const angle = ((start + (90 * step) / steps) * Math.PI) / 180;
      points.push([sx * (w / 2 - radius) + radius * Math.cos(angle), sy * (d / 2 - radius) + radius * Math.sin(angle)]);
    }
  }
  return points;
}

const shapePoints = (shape: Shape): P2[] => {
  switch (shape.kind) {
    case "rrect":
      return footprint(shape.w, shape.h, shape.r, 4).map(([x, y]) => [x + shape.x, y + shape.y] as const);
    case "circle":
      return Array.from({ length: 20 }, (_, index) => {
        const angle = (index / 20) * Math.PI * 2;
        return [shape.x + shape.r * Math.cos(angle), shape.y + shape.r * Math.sin(angle)] as const;
      });
    case "line":
      return [[shape.x1, shape.y1], [shape.x2, shape.y2]];
  }
};

// --- camera -----------------------------------------------------------------

interface Camera {
  readonly project: (point: V3) => P2;
  readonly depth: (point: V3) => number;
  readonly faces: (normal: V3) => boolean;
  readonly tone: (normal: V3) => "top" | "front" | "side";
}

const REST_YAW = 34;
const ELEVATION = 27;

function camera(turn: number, scale: number, tx: number, ty: number): Camera {
  const yaw = ((REST_YAW + turn) * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ce = Math.cos((ELEVATION * Math.PI) / 180);
  const se = Math.sin((ELEVATION * Math.PI) / 180);
  const view: V3 = [-s * ce, c * ce, -se];
  return {
    project: ([x, y, z]) => [tx + scale * (x * c + y * s), ty + scale * (-z * ce - (-x * s + y * c) * se)],
    depth: (point) => dot(point, view),
    faces: (normal) => dot(normal, view) < -1e-6,
    // The light is fixed to the page, upper left, so a turned machine is lit
    // the same way as every other print on the sheet.
    tone: (normal) => {
      if (normal[2] > 0.6) return "top";
      const nx = normal[0] * c + normal[1] * s;
      const ny = -normal[0] * s + normal[1] * c;
      return -0.75 * nx - 0.66 * ny + 0.2 * normal[2] > 0.3 ? "front" : "side";
    },
  };
}

// --- drawing ----------------------------------------------------------------

const f = (value: number): string => (Math.round(value * 10) / 10).toString();
const poly = (points: ReadonlyArray<P2>, close = true): string =>
  `${points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${f(x)} ${f(y)}`).join("")}${close ? "Z" : ""}`;

function hull(points: ReadonlyArray<P2>): P2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (input: ReadonlyArray<P2>): P2[] => {
    const out: P2[] = [];
    for (const point of input) {
      while (out.length >= 2 && cross(out[out.length - 2] as P2, out[out.length - 1] as P2, point) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

interface Stroke {
  readonly outline: number;
  readonly offset: number;
  readonly steps: number;
}

const strokeFor = (detail: MachineDetail): Stroke =>
  detail === "glyph" ? { outline: 4.2, offset: 0, steps: 3 } : detail === "card" ? { outline: 3, offset: 1.4, steps: 5 } : { outline: 2.4, offset: 1.6, steps: 7 };

const RANK = { glyph: 0, card: 1, rich: 2 } as const;

interface Drawn {
  readonly fills: string;
  readonly inks: string;
  readonly outline: string;
  readonly edge: string;
  readonly depth: number;
  readonly points: ReadonlyArray<P2>;
}

function drawSlab(slab: Slab, cam: Camera, pal: Palette, stroke: Stroke, detail: MachineDetail): Drawn {
  const at = (x: number, y: number, z: number): V3 => add(add(add(slab.o, mul(slab.u, x)), mul(slab.v, y)), mul(slab.n, z));
  const base = footprint(slab.w, slab.d, slab.r, stroke.steps);
  const count = base.length;
  const low = base.map(([x, y]) => cam.project(at(x, y, 0)));
  const high = base.map(([x, y]) => cam.project(at(x, y, slab.h)));
  const thin = stroke.outline * 0.5;
  let fills = "";
  let inks = "";

  // Side faces, merged into runs of one tone so no seam shows inside a curve.
  const sides = base.map((point, index) => {
    const next = base[(index + 1) % count] as P2;
    const dx = next[0] - point[0];
    const dy = next[1] - point[1];
    const length = Math.hypot(dx, dy) || 1;
    const normal = add(mul(slab.u, dy / length), mul(slab.v, -dx / length));
    return cam.faces(normal) ? cam.tone(normal) : undefined;
  });
  const start = sides.findIndex((side, index) => side !== sides[(index - 1 + count) % count]);
  if (start >= 0) {
    let index = 0;
    while (index < count) {
      const from = (start + index) % count;
      const side = sides[from];
      let length = 1;
      while (index + length < count && sides[(start + index + length) % count] === side) length += 1;
      if (side !== undefined) {
        const ring = Array.from({ length: length + 1 }, (_, step) => (from + step) % count);
        fills += `<path d="${poly([...ring.map((i) => high[i] as P2), ...ring.reverse().map((i) => low[i] as P2)])}" fill="${pal[side]}"/>`;
        // A hard corner between two visible faces is an edge worth a line.
        const after = sides[(from + length) % count];
        if (slab.r < 1.2 && after !== undefined && after !== side) {
          const corner = (from + length) % count;
          inks += `<path d="${poly([high[corner] as P2, low[corner] as P2], false)}" stroke="${pal.ink}" stroke-width="${f(thin)}" stroke-linecap="round" fill="none"/>`;
        }
      }
      index += length;
    }
  } else if (sides[0] !== undefined) {
    fills += `<path d="${poly(hull([...low, ...high]))}" fill="${pal[sides[0]]}"/>`;
  }

  // Caps.
  for (const [points, normal] of [[high, slab.n], [low, neg(slab.n)]] as const) {
    if (!cam.faces(normal)) continue;
    fills += `<path d="${poly(points)}" fill="${pal[cam.tone(normal)]}"/>`;
    inks += `<path d="${poly(points)}" stroke="${pal.ink}" stroke-width="${f(thin)}" stroke-linejoin="round" fill="none"/>`;
  }

  for (const decal of slab.decals ?? []) {
    if (decal.minDetail && RANK[decal.minDetail] > RANK[detail]) continue;
    if (!cam.faces(decal.on.n)) continue;
    const points = shapePoints(decal.shape).map(([x, y]) => cam.project(add(add(decal.on.o, mul(decal.on.u, x)), mul(decal.on.v, y))));
    const closed = decal.shape.kind !== "line";
    const opacity = decal.opacity !== undefined ? ` opacity="${decal.opacity}"` : "";
    if (decal.fill && closed) fills += `<path d="${poly(points)}" fill="${pal[decal.fill]}"${opacity}/>`;
    if (decal.line) {
      inks += `<path d="${poly(points, closed)}" stroke="${pal[decal.lineRole ?? "ink"]}" stroke-width="${f(stroke.outline * decal.line)}" stroke-linecap="round" stroke-linejoin="round" fill="none"${opacity}/>`;
    }
  }

  const silhouette = hull([...low, ...high]);
  return {
    fills,
    inks,
    outline: `<path d="${poly(silhouette)}" fill="none" stroke="${pal.ink}" stroke-width="${f(stroke.outline)}" stroke-linejoin="round"/>`,
    edge: poly(silhouette),
    depth: cam.depth(at(0, 0, slab.h / 2)),
    points: silhouette,
  };
}

// --- forms ------------------------------------------------------------------

interface Form {
  readonly slabs: ReadonlyArray<Slab>;
  /** Where seats perch: a line across the roof, end to end. */
  readonly perch: readonly [V3, V3];
  /** Where this machine's pennant stands. */
  readonly mast: V3;
}

interface FormInput {
  readonly lit: boolean;
  readonly led: Role;
  readonly mark: MachineGenome["mark"];
}

const led = (on: Plane, x: number, y: number, r: number, role: Role): Decal => ({ on, shape: { kind: "circle", x, y, r }, fill: role, line: 0.4 });

function markOn(on: Plane, mark: MachineGenome["mark"], x: number, y: number, size: number): Decal[] {
  switch (mark) {
    case "dot":
      return [{ on, shape: { kind: "circle", x, y, r: size }, fill: "accent", line: 0.4, minDetail: "card" }];
    case "ring":
      return [{ on, shape: { kind: "circle", x, y, r: size * 1.15 }, line: 0.7, lineRole: "accent", minDetail: "card" }];
    case "stripe":
      return [{ on, shape: { kind: "rrect", x, y, w: size * 3.2, h: size * 0.9, r: size * 0.45 }, fill: "accent", line: 0.4, minDetail: "card" }];
  }
}

function macbook({ lit, mark }: FormInput): Form {
  const w = 31;
  const d = 21.5;
  const base = box([0, 0, 0], w, d, 1.5, 2.6);
  const lean = (18 * Math.PI) / 180;
  const up: V3 = [0, Math.sin(lean), Math.cos(lean)];
  const facing: V3 = [0, -Math.cos(lean), Math.sin(lean)];
  const hinge: V3 = [0, d / 2 - 1, 1.5];
  const lid = { o: add(hinge, mul(up, d / 2)), u: X, v: up, n: facing, w, d, h: 0.9, r: 2.6 };
  const screen = capOf(lid);
  const deck = capOf(base);
  return {
    slabs: [
      {
        ...base,
        decals: [
          { on: deck, shape: { kind: "rrect", x: 0, y: 3, w: 25, h: 9, r: 1.2 }, fill: "side", line: 0.4, minDetail: "card" },
          { on: deck, shape: { kind: "rrect", x: 0, y: -6.4, w: 10.5, h: 5.6, r: 1 }, line: 0.4, minDetail: "rich" },
          ...markOn(deck, mark, 11.5, -6.6, 1.5),
        ],
      },
      {
        ...lid,
        decals: [
          { on: screen, shape: { kind: "rrect", x: 0, y: 0.2, w: w - 2.6, h: d - 2.8, r: 1.6 }, fill: lit ? "glassLit" : "glass", line: 0.4 },
          { on: screen, shape: { kind: "rrect", x: 0, y: d / 2 - 1.9, w: 4.4, h: 1.1, r: 0.5 }, fill: "ink", minDetail: "rich" },
          ...(lit
            ? ([
                { on: screen, shape: { kind: "line", x1: -11, y1: 5.5, x2: -8.6, y2: 3.6 }, line: 0.6, lineRole: "accent", minDetail: "card" },
                { on: screen, shape: { kind: "line", x1: -8.6, y1: 3.6, x2: -11, y2: 1.7 }, line: 0.6, lineRole: "accent", minDetail: "card" },
                { on: screen, shape: { kind: "line", x1: -6.4, y1: 1.7, x2: -1.5, y2: 1.7 }, line: 0.6, lineRole: "shine", opacity: 0.75, minDetail: "card" },
                { on: screen, shape: { kind: "line", x1: -11, y1: -2.4, x2: 3, y2: -2.4 }, line: 0.45, lineRole: "shine", opacity: 0.4, minDetail: "rich" },
                { on: screen, shape: { kind: "line", x1: -11, y1: -5, x2: -2, y2: -5 }, line: 0.45, lineRole: "shine", opacity: 0.4, minDetail: "rich" },
              ] satisfies Decal[])
            : []),
        ],
      },
    ],
    perch: [add(screen.o, add(mul(X, -w / 2 + 9.5), mul(up, d / 2))), add(screen.o, add(mul(X, w / 2 - 4), mul(up, d / 2)))],
    mast: add(screen.o, add(mul(X, -w / 2 + 2.6), mul(up, d / 2))),
  };
}

function puck(height: number, { led: ledRole, mark }: FormInput): Form {
  const w = 19.7;
  const body = box([0, 0, 0], w, w, height, 5.2);
  const front = frontOf(body);
  const roof = capOf(body);
  const tall = height > 7;
  return {
    slabs: [
      {
        ...body,
        decals: [
          led(front, 6.2, tall ? -3.1 : -0.4, 0.62, ledRole),
          ...(tall
            ? ([
                { on: front, shape: { kind: "rrect", x: -4.4, y: -3.1, w: 2.2, h: 1, r: 0.5 }, fill: "ink", minDetail: "card" },
                { on: front, shape: { kind: "rrect", x: -1.2, y: -3.1, w: 2.2, h: 1, r: 0.5 }, fill: "ink", minDetail: "card" },
                { on: front, shape: { kind: "rrect", x: 2.4, y: -3.1, w: 3.2, h: 0.7, r: 0.35 }, fill: "ink", minDetail: "rich" },
              ] satisfies Decal[])
            : ([
                { on: front, shape: { kind: "rrect", x: -5.6, y: -0.4, w: 1.9, h: 0.9, r: 0.45 }, fill: "ink", minDetail: "rich" },
                { on: front, shape: { kind: "rrect", x: -2.9, y: -0.4, w: 1.9, h: 0.9, r: 0.45 }, fill: "ink", minDetail: "rich" },
              ] satisfies Decal[])),
          ...markOn(roof, mark, 0, -4.6, 2),
        ],
      },
    ],
    perch: [add(roof.o, [-w / 2 + 4.2, 2.6, 0]), add(roof.o, [w / 2 - 4.2, 2.6, 0])],
    mast: add(roof.o, [-w / 2 + 3.4, w / 2 - 3.4, 0]),
  };
}

function tower({ led: ledRole, mark }: FormInput): Form {
  const body = box([0, 0, 0], 11, 21, 23, 1);
  const front = frontOf(body);
  const side = rightOf(body);
  const roof = capOf(body);
  const slats = [-9.2, -7.4, -5.6, -3.8].map(
    (y): Decal => ({ on: front, shape: { kind: "line", x1: -3.2, y1: y, x2: 3.2, y2: y }, line: 0.45, minDetail: "card" }),
  );
  return {
    slabs: [
      {
        ...body,
        decals: [
          { on: front, shape: { kind: "circle", x: -2, y: 8.2, r: 1.5 }, fill: "accent", line: 0.4 },
          led(front, 2.6, 8.2, 0.7, ledRole),
          { on: front, shape: { kind: "rrect", x: 0, y: 3.6, w: 7.4, h: 1.5, r: 0.5 }, fill: "side", line: 0.4, minDetail: "card" },
          { on: front, shape: { kind: "rrect", x: 0, y: 0.8, w: 7.4, h: 1.5, r: 0.5 }, fill: "side", line: 0.4, minDetail: "rich" },
          ...slats,
          { on: side, shape: { kind: "rrect", x: 0, y: 1, w: 14, h: 15, r: 1.6 }, line: 0.4, minDetail: "rich" },
          ...markOn(side, mark, 0, 1, 2.2),
        ],
      },
    ],
    perch: [add(roof.o, [0, -7, 0]), add(roof.o, [0, 7, 0])],
    mast: add(roof.o, [-3, 8, 0]),
  };
}

function rack({ led: ledRole, mark }: FormInput): Form {
  const w = 30;
  const d = 20;
  const unit = 4.6;
  const slabs = [0, 1, 2].map((level): Slab => {
    const body = box([0, 0, level * unit], w, d, unit, 0.7);
    const front = frontOf(body);
    return {
      ...body,
      decals: [
        led(front, -12, 0.2, 0.7, ledRole),
        { on: front, shape: { kind: "circle", x: -9.6, y: 0.2, r: 0.55 }, fill: "ledOff", line: 0.35, minDetail: "rich" },
        ...[-5, -2.6, -0.2, 2.2, 4.6].map(
          (x): Decal => ({ on: front, shape: { kind: "line", x1: x, y1: -1.1, x2: x, y2: 1.3 }, line: 0.45, minDetail: "card" }),
        ),
        { on: front, shape: { kind: "rrect", x: 10.8, y: 0.1, w: 4.6, h: 2, r: 0.7 }, fill: "side", line: 0.4, minDetail: "card" },
        ...(level === 2 ? markOn(capOf(body), mark, 9, -5, 1.6) : []),
      ],
    };
  });
  const roof: V3 = [0, 0, unit * 3];
  return {
    slabs,
    perch: [add(roof, [-w / 2 + 4, 1.5, 0]), add(roof, [w / 2 - 4, 1.5, 0])],
    mast: add(roof, [-w / 2 + 2.6, d / 2 - 2.6, 0]),
  };
}

const formFor = (form: MachineForm, input: FormInput): Form => {
  switch (form) {
    case "macbook":
      return macbook(input);
    case "mac-mini":
      return puck(5.6, input);
    case "mac-studio":
      return puck(10.2, input);
    case "linux-box":
      return tower(input);
    case "server":
      return rack(input);
  }
};

// --- marks in the page plane ------------------------------------------------

/** A seat on the roof: Pip at the size of a full stop. */
function pip(x: number, y: number, r: number, pal: Palette, stroke: Stroke, detail: MachineDetail, loose: string): string {
  const cy = y - r + 0.6;
  const nudge = stroke.offset > 0 ? ` transform="translate(${f(stroke.offset * 0.6)} ${f(stroke.offset * 0.42)})"` : "";
  const line = f(stroke.outline * 0.62);
  const eyes =
    detail === "rich"
      ? `<circle cx="${f(x - r * 0.36)}" cy="${f(cy - r * 0.05)}" r="${f(r * 0.13)}" fill="${pal.ink}"/><circle cx="${f(x + r * 0.36)}" cy="${f(cy - r * 0.05)}" r="${f(r * 0.13)}" fill="${pal.ink}"/>`
      : "";
  return [
    `<path d="M${f(x)} ${f(cy - r)}q${f(r * 0.1)} ${f(-r * 0.5)} ${f(r * 0.45)} ${f(-r * 0.75)}" stroke="${loose}" stroke-width="${line}" stroke-linecap="round" fill="none"/>`,
    `<ellipse cx="${f(x + r * 0.72)}" cy="${f(cy - r * 1.78)}" rx="${f(r * 0.5)}" ry="${f(r * 0.3)}" transform="rotate(-28 ${f(x + r * 0.72)} ${f(cy - r * 1.78)})" fill="${pal.leaf}" stroke="${pal.ink}" stroke-width="${f(stroke.outline * 0.45)}"/>`,
    `<circle cx="${f(x)}" cy="${f(cy)}" r="${f(r)}" fill="${pal.pip}"${nudge}/>`,
    `<circle cx="${f(x)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${pal.ink}" stroke-width="${line}"/>`,
    eyes,
  ].join("");
}

type BadgeKind = "update" | "harness" | "secret" | "incoming";

const BADGE_ICON: Record<BadgeKind, string> = {
  update: "M0 3.2V-3M-2.7 -0.4L0 -3.2L2.7 -0.4",
  incoming: "M0 -3.2V3M-2.7 0.4L0 3.2L2.7 0.4",
  harness: "M-3.2 -2.2L-0.6 0L-3.2 2.2M0.6 2.4H3.4",
  secret: "M-0.2 0H3.6M2.6 0V1.9M-3.6 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0 -3.4 0",
};

function badge(kind: BadgeKind, x: number, y: number, r: number, pal: Palette, stroke: Stroke): string {
  const fill = kind === "incoming" ? pal.top : pal.badge;
  const k = r / 6.2;
  return [
    `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${fill}" stroke="${pal.ink}" stroke-width="${f(stroke.outline * 0.75)}"/>`,
    `<path d="${BADGE_ICON[kind]}" transform="translate(${f(x)} ${f(y)}) scale(${f(k)})" stroke="${pal.ink}" stroke-width="${f((stroke.outline * 0.62) / k)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  ].join("");
}

const GRAIN = `<filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.1 0.62"/><feComposite in2="SourceGraphic" operator="in"/></filter>`;

// --- the figure -------------------------------------------------------------

const FLOOR = 82;

/** Build the figure's SVG document. Pure; callers cache by `machineFigureKey`. */
export function machineFigureSvg(request: MachineFigureRequest): string {
  const { name, form, state, mode, detail, isThisMachine } = request;
  const frame = request.frame ?? "bare";
  const genome = machineGenome(name, request.hue);
  const stroke = strokeFor(detail);
  const blank = state.setUp === false;
  const asleep = state.reach === "unreachable" && !blank;
  const installing = state.install === "sending" || state.install === "updating";
  const lit = state.reach === "reachable" && !installing && !blank;
  const live = paletteFor(genome, mode, false);
  const drained = paletteFor(genome, mode, true);
  const pal = asleep || blank ? drained : live;
  const input: FormInput = { lit, led: state.reach === "reachable" && !blank ? "ledOn" : "ledOff", mark: genome.mark };
  const shape = formFor(form, input);

  // Fit the resting pose once, so a turn or a state never moves the figure.
  const rest = camera(0, 1, 0, 0);
  const restPoints = shape.slabs.flatMap((slab) => drawSlab(slab, rest, live, stroke, detail).points);
  const xs = restPoints.map((point) => point[0]);
  const ys = restPoints.map((point) => point[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const room = detail === "glyph" ? { w: 88, h: 78 } : { w: 66, h: 54 };
  const scale = Math.min(room.w / (maxX - minX), room.h / (maxY - minY));
  const floor = detail === "glyph" ? 92 : FLOOR;
  const tx = 50 - ((minX + maxX) / 2) * scale - (detail === "glyph" ? 0 : 7);
  const ty = floor - maxY * scale;
  const cam = camera(request.turn ?? 0, scale, tx, ty);

  const body = (palette: Palette): ReadonlyArray<Drawn> =>
    shape.slabs.map((slab) => drawSlab(slab, cam, palette, stroke, detail)).sort((a, b) => b.depth - a.depth);
  const nudge = stroke.offset > 0 ? ` transform="translate(${stroke.offset} ${f(stroke.offset * 0.7)})"` : "";
  const paint = (drawn: ReadonlyArray<Drawn>): string => drawn.map((part) => `<g${nudge}>${part.fills}</g>${part.inks}${part.outline}`).join("");

  // Being sent or updated: the print fills from the floor up, one band per
  // installer transition. Five still frames, never a loop.
  const drawnLive = body(pal);
  const all = drawnLive.flatMap((part) => part.points);
  const top = Math.min(...all.map((point) => point[1])) - stroke.outline;
  const bottom = Math.max(...all.map((point) => point[1])) + stroke.outline;
  const filled = clamp((state.step ?? 0) / 5, 0.1, 1);
  const level = bottom - (bottom - top) * filled;
  const solids = installing
    ? `${paint(body(drained))}<g clip-path="url(#p)">${paint(drawnLive)}</g>${
        filled < 1 && detail !== "glyph"
          ? `<path d="M${f(Math.min(...all.map((p) => p[0])) - 5)} ${f(level)}H${f(Math.max(...all.map((p) => p[0])) + 5)}" stroke="${pal.badge}" stroke-width="${f(stroke.outline * 0.5)}" stroke-linecap="round" stroke-dasharray="0.1 ${f(stroke.outline * 1.1)}"/>`
          : ""
      }`
    : paint(drawnLive);

  // The floor shadow: the footprint, printed once more in the tile's shade.
  const ground = shape.slabs[0] as Slab;
  const shadowPoints = footprint(ground.w + 2, ground.d + 2, ground.r + 1, stroke.steps).map(([x, y]) => {
    const [px, py] = cam.project(add(add(ground.o, mul(ground.u, x)), mul(ground.v, y)));
    return [px + 3.2, py + 2.2] as const;
  });
  const shadow = `<path d="${poly(shadowPoints)}" fill="${mode === "dark" ? "#000" : live.ink}" opacity="${mode === "dark" ? 0.34 : 0.13}"/>`;

  // Lines that leave the body stand on the page, where the dark edition's
  // ink is the ground itself; there they take the quiet text tone.
  const loose = frame === "bare" && mode === "dark" ? live.mute : live.ink;

  // Seats perch along the roof.
  const [from, to] = [cam.project(shape.perch[0]), cam.project(shape.perch[1])];
  const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const crew = detail === "rich" && request.crew && request.crew.length > 0 ? request.crew : undefined;
  const pipR = crew ? 8.5 : detail === "rich" ? 4.3 : 4.9;
  const fit = Math.max(1, Math.min(5, Math.floor(span / (pipR * (crew ? 1.05 : 2) + 1)) + 1));
  // More seats than the roof holds: the last place on the roof says how many more.
  const places = detail === "glyph" ? 0 : Math.min(state.seats, fit);
  const shown = state.seats > fit ? places - 1 : places;
  const [left, right] = from[0] <= to[0] ? [from, to] : [to, from];
  const spots = Array.from({ length: places }, (_, index) => {
    const t = places === 1 ? 0.5 : index / (places - 1);
    return [left[0] + (right[0] - left[0]) * t, left[1] + (right[1] - left[1]) * t] as const;
  });
  const perched = spots
    .slice(0, shown)
    .sort((a, b) => a[1] - b[1])
    .map(([x, y], index) => {
      const member = crew?.[index];
      if (!member) return pip(x, y, pipR, pal, stroke, detail, loose);
      // A real seat: its own portrait, feet on the roof. Ids are made unique
      // because several portraits share this one document.
      const inner = portraitSvg({ seed: member.seed, config: member.config, mode, detail: "card", frame: "bare" })
        .replace(/id="b"/g, `id="c${index}"`)
        .replace(/url\(#b\)/g, `url(#c${index})`)
        .replace("<svg ", `<svg x="${f(x - pipR * 1.25)}" y="${f(y - pipR * 2.5 + 1.6)}" width="${f(pipR * 2.5)}" height="${f(pipR * 2.5)}" `);
      return inner;
    })
    .join("");
  const rest_ = spots[shown];
  const more =
    rest_ && places > shown
      ? `<text x="${f(rest_[0])}" y="${f(rest_[1] - 1.5)}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="${f(crew ? 9 : pipR * 2)}" font-weight="700" fill="${live.ink}" stroke="${live.top}" stroke-width="2.2" stroke-linejoin="round" paint-order="stroke">+${state.seats - shown}</text>`
      : "";

  // This machine flies a pennant. A mark of place, not of rank.
  const mast = cam.project(shape.mast);
  const pennant =
    isThisMachine && detail !== "glyph"
      ? `<path d="M${f(mast[0])} ${f(mast[1])}v-13" stroke="${loose}" stroke-width="${f(stroke.outline * 0.62)}" stroke-linecap="round"/><path d="M${f(mast[0])} ${f(mast[1] - 13)}l8.4 2.6l-8.4 2.8Z" fill="${pal.badge}" stroke="${pal.ink}" stroke-width="${f(stroke.outline * 0.55)}" stroke-linejoin="round"/>`
      : "";

  // Out of reach reads as asleep, the way a resting seat does.
  const zzz = asleep
    ? [0, 1, 2]
        .slice(0, detail === "glyph" ? 2 : 3)
        .map((index) => {
          const size = (detail === "glyph" ? 9 : 5.2) - index * (detail === "glyph" ? 2.6 : 1.1);
          const x = (detail === "glyph" ? 62 : 77) + index * (detail === "glyph" ? 13 : 6.5);
          const y = (detail === "glyph" ? 34 : 24) - index * (detail === "glyph" ? 12 : 7);
          return `<path d="M${f(x)} ${f(y)}h${f(size)}l${f(-size)} ${f(size)}h${f(size)}" stroke="${loose}" stroke-width="${f(stroke.outline * (detail === "glyph" ? 0.8 : 0.62))}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
        })
        .join("")
    : "";

  // What needs the operator, as amber badges; work in progress, as a pale one.
  const kinds: BadgeKind[] = [
    ...(installing ? (["incoming"] as const) : []),
    ...(state.install === "needs-update" ? (["update"] as const) : []),
    ...(state.missingHarness ? (["harness"] as const) : []),
    ...(state.missingSecrets > 0 ? (["secret"] as const) : []),
  ];
  const badges =
    detail === "glyph"
      ? kinds.some((kind) => kind !== "incoming")
        ? `<circle cx="84" cy="80" r="11" fill="${live.badge}" stroke="${live.ink}" stroke-width="${f(stroke.outline * 0.8)}"/>`
        : ""
      : kinds.map((kind, index) => badge(kind, 90.5, 76 - index * 15.5, detail === "rich" ? 6.2 : 6.8, live, stroke)).join("");

  // On the dark ground the ink outline is the ground itself, so a bare figure
  // gets a quiet rim behind it, the cut edge of a sticker.
  const rim =
    frame === "bare" && mode === "dark"
      ? `<g opacity="0.5">${drawnLive.map((part) => `<path d="${part.edge}" fill="none" stroke="${live.mute}" stroke-width="${f(stroke.outline * (detail === "glyph" ? 1.5 : 1.7))}" stroke-linejoin="round"/>`).join("")}</g>`
      : "";

  const figure = `<g transform="rotate(${f(genome.tilt)} 50 ${FLOOR})">${shadow}${rim}${solids}${perched}${more}${pennant}</g>${zzz}${badges}`;
  const defs = `${installing ? `<clipPath id="p"><rect x="-20" y="${f(level)}" width="140" height="${f(140 - level)}"/></clipPath>` : ""}${frame === "tile" ? `<clipPath id="t"><rect width="100" height="100" rx="24"/></clipPath>` : ""}${detail === "rich" && frame === "tile" ? GRAIN : ""}`;
  if (frame === "bare") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs ? `<defs>${defs}</defs>` : ""}${figure}</svg>`;
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`,
    `<defs>${defs}</defs>`,
    `<g clip-path="url(#t)">`,
    `<rect width="100" height="100" fill="${pal.tile}"/>`,
    `<circle cx="46" cy="46" r="37" fill="${pal.halo}"/>`,
    figure,
    detail === "rich" ? `<rect width="100" height="100" fill="${live.ink}" filter="url(#g)" opacity="0.16"/>` : "",
    `</g></svg>`,
  ].join("");
}

export const machineFigureKey = (request: MachineFigureRequest): string =>
  [
    request.name,
    request.form,
    request.isThisMachine ? 1 : 0,
    request.mode,
    request.detail,
    request.frame ?? "bare",
    request.turn ?? 0,
    request.hue ?? "",
    request.state.reach,
    request.state.install,
    request.state.step ?? 0,
    request.state.missingHarness ? 1 : 0,
    Math.min(request.state.missingSecrets, 1),
    request.state.seats,
    request.state.setUp === false ? 0 : 1,
    (request.crew ?? []).map((member) => `${member.seed}:${JSON.stringify(member.config ?? {})}`).join(","),
  ].join("|");

export const machineFigureDataUri = (request: MachineFigureRequest): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(machineFigureSvg(request))}`;
