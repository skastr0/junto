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

/** The wire's straight runs at least `min` long, each with where it starts along the wire. */
export const trackRuns = (d: string, min: number): TrackRun[] => {
  const points = flattenWirePath(d);
  const out: TrackRun[] = [];
  let walked = 0;
  let i = 0;
  while (i < points.length - 1) {
    const a = points[i]!;
    const dx = points[i + 1]!.x - a.x;
    const dy = points[i + 1]!.y - a.y;
    const len0 = Math.hypot(dx, dy);
    let j = i + 1;
    let length = len0;
    // Merge the following segments that keep the same heading.
    while (j < points.length - 1 && len0 > 0) {
      const ex = points[j + 1]!.x - points[j]!.x;
      const ey = points[j + 1]!.y - points[j]!.y;
      const len = Math.hypot(ex, ey);
      if (len === 0 || Math.abs(dx * ey - dy * ex) / (len0 * len) > 1e-3 || dx * ex + dy * ey < 0) break;
      length += len;
      j += 1;
    }
    if (length >= min && len0 > 0) {
      out.push({ x: a.x, y: a.y, length, angle: (Math.atan2(dy, dx) * 180) / Math.PI, at: walked });
    }
    walked += length;
    i = j;
  }
  return out;
};

/** A strip's height at `scale`: the chevron and its stroke, no more. */
export const trackHeight = (scale: number): number => (TRACK_SPREAD + TRACK_WIDTH) * 2 * scale;

/**
 * One period of the track as a mask: a single open chevron, white, pointing
 * along +x. The strip's colour fills it, so the hue stays a stylesheet token.
 */
export const trackTile = (scale: number): string => {
  const p = TRACK_PERIOD * scale;
  const h = trackHeight(scale);
  const arm = TRACK_ARM * scale;
  const spread = TRACK_SPREAD * scale;
  const c = p / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${p}" height="${h}" viewBox="0 0 ${p} ${h}">` +
    `<polyline points="${c - arm / 2},${h / 2 - spread} ${c + arm / 2},${h / 2} ${c - arm / 2},${h / 2 + spread}" ` +
    `fill="none" stroke="white" stroke-width="${TRACK_WIDTH * scale}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};
