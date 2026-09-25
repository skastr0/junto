// Brand video scene: a pure function of time painted on one 1920x1080 canvas.
// The critters are the app's own portraits (agent-portrait.ts), their faces
// the app's own expressions (portrait-expression.ts), and their rings the
// app's own canvas painters (activity-rings.ts). Nothing here redraws a
// character or a ring by hand. Bundled for the browser by render.ts.
import { portraitDataUri, type PortraitConfig, type PortraitFace } from "../../src/shared/agent-portrait";
import { portraitFaceFor, type ExpressionInput } from "../../src/shared/portrait-expression";
import { FONT_DISPLAY, FONT_MONO, themeRuntime } from "../../src/shared/theme";
import {
  LAND_FRAMES,
  RING_HOLE_R,
  RING_R,
  paintDone,
  paintFlag,
  paintGlow,
  paintHalo,
  paintLoop,
  paintStill,
  type LoopRing,
  type RingPalette,
  type StillRing,
} from "../../src/renderer/lib/activity-rings";
import { VIDEO_MASCOT } from "./mascot";
import {
  alpha,
  bowPoint,
  bump,
  clamp01,
  dropOut,
  easeInOut,
  easeOut,
  hash01,
  lerp,
  mix,
  mod,
  ramp,
  springOut,
  window01,
  type Point,
} from "./motion";

export const W = 1920;
export const H = 1080;

const T = themeRuntime("bright");
const tok = (name: string): string => T[name] ?? "#000000";
const INK = tok("ink");
const DIM = tok("dim");
const FAINT = tok("faint");
const GROUND = tok("ground");
const RAISE = tok("raise");
const TONE = {
  amber: tok("amber"),
  amberHi: tok("amber-hi"),
  cyan: tok("cyan"),
  green: tok("green"),
  crimson: tok("crimson"),
  steel: tok("steel"),
  violet: tok("violet"),
  indigo: tok("indigo"),
  orange: tok("orange"),
} as const;
const TONE_FG = {
  amber: tok("amber-fg"),
  cyan: tok("cyan-fg"),
  crimson: tok("crimson-fg"),
  green: tok("green"),
  steel: tok("steel"),
  dim: tok("dim"),
} as const;
// Daylight: the app's rings carry no bloom in the bright theme.
const PALETTE: RingPalette = { glow: 0, dark: false };

const mono = (px: number, weight = 500): string => `${String(weight)} ${String(px)}px ${FONT_MONO}`;
const display = (px: number, weight = 600): string => `${String(weight)} ${String(px)}px ${FONT_DISPLAY}`;

// --- states -------------------------------------------------------------------

type StateName =
  | "asleep"
  | "idle"
  | "working"
  | "going-well"
  | "exceeding"
  | "stuck"
  | "thrashing"
  | "waiting"
  | "blocked"
  | "done";

type Ring =
  | { readonly kind: "loop"; readonly ring: LoopRing; readonly color: string }
  | { readonly kind: "still"; readonly ring: StillRing; readonly color: string }
  | { readonly kind: "done" };

type StateSpec = {
  readonly ring: Ring;
  readonly halo?: "good" | "exceeding";
  readonly glow?: string;
  readonly flag?: boolean;
  readonly expr: Omit<ExpressionInput, "temperament">;
  readonly label: string;
  readonly fg: string;
};

// The mapping the app's ringCells() applies: work is cyan, trouble bends the
// ring amber (stuck runs backwards, thrashing snakes), a call glows amber, a
// declared blocker halts crimson with its flag, done seals green.
const STATES: Readonly<Record<StateName, StateSpec>> = {
  asleep: { ring: { kind: "still", ring: "off", color: TONE.steel }, expr: { activity: "off" }, label: "resting", fg: TONE_FG.dim },
  idle: { ring: { kind: "still", ring: "rest", color: TONE.steel }, expr: { activity: "rest" }, label: "idle", fg: TONE_FG.dim },
  working: { ring: { kind: "loop", ring: "work", color: TONE.cyan }, expr: { activity: "work" }, label: "working", fg: TONE_FG.cyan },
  "going-well": {
    ring: { kind: "loop", ring: "work", color: TONE.cyan },
    halo: "good",
    expr: { activity: "work", health: "going_well" },
    label: "going well",
    fg: TONE_FG.green,
  },
  exceeding: {
    ring: { kind: "loop", ring: "work", color: TONE.cyan },
    halo: "exceeding",
    expr: { activity: "work", health: "exceeding" },
    label: "exceeding",
    fg: TONE_FG.green,
  },
  stuck: { ring: { kind: "loop", ring: "reverse", color: TONE.amber }, expr: { activity: "work", health: "stuck" }, label: "stuck", fg: TONE_FG.amber },
  thrashing: {
    ring: { kind: "loop", ring: "snake", color: TONE.amber },
    expr: { activity: "work", health: "thrashing" },
    label: "thrashing",
    fg: TONE_FG.amber,
  },
  waiting: {
    ring: { kind: "loop", ring: "call", color: TONE.amber },
    glow: TONE.amber,
    expr: { activity: "call" },
    label: "waiting on you",
    fg: TONE_FG.amber,
  },
  blocked: {
    ring: { kind: "loop", ring: "halt", color: TONE.crimson },
    glow: TONE.crimson,
    flag: true,
    expr: { activity: "halt", signal: "blocked" },
    label: "blocked",
    fg: TONE_FG.crimson,
  },
  done: { ring: { kind: "done" }, expr: { activity: "done" }, label: "done", fg: TONE_FG.green },
};
const STATE_NAMES = Object.keys(STATES) as StateName[];

/** Frames per loop in the attention clock: every loop repeats cleanly. */
const LOOP_FRAMES: Readonly<Record<LoopRing, number>> = { work: 16, reverse: 32, snake: 32, call: 32, halt: 32 };

// --- cast -----------------------------------------------------------------------

type Critter = {
  readonly seed: string;
  readonly name: string;
  readonly temperament: number;
  readonly config?: PortraitConfig;
  readonly phase: number;
};

const CAST: ReadonlyArray<Critter> = [
  { seed: "herald", name: "scout", temperament: 0.7, phase: 0.1 },
  { seed: "planner", name: "planner", temperament: 0.4, phase: 0.55 },
  { seed: "reviewer", name: "reviewer", temperament: -0.2, phase: 0.3 },
  { seed: "librarian", name: "research", temperament: 0.9, phase: 0.8 },
  { seed: "keeper", name: "builder", temperament: 0.1, phase: 0.2 },
  { seed: "atlas", name: "docs", temperament: 0.6, phase: 0.65 },
  { seed: "sorter", name: "tests", temperament: -0.5, phase: 0.45 },
];

// --- options --------------------------------------------------------------------

export type Beats = {
  /** Provenance-coloured preamble bubbles (PreambleBubble.tsx committed). */
  readonly preambles: boolean;
  /** A squad dropping into a region (squad UI committed). */
  readonly squads: boolean;
};

export type SceneOptions = {
  readonly cut: "full" | "loop";
  readonly beats: Beats;
};

let opts: SceneOptions = { cut: "full", beats: { preambles: false, squads: false } };
/** Attention clock tick. The loop cut slows it so every ring divides 8 s. */
let frameMs = 90;
const LOOP_SECONDS = 8;

// --- portrait bitmaps -------------------------------------------------------------

const RASTER = 360;
const bitmaps = new Map<string, HTMLCanvasElement>();

const faceKey = (seed: string, face: PortraitFace | undefined, blink: boolean): string =>
  `${seed}|${JSON.stringify(face ?? null)}|${blink ? "b" : ""}`;

