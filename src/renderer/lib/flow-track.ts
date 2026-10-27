// Flow track: the moving chevrons a flows wire draws instead of a hairline.
//
// A flows wire joins two task boards, and the operator reads it as a
// dependency with a direction, so it is drawn as a track of open chevrons
// pointing the way the work runs (>>>> or <<<<), always opaque, half again a
// wire's weight, and sliding toward the dependent board.
//
// The slide runs on the compositor. Every wire path on the canvas is an
// orthogonal run with rounded corners (M, L and Q only: wire-route.ts
// roundedOrthogonalPath, React Flow's smooth step), so the track is laid as
// one clipped strip per straight run, turned to the run's heading, whose
// marks translate one period and loop. The short corner pieces carry no
// marks. Each run's marks are phased by the distance walked to it, so the
// period carries on round every corner.

import type { CanvasTier } from "./canvas-tier";

/** A plain wire's stroke (WireEdge). */
export const WIRE_WIDTH = 1.2;
/** A track's chevrons: half again a wire's weight. */
export const TRACK_WIDTH = WIRE_WIDTH * 1.5;
/** Canvas units from one chevron to the next, at near. */
export const TRACK_PERIOD = 18;
/** How far a chevron's arms reach back from its tip. */
const TRACK_ARM = 4;
/** Half the chevron's height, across the path. */
const TRACK_SPREAD = 4.4;
/** One period's slide: 40 canvas units a second at near (flow-track.css). */
export const TRACK_PERIOD_MS = 450;

/**
 * How much larger the track is laid as the camera pulls back, so a chevron
 * stays about the same size on screen at every tier (the tiers' typical
 * zooms are 0.8, 0.45, 0.26 and 0.15).
 */
export const TRACK_SCALE: Readonly<Record<CanvasTier, number>> = {
  near: 1,
  mid: 1.75,
  far: 3,
  overview: 5,
};

export type TrackPoint = { readonly x: number; readonly y: number };

const QUAD_STEPS = 8;
const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

/** The path as a polyline, source to target. Q corners are flattened. */
export const flattenWirePath = (d: string): TrackPoint[] => {
  const out: TrackPoint[] = [];
  for (const [, command, args] of d.matchAll(/([MLQ])([^MLQ]*)/g)) {
    const n = (args!.match(NUMBER) ?? []).map(Number);
    if (command === "M" || command === "L") {
      for (let i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i]!, y: n[i + 1]! });
    } else {
      for (let i = 0; i + 3 < n.length; i += 4) {
        const from = out[out.length - 1] ?? { x: n[i]!, y: n[i + 1]! };
        const c = { x: n[i]!, y: n[i + 1]! };
        const to = { x: n[i + 2]!, y: n[i + 3]! };
        for (let s = 1; s <= QUAD_STEPS; s += 1) {
          const t = s / QUAD_STEPS;
          const u = 1 - t;
          out.push({
            x: u * u * from.x + 2 * u * t * c.x + t * t * to.x,
            y: u * u * from.y + 2 * u * t * c.y + t * t * to.y,
          });
        }
      }
    }
  }
  return out;
};

/** One straight stretch of the track, in canvas units, source to target. */
export type TrackRun = {
  readonly x: number;
  readonly y: number;
  readonly length: number;
  /** Heading in degrees, 0 pointing along +x. */
  readonly angle: number;
  /** Distance along the whole wire where this run starts. */
  readonly at: number;
};

type Stretch = { x: number; y: number; ux: number; uy: number; length: number; at: number };

/** The polyline as maximal straight stretches; zero-length pieces join their neighbours. */
const stretchesOf = (points: ReadonlyArray<TrackPoint>): Stretch[] => {
  const out: Stretch[] = [];
  let walked = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const dx = points[i + 1]!.x - a.x;
    const dy = points[i + 1]!.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    const last = out[out.length - 1];
    if (last && Math.abs(last.ux * uy - last.uy * ux) < 1e-3 && last.ux * ux + last.uy * uy > 0) last.length += len;
    else out.push({ x: a.x, y: a.y, ux, uy, length: len, at: walked });
    walked += len;
  }
  return out;
};

/**
 * The wire's straight runs at least `min` long, each with where it starts
 * along the wire. A sideways step no wider than `jog` between two stretches
 * on the same heading (a lane stitch, wire-loom.ts) is ridden straight
 * through, so the track does not step and double its chevrons there.
 */
