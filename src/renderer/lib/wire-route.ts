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
  /** Handle side used to leave the source node, when known. */
  readonly sourceDirection?: WireDirection;
  /** Handle side used to enter the target node, when known. */
  readonly targetDirection?: WireDirection;
};

export type WireDirection = "left" | "right" | "top" | "bottom";

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
    if (Math.abs(p.x - prev.x) <= eps && Math.abs(p.y - prev.y) <= eps) continue;
    const before = out[out.length - 2];
    if (before) {
      const incomingX = prev.x - before.x;
      const incomingY = prev.y - before.y;
      const outgoingX = p.x - prev.x;
      const outgoingY = p.y - prev.y;
      const cross = incomingX * outgoingY - incomingY * outgoingX;
      const dot = incomingX * outgoingX + incomingY * outgoingY;
      if (Math.abs(cross) <= eps && dot > 0) {
        // Keep the far endpoint of a straight run; waypoint corners should
        // never leave a visible 8–10px notch in an otherwise straight wire.
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
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

function isStrictlyInside(point: WirePoint, rect: WireRect): boolean {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

function directionOf(a: WirePoint, b: WirePoint): WireDirection | null {
  if (Math.abs(a.x - b.x) >= Math.abs(a.y - b.y)) {
    if (b.x > a.x) return "right";
    if (b.x < a.x) return "left";
  }
  if (b.y > a.y) return "bottom";
  if (b.y < a.y) return "top";
  return null;
}

function runsAlongBoundary(a: WirePoint, b: WirePoint, rect: WireRect): boolean {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (a.y === b.y && (a.y === rect.y || a.y === bottom)) {
    return Math.max(a.x, b.x) > rect.x && Math.min(a.x, b.x) < right;
  }
  if (a.x === b.x && (a.x === rect.x || a.x === right)) {
    return Math.max(a.y, b.y) > rect.y && Math.min(a.y, b.y) < bottom;
  }
  return false;
}

function opposite(direction: WireDirection): WireDirection {
  switch (direction) {
    case "left":
      return "right";
    case "right":
      return "left";
    case "top":
      return "bottom";
    case "bottom":
      return "top";
  }
}

function compareScore(
  a: { readonly cost: number; readonly length: number },
  b: { readonly cost: number; readonly length: number },
): number {
  const costDelta = a.cost - b.cost;
  if (Math.abs(costDelta) > 1e-6) return costDelta;
  return a.length - b.length;
}

function candidatePads(padding: number): number[] {
  // A dense node cluster can be physically navigable while its inflated
  // clearance rectangles overlap. Prefer the normal moat, then deliberately
  // relax it in small, explicit steps before EtherEdge falls back to a path
  // that may sit on a node border.
  return [...new Set([padding, Math.min(padding, 8), Math.min(padding, 4), 0])];
}

type RoutePoint = WirePoint & { readonly key: string };

function pointKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function visibilityRoute(
  source: WirePoint,
  target: WirePoint,
  obstacles: ReadonlyArray<WireRect>,
  input: WireRouteInput,
  borderRadius: number,
): WireRouteResult | null {
  if (obstacles.length === 0) return null;

  const corridorPad = Math.max((input.padding ?? DEFAULT_PAD) * 2, 40);
  const cMinX = Math.min(source.x, target.x) - corridorPad;
  const cMaxX = Math.max(source.x, target.x) + corridorPad;
  const cMinY = Math.min(source.y, target.y) - corridorPad;
  const cMaxY = Math.max(source.y, target.y) + corridorPad;
  const relevant = obstacles.filter(
    (o) =>
      o.x + o.width >= cMinX &&
      o.x <= cMaxX &&
      o.y + o.height >= cMinY &&
      o.y <= cMaxY,
  );
  if (relevant.length === 0) return null;

  const pointsByKey = new Map<string, RoutePoint>();
  const addPoint = (x: number, y: number, force = false) => {
    const key = pointKey(x, y);
    if (pointsByKey.has(key)) return;
    if (!force && relevant.some((obstacle) => isStrictlyInside({ x, y }, obstacle))) return;
    pointsByKey.set(key, { x, y, key });
  };

  addPoint(source.x, source.y, true);
  addPoint(target.x, target.y, true);
  for (const obstacle of relevant) {
    addPoint(obstacle.x, obstacle.y);
    addPoint(obstacle.x + obstacle.width, obstacle.y);
    addPoint(obstacle.x, obstacle.y + obstacle.height);
    addPoint(obstacle.x + obstacle.width, obstacle.y + obstacle.height);
  }

  // A small directional lead keeps a detour from turning immediately at the
  // handle. These coordinates are also enough to express the usual XYFlow
  // bottom/left escape without introducing a tiny notch at a node border.
  const lead = Math.max(20, borderRadius * 2 + 4);
  if (input.sourceDirection === "left" || input.sourceDirection === "right") {
    addPoint(source.x + (input.sourceDirection === "right" ? lead : -lead), source.y);
  } else if (input.sourceDirection === "top" || input.sourceDirection === "bottom") {
    addPoint(source.x, source.y + (input.sourceDirection === "bottom" ? lead : -lead));
  }
  if (input.targetDirection === "left" || input.targetDirection === "right") {
    addPoint(target.x + (input.targetDirection === "left" ? -lead : lead), target.y);
  } else if (input.targetDirection === "top" || input.targetDirection === "bottom") {
    addPoint(target.x, target.y + (input.targetDirection === "top" ? -lead : lead));
  }

  // Endpoints are valid route anchors even when their requested clearance is
  // consumed by an adjacent node. The staged padding pass below handles the
  // short physical gap without silently abandoning the custom route.
  addPoint(source.x, source.y, true);
  addPoint(target.x, target.y, true);

  const points = [...pointsByKey.values()];
  const sourceIndex = points.findIndex((point) => point.key === pointKey(source.x, source.y));
  const targetIndex = points.findIndex((point) => point.key === pointKey(target.x, target.y));
  if (sourceIndex < 0 || targetIndex < 0) return null;

  type RouteStep = {
    readonly to: number;
    readonly points: WirePoint[];
  };
  const adjacency: RouteStep[][] = points.map(() => []);
  const addStep = (from: number, to: number, candidate: ReadonlyArray<WirePoint>) => {
    const path = simplifyPolyline(candidate);
    if (path.length < 2 || polylineHitsObstacles(path, relevant)) return;
    adjacency[from]!.push({ to, points: path.slice(1) });
  };
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      if (a.x === b.x || a.y === b.y) {
        addStep(i, j, [a, b]);
        addStep(j, i, [b, a]);
        continue;
      }
      // Every shortest rectilinear route can turn at one of these obstacle
      // corners (or at a handle lead). Keep both L orientations when clear;
      // the Dijkstra score chooses the one that respects the port directions.
      addStep(i, j, [a, { x: b.x, y: a.y }, b]);
      addStep(i, j, [a, { x: a.x, y: b.y }, b]);
      addStep(j, i, [b, { x: a.x, y: b.y }, a]);
      addStep(j, i, [b, { x: b.x, y: a.y }, a]);
    }
  }

  type State = {
    readonly point: number;
    readonly direction: WireDirection | null;
    readonly cost: number;
    readonly length: number;
    readonly edgePoints: WirePoint[];
    readonly previous: State | null;
  };
  const best = new Map<string, State>();
  const queue: State[] = [
    {
      point: sourceIndex,
      direction: null,
      cost: 0,
      length: 0,
      edgePoints: [],
      previous: null,
    },
  ];
  const pushQueue = (state: State) => {
    queue.push(state);
    let index = queue.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareScore(queue[parent]!, queue[index]!) <= 0) break;
      [queue[parent], queue[index]] = [queue[index]!, queue[parent]!];
      index = parent;
    }
  };
  const popQueue = (): State | undefined => {
    if (queue.length === 0) return undefined;
    const first = queue[0]!;
    const last = queue.pop()!;
    if (queue.length > 0) {
      queue[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < queue.length && compareScore(queue[left]!, queue[smallest]!) < 0) {
          smallest = left;
        }
        if (right < queue.length && compareScore(queue[right]!, queue[smallest]!) < 0) {
          smallest = right;
        }
        if (smallest === index) break;
        [queue[index], queue[smallest]] = [queue[smallest]!, queue[index]!];
        index = smallest;
      }
    }
    return first;
  };

  const stateKey = (point: number, direction: WireDirection | null): string =>
    `${point}:${direction ?? "none"}`;
  const portPenalty = 180;
  const bendPenalty = 72;
  const shortSegmentPenalty = 120;
  const boundaryPenalty = 260;
  const minInternalSegment = Math.max(borderRadius * 2, 14);

  while (queue.length > 0) {
    const current = popQueue()!;
    const currentKey = stateKey(current.point, current.direction);
    const recorded = best.get(currentKey);
    if (recorded && compareScore(recorded, current) <= 0) continue;
    best.set(currentKey, current);
    if (current.point === targetIndex) {
      // The first target state is the best one under the same score ordering.
      const states: State[] = [];
      let cursor: State | null = current;
      while (cursor) {
        states.push(cursor);
        cursor = cursor.previous;
      }
      states.reverse();
      const path: WirePoint[] = [source];
      for (const state of states.slice(1)) path.push(...state.edgePoints);
      const simplified = simplifyPolyline(path);
      if (simplified.length < 2 || polylineHitsObstacles(simplified, relevant)) continue;
      const hasAwkwardJog = simplified
        .slice(1, -1)
        .some((point, index) => {
          const previous = simplified[index]!;
          const next = simplified[index + 2]!;
          return (
            Math.hypot(point.x - previous.x, point.y - previous.y) < minInternalSegment ||
            Math.hypot(next.x - point.x, next.y - point.y) < minInternalSegment
          );
        });
      if (hasAwkwardJog) continue;
      const label = midpointOfPolyline(simplified);
      const direct = [
        [source, { x: target.x, y: source.y }, target],
        [source, { x: source.x, y: target.y }, target],
      ];
      const hasClearDirect = direct.some((candidate) => {
        const pointsForCandidate = simplifyPolyline(candidate);
        return !polylineHitsObstacles(pointsForCandidate, relevant);
      });
      return {
        path: roundedOrthogonalPath(simplified, borderRadius),
        labelX: label.x,
        labelY: label.y,
        detoured: !hasClearDirect,
      };
    }

    for (const step of adjacency[current.point]!) {
      let previousPoint: WirePoint = points[current.point]!;
      let direction = current.direction;
      let stepCost = 0;
      let stepLength = 0;
      let stepIndex = 0;
      for (const next of step.points) {
        const nextDirection = directionOf(previousPoint, next);
        if (!nextDirection) {
          stepIndex++;
          previousPoint = next;
          continue;
        }
        const length = Math.hypot(next.x - previousPoint.x, next.y - previousPoint.y);
        stepLength += length;
        stepCost +=
          length + (direction && direction !== nextDirection ? bendPenalty : 0);
        if (relevant.some((obstacle) => runsAlongBoundary(previousPoint, next, obstacle))) {
          // Padding-zero recovery is allowed to touch a boundary, but it is
          // never preferred over an equally short path that stays in the
          // open field. This keeps a wire from visually merging with a card.
          stepCost += boundaryPenalty;
        }
        if (
          length < minInternalSegment &&
          current.point !== sourceIndex &&
          !(step.to === targetIndex && stepIndex === step.points.length - 1)
        ) {
          stepCost += shortSegmentPenalty;
        }
        if (
          current.point === sourceIndex &&
          stepIndex === 0 &&
          input.sourceDirection &&
          nextDirection !== input.sourceDirection
        ) {
          stepCost += portPenalty;
        }
        if (
          step.to === targetIndex &&
          stepIndex === step.points.length - 1 &&
          input.targetDirection &&
          nextDirection !== opposite(input.targetDirection)
        ) {
          stepCost += portPenalty;
        }
        direction = nextDirection;
        previousPoint = next;
        stepIndex++;
      }
      if (!direction || stepLength <= 0) continue;
      const nextState: State = {
        point: step.to,
        direction,
        cost: current.cost + stepCost,
        length: current.length + stepLength,
        edgePoints: step.points,
        previous: current,
      };
      const existing = best.get(stateKey(step.to, direction));
      if (!existing || compareScore(nextState, existing) < 0) pushQueue(nextState);
    }
  }
  return null;
}

/**
 * Build a short, rounded Manhattan route through obstacle-corner visibility
 * points. When the normal clearance is impossible in a dense cluster, retry
 * with a deliberately smaller moat before the caller uses XYFlow's fallback.
 */
export function routeWire(input: WireRouteInput): WireRouteResult | null {
  const { source, target, obstacles } = input;
  const padding = Math.max(0, input.padding ?? DEFAULT_PAD);
  const radius = input.borderRadius ?? DEFAULT_RADIUS;
  for (const pad of candidatePads(padding)) {
    const inflated = obstacles
      .filter((o) => o.width > 0 && o.height > 0)
      .map((o) => inflateRect(o, pad));
    const routed = visibilityRoute(
      source,
      target,
      inflated,
      { ...input, padding: pad },
      radius,
    );
    if (routed) return routed;
  }
  return null;
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