const blinkFace = (face: PortraitFace): PortraitFace => ({ ...face, eyes: "line" });

const faceFor = (c: Critter, state: StateName): PortraitFace =>
  portraitFaceFor({ temperament: c.temperament, ...STATES[state].expr });

const rasterize = async (seed: string, config: PortraitConfig | undefined, face: PortraitFace, blink: boolean): Promise<void> => {
  const key = faceKey(seed, face, blink);
  if (bitmaps.has(key)) return;
  const img = new Image();
  img.src = portraitDataUri({ seed, mode: "bright", detail: "rich", frame: "round", config, face: blink ? blinkFace(face) : face });
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = RASTER;
  canvas.height = RASTER;
  const c = canvas.getContext("2d");
  if (!c) throw new Error("no 2d context");
  c.imageSmoothingQuality = "high";
  c.drawImage(img, 0, 0, RASTER, RASTER);
  bitmaps.set(key, canvas);
};

const bitmap = (seed: string, face: PortraitFace, blink: boolean): HTMLCanvasElement | undefined =>
  bitmaps.get(faceKey(seed, face, blink)) ?? bitmaps.get(faceKey(seed, face, false));

// --- canvas ----------------------------------------------------------------------

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let ringLayer: HTMLCanvasElement;
let ringCtx: CanvasRenderingContext2D;
let grain: HTMLCanvasElement;

const setSpacing = (c: CanvasRenderingContext2D, value: string): void => {
  (c as unknown as { letterSpacing: string }).letterSpacing = value;
};

// --- rings -------------------------------------------------------------------------

/**
 * Paint a state's ring into the scratch layer (the painters punch holes for
 * the flag and the halo spark, so they never draw straight onto the stage),
 * then composite it at (x, y) with box edge `size`.
 */
const drawRing = (state: StateName, elapsed: number, x: number, y: number, size: number, a: number): void => {
  const spec = STATES[state];
  const px = Math.ceil(size * 1.3);
  const scale = size / 20;
  // Clear the whole layer: a larger ring drawn earlier would otherwise bleed
  // into the copy's edge when it is resampled.
  ringCtx.setTransform(1, 0, 0, 1, 0, 0);
  ringCtx.clearRect(0, 0, ringLayer.width, ringLayer.height);
  const off = (px - size) / 2;
  ringCtx.setTransform(scale, 0, 0, scale, off, off);
  const frame = (elapsed * 1000) / frameMs;
  if (spec.glow) paintGlow(ringCtx, PALETTE, spec.glow, clamp01(elapsed / 0.4));
  if (spec.ring.kind === "done") {
    paintDone(ringCtx, PALETTE, TONE.green, Math.min(LAND_FRAMES, Math.max(0, frame)));
    // The seal lets one dot of light out from where the sweep closed.
    const seal = (elapsed * 1000 - LAND_FRAMES * 90 * 0.6) / 700;
    if (seal > 0 && seal < 1) {
      ringCtx.save();
      ringCtx.fillStyle = TONE.green;
      ringCtx.strokeStyle = TONE.green;
      ringCtx.globalAlpha = (1 - seal) ** 1.5;
      ringCtx.beginPath();
      ringCtx.arc(10, 10 - RING_R - seal * 1.2, 0.9 + seal * 1.6, 0, Math.PI * 2);
      ringCtx.fill();
      ringCtx.globalAlpha = 0.5 * (1 - seal);
      ringCtx.lineWidth = 0.35;
      ringCtx.beginPath();
      ringCtx.arc(10, 10, RING_R + 0.6 + seal * 2.4, 0, Math.PI * 2);
      ringCtx.stroke();
      ringCtx.restore();
    }
  } else if (spec.ring.kind === "loop") {
    paintLoop(ringCtx, PALETTE, spec.ring.ring, spec.ring.color, mod(frame, LOOP_FRAMES[spec.ring.ring]));
  } else {
    paintStill(ringCtx, PALETTE, spec.ring.ring, spec.ring.color);
  }
  if (spec.halo) paintHalo(ringCtx, PALETTE, spec.halo, TONE.green, clamp01(elapsed / 0.4));
  if (spec.flag) paintFlag(ringCtx, PALETTE, TONE.crimson, true);
  ringCtx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.drawImage(ringLayer, 0, 0, px, px, x - px / 2, y - px / 2, px, px);
  ctx.restore();
};

// --- poses ---------------------------------------------------------------------------

type Label = "none" | "below" | "right";

type Pose = {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly alpha: number;
  readonly state: StateName;
  /** Absolute time the state began. */
  readonly since: number;
  readonly label: Label;
  readonly labelAlpha?: number;
  /** Extra bounce, 0..1 (mail arriving). */
  readonly kick?: number;
  /** False: the scene owns the handoff from the previous pose. */
  readonly blend?: boolean;
};

type SceneFn = {
  readonly id: string;
  readonly dur: number;
  readonly caption?: string;
  readonly pose: (m: number, local: number, start: number, prev: Pose | null) => Pose;
  readonly under?: (local: number, start: number, fade: number) => void;
  readonly over?: (local: number, start: number, fade: number) => void;
};

const TRANS = 0.9;

// --- scene helpers ---------------------------------------------------------------------

const seatPos = (p: Pose): Point => ({ x: p.x, y: p.y });

