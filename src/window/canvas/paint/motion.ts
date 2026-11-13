/**
 * Rings and bands in motion (architecture section 10). The tables here are
 * built from `RING_MOTION`, `BAND_PERIOD_MS` and the atlas layout, so the
 * canvas holds no tempo of its own. `sampleMotion` is the reference arithmetic
 * of every motion, from the wall clock: the shader mirrors it, and a test
 * holds it against the DOM's keyframes (`junto-mark-turn` and the rest).
 */

import {
  LAND_FRAMES,
  MARK_PHASE_MS,
  RING_FRAME_MS,
  type RingState,
} from "@shared/wire/rings";
import { DURATION, EASING } from "@shared/theme";
import { MARK_BLANK_CELL, MARK_LAND_ROW, ringCellsOf } from "../../lib/activity-atlas";
import { BAND_PERIOD_MS, type BandMotion } from "../../lib/kind-band";
import type { Quad, QuadMotion, Rect, ScaleRule } from "../contract";
import { sprite } from "./refs";

/** Milliseconds of the done draw-in. */
export const LAND_MS = LAND_FRAMES * RING_FRAME_MS;

// --- the ring's quads ---------------------------------------------------------

/**
 * The sprites of one ring, in the order the DOM paints them: the base
 * (background), the band, then, after the portrait, the moving parts. The
 * caller places the portrait between `under` and `over`.
 *
 * While motion is live the base is the still part and the parts move. While it
 * is paused (hidden window, reduced motion) the ring shows its rest pose
 * instead, which is what `animate: false` gives (`ringCellsOf`).
 */
export type RingQuads = { readonly under: ReadonlyArray<Quad>; readonly over: ReadonlyArray<Quad> };

export const ringQuads = (
  state: RingState,
  since: number,
  rect: Rect,
  scale: ScaleRule,
  key: string,
  z: number,
): RingQuads => {
  const live = ringCellsOf(state, true);
  const rest = ringCellsOf(state, false);
  const under: Quad[] = [];
  const over: Quad[] = [];
  const cell = (k: string, zz: number, at: { col: number; row: number }, extra: Partial<Quad>): Quad =>
    sprite({ key: `${key}.${k}`, z: zz, rect }, { scale, sprite: { atlas: "mark", cell: { col: at.col, row: at.row } }, ...extra });

  const moving = live.core.motion === "loop" && live.core.parts !== undefined;
  if (!moving) {
    under.push(cell("core", z, live.core, {}));
  } else {
    const parts = live.core.parts!;
    // Paused: the rest pose alone.
    under.push(cell("rest", z, rest.core, { gate: "paused" }));
    const landing = live.core.land !== undefined;
    const base = parts.base;
    const blank = base.col === MARK_BLANK_CELL.col && base.row === MARK_BLANK_CELL.row;
    if (!blank) {
      under.push(cell("base", z, base, { gate: "live", ...(landing ? { motion: { kind: "landed", since } as QuadMotion } : {}) }));
    }
    if (landing) {
      over.push(cell("land", z + 2, { col: LAND_FRAMES, row: MARK_LAND_ROW }, { gate: "live", motion: { kind: "land", since } }));
    }
    if (parts.spin) {
      const { ms, ccw, fade } = parts.spin;
      over.push(
        cell("spin", z + 3, parts.spin, {
          gate: "live",
          motion: { kind: "turn", periodMs: ms, ...(ccw ? { ccw } : {}), ...(fade ? { fade } : {}) },
        }),
      );
    }
    if (parts.pulse) {
      over.push(cell("pulse", z + 4, parts.pulse, { gate: "live", motion: { kind: parts.pulse.kind, periodMs: parts.pulse.ms } }));
    }
  }
  if (live.band) under.push(cell("band", z + 1, live.band, {}));
  return { under, over };
};

/** A band layer's motion, from its name. */
export const bandMotion = (motion: BandMotion): QuadMotion => {
  const periodMs = BAND_PERIOD_MS[motion];
  switch (motion) {
    case "chase":
    case "shimmer":
    case "hand":
    case "scan":
    case "orbit":
      return { kind: "turn", periodMs };
    case "pulse":
    case "breathe":
      return { kind: "bandFade", periodMs };
    case "blink":
    case "blink-fast":
      return { kind: "blink", periodMs };
    case "ripple":
      return { kind: "ripple", periodMs };
    case "glint":
      return { kind: "glint", periodMs };
    case "shake":
      return { kind: "shake", periodMs };
  }
};

// --- the arithmetic of every motion --------------------------------------------

export type MotionSample = {
  /** Degrees, clockwise. */
  readonly angle: number;
  readonly scale: number;
  readonly opacity: number;
  /** Board units along x (the shake). */
  readonly dx: number;
  /** Board units along y (the preamble line's rise). */
  readonly dy: number;
  /** The quad is not drawn at all (a land that has landed). */
  readonly hidden: boolean;
};

