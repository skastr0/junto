/**
 * Routes as points. A wire's path comes from one of three sources, in today's
 * order of precedence (WireEdge.tsx:96-99): a cable strand (`stitchStrand`,
 * three or more wires on one handle), a planned route (`routeWire`), and the
 * fallback elbow (elbow.ts). Each becomes a `WireRoute`: the polyline it
 * rounds, how its corners round, its label point and its hit width.
 *
 * `wireLine` then flattens a route into the centreline every other wire
 * module reads: board-unit samples with tangents and the distance walked to
 * each. Its samples are exactly the points `flattenWirePath` (flow-track.ts)
 * reads back from the SVG path the DOM draws today, so distance along the
 * wire means the same thing to the strip, the track and the pulse.
 *
 * Pure geometry. No React, no React Flow, no DOM.
 */

import { roundedOrthogonalPath, simplifyPolyline, type WireDirection, type WireRouteResult } from "@shared/wire-route";
import { LANE_GAP, SPINE_RADIUS, type LoomStitch } from "@window/lib/wire-loom";
import type { Point, Rect } from "../../contract";
import { ELBOW_RADIUS, elbowBend, elbowPath, elbowPoints, type ElbowInput } from "./elbow";

/** The router's corner radius (loom-view.ts planStandaloneRoutes, borderRadius 8). */
export const ROUTE_RADIUS = 8;
/** React Flow's default `interactionWidth`: the invisible stroke a wire is picked by (RF index.js:2570). */
export const HIT_WIDTH = 20;
/** A cable member's hit stroke: one lane, so it never straddles its neighbours (WireEdge.tsx:121-123). */
export const STRAND_HIT_WIDTH = LANE_GAP;
/** Samples per rounded corner: flow-track.ts `QUAD_STEPS`, so the centreline is the one the track reads. */
export const CORNER_STEPS = 8;

export type RouteKind = "strand" | "route" | "elbow";

export type WireRoute = {
  readonly kind: RouteKind;
  /** The polyline the path rounds, source to target, in board units. */
  readonly points: ReadonlyArray<Point>;
  readonly radius: number;
  /**
   * `orthogonal`: `roundedOrthogonalPath` (wire-route.ts:128-160), the
   * router's and the loom's. `step`: React Flow's `getBend`, the elbow's.
   */
  readonly rounding: "orthogonal" | "step";
  /** Where today's invisible midpoint button sits. */
  readonly label: Point;
  /** Half the hit stroke's width: a point this near the centreline picks the wire. */
  readonly hitHalfWidth: number;
};

export const routeOfPlanned = (planned: WireRouteResult): WireRoute => ({
  kind: "route",
  points: planned.points.map(({ x, y }) => ({ x, y })),
  radius: ROUTE_RADIUS,
  rounding: "orthogonal",
  label: { x: planned.labelX, y: planned.labelY },
  hitHalfWidth: HIT_WIDTH / 2,
});

export const routeOfStrand = (stitch: LoomStitch): WireRoute => ({
  kind: "strand",
  points: stitch.points.map(({ x, y }) => ({ x, y })),
  radius: SPINE_RADIUS,
  rounding: "orthogonal",
  label: { x: stitch.labelX, y: stitch.labelY },
  hitHalfWidth: STRAND_HIT_WIDTH / 2,
});

/** A pair lane's shift of the two live ends (CanvasLoom.tsx:203-330), applied before the elbow is built. */
export type LaneShift = { readonly source: Point; readonly target: Point };

export const routeOfElbow = (input: ElbowInput, lane?: LaneShift): WireRoute => {
  const elbow = elbowPoints({
    ...input,
    source: { x: input.source.x + (lane?.source.x ?? 0), y: input.source.y + (lane?.source.y ?? 0) },
    target: { x: input.target.x + (lane?.target.x ?? 0), y: input.target.y + (lane?.target.y ?? 0) },
  });
  return {
    kind: "elbow",
    points: elbow.points,
    radius: ELBOW_RADIUS,
    rounding: "step",
    label: elbow.label,
    hitHalfWidth: HIT_WIDTH / 2,
  };
};