const strokeBow = (a: Point, b: Point, bow: number, from: number, to: number, steps = 48): void => {
  ctx.beginPath();
  for (let i = 0; i <= steps; i += 1) {
    const q = bowPoint(a, b, bow, lerp(from, to, i / steps));
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
};

/** A light travelling along a bowed wire: a fading trail and a soft head. */
const drawPulse = (a: Point, b: Point, bow: number, p: number, color: string, fade: number, trim = 0): void => {
  const head = lerp(trim, 1 - trim, clamp01(p));
  const tail = Math.max(trim, head - 0.24);
  ctx.save();
  ctx.lineCap = "round";
  const segs = 10;
  for (let s = 0; s < segs; s += 1) {
    const f0 = lerp(tail, head, s / segs);
    const f1 = lerp(tail, head, (s + 1) / segs);
    ctx.strokeStyle = alpha(color, 0.75 * fade * ((s + 1) / segs) ** 1.6);
    ctx.lineWidth = 2.5 + 4 * ((s + 1) / segs);
    strokeBow(a, b, bow, f0, f1, 4);
  }
  const q = bowPoint(a, b, bow, head);
  ctx.fillStyle = alpha(color, 0.16 * fade);
  ctx.beginPath();
  ctx.arc(q.x, q.y, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = alpha(color, 0.3 * fade);
  ctx.beginPath();
  ctx.arc(q.x, q.y, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = alpha(color, fade);
  ctx.beginPath();
  ctx.arc(q.x, q.y, 8.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};

const card = (x: number, y: number, w: number, h: number, r: number, a: number, fill = RAISE): void => {
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.shadowColor = "rgba(54,44,36,0.16)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = fill;
  roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = alpha(INK, 0.14);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
};

type Provenance = "agent" | "ai" | "system" | "operator";

const drawGlyph = (prov: Provenance, x: number, y: number, color: string): void => {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (prov === "agent") {
    roundRect(x - 7, y - 6, 14, 10, 2.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 3, y + 4);
    ctx.lineTo(x - 5, y + 8);
    ctx.lineTo(x + 1, y + 4);
    ctx.stroke();
  } else if (prov === "ai") {
    ctx.beginPath();
    ctx.moveTo(x, y - 8);
    ctx.quadraticCurveTo(x + 1.5, y - 1.5, x + 8, y);
    ctx.quadraticCurveTo(x + 1.5, y + 1.5, x, y + 8);
    ctx.quadraticCurveTo(x - 1.5, y + 1.5, x - 8, y);
    ctx.quadraticCurveTo(x - 1.5, y - 1.5, x, y - 8);
    ctx.fill();
  } else if (prov === "system") {
    ctx.beginPath();
    ctx.arc(x, y, 2.4, 0, Math.PI * 2);
    ctx.fill();
    for (const r of [5.5, 8.5]) {
      ctx.beginPath();
      ctx.arc(x, y, r, -0.7, 0.7);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r, Math.PI - 0.7, Math.PI + 0.7);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.arc(x, y - 3, 3.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y + 9, 7, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.restore();
};

const WHO: Readonly<Record<Provenance, string | undefined>> = { agent: undefined, ai: "AI", system: "Junto", operator: "you" };

/**
 * A preamble bubble as PreambleBubble.tsx draws it: the action's hue tints
 * the card, provenance is the glyph, the word, and the border's line (agent
 * solid, AI dashed, Junto dotted and quieter, the operator a stronger rule).
 */
const drawPreamble = (anchor: Point, prov: Provenance, hue: string, text: string, appear: number): void => {
  if (appear <= 0.01) return;
  const word = WHO[prov];
  ctx.save();
  ctx.font = display(15, 600);
  setSpacing(ctx, "1.5px");
  const wordW = word ? ctx.measureText(word.toUpperCase()).width + 8 : 0;
  ctx.font = mono(18, 500);
  setSpacing(ctx, "0px");
  const textW = ctx.measureText(text).width;
  const w = 16 + 20 + 6 + wordW + textW + 14;
  const h = 38;
  const x = anchor.x - 26;
  const y = anchor.y - h - 12;
  const s = lerp(0.9, 1, easeOut(appear));
  ctx.translate(anchor.x - 14, anchor.y);
  ctx.scale(s, s);
  ctx.translate(-(anchor.x - 14), -anchor.y);
  ctx.globalAlpha *= clamp01(appear * 1.4);
  ctx.shadowColor = "rgba(54,44,36,0.16)";
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = mix(hue, GROUND, 0.9);
  roundRect(x, y, w, h, 12);
  ctx.fill();
  // Tail onto the ring.
  ctx.beginPath();
  ctx.moveTo(x + 20, y + h - 1);
  ctx.lineTo(x + 26, y + h + 9);
  ctx.lineTo(x + 34, y + h - 1);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = alpha(hue, prov === "system" ? 0.38 : prov === "operator" ? 0.85 : 0.55);
  ctx.lineWidth = prov === "operator" ? 2.6 : 1.6;
  ctx.setLineDash(prov === "ai" ? [7, 4] : prov === "system" ? [2, 4] : []);
  roundRect(x, y, w, h, 12);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = alpha(hue, 0.65);
  ctx.fillRect(x + 1, y + 8, 3, h - 16);
  drawGlyph(prov, x + 24, y + h / 2, hue);
  let cx = x + 40;
  if (word) {
    ctx.font = display(15, 600);
    setSpacing(ctx, "1.5px");
    ctx.fillStyle = hue;
    ctx.textBaseline = "middle";
    ctx.fillText(word.toUpperCase(), cx, y + h / 2 + 1);
    cx += wordW;
  }
  ctx.font = mono(18, 500);
  setSpacing(ctx, "0px");
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, y + h / 2 + 1);
  ctx.restore();
};

// --- scenes ------------------------------------------------------------------------------

const ROW_STATES: ReadonlyArray<StateName> = ["working", "going-well", "stuck", "thrashing", "waiting", "blocked", "done"];

const wake: SceneFn = {
  id: "wake",
  dur: 3.0,
  caption: "every agent gets a face",
  pose: (m, local, start) => {
    const appear = 0.15 + m * 0.13;
    const wakeAt = 1.25 + m * 0.11;
    const grow = springOut(ramp(local, appear, 0.75));
    const state: StateName = local < wakeAt ? "asleep" : local < wakeAt + 0.5 ? "idle" : "working";
    const since = start + (state === "asleep" ? appear : state === "idle" ? wakeAt : wakeAt + 0.5);
    return {
      x: W / 2 + (m - 3) * 252,
      y: 500 + (m - 3) ** 2 * 9,
      size: 224 * Math.max(0.02, grow),
      alpha: ramp(local, appear, 0.25),
      state,
      since,
      label: "none",
    };
  },
};

const states: SceneFn = {
  id: "states",
  dur: 6.2,
  caption: "a ring and a face for every state",
  pose: (m, local, start) => {
    const first = 0.9 + m * 0.24;
    const turn = 4.05 + m * 0.12;
    let state: StateName = "working";
    let since = start;
    if (local >= turn) {
      state = ROW_STATES[(m + 1) % ROW_STATES.length]!;
      since = start + turn;
    } else if (local >= first) {
      state = ROW_STATES[m]!;
      since = start + first;
    }
    return { x: W / 2 + (m - 3) * 262, y: 480, size: 236, alpha: 1, state, since, label: "below", labelAlpha: ramp(local, 0.6, 0.5) };
  },
};

const SELECTED = [0, 1, 2, 3, 4];
const multiSeat = (i: number): Point => ({ x: 1190 + (i - 2) ** 2 * 26, y: 515 + (i - 2) * 168 });
const SEND_AT = 2.25;
const arrival = (i: number): number => SEND_AT + 0.9 + i * 0.08;
const CARD = { x: 250, y: 430, w: 610, h: 230 } as const;

const multi: SceneFn = {
  id: "multi-prompt",
  dur: 4.3,
  caption: "one prompt, many agents",
  pose: (m, local, start) => {
    const i = SELECTED.indexOf(m);
    if (i < 0) return { x: 2200, y: 280 + (m - 5) * 520, size: 150, alpha: 0, state: "working", since: start, label: "none" };
    const at = arrival(i);
    const p = multiSeat(i);
    const state: StateName = local < at ? "idle" : "working";
    return { ...p, size: 150, alpha: 1, state, since: start + (local < at ? 0 : at), label: "right" };
  },
  under: (local, _start, fade) => {
    // The rubber band that made the selection.
    const a = fade * Math.min(ramp(local, 0.85, 0.35), 1 - ramp(local, 3.4, 0.6));
    if (a <= 0.01) return;
    const top = multiSeat(0).y - 104;
    const bottom = multiSeat(4).y + 100;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = alpha(TONE.cyan, 0.05);
    ctx.strokeStyle = alpha(TONE.cyan, 0.7);
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 7]);
    ctx.lineDashOffset = -local * 30;
    const grow = easeOut(ramp(local, 0.85, 0.55));
    roundRect(1080, top, lerp(40, 640, grow), lerp(40, bottom - top, grow), 22);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  },
  over: (local, start, fade) => {
    const a = fade * ramp(local, 0.35, 0.45);
    if (a <= 0.01) return;
    const rise = (1 - easeOut(ramp(local, 0.35, 0.6))) * 24;
    const { x, w, h } = CARD;
    const y = CARD.y + rise;
    card(x, y, w, h, 20, a);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = display(18, 600);
    setSpacing(ctx, "3px");
    ctx.fillStyle = DIM;
    ctx.textBaseline = "alphabetic";
    ctx.fillText("PROMPT 5 AGENTS", x + 34, y + 50);
    setSpacing(ctx, "0px");
    const lines = ["run the tests and", "tell me what broke"];
    const chars = Math.floor(lerp(0, lines.join("").length, ramp(local, 0.8, 1.2)));
    ctx.font = mono(32, 500);
    ctx.fillStyle = INK;
    let left = chars;
    let caret: Point = { x: x + 34, y: y + 105 };
    lines.forEach((line, row) => {
      const shown = line.slice(0, Math.max(0, left));
      left -= line.length;
      const ly = y + 105 + row * 46;
      ctx.fillText(shown, x + 34, ly);
      if (shown.length > 0 || row === 0) caret = { x: x + 34 + ctx.measureText(shown).width + 3, y: ly };
    });
    if (local < SEND_AT && mod(local, 0.9) < 0.55) {
      ctx.fillStyle = TONE.cyan;
      ctx.fillRect(caret.x, caret.y - 28, 3, 34);
    }
    // The send key: a quiet chip that lights on send.
    const lit = bump(local, SEND_AT - 0.1, 0.5);
    ctx.font = mono(19, 600);
    const label = "enter  send";
    const kw = ctx.measureText(label).width + 26;
    const kx = x + w - kw - 28;
    const ky = y + h - 58;
    ctx.fillStyle = mix(TONE.amber, RAISE, 0.9 - 0.25 * lit);
    roundRect(kx, ky, kw, 36, 9);
    ctx.fill();
    ctx.strokeStyle = alpha(TONE.amber, 0.35 + 0.5 * lit);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = TONE_FG.amber;
    ctx.fillText(label, kx + 13, ky + 25);
    ctx.restore();

    // Fan out: one prompt, one light per selected seat.
    const from: Point = { x: x + w, y: CARD.y + h / 2 };
    SELECTED.forEach((_m, i) => {
      const seat = multiSeat(i);
      const to: Point = { x: seat.x - 84, y: seat.y };
      const t0 = SEND_AT + i * 0.08;
      const p = ramp(local, t0, 0.9);
      if (p <= 0) return;
      const bow = (i - 2) * -28;
      const wireA = fade * (1 - ramp(local, arrival(i) + 0.2, 0.7)) * 0.45;
      if (wireA > 0.01) {
        ctx.save();
        ctx.strokeStyle = alpha(TONE.amberHi, wireA);
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        strokeBow(from, to, bow, 0, easeInOut(p));
        ctx.restore();
      }
      if (p < 1) drawPulse(from, to, bow, easeInOut(p), TONE.amberHi, fade);
    });
    if (opts.beats.preambles) {
      SELECTED.forEach((_m, i) => {
        const seat = multiSeat(i);
        const t0 = arrival(i) + 0.25;
        const shown = fade * Math.min(ramp(local, t0, 0.3), 1 - ramp(local, t0 + 0.9, 0.35));
        drawPreamble({ x: seat.x - 20, y: seat.y - 76 }, "agent", TONE.cyan, ["reading the suite", "running unit tests", "checking e2e", "running lint", "building first"][i] ?? "", shown);
      });
    }
    void start;
  },
};

const MAIL_SEATS: ReadonlyArray<Point> = [
  { x: 420, y: 370 },
  { x: 790, y: 235 },
  { x: 1170, y: 335 },
  { x: 1515, y: 250 },
  { x: 590, y: 770 },
  { x: 990, y: 700 },
  { x: 1415, y: 745 },
];
const WIRES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 36],
  [1, 2, -30],
  [2, 3, 34],
  [0, 4, -40],
  [4, 5, 30],
  [5, 2, -26],
  [5, 6, 34],
  [6, 3, -36],
  [1, 5, 24],
];
type MailPulse = { readonly wire: number; readonly reverse: boolean; readonly at: number; readonly kind: "notice" | "prompt" | "answer" };
// The app's pulse colours: notice cyan, prompt amber-hi, answer violet.
const PULSE_COLOR = { notice: TONE.cyan, prompt: TONE.amberHi, answer: TONE.violet } as const;
const PULSE_S = 0.9;
const MAIL_PULSES: ReadonlyArray<MailPulse> = [
  { wire: 0, reverse: false, at: 0.9, kind: "prompt" },
  { wire: 4, reverse: false, at: 1.15, kind: "notice" },
  { wire: 1, reverse: false, at: 1.45, kind: "prompt" },
  { wire: 5, reverse: true, at: 1.7, kind: "answer" },
  { wire: 2, reverse: false, at: 2.0, kind: "notice" },
  { wire: 6, reverse: false, at: 2.3, kind: "prompt" },
  { wire: 8, reverse: true, at: 2.55, kind: "answer" },
  { wire: 3, reverse: true, at: 2.85, kind: "notice" },
  { wire: 7, reverse: false, at: 3.1, kind: "answer" },
  { wire: 1, reverse: true, at: 3.35, kind: "answer" },
];
const receiver = (p: MailPulse): number => {
  const [a, b] = WIRES[p.wire]!;
  return p.reverse ? a : b;
};

const drawWires = (seats: ReadonlyArray<Point>, drawIn: (i: number) => number, fade: number): void => {
  ctx.save();
  ctx.lineCap = "round";
  WIRES.forEach(([a, b, bow], i) => {
    const p = drawIn(i);
    if (p <= 0) return;
    ctx.strokeStyle = alpha(INK, 0.2 * fade);
    ctx.lineWidth = 2.2;
    const pa = seats[a]!;
    const pb = seats[b]!;
    const trim = 78 / Math.hypot(pb.x - pa.x, pb.y - pa.y);
    strokeBow(pa, pb, bow, trim, lerp(trim, 1 - trim, easeInOut(p)));
  });
  ctx.restore();
};

const drawMail = (seats: ReadonlyArray<Point>, pulses: ReadonlyArray<{ pulse: MailPulse; p: number }>, fade: number): void => {
  for (const { pulse, p } of pulses) {
    const [a, b, bow] = WIRES[pulse.wire]!;
    const pa = seats[pulse.reverse ? b : a]!;
    const pb = seats[pulse.reverse ? a : b]!;
    const trim = 78 / Math.hypot(pb.x - pa.x, pb.y - pa.y);
    drawPulse(pa, pb, pulse.reverse ? -bow : bow, easeInOut(p), PULSE_COLOR[pulse.kind], fade, trim);
  }
};

const MAIL_PREAMBLES: ReadonlyArray<{ m: number; at: number; prov: Provenance; hue: string; text: string }> = [
  { m: 2, at: 1.1, prov: "agent", hue: TONE.cyan, text: "reading the diff" },
  { m: 5, at: 1.75, prov: "ai", hue: TONE.green, text: "going well" },
  { m: 0, at: 2.4, prov: "system", hue: TONE.steel, text: "mail from reviewer" },
  { m: 3, at: 3.0, prov: "operator", hue: TONE.amber, text: "ship it when green" },
];

const mail: SceneFn = {
  id: "mail",
  dur: 4.3,
  caption: "agents talk along the wires you draw",
  pose: (m, local, start) => {
    let state: StateName = "working";
    let since = start;
    let kick = 0;
    for (const pulse of MAIL_PULSES) {
      if (receiver(pulse) !== m) continue;
      const land = pulse.at + PULSE_S;
      kick = Math.max(kick, bump(local, land, 0.4));
      if (local >= land && pulse.kind === "answer") {
        state = "going-well";
        since = start + land;
      }
    }
    return { ...MAIL_SEATS[m]!, size: 170, alpha: 1, state, since, label: "none", kick };
  },
  under: (local, _start, fade) => {
    drawWires(MAIL_SEATS, (i) => ramp(local, 0.15 + i * 0.07, 0.7), fade);
    drawMail(
      MAIL_SEATS,
      MAIL_PULSES.map((pulse) => ({ pulse, p: (local - pulse.at) / PULSE_S })).filter(({ p }) => p > 0 && p < 1),
      fade,
    );
  },
  over: (local, _start, fade) => {
    if (!opts.beats.preambles) return;
    for (const note of MAIL_PREAMBLES) {
      const seat = MAIL_SEATS[note.m]!;
      const shown = fade * Math.min(ramp(local, note.at, 0.3), 1 - ramp(local, note.at + 1.35, 0.35));
      drawPreamble({ x: seat.x - 18, y: seat.y - 86 }, note.prov, note.hue, note.text, shown);
    }
  },
};

const SQUAD = [2, 3, 4];
const SQUAD_SEATS: ReadonlyArray<Point> = [
  { x: 545, y: 455 },
  { x: 915, y: 455 },
  { x: 730, y: 690 },
];
const REGION = { x: 330, y: 250, w: 800, h: 610 } as const;
const OTHERS = [0, 1, 5, 6];
const dropAt = (k: number): number => 0.55 + k * 0.2;

const squad: SceneFn = {
  id: "squad",
  dur: 3.0,
  caption: "a squad drops into a region",
  pose: (m, local, start, prev) => {
    const k = SQUAD.indexOf(m);
    if (k >= 0) {
      const at = dropAt(k);
      const target = SQUAD_SEATS[k]!;
      if (local < at && prev) {
        // Leave where it was, softly, before falling in from above.
        return { ...prev, alpha: prev.alpha * (1 - ramp(local, 0, 0.35)), blend: false };
      }
      const d = dropOut(ramp(local, at, 0.7));
      const landed = local >= at + 0.45;
      return {
        x: target.x,
        y: lerp(-160, target.y, d),
        size: 180,
        alpha: 1,
        state: landed ? "working" : "idle",
        since: start + (landed ? at + 0.45 : at),
        label: "below",
        labelAlpha: ramp(local, at + 0.5, 0.4),
        blend: false,
      };
    }
    const j = OTHERS.indexOf(m);
    return {
      x: 1460 + (j % 2) * 240,
      y: 340 + Math.floor(j / 2) * 350,
      size: 160,
      alpha: 1,
      state: j === 1 ? "going-well" : "working",
      since: start + 0.4,
      label: "below",
    };
  },
  under: (local, _start, fade) => {
    const a = fade * ramp(local, 0.05, 0.5);
    if (a <= 0.01) return;
    const s = lerp(0.97, 1, easeOut(ramp(local, 0.05, 0.6)));
    const { x, y, w, h } = REGION;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(s, s);
    ctx.translate(-(x + w / 2), -(y + h / 2));
    ctx.fillStyle = alpha(TONE.violet, 0.07);
    roundRect(x, y, w, h, 24);
    ctx.fill();
    ctx.strokeStyle = alpha(TONE.violet, 0.5);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = display(22, 600);
    setSpacing(ctx, "4px");
    ctx.fillStyle = TONE.violet;
    ctx.fillText("RELEASE", x + 28, y + 44);
    // The squad's name tag lands with its members.
    const tag = ramp(local, 1.5, 0.4);
    if (tag > 0) {
      ctx.globalAlpha = a * tag;
      ctx.font = mono(18, 600);
      setSpacing(ctx, "0px");
      const label = "review squad";
      const tw = ctx.measureText(label).width + 28;
      const tx = x + w - tw - 26;
      ctx.fillStyle = mix(TONE.violet, GROUND, 0.86);
      roundRect(tx, y + 20, tw, 34, 17);
      ctx.fill();
      ctx.fillStyle = TONE.violet;
      ctx.fillText(label, tx + 14, y + 43);
    }
    // A placed squad keeps its connections: they draw in once it has landed.
    ctx.lineCap = "round";
    ctx.strokeStyle = alpha(INK, 0.2);
    ctx.lineWidth = 2.2;
    const links: ReadonlyArray<readonly [number, number, number]> = [
      [0, 1, 24],
      [1, 2, 20],
      [2, 0, 20],
    ];
    links.forEach(([a, b, bow], n) => {
      const p = ramp(local, dropAt(2) + 0.55 + n * 0.12, 0.5);
      if (p <= 0) return;
      const pa = SQUAD_SEATS[a]!;
      const pb = SQUAD_SEATS[b]!;
      const trim = 84 / Math.hypot(pb.x - pa.x, pb.y - pa.y);
      strokeBow(pa, pb, bow, trim, lerp(trim, 1 - trim, easeInOut(p)));
    });
    // Landing ripples.
    SQUAD_SEATS.forEach((seat, k) => {
      const r = ramp(local, dropAt(k) + 0.42, 0.7);
      if (r <= 0 || r >= 1) return;
      ctx.globalAlpha = a * (1 - r) * 0.5;
      ctx.strokeStyle = TONE.violet;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(seat.x, seat.y + 94, 50 + r * 90, 10 + r * 18, 0, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  },
};

type FeedKind = "blocked" | "attention" | "escalate" | "feedback" | "health";
const FEED_CHIP: Readonly<Record<FeedKind, { tone: keyof typeof TONE_FG; hue: string; label: string }>> = {
  blocked: { tone: "crimson", hue: TONE.crimson, label: "blocked" },
  attention: { tone: "amber", hue: TONE.amber, label: "wants input" },
  escalate: { tone: "amber", hue: TONE.amber, label: "escalation" },
  feedback: { tone: "cyan", hue: TONE.cyan, label: "feedback" },
  health: { tone: "steel", hue: TONE.steel, label: "AI read" },
};
type FeedRow =
  | { readonly section: string }
  | { readonly m: number; readonly kind: FeedKind; readonly state: StateName; readonly text: string };
const FEED: ReadonlyArray<FeedRow> = [
  { section: "RELEASE" },
  { m: 1, kind: "blocked", state: "blocked", text: "needs the staging credentials" },
  { m: 2, kind: "attention", state: "waiting", text: "approve the migration plan?" },
  { m: 3, kind: "escalate", state: "waiting", text: "two specs disagree on retries" },
  { section: "DOCS" },
  { m: 0, kind: "feedback", state: "waiting", text: "is this the tone you meant?" },
  { m: 5, kind: "attention", state: "waiting", text: "which region gets the guide?" },
  { section: "QA" },
  { m: 6, kind: "health", state: "stuck", text: "looks stuck on a flaky test" },
];
const FEED_SEATS: ReadonlyArray<Point> = [
  { x: 270, y: 330 },
  { x: 580, y: 230 },
  { x: 470, y: 560 },
  { x: 200, y: 720 },
  { x: 790, y: 460 },
  { x: 730, y: 800 },
  { x: 440, y: 890 },
];
const PANEL = { x: 1000, y: 120, w: 800, h: 840 } as const;
const feedRowAt = (m: number): number => FEED.findIndex((row) => "m" in row && row.m === m);
const feedShowAt = (index: number): number => 0.5 + index * 0.16;

const feed: SceneFn = {
  id: "feed",
  dur: 3.8,
  caption: "one feed for everything that needs you",
  pose: (m, local, start) => {
    const row = feedRowAt(m);
    const entry = row >= 0 ? FEED[row] : undefined;
    const need = entry && "m" in entry ? entry : undefined;
    const at = need ? feedShowAt(row) : 0;
    const state: StateName = need && local >= at ? need.state : "working";
    return {
      ...FEED_SEATS[m]!,
      size: 150,
      alpha: 1,
      state,
      since: start + (need && local >= at ? at : 0),
      label: "none",
    };
  },
  over: (local, start, fade) => {
    const slide = easeOut(ramp(local, 0.05, 0.8));
    const a = fade * slide;
    if (a <= 0.01) return;
    const x = PANEL.x + (1 - slide) * 160;
    const { y, w, h } = PANEL;
    card(x, y, w, h, 22, a);
    ctx.save();
    ctx.globalAlpha = a;
    // Header: tray, title, count, the shortcut.
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x + 34, y + 44);
    ctx.lineTo(x + 40, y + 30);
    ctx.lineTo(x + 58, y + 30);
    ctx.lineTo(x + 64, y + 44);
    ctx.lineTo(x + 64, y + 56);
    ctx.lineTo(x + 34, y + 56);
    ctx.closePath();
    ctx.moveTo(x + 34, y + 44);
    ctx.lineTo(x + 43, y + 44);
    ctx.lineTo(x + 46, y + 48);
    ctx.lineTo(x + 52, y + 48);
    ctx.lineTo(x + 55, y + 44);
    ctx.lineTo(x + 64, y + 44);
    ctx.stroke();
    ctx.font = display(26, 600);
    setSpacing(ctx, "4px");
    ctx.fillStyle = INK;
    ctx.fillText("NEEDS YOU", x + 80, y + 54);
    const titleW = ctx.measureText("NEEDS YOU").width;
    setSpacing(ctx, "0px");
    const shown = FEED.filter((row, i) => "m" in row && local >= feedShowAt(i)).length;
    ctx.font = mono(18, 700);
    ctx.fillStyle = mix(TONE.amber, RAISE, 0.82);
    roundRect(x + 94 + titleW, y + 32, 36, 28, 14);
    ctx.fill();
    ctx.fillStyle = TONE_FG.amber;
    ctx.textAlign = "center";
    ctx.fillText(String(shown), x + 112 + titleW, y + 52);
    ctx.textAlign = "left";
    ctx.font = mono(18, 600);
    const kbd = "\u2318I";
    const kbdW = ctx.measureText(kbd).width + 20;
    ctx.fillStyle = FAINT;
    ctx.strokeStyle = alpha(INK, 0.25);
    ctx.lineWidth = 1.5;
    roundRect(x + w - 32 - kbdW, y + 30, kbdW, 30, 7);
    ctx.stroke();
    ctx.fillText(kbd, x + w - 22 - kbdW, y + 52);
    ctx.fillStyle = alpha(INK, 0.1);
    ctx.fillRect(x + 24, y + 84, w - 48, 1.5);
    // Body: sections and cards, scrolling gently.
    ctx.beginPath();
    ctx.rect(x + 8, y + 92, w - 16, h - 104);
    ctx.clip();
    const scroll = Math.max(0, local - 1.5) * 42;
    let cy = y + 108 - scroll;
    let cardIndex = 0;
    const selected = local < 2.6 ? 0 : 1;
    FEED.forEach((row, i) => {
      const t0 = feedShowAt(i);
      const appear = easeOut(ramp(local, t0, 0.45));
      if ("section" in row) {
        ctx.globalAlpha = a * appear;
        ctx.font = display(17, 600);
        setSpacing(ctx, "4px");
        ctx.fillStyle = FAINT;
        ctx.fillText(row.section, x + 30, cy + 26);
        setSpacing(ctx, "0px");
        cy += 44;
        return;
      }
      const lift = (1 - appear) * 26;
      const top = cy + lift;
      ctx.globalAlpha = a * appear;
      ctx.fillStyle = mix(GROUND, RAISE, 0.35);
      roundRect(x + 22, top, w - 44, 108, 14);
      ctx.fill();
      ctx.strokeStyle = alpha(INK, 0.09);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (cardIndex === selected) {
        const sel = cardIndex === 0 ? 1 - ramp(local, 2.6, 0.25) : ramp(local, 2.6, 0.25);
        ctx.fillStyle = alpha(TONE.cyan, 0.9 * sel);
        ctx.fillRect(x + 22, top + 12, 4, 84);
      }
      const critter = CAST[row.m]!;
      const ring = 78;
      const rx = x + 78;
      const ry = top + 54;
      const face = faceFor(critter, row.state);
      const img = bitmap(critter.seed, face, false);
      const d = (ring * RING_HOLE_R) / 10;
      if (img) ctx.drawImage(img, rx - d / 2, ry - d / 2, d, d);
      drawRing(row.state, local - t0, rx, ry, ring, 1);
      void start;
      ctx.font = mono(23, 700);
      ctx.fillStyle = INK;
      ctx.fillText(critter.name, x + 138, top + 44);
      const nameW = ctx.measureText(critter.name).width;
      const chip = FEED_CHIP[row.kind];
      ctx.font = mono(16, 600);
      const cw = ctx.measureText(chip.label).width + 22;
      ctx.fillStyle = mix(chip.hue, GROUND, 0.87);
      roundRect(x + 152 + nameW, top + 22, cw, 30, 15);
      ctx.fill();
      ctx.fillStyle = TONE_FG[chip.tone];
      ctx.fillText(chip.label, x + 163 + nameW, top + 43);
      ctx.font = mono(19, 500);
      ctx.fillStyle = DIM;
      ctx.fillText(row.text, x + 138, top + 80);
      cy += 120;
      cardIndex += 1;
    });
    ctx.restore();
  },
};

const MASCOT_SIZE = 380;

const endCard: SceneFn = {
  id: "end",
  dur: 3.8,
  pose: (_m, local, start, prev) => {
    const from = prev ?? { x: W / 2, y: H / 2, size: 110, alpha: 1, state: "working" as StateName, since: start, label: "none" as Label };
    const e = easeInOut(ramp(local, 0, 1.1));
    const dx = from.x - W / 2;
    const dy = from.y - H / 2;
    const len = Math.hypot(dx, dy) || 1;
    return {
      ...from,
      x: from.x + (dx / len) * 240 * e,
      y: from.y + (dy / len) * 240 * e - 40 * e,
      size: from.size * lerp(1, 0.85, e),
      alpha: from.alpha * (1 - e),
      label: "none",
      blend: false,
    };
  },
  over: (local, start) => drawMascotCard(local, start, 1),
};

/** The end card: the mascot seals its ring, the wordmark settles beside it. */
const drawMascotCard = (local: number, start: number, fade: number): void => {
  const mascot = VIDEO_MASCOT;
  ctx.save();
  ctx.font = display(176, 600);
  setSpacing(ctx, `${String(Math.round(176 * 0.14))}px`);
  const word = "JUNTO";
  const wordW = ctx.measureText(word).width - 176 * 0.14;
  const gap = 70;
  const total = MASCOT_SIZE * 0.86 + gap + wordW;
  const left = W / 2 - total / 2;
  const mx = left + (MASCOT_SIZE * 0.86) / 2;
  const my = H / 2 - 10;
  const enter = easeOut(ramp(local, 0.45, 0.9));
  const a = fade * ramp(local, 0.45, 0.5);
  const sealAt = 1.9;
  const face = local < sealAt ? mascot.faces.working : mascot.faces.celebrating;
  const since = local < sealAt ? start + 0.45 : start + sealAt;
  const y = my + (1 - enter) * 50 + Math.sin((start + local) * 1.7) * 4;
  // Soft shadow.
  ctx.fillStyle = alpha(INK, 0.07 * a);
  ctx.beginPath();
  ctx.ellipse(mx, my + MASCOT_SIZE * 0.5, MASCOT_SIZE * 0.24, MASCOT_SIZE * 0.045, 0, 0, Math.PI * 2);
  ctx.fill();
  const pop = 1 + 0.06 * bump(local, sealAt, 0.45);
  const d = ((MASCOT_SIZE * RING_HOLE_R) / 10) * pop;
  const img = bitmap(mascot.seed, face, false);
  const prevImg = bitmap(mascot.seed, mascot.faces.working, false);
  const k = ramp(local, sealAt, 0.25);
  ctx.globalAlpha = a;
  if (prevImg && k < 1) ctx.drawImage(prevImg, mx - d / 2, y - d / 2, d, d);
  ctx.globalAlpha = a * (local < sealAt ? 1 : k);
  if (img) ctx.drawImage(img, mx - d / 2, y - d / 2, d, d);
  ctx.globalAlpha = 1;
  drawRing(local < sealAt ? "working" : "done", start + local - since, mx, y, MASCOT_SIZE * pop, a);
  // Wordmark.
  const wa = fade * ramp(local, 1.2, 0.8);
  ctx.globalAlpha = wa;
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(word, left + MASCOT_SIZE * 0.86 + gap - (1 - easeOut(ramp(local, 1.2, 0.9))) * 30, my + 8);
  setSpacing(ctx, "0px");
  ctx.globalAlpha = fade * ramp(local, 2.2, 0.7);
  ctx.font = mono(26, 500);
  ctx.fillStyle = FAINT;
  ctx.fillText("juntoagents.com", left + MASCOT_SIZE * 0.86 + gap + 6, my + 118);
  ctx.restore();
};

// --- the loop cut -------------------------------------------------------------------------

const LOOP_STATES: ReadonlyArray<StateName> = ["working", "going-well", "waiting", "working", "exceeding", "done", "stuck"];
const LOOP_PULSES: ReadonlyArray<MailPulse> = [
  { wire: 0, reverse: false, at: 0.2, kind: "prompt" },
  { wire: 5, reverse: true, at: 1.2, kind: "answer" },
  { wire: 2, reverse: false, at: 2.2, kind: "notice" },
  { wire: 6, reverse: false, at: 3.2, kind: "prompt" },
  { wire: 3, reverse: true, at: 4.2, kind: "notice" },
  { wire: 8, reverse: true, at: 5.2, kind: "answer" },
  { wire: 4, reverse: false, at: 6.2, kind: "notice" },
  { wire: 7, reverse: false, at: 7.2, kind: "answer" },
];

const loopPose = (m: number, t: number): Pose => {
  let kick = 0;
  for (const pulse of LOOP_PULSES) {
    if (receiver(pulse) !== m) continue;
    const since = mod(t - (pulse.at + PULSE_S), LOOP_SECONDS);
    kick = Math.max(kick, bump(since, 0, 0.4));
  }
  const state = LOOP_STATES[m]!;
  // Done sits sealed; loops run from zero so every ring repeats in 8 s.
  return { ...MAIL_SEATS[m]!, size: 170, alpha: 1, state, since: state === "done" ? -100 : 0, label: "none", kick };
};

// --- timeline ---------------------------------------------------------------------------------

let scenes: SceneFn[] = [];
let starts: number[] = [];
let duration = 0;

const buildTimeline = (): void => {
  scenes = [wake, states, multi, mail, ...(opts.beats.squads ? [squad] : []), feed, endCard];
  starts = [];
  let at = 0;
  for (const scene of scenes) {
    starts.push(at);
    at += scene.dur;
  }
  duration = at;
};

const locate = (t: number): { i: number; local: number } => {
  for (let i = scenes.length - 1; i >= 0; i -= 1) {
    if (t >= starts[i]!) return { i, local: t - starts[i]! };
  }
  return { i: 0, local: t };
};

const scenePose = (i: number, m: number, local: number): Pose => {
  const prev = i > 0 ? scenePose(i - 1, m, scenes[i - 1]!.dur) : null;
  return scenes[i]!.pose(m, local, starts[i]!, prev);
};

const poseAt = (m: number, t: number): Pose => {
  if (opts.cut === "loop") return loopPose(m, t);
  const { i, local } = locate(t);
  const cur = scenePose(i, m, local);
  if (i === 0 || cur.blend === false || local >= TRANS) return cur;
  const prev = scenePose(i - 1, m, scenes[i - 1]!.dur);
  const e = easeInOut(local / TRANS);
  const sameLabel = prev.label === cur.label;
  return {
    ...cur,
    x: lerp(prev.x, cur.x, e),
    y: lerp(prev.y, cur.y, e),
    size: lerp(prev.size, cur.size, e),
    alpha: lerp(prev.alpha, cur.alpha, e),
    label: sameLabel || e >= 0.5 ? cur.label : prev.label,
    labelAlpha: sameLabel
      ? lerp(prev.labelAlpha ?? 1, cur.labelAlpha ?? 1, e)
      : e < 0.5
        ? (prev.labelAlpha ?? 1) * (1 - 2 * e)
        : (cur.labelAlpha ?? 1) * (2 * e - 1),
  };
};

// --- critters ------------------------------------------------------------------------------------

const blinking = (c: Critter, t: number): boolean => {
  const every = opts.cut === "loop" ? 4 : 3.6 + c.phase * 1.8;
  return mod(t + c.phase * 7, every) < 0.14;
};

const drawCritter = (m: number, t: number): void => {
  const c = CAST[m]!;
  const pose = poseAt(m, t);
  if (pose.alpha <= 0.01 || pose.size < 2) return;
  const before = pose.since > -50 ? poseAt(m, pose.since - 0.001) : pose;
  const prevState = before.state;
  const bobPeriod = opts.cut === "loop" ? 4 : 3.2;
  const bob = Math.sin(((t / bobPeriod + c.phase) * Math.PI * 2)) * pose.size * 0.02;
  const pop = 1 + 0.07 * bump(t, pose.since, 0.42) + 0.06 * (pose.kick ?? 0);
  const size = pose.size * pop;
  const x = pose.x;
  const y = pose.y + bob;
  ctx.save();
  ctx.globalAlpha = pose.alpha;
  // Shadow on the ground, tighter as the critter bobs up.
  ctx.fillStyle = alpha(INK, 0.07);
  ctx.beginPath();
  ctx.ellipse(x, pose.y + pose.size * 0.52, pose.size * 0.25 * (1 - bob / pose.size), pose.size * 0.045, 0, 0, Math.PI * 2);
  ctx.fill();
  const d = (size * RING_HOLE_R) / 10;
  const blink = pose.state !== "asleep" && blinking(c, t);
  const now = bitmap(c.seed, faceFor(c, pose.state), blink);
  const k = ramp(t, pose.since, 0.24);
  if (k < 1 && prevState !== pose.state) {
    const was = bitmap(c.seed, faceFor(c, prevState), false);
    if (was) ctx.drawImage(was, x - d / 2, y - d / 2, d, d);
    ctx.globalAlpha = pose.alpha * k;
  }
  if (now) ctx.drawImage(now, x - d / 2, y - d / 2, d, d);
  ctx.globalAlpha = 1;
  drawRing(pose.state, t - pose.since, x, y, size, pose.alpha);
  // Label: the seat's name and what it is doing, in the state's own ink.
  const la = pose.alpha * (pose.labelAlpha ?? 1);
  if (pose.label !== "none" && la > 0.01) {
    const spec = STATES[pose.state];
    ctx.globalAlpha = la;
    ctx.textBaseline = "alphabetic";
    if (pose.label === "below") {
      ctx.textAlign = "center";
      ctx.font = mono(Math.round(pose.size * 0.15), 700);
      ctx.fillStyle = INK;
      ctx.fillText(c.name, x, pose.y + pose.size * 0.66);
      ctx.font = mono(Math.round(pose.size * 0.104), 500);
      ctx.fillStyle = spec.fg;
      ctx.fillText(spec.label, x, pose.y + pose.size * 0.66 + pose.size * 0.15);
      ctx.textAlign = "left";
    } else {
      ctx.font = mono(30, 700);
      ctx.fillStyle = INK;
      ctx.fillText(c.name, x + pose.size * 0.5, pose.y - 4);
      ctx.font = mono(24, 500);
      ctx.fillStyle = spec.fg;
      ctx.fillText(spec.label, x + pose.size * 0.5, pose.y + 30);
    }
  }
  ctx.restore();
};

// --- background ------------------------------------------------------------------------------------

const ORBS = [
  { color: TONE.amber, r: 720, x: 0.18, y: 0.22, ax: 0.05, ay: 0.06, k: [1, 1], a: 0.13 },
  { color: TONE.cyan, r: 760, x: 0.84, y: 0.3, ax: 0.05, ay: 0.05, k: [1, 2], a: 0.11 },
  { color: TONE.violet, r: 680, x: 0.62, y: 0.92, ax: 0.06, ay: 0.04, k: [2, 1], a: 0.09 },
  { color: TONE.green, r: 600, x: 0.2, y: 0.9, ax: 0.04, ay: 0.05, k: [1, 1], a: 0.08 },
  { color: TONE.orange, r: 520, x: 0.48, y: 0.12, ax: 0.07, ay: 0.03, k: [1, 1], a: 0.06 },
] as const;

const MOTES = Array.from({ length: 34 }, (_, i) => ({
  x: hash01(i + 1) * W,
  y: hash01(i + 101) * H,
  r: 2 + hash01(i + 201) * 4,
  orbit: 10 + hash01(i + 301) * 26,
  phase: hash01(i + 401),
  hue: [TONE.amber, TONE.cyan, TONE.violet, TONE.green][i % 4]!,
  speed: i % 3 === 0 ? 2 : 1,
}));

const drawBackground = (t: number): void => {
  const period = opts.cut === "loop" ? LOOP_SECONDS : 24;
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, W, H);
  for (const orb of ORBS) {
    const w = (t / period) * Math.PI * 2;
    const cx = (orb.x + orb.ax * Math.sin(w * orb.k[0] + orb.r)) * W;
    const cy = (orb.y + orb.ay * Math.cos(w * orb.k[1] + orb.x * 7)) * H;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, orb.r);
    g.addColorStop(0, alpha(orb.color, orb.a));
    g.addColorStop(0.55, alpha(orb.color, orb.a * 0.45));
    g.addColorStop(1, alpha(orb.color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  // The canvas' own dot field, drifting like a slow current.
  const gap = 40;
  const drift = mod((t / period) * gap * (opts.cut === "loop" ? 1 : 3), gap);
  ctx.fillStyle = alpha(INK, 0.075);
  for (let gy = -gap; gy < H + gap; gy += gap) {
    for (let gx = -gap; gx < W + gap; gx += gap) {
      ctx.beginPath();
      ctx.arc(gx + drift, gy + drift * 0.5, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (const mote of MOTES) {
    const w = (t / (opts.cut === "loop" ? LOOP_SECONDS : 9)) * Math.PI * 2 * mote.speed + mote.phase * Math.PI * 2;
    const tw = 0.5 + 0.5 * Math.sin(w * 2);
    ctx.fillStyle = alpha(mote.hue, 0.1 + 0.12 * tw);
    ctx.beginPath();
    ctx.arc(mote.x + Math.cos(w) * mote.orbit, mote.y + Math.sin(w) * mote.orbit * 0.7, mote.r, 0, Math.PI * 2);
    ctx.fill();
  }
};

const drawFinish = (): void => {
  // A warm vignette, then a whisper of static grain (never animated: it would
  // cost bitrate and read as noise, not texture).
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05);
  g.addColorStop(0, "rgba(54,44,36,0)");
  g.addColorStop(1, "rgba(54,44,36,0.09)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalAlpha = 0.035;
  ctx.fillStyle = ctx.createPattern(grain, "repeat") ?? "transparent";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
};

const drawCaption = (text: string, a: number): void => {
  if (a <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = display(26, 600);
  setSpacing(ctx, "6px");
  ctx.fillStyle = DIM;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text.toUpperCase(), W / 2 + 3, H - 70);
  ctx.restore();
};

// --- frame ------------------------------------------------------------------------------------------

const draw = (t: number): void => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  drawBackground(t);
  if (opts.cut === "loop") {
    drawWires(MAIL_SEATS, () => 1, 1);
    drawMail(
      MAIL_SEATS,
      LOOP_PULSES.map((pulse) => ({ pulse, p: mod(t - pulse.at, LOOP_SECONDS) / PULSE_S })).filter(({ p }) => p > 0 && p < 1),
      1,
    );
    CAST.map((_, m) => m)
      .sort((a, b) => poseAt(a, t).y - poseAt(b, t).y)
      .forEach((m) => drawCritter(m, t));
    drawFinish();
    return;
  }
  const { i, local } = locate(t);
  const scene = scenes[i]!;
  const prev = i > 0 && local < TRANS ? scenes[i - 1]! : undefined;
  const handoff = prev ? 1 - easeInOut(local / TRANS) : 0;
  if (prev?.under) prev.under(prev.dur + local, starts[i - 1]!, handoff);
  scene.under?.(local, starts[i]!, 1);
  CAST.map((_, m) => m)
    .sort((a, b) => poseAt(a, t).y - poseAt(b, t).y)
    .forEach((m) => drawCritter(m, t));
  if (prev?.over) prev.over(prev.dur + local, starts[i - 1]!, handoff);
  scene.over?.(local, starts[i]!, 1);
  if (scene.caption) drawCaption(scene.caption, window01(local, 0.45, scene.dur - 0.15, 0.55, 0.5));
  drawFinish();
};

// --- page API -----------------------------------------------------------------------------------------

const prepare = async (options: SceneOptions): Promise<{ duration: number; scenes: ReadonlyArray<{ id: string; start: number; dur: number }> }> => {
  opts = options;
  frameMs = options.cut === "loop" ? 125 : 90;
  canvas = document.getElementById("stage") as HTMLCanvasElement;
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext("2d", { alpha: false });
  if (!c) throw new Error("no 2d context");
  ctx = c;
  ctx.imageSmoothingQuality = "high";
  ringLayer = document.createElement("canvas");
  ringLayer.width = 600;
  ringLayer.height = 600;
  const rc = ringLayer.getContext("2d");
  if (!rc) throw new Error("no 2d context");
  ringCtx = rc;
  grain = document.createElement("canvas");
  grain.width = 256;
  grain.height = 256;
  const gc = grain.getContext("2d");
  if (!gc) throw new Error("no 2d context");
  const noise = gc.createImageData(256, 256);
  for (let p = 0; p < noise.data.length; p += 4) {
    const v = Math.floor(hash01(p * 0.25 + 7) * 255);
    noise.data[p] = v;
    noise.data[p + 1] = v;
    noise.data[p + 2] = v;
    noise.data[p + 3] = 255;
  }
  gc.putImageData(noise, 0, 0);
  const jobs: Promise<void>[] = [];
  for (const critter of CAST) {
    for (const state of STATE_NAMES) {
      const face = faceFor(critter, state);
      jobs.push(rasterize(critter.seed, critter.config, face, false), rasterize(critter.seed, critter.config, face, true));
    }
  }
  for (const face of Object.values(VIDEO_MASCOT.faces)) {
    jobs.push(rasterize(VIDEO_MASCOT.seed, VIDEO_MASCOT.config, face, false));
  }
  await Promise.all(jobs);
  await document.fonts.ready;
  buildTimeline();
  return {
    duration: options.cut === "loop" ? LOOP_SECONDS : duration,
    scenes: scenes.map((scene, i) => ({ id: scene.id, start: starts[i]!, dur: scene.dur })),
  };
};

const api = {
  prepare,
  draw,
  png: (): string => canvas.toDataURL("image/png"),
  jpeg: (quality: number): string => canvas.toDataURL("image/jpeg", quality),
};

(window as unknown as { __junto: typeof api }).__junto = api;