const bezier = (x1: number, y1: number, x2: number, y2: number): ((t: number) => number) => {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number): number => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number): number => ((ay * u + by) * u + cy) * u;
  const dx = (u: number): number => (3 * ax * u + 2 * bx) * u + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 8; i += 1) {
      const e = sx(u) - x;
      if (Math.abs(e) < 1e-6) return sy(u);
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= e / d;
    }
    let lo = 0;
    let hi = 1;
    u = x;
    while (hi - lo > 1e-6) {
      if (sx(u) < x) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
};

const ease = (name: keyof typeof EASING): ((t: number) => number) => {
  const [a, b, c, d] = EASING[name];
  return bezier(a, b, c, d);
};
const easeInOut = ease("in-out");
const easeSettle = ease("settle");

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Piecewise linear through `[progress, value]` stops. */
const through = (stops: ReadonlyArray<readonly [number, number]>, p: number): number => {
  for (let i = 1; i < stops.length; i += 1) {
    const [p1, v1] = stops[i]!;
    if (p <= p1) {
      const [p0, v0] = stops[i - 1]!;
      return lerp(v0, v1, p1 === p0 ? 1 : (p - p0) / (p1 - p0));
    }
  }
  return stops[stops.length - 1]![1];
};

const SAMPLE: MotionSample = { angle: 0, scale: 1, opacity: 1, dx: 0, dy: 0, hidden: false };

/** Progress through a looping motion: wall time modulo the shared phase, then the period. */
export const phaseOf = (wallMs: number, periodMs: number): number => {
  const t = ((wallMs % MARK_PHASE_MS) + MARK_PHASE_MS) % MARK_PHASE_MS;
  return (t % periodMs) / periodMs;
};

/**
 * Where a motion stands at `wallMs` (epoch milliseconds, the frame's time
 * plus the time origin). Keyframes as the DOM has them (`activity-atlas.ts`
 * motionCss, `kind-seat.css`, `reach-preview.css`).
 */
export const sampleMotion = (motion: QuadMotion | undefined, wallMs: number): MotionSample => {
  if (motion === undefined) return SAMPLE;
  switch (motion.kind) {
    case "turn": {
      const p = phaseOf(wallMs, motion.periodMs);
      const angle = 360 * (motion.ccw ? 1 - p : p);
      return { ...SAMPLE, angle: angle === 360 ? 0 : angle, ...(motion.fade ? { opacity: easeInOut(p < 0.5 ? p * 2 : 2 - p * 2) } : {}) };
    }
    case "send": {
      const p = phaseOf(wallMs, motion.periodMs);
      const q = Math.min(1, p / 0.8125);
      const e = easeSettle(q);
      return { ...SAMPLE, scale: lerp(1, 1.31, e), opacity: lerp(1, 0, e) };
    }
    case "beat": {
      const p = phaseOf(wallMs, motion.periodMs);
      return { ...SAMPLE, opacity: through([[0, 0], [0.1875, 1], [0.375, 0], [0.5, 0.55], [0.6875, 0], [1, 0]], p) };
    }
    case "breathe": {
      const p = phaseOf(wallMs, motion.periodMs);
      return { ...SAMPLE, opacity: p < 0.5 ? easeInOut(p * 2) : easeInOut(2 - p * 2) };
    }
    case "bandFade": {
      const p = phaseOf(wallMs, motion.periodMs);
      return { ...SAMPLE, opacity: through([[0, 0.25], [0.5, 1], [1, 0.25]], p) };
    }
    case "blink": {
      const p = phaseOf(wallMs, motion.periodMs);
      return { ...SAMPLE, opacity: p < 0.5 ? 1 : 0.1 };
    }
    case "ripple": {
      const p = phaseOf(wallMs, motion.periodMs);
      return { ...SAMPLE, opacity: lerp(0.8, 0, p), scale: lerp(1, 1.22, p) };
    }
    case "glint": {
      const p = phaseOf(wallMs, motion.periodMs);
      return { ...SAMPLE, opacity: through([[0, 0], [0.3, 0.9], [0.6, 0], [1, 0]], p) };
    }
    case "shake": {
      const p = phaseOf(wallMs, motion.periodMs);
      return { ...SAMPLE, dx: through([[0, 0], [0.25, -1], [0.75, 1], [1, 0]], p) };
    }
    case "reach": {
      const p = phaseOf(wallMs, motion.periodMs);
      const e = p < 0.5 ? easeInOut(p * 2) : easeInOut(2 - p * 2);
      return { ...SAMPLE, opacity: lerp(1, 0.55, e), scale: lerp(1, 1.015, e) };
    }
    case "land": {
      const t = Math.max(0, wallMs - motion.since);
      if (t >= LAND_MS) return { ...SAMPLE, hidden: true };
      const e = easeSettle(t / LAND_MS);
      return { ...SAMPLE, scale: lerp(0.82, 1, e), opacity: e };
    }
    case "rise": {
      const e = ease("enter")(Math.min(1, Math.max(0, wallMs - motion.since) / DURATION.enter));
      return { ...SAMPLE, opacity: e, dy: lerp(3, 0, e) };
    }
    case "landed": {
      const t = Math.max(0, wallMs - motion.since);
      return { ...SAMPLE, opacity: t >= LAND_MS ? 1 : 0 };
    }
  }
};