/** Today's precedence: the strand, else the planned route, else the elbow. */
export const chooseRoute = (sources: {
  readonly strand?: LoomStitch | null;
  readonly planned?: WireRouteResult | null;
  readonly elbow: ElbowInput;
  readonly lane?: LaneShift;
}): WireRoute => {
  if (sources.strand) return routeOfStrand(sources.strand);
  if (sources.planned) return routeOfPlanned(sources.planned);
  return routeOfElbow(sources.elbow, sources.lane);
};

/**
 * Where React Flow ends a wire on a card today: the outer edge midpoint of
 * the handle box for its side (getHandlePosition, RF system index.js:1434).
 * The handle is a 9 unit dot (styles.css:1485-1487, border-box) centred on
 * the side, the source one pushed 2 out and the target one 3 in
 * (styles.css:1509-1516). Computed from the stylesheet; not measured.
 */
export const HANDLE_SIZE = 9;
export const HANDLE_SOURCE_OUT = 2;
export const HANDLE_TARGET_IN = 3;

export const handleEnd = (rect: Rect, side: WireDirection, role: "source" | "target"): Point => {
  const out = HANDLE_SIZE / 2 + (role === "source" ? HANDLE_SOURCE_OUT : -HANDLE_TARGET_IN);
  switch (side) {
    case "left":
      return { x: rect.x - out, y: rect.y + rect.height / 2 };
    case "right":
      return { x: rect.x + rect.width + out, y: rect.y + rect.height / 2 };
    case "top":
      return { x: rect.x + rect.width / 2, y: rect.y - out };
    case "bottom":
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height + out };
  }
};

/** The SVG path the DOM draws for this route today; the old canvas and the track and pulse planners read it. */
export const routePath = (route: WireRoute): string =>
  route.rounding === "step" ? elbowPath(route.points, route.radius) : roundedOrthogonalPath(route.points, route.radius);

// ---------------------------------------------------------------------------
// The centreline
// ---------------------------------------------------------------------------

/**
 * A route flattened: `count` samples from source to target. `tx, ty` is the
 * unit tangent at each sample, `s` the distance walked along the samples to
 * it. Consecutive samples never coincide.
 */
export type WireLine = {
  readonly count: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly tx: Float64Array;
  readonly ty: Float64Array;
  readonly s: Float64Array;
  readonly length: number;
};

type Sample = { x: number; y: number; tx: number; ty: number };

const unit = (x: number, y: number): { x: number; y: number } | null => {
  const len = Math.hypot(x, y);
  return len > 1e-12 ? { x: x / len, y: y / len } : null;
};

/** Push a sharp or straight point; its tangent is the way in. */
const pushLine = (out: Sample[], x: number, y: number): void => {
  const last = out[out.length - 1];
  const dir = last ? unit(x - last.x, y - last.y) : null;
  out.push({ x, y, tx: dir?.x ?? last?.tx ?? 1, ty: dir?.y ?? last?.ty ?? 0 });
};

/** Push a quadratic corner from the last sample through control `c` to `to`, as flattenWirePath samples it. */
const pushQuad = (out: Sample[], c: Point, to: Point): void => {
  const from = out[out.length - 1]!;
  const fx = from.x;
  const fy = from.y;
  for (let step = 1; step <= CORNER_STEPS; step += 1) {
    const t = step / CORNER_STEPS;
    const u = 1 - t;
    const x = u * u * fx + 2 * u * t * c.x + t * t * to.x;
    const y = u * u * fy + 2 * u * t * c.y + t * t * to.y;
    const dir = unit(u * (c.x - fx) + t * (to.x - c.x), u * (c.y - fy) + t * (to.y - c.y));
    const prev = out[out.length - 1]!;
    out.push({ x, y, tx: dir?.x ?? prev.tx, ty: dir?.y ?? prev.ty });
  }
};