export const trackRuns = (d: string, min: number, jog = 0): TrackRun[] => {
  const stretches = stretchesOf(flattenWirePath(d));
  const merged: Stretch[] = [];
  for (let i = 0; i < stretches.length; i += 1) {
    const run = { ...stretches[i]! };
    // A step is the short sideways stretches (corners included) before the
    // next stretch that keeps this heading.
    for (;;) {
      let k = i + 1;
      let side = 0;
      while (k < stretches.length && Math.abs(stretches[k]!.ux * run.ux + stretches[k]!.uy * run.uy) < 0.999) {
        side += stretches[k]!.length;
        k += 1;
      }
      const next = stretches[k];
      if (k === i + 1 || !next || side > jog * 2 || next.ux * run.ux + next.uy * run.uy < 0) break;
      const end = { x: next.x + next.ux * next.length, y: next.y + next.uy * next.length };
      const offset = Math.abs((end.x - run.x) * run.uy - (end.y - run.y) * run.ux);
      if (offset > jog) break;
      run.length = (end.x - run.x) * run.ux + (end.y - run.y) * run.uy;
      i = k;
    }
    merged.push(run);
  }
  return merged
    .filter((run) => run.length >= min)
    .map((run) => ({ x: run.x, y: run.y, length: run.length, angle: (Math.atan2(run.uy, run.ux) * 180) / Math.PI, at: run.at }));
};

/**
 * Per run, the room across it: the distance to the nearest other run that
 * lies alongside it (parallel either way, overlapping it along its length)
 * on any flows track, the same track's other runs included. Infinity where
 * nothing lies alongside.
 */
export const trackClearances = (
  tracks: Readonly<Record<string, ReadonlyArray<TrackRun>>>,
): Record<string, number[]> => {
  const all = Object.entries(tracks).flatMap(([id, runs]) =>
    runs.map((run, index) => {
      const rad = (run.angle * Math.PI) / 180;
      return { id, index, run, ux: Math.cos(rad), uy: Math.sin(rad) };
    }),
  );
  const out: Record<string, number[]> = {};
  for (const [id, runs] of Object.entries(tracks)) out[id] = runs.map(() => Number.POSITIVE_INFINITY);
  for (let i = 0; i < all.length; i += 1) {
    const a = all[i]!;
    for (let j = i + 1; j < all.length; j += 1) {
      const b = all[j]!;
      if (Math.abs(a.ux * b.uy - a.uy * b.ux) > 1e-3) continue;
      // b's two ends along a's line, and its distance across it.
      const s0 = (b.run.x - a.run.x) * a.ux + (b.run.y - a.run.y) * a.uy;
      const s1 = s0 + b.run.length * (a.ux * b.ux + a.uy * b.uy);
      if (Math.max(s0, s1) <= 0 || Math.min(s0, s1) >= a.run.length) continue;
      const across = Math.abs((b.run.x - a.run.x) * a.uy - (b.run.y - a.run.y) * a.ux);
      if (across < 1e-6) continue;
      out[a.id]![a.index] = Math.min(out[a.id]![a.index]!, across);
      out[b.id]![b.index] = Math.min(out[b.id]![b.index]!, across);
    }
  }
  return out;
};

/**
 * The size a run's chevron is drawn at: the tier's scale, or less where
 * another run lies within `room`, so two tracks side by side keep a stroke's
 * width of ground between them instead of crossing. The whole chevron
 * shrinks (arms, spread and stroke alike), never below its near size; the
 * spacing stays the tier's, so every run slides at the same pace.
 */
export const trackFit = (scale: number, room = Number.POSITIVE_INFINITY): number =>
  Math.max(Math.min(scale, 1), Math.min(scale, room / (trackHeight(1) + TRACK_WIDTH)));

/** A strip's height for a chevron drawn at `fit`: the chevron and its stroke, no more. */
export const trackHeight = (fit: number): number => (TRACK_SPREAD + TRACK_WIDTH) * 2 * fit;

/**
 * One period of the track as a mask: a single open chevron, white, pointing
 * along +x, a period at `scale` long and drawn at `fit`. The strip's colour
 * fills it, so the hue stays a stylesheet token.
 */
export const trackTile = (scale: number, fit = scale): string => {
  const p = TRACK_PERIOD * scale;
  const h = trackHeight(fit);
  const arm = TRACK_ARM * fit;
  const spread = TRACK_SPREAD * fit;
  const c = p / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${p}" height="${h}" viewBox="0 0 ${p} ${h}">` +
    `<polyline points="${c - arm / 2},${h / 2 - spread} ${c + arm / 2},${h / 2} ${c - arm / 2},${h / 2 + spread}" ` +
    `fill="none" stroke="white" stroke-width="${TRACK_WIDTH * fit}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};
