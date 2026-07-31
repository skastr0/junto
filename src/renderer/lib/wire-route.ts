/**
 * Orthogonal wire routing that skirts intermediate node bounds.
 *
 * Prefer a short Manhattan path that does not cross non-endpoint nodes.
 * Fall back to the caller's default smooth-step path when every candidate
 * still collides (dense clusters). Pure geometry — no React / xyflow.
 */

export type WirePoint = { readonly x: number; readonly y: number };

export type WireRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type WireRouteInput = {
  readonly source: WirePoint;
  readonly target: WirePoint;
  /** Intermediate node bounds to avoid (source/target already excluded). */
  readonly obstacles: ReadonlyArray<WireRect>;
  /** Clearance around each obstacle. Default 14. */
  readonly padding?: number;
  /** Corner radius for the SVG path. Default 8. */
  readonly borderRadius?: number;
};

export type WireRouteResult = {
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  /** True when a detour (non-straightest candidate) was chosen. */
  readonly detoured: boolean;
};

const DEFAULT_PAD = 14;
const DEFAULT_RADIUS = 8;

export function inflateRect(r: WireRect, pad: number): WireRect {
  return {
    x: r.x - pad,
    y: r.y - pad,
    width: r.width + pad * 2,
    height: r.height + pad * 2,
  };
}

/**
 * Axis-aligned segment vs AABB. Boundary-grazing is allowed (wires run on the
 * clearance edge after inflate). Interior crossings count as hits.
 */
export function segmentHitsRect(a: WirePoint, b: WirePoint, r: WireRect): boolean {
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  // Exterior (including pure exterior contact on a single corner/edge).
  if (maxX <= r.x || minX >= right || maxY <= r.y || minY >= bottom) {
    return false;
  }
  // Vertical interior line
  if (Math.abs(a.x - b.x) < 1e-6) {
    return a.x > r.x && a.x < right && maxY > r.y && minY < bottom;
  }
  // Horizontal interior line
  if (Math.abs(a.y - b.y) < 1e-6) {
    return a.y > r.y && a.y < bottom && maxX > r.x && minX < right;
  }
  // Non-orthogonal: treat remaining bbox overlap as a hit (orthogonal-only emitter).
  return true;
}

export function polylineHitsObstacles(
  points: ReadonlyArray<WirePoint>,
  obstacles: ReadonlyArray<WireRect>,
): boolean {
  if (points.length < 2 || obstacles.length === 0) return false;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (const o of obstacles) {
      if (segmentHitsRect(a, b, o)) return true;
    }
  }
  return false;
}

/** Drop near-duplicate consecutive points (snap noise). */
export function simplifyPolyline(points: ReadonlyArray<WirePoint>, eps = 0.5): WirePoint[] {
  if (points.length === 0) return [];
  const out: WirePoint[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = out[out.length - 1]!;
    if (Math.abs(p.x - prev.x) > eps || Math.abs(p.y - prev.y) > eps) {
      out.push(p);
    }
  }
  return out;
}