/** `roundedOrthogonalPath`'s geometry (wire-route.ts:128-160), as samples. */
const orthogonalSamples = (points: ReadonlyArray<Point>, radius: number): Sample[] => {
  const pts = simplifyPolyline(points);
  const out: Sample[] = [];
  if (pts.length === 0) return out;
  out.push({ x: pts[0]!.x, y: pts[0]!.y, tx: 1, ty: 0 });
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1]!;
    const curr = pts[i]!;
    const next = pts[i + 1]!;
    const d1x = curr.x - prev.x;
    const d1y = curr.y - prev.y;
    const d2x = next.x - curr.x;
    const d2y = next.y - curr.y;
    const len1 = Math.hypot(d1x, d1y) || 1;
    const len2 = Math.hypot(d2x, d2y) || 1;
    const r = Math.min(radius, len1 / 2, len2 / 2);
    pushLine(out, curr.x - (d1x / len1) * r, curr.y - (d1y / len1) * r);
    pushQuad(out, curr, { x: curr.x + (d2x / len2) * r, y: curr.y + (d2y / len2) * r });
  }
  if (pts.length > 1) pushLine(out, pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
  return out;
};

/** `getSmoothStepPath`'s geometry (elbow.ts `elbowPath`), as samples. */
const stepSamples = (points: ReadonlyArray<Point>, radius: number): Sample[] => {
  const out: Sample[] = [];
  if (points.length === 0) return out;
  out.push({ x: points[0]!.x, y: points[0]!.y, tx: 1, ty: 0 });
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const bend = elbowBend(a, b, c, radius);
    if (bend === null) {
      pushLine(out, b.x, b.y);
    } else if (a.y === b.y) {
      pushLine(out, b.x + bend * (a.x < c.x ? -1 : 1), b.y);
      pushQuad(out, b, { x: b.x, y: b.y + bend * (a.y < c.y ? 1 : -1) });
    } else {
      pushLine(out, b.x, b.y + bend * (a.y < c.y ? -1 : 1));
      pushQuad(out, b, { x: b.x + bend * (a.x < c.x ? 1 : -1), y: b.y });
    }
  }
  if (points.length > 1) pushLine(out, points[points.length - 1]!.x, points[points.length - 1]!.y);
  return out;
};

/** The route as its centreline. */
export const wireLine = (route: WireRoute): WireLine => {
  const raw =
    route.rounding === "step" ? stepSamples(route.points, route.radius) : orthogonalSamples(route.points, route.radius);
  // Drop samples that repeat the one before (a straight of zero length between two corners).
  const samples: Sample[] = [];
  for (const sample of raw) {
    const last = samples[samples.length - 1];
    if (last && last.x === sample.x && last.y === sample.y) continue;
    samples.push(sample);
  }
  // The first sample's tangent is the way out of it.
  if (samples.length > 1) {
    const dir = unit(samples[1]!.x - samples[0]!.x, samples[1]!.y - samples[0]!.y);
    if (dir) {
      samples[0]!.tx = dir.x;
      samples[0]!.ty = dir.y;
    }
  }
  const count = samples.length;
  const line = {
    count,
    x: new Float64Array(count),
    y: new Float64Array(count),
    tx: new Float64Array(count),
    ty: new Float64Array(count),
    s: new Float64Array(count),
    length: 0,
  };
  let walked = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = samples[i]!;
    if (i > 0) walked += Math.hypot(sample.x - samples[i - 1]!.x, sample.y - samples[i - 1]!.y);
    line.x[i] = sample.x;
    line.y[i] = sample.y;
    line.tx[i] = sample.tx;
    line.ty[i] = sample.ty;
    line.s[i] = walked;
  }
  line.length = walked;
  return line;
};

/** The point a distance `s` along the centreline, clamped to its ends. */
export const pointAt = (line: WireLine, s: number): Point => {
  if (line.count === 0) return { x: 0, y: 0 };
  if (s <= 0 || line.count === 1) return { x: line.x[0]!, y: line.y[0]! };
  for (let i = 1; i < line.count; i += 1) {
    if (s <= line.s[i]!) {
      const span = line.s[i]! - line.s[i - 1]!;
      const t = span > 0 ? (s - line.s[i - 1]!) / span : 0;
      return { x: line.x[i - 1]! + (line.x[i]! - line.x[i - 1]!) * t, y: line.y[i - 1]! + (line.y[i]! - line.y[i - 1]!) * t };
    }
  }
  return { x: line.x[line.count - 1]!, y: line.y[line.count - 1]! };
};