/** Rounded orthogonal SVG path from polyline waypoints. */
export function roundedOrthogonalPath(
  points: ReadonlyArray<WirePoint>,
  radius: number,
): string {
  const pts = simplifyPolyline(points);
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0]!.x} ${pts[0]!.y}`;
  if (pts.length === 2) {
    return `M ${pts[0]!.x},${pts[0]!.y} L ${pts[1]!.x},${pts[1]!.y}`;
  }

  let d = `M ${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
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
    const p1x = curr.x - (d1x / len1) * r;
    const p1y = curr.y - (d1y / len1) * r;
    const p2x = curr.x + (d2x / len2) * r;
    const p2y = curr.y + (d2y / len2) * r;
    d += ` L ${p1x},${p1y} Q ${curr.x},${curr.y} ${p2x},${p2y}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` L ${last.x},${last.y}`;
  return d;
}

function midpointOfPolyline(points: ReadonlyArray<WirePoint>): WirePoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  let total = 0;
  const segs: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push(len);
    total += len;
  }
  if (total <= 0) return points[0]!;
  let remain = total / 2;
  for (let i = 0; i < points.length - 1; i++) {
    const len = segs[i]!;
    if (remain <= len) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const t = len === 0 ? 0 : remain / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remain -= len;
  }
  return points[points.length - 1]!;
}

function polyLength(points: ReadonlyArray<WirePoint>): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/**
 * Build candidate Manhattan polylines ordered shortest-first among clear ones.
 * When none are clear, returns null so the caller can keep its default path.
 */
export function routeWire(input: WireRouteInput): WireRouteResult | null {
  const { source, target, obstacles } = input;
  const pad = input.padding ?? DEFAULT_PAD;
  const radius = input.borderRadius ?? DEFAULT_RADIUS;

  if (obstacles.length === 0) return null;

  const inflated = obstacles
    .filter((o) => o.width > 0 && o.height > 0)
    .map((o) => inflateRect(o, pad));

  // Only obstacles that sit near the source→target corridor matter.
  const corridorPad = Math.max(pad * 2, 40);
  const cMinX = Math.min(source.x, target.x) - corridorPad;
  const cMaxX = Math.max(source.x, target.x) + corridorPad;
  const cMinY = Math.min(source.y, target.y) - corridorPad;
  const cMaxY = Math.max(source.y, target.y) + corridorPad;
  const relevant = inflated.filter(
    (o) =>
      o.x + o.width >= cMinX &&
      o.x <= cMaxX &&
      o.y + o.height >= cMinY &&
      o.y <= cMaxY,
  );
  if (relevant.length === 0) return null;

  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;

  let unionMinX = Infinity;
  let unionMinY = Infinity;
  let unionMaxX = -Infinity;
  let unionMaxY = -Infinity;
  for (const o of relevant) {
    unionMinX = Math.min(unionMinX, o.x);
    unionMinY = Math.min(unionMinY, o.y);
    unionMaxX = Math.max(unionMaxX, o.x + o.width);
    unionMaxY = Math.max(unionMaxY, o.y + o.height);
  }

  const candidates: WirePoint[][] = [
    // Direct L / Z — prefer when free.
    [source, { x: target.x, y: source.y }, target],
    [source, { x: source.x, y: target.y }, target],
    [source, { x: midX, y: source.y }, { x: midX, y: target.y }, target],
    [source, { x: source.x, y: midY }, { x: target.x, y: midY }, target],
    // Skirt the obstacle union (wire around the cluster).
    [source, { x: source.x, y: unionMinY }, { x: target.x, y: unionMinY }, target],
    [source, { x: source.x, y: unionMaxY }, { x: target.x, y: unionMaxY }, target],
    [source, { x: unionMinX, y: source.y }, { x: unionMinX, y: target.y }, target],
    [source, { x: unionMaxX, y: source.y }, { x: unionMaxX, y: target.y }, target],
    // Two-step: exit vertically then hug top/bottom across then into target.
    [
      source,
      { x: source.x, y: unionMinY },
      { x: midX, y: unionMinY },
      { x: midX, y: target.y },
      target,
    ],
    [
      source,
      { x: source.x, y: unionMaxY },
      { x: midX, y: unionMaxY },
      { x: midX, y: target.y },
      target,
    ],
    [
      source,
      { x: unionMinX, y: source.y },
      { x: unionMinX, y: midY },
      { x: target.x, y: midY },
      target,
    ],
    [
      source,
      { x: unionMaxX, y: source.y },
      { x: unionMaxX, y: midY },
      { x: target.x, y: midY },
      target,
    ],
  ];

  type Ranked = { points: WirePoint[]; length: number; detoured: boolean };
  const clear: Ranked[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const points = simplifyPolyline(candidates[i]!);
    if (points.length < 2) continue;
    if (polylineHitsObstacles(points, relevant)) continue;
    clear.push({
      points,
      length: polyLength(points),
      // First four candidates are direct L/Z; the rest are deliberate detours.
      detoured: i >= 4,
    });
  }

  if (clear.length === 0) return null;

  clear.sort((a, b) => a.length - b.length);
  const best = clear[0]!;
  const label = midpointOfPolyline(best.points);
  return {
    path: roundedOrthogonalPath(best.points, radius),
    labelX: label.x,
    labelY: label.y,
    detoured: best.detoured,
  };
}

/** Bounds helpers for Flow / canvas nodes. */
export function nodeBounds(
  position: WirePoint,
  size: { readonly width: number; readonly height: number },
): WireRect {
  return {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  };
}
