/**
 * Wire loom — lane geometry for point-coincident edge fans.
 *
 * A node renders one handle per side per role, and every edge is pinned to one
 * handle pair. Two edges leaving the same node on the same side are therefore
 * measured off the same DOM handle and arrive with identical endpoints: a fan
 * is already gathered at the hub. The loom does not gather it. It lanes the
 * strands along a shared corridor, then combs them out near the far ends.
 *
 * Paint and geometry only — nothing here reads or writes grants, ports,
 * physics, or ether fields. Pure: no React / xyflow / observables.
 */

import {
  inflateRect,
  polylineHitsObstacles,
  roundedOrthogonalPath,
  simplifyPolyline,
} from "./wire-route";
import type { WireDirection, WirePoint, WireRect } from "./wire-route";

export type LoomEdgeInput = {
  readonly id: string;
  /** Stoppage paint (phase blocks / rippling). Ejected, but holds its lane. */
  readonly blocked: boolean;
  readonly sourceNodeId: string;
  readonly sourceSide: WireDirection;
  /** Node-derived and approximate; stitching uses the live endpoints. */
  readonly sourceAnchor: WirePoint;
  readonly targetNodeId: string;
  readonly targetSide: WireDirection;
  readonly targetAnchor: WirePoint;
};

export type LoomObstacle = WireRect & { readonly nodeId: string };

export type LoomStrand = {
  readonly edgeId: string;
  readonly bundleKey: string;
  readonly hubEnd: "source" | "target";
  /** Direction the trunk runs from the hub. */
  readonly hubAxis: WireDirection;
  /** 0..laneCount-1, ascending across the fan. */
  readonly laneIndex: number;
  /** Includes reserved holes for ejected strands. */
  readonly laneCount: number;
  /** Signed px, perpendicular to hubAxis. */
  readonly laneOffset: number;
  /** Axial px from the hub where this strand leaves the axis. */
  readonly splayAt: number;
  /** Axial px from the hub where this strand leaves the trunk. */
  readonly stationAt: number;
};

export type LoomPlan = {
  /** Emitted strands only, keyed by edge id. */
  readonly strands: ReadonlyMap<string, LoomStrand>;
  /** Trunk and comb bounds, for stoppage clearance. */
  readonly corridors: ReadonlyArray<WireRect>;
};

/** Two wires read as two wires; a cable starts at three. */
export const MIN_FAN = 3;
/** Canvas units, so a cable fuses below ~0.4 zoom and separates above 1.5. */
export const LANE_GAP = 3;
export const LANE_SPAN_MAX = 72;
export const STATION_GAP_MAX = 8;
/** Minimum axial run out of the hub before the first splay. */
export const LOOM_LEAD = 24;
export const SPLIT_BACKOFF = 48;
/** Px quantization for ordering and side classification. */
export const LOOM_QUANT = 4;
export const SPINE_RADIUS = 8;

/** Base obstacle clearance, matching the per-edge router's own moat. */
const LOOM_CLEARANCE = 14;
/** Short trunk lead-in so a tail overlay does not start on a bare corner. */
const TAIL_LEAD = 12;

type AxisFrame = { readonly u: WirePoint; readonly v: WirePoint };

function axisVectors(direction: WireDirection): AxisFrame {
  switch (direction) {
    case "right":
      return { u: { x: 1, y: 0 }, v: { x: 0, y: 1 } };
    case "left":
      return { u: { x: -1, y: 0 }, v: { x: 0, y: -1 } };
    case "bottom":
      return { u: { x: 0, y: 1 }, v: { x: -1, y: 0 } };
    case "top":
      return { u: { x: 0, y: -1 }, v: { x: 1, y: 0 } };
  }
}

function framePoint(hub: WirePoint, frame: AxisFrame, along: number, perp: number): WirePoint {
  return {
    x: hub.x + frame.u.x * along + frame.v.x * perp,
    y: hub.y + frame.u.y * along + frame.v.y * perp,
  };
}

function frameRect(
  hub: WirePoint,
  frame: AxisFrame,
  along: readonly [number, number],
  perp: readonly [number, number],
): WireRect {
  const corners = [
    framePoint(hub, frame, along[0], perp[0]),
    framePoint(hub, frame, along[1], perp[0]),
    framePoint(hub, frame, along[0], perp[1]),
    framePoint(hub, frame, along[1], perp[1]),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

function polylineMidpoint(points: ReadonlyArray<WirePoint>): WirePoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  const segments: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    segments.push(length);
    total += length;
  }
  if (total <= 0) return points[0]!;
  let remain = total / 2;
  for (let i = 0; i < points.length - 1; i++) {
    const length = segments[i]!;
    if (remain <= length) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const t = length === 0 ? 0 : remain / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remain -= length;
  }
  return points[points.length - 1]!;
}

function quantize(value: number): number {
  return Math.round(value / LOOM_QUANT);
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** `${nodeId}|${side}|${role}` — same node, different side is a different fan. */
export function bundleKey(nodeId: string, side: WireDirection, role: "s" | "t"): string {
  return `${nodeId}|${side}|${role}`;
}

type Candidate = {
  readonly edge: LoomEdgeInput;
  readonly hubEnd: "source" | "target";
  readonly key: string;
  readonly hubNodeId: string;
  readonly hubAxis: WireDirection;
  readonly hub: WirePoint;
  readonly farNodeId: string;
  readonly farSide: WireDirection;
  readonly far: WirePoint;
};

type Lane = {
  readonly candidate: Candidate;
  readonly along: number;
  readonly perp: number;
  readonly laneIndex: number;
  readonly laneOffset: number;
};

function candidatesOf(edge: LoomEdgeInput): readonly [Candidate, Candidate] {
  return [
    {
      edge,
      hubEnd: "source",
      key: bundleKey(edge.sourceNodeId, edge.sourceSide, "s"),
      hubNodeId: edge.sourceNodeId,
      hubAxis: edge.sourceSide,
      hub: edge.sourceAnchor,
      farNodeId: edge.targetNodeId,
      farSide: edge.targetSide,
      far: edge.targetAnchor,
    },
    {
      edge,
      hubEnd: "target",
      key: bundleKey(edge.targetNodeId, edge.targetSide, "t"),
      hubNodeId: edge.targetNodeId,
      hubAxis: edge.targetSide,
      hub: edge.targetAnchor,
      farNodeId: edge.sourceNodeId,
      farSide: edge.sourceSide,
      far: edge.sourceAnchor,
    },
  ];
}

/** The far handle must face back down the hub axis for a clean orthogonal entry. */
function entersCleanly(farSide: WireDirection, frame: AxisFrame): boolean {
  const face = axisVectors(farSide).u;
  return face.x * frame.u.x + face.y * frame.u.y < 0;
}

function obstacleField(
  obstacles: ReadonlyArray<LoomObstacle>,
  excluded: ReadonlySet<string>,
  pad: number,
): WireRect[] {
  return obstacles
    .filter((o) => o.width > 0 && o.height > 0 && !excluded.has(o.nodeId))
    .map((o) => inflateRect(o, pad));
}

type FanPlan = {
  readonly strands: ReadonlyArray<LoomStrand>;
  readonly corridors: ReadonlyArray<WireRect>;
};

function planFan(
  key: string,
  members: ReadonlyArray<Candidate>,
  obstacles: ReadonlyArray<LoomObstacle>,
): FanPlan | null {
  // The bundle shares one DOM handle, so any member's anchor is the hub. Pick
  // it by edge id so a shuffled input cannot change the plan.
  const anchorOf = [...members].sort((a, b) => compareIds(a.edge.id, b.edge.id))[0]!;
  const hub = anchorOf.hub;
  const hubAxis = anchorOf.hubAxis;
  const hubNodeId = anchorOf.hubNodeId;
  const frame = axisVectors(hubAxis);

  const placed = members
    .map((candidate) => {
      const dx = candidate.far.x - hub.x;
      const dy = candidate.far.y - hub.y;
      return {
        candidate,
        along: dx * frame.u.x + dy * frame.u.y,
        perp: dx * frame.v.x + dy * frame.v.y,
      };
    })
    .sort((a, b) => {
      const perpDelta = quantize(a.perp) - quantize(b.perp);
      if (perpDelta !== 0) return perpDelta;
      const alongDelta = quantize(a.along) - quantize(b.along);
      if (alongDelta !== 0) return alongDelta;
      return compareIds(a.candidate.edge.id, b.candidate.edge.id);
    });

  // Lanes are assigned over every candidate, blocked included: a wire entering
  // stoppage leaves its hole rather than reshuffling the cable.
  const laneCount = placed.length;
  const laneGap = Math.min(LANE_GAP, LANE_SPAN_MAX / Math.max(1, laneCount - 1));
  const lanes: Lane[] = placed.map((p, laneIndex) => ({
    ...p,
    laneIndex,
    laneOffset: (laneIndex - (laneCount - 1) / 2) * laneGap,
  }));

  const eligible = lanes.filter(
    (lane) =>
      !lane.candidate.edge.blocked &&
      entersCleanly(lane.candidate.farSide, frame) &&
      lane.along > LOOM_LEAD + SPLIT_BACKOFF,
  );
  if (eligible.length < MIN_FAN) return null;

  const trunkEnd = Math.min(...eligible.map((lane) => lane.along)) - SPLIT_BACKOFF;
  if (trunkEnd <= LOOM_LEAD) return null;

  const maxOffset = ((laneCount - 1) / 2) * laneGap;
  const maxSplay = LOOM_LEAD + maxOffset;

  // Extreme perp takes the outermost lane and the earliest turn. Both are
  // monotone in the same direction, which is what keeps the comb planar.
  const minus = eligible.filter((lane) => quantize(lane.perp) < 0);
  const plus = eligible.filter((lane) => quantize(lane.perp) >= 0);
  const maxGroup = Math.max(minus.length, plus.length);
  const stationGap = clamp(
    (trunkEnd - LOOM_LEAD) / Math.max(1, maxGroup - 1),
    laneGap,
    STATION_GAP_MAX,
  );
  const minStation = trunkEnd - (maxGroup - 1) * stationGap;
  if (minStation <= maxSplay) return null;

  const stationOf = new Map<string, number>();
  for (const group of [minus, plus]) {
    const ranked = [...group].sort((a, b) => {
      const extremeDelta = Math.abs(b.perp) - Math.abs(a.perp);
      if (Math.abs(extremeDelta) > 1e-6) return extremeDelta;
      return a.laneIndex - b.laneIndex;
    });
    ranked.forEach((lane, rank) => {
      stationOf.set(lane.candidate.edge.id, trunkEnd - (group.length - 1 - rank) * stationGap);
    });
  }

  const splayOf = (lane: Lane): number => LOOM_LEAD + Math.abs(lane.laneOffset);
  const tailOf = (lane: Lane): WirePoint[] => {
    const station = stationOf.get(lane.candidate.edge.id)!;
    return [
      framePoint(hub, frame, station, lane.laneOffset),
      framePoint(hub, frame, station, lane.perp),
      framePoint(hub, frame, lane.along, lane.perp),
    ];
  };

  // Straight-spine clearance oracle. v1 has no bent spine: any hit dissolves
  // the whole fan and every member falls back to the per-edge router.
  const pad = LOOM_CLEARANCE + Math.ceil(maxOffset);
  const fanExcluded = new Set<string>([hubNodeId, ...members.map((m) => m.farNodeId)]);
  const fanField = obstacleField(obstacles, fanExcluded, pad);
  const combMinPerp = Math.min(-maxOffset, ...eligible.map((lane) => lane.perp));
  const combMaxPerp = Math.max(maxOffset, ...eligible.map((lane) => lane.perp));
  const combBox = frameRect(hub, frame, [minStation, trunkEnd], [combMinPerp, combMaxPerp]);
  const ribbon: WirePoint[][] = [
    [framePoint(hub, frame, 0, maxOffset), framePoint(hub, frame, trunkEnd, maxOffset)],
    [framePoint(hub, frame, 0, -maxOffset), framePoint(hub, frame, trunkEnd, -maxOffset)],
    [
      { x: combBox.x, y: combBox.y },
      { x: combBox.x + combBox.width, y: combBox.y },
      { x: combBox.x + combBox.width, y: combBox.y + combBox.height },
      { x: combBox.x, y: combBox.y + combBox.height },
      { x: combBox.x, y: combBox.y },
    ],
    ...eligible.map(tailOf),
  ];
  if (ribbon.some((line) => polylineHitsObstacles(line, fanField))) return null;

  // A single tail that still collides ejects on its own; the cable holds.
  const emitted = eligible.filter((lane) => {
    const excluded = new Set<string>([hubNodeId, lane.candidate.farNodeId]);
    return !polylineHitsObstacles(tailOf(lane), obstacleField(obstacles, excluded, pad));
  });
  if (emitted.length < MIN_FAN) return null;

  const strands = emitted.map((lane) => ({
    edgeId: lane.candidate.edge.id,
    bundleKey: key,
    hubEnd: lane.candidate.hubEnd,
    hubAxis,
    laneIndex: lane.laneIndex,
    laneCount,
    laneOffset: lane.laneOffset,
    splayAt: splayOf(lane),
    stationAt: stationOf.get(lane.candidate.edge.id)!,
  }));

  const trunkBox = frameRect(hub, frame, [0, trunkEnd], [-maxOffset, maxOffset]);
  return { strands, corridors: [trunkBox, combBox] };
}

/**
 * Lane every fan that reads as a cable, and report the corridors it occupies.
 * Membership depends only on handle keys, unblocked counts, and doc topology,
 * so a drag can never change it; identical geometry gives identical output.
 */
export function planLoom(input: {
  readonly edges: ReadonlyArray<LoomEdgeInput>;
  readonly obstacles: ReadonlyArray<LoomObstacle>;
}): LoomPlan {
  const candidates = new Map<string, Candidate[]>();
  const paired: Array<readonly [Candidate, Candidate]> = [];
  for (const edge of input.edges) {
    const pair = candidatesOf(edge);
    paired.push(pair);
    for (const candidate of pair) {
      const bucket = candidates.get(candidate.key);
      if (bucket) bucket.push(candidate);
      else candidates.set(candidate.key, [candidate]);
    }
  }

  // Candidate counts are fixed before membership resolves, so the tie-break
  // never depends on the order edges happen to be visited in.
  const unblocked = new Map<string, number>();
  for (const [key, bucket] of candidates) {
    unblocked.set(key, bucket.filter((c) => !c.edge.blocked).length);
  }

  const fans = new Map<string, Candidate[]>();
  for (const [source, target] of paired) {
    const sourceCount = unblocked.get(source.key) ?? 0;
    const targetCount = unblocked.get(target.key) ?? 0;
    let winner: Candidate;
    if (sourceCount !== targetCount) winner = sourceCount > targetCount ? source : target;
    else winner = compareIds(source.key, target.key) <= 0 ? source : target;
    const bucket = fans.get(winner.key);
    if (bucket) bucket.push(winner);
    else fans.set(winner.key, [winner]);
  }

  const strands = new Map<string, LoomStrand>();
  const corridors: WireRect[] = [];
  for (const key of [...fans.keys()].sort(compareIds)) {
    const planned = planFan(key, fans.get(key)!, input.obstacles);
    if (!planned) continue;
    for (const strand of planned.strands) strands.set(strand.edgeId, strand);
    corridors.push(...planned.corridors);
  }
  return { strands, corridors };
}

export type LoomStitch = {
  readonly path: string;
  /** Last leg only — where the word bed and the effect signal are legible. */
  readonly tailPath: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly points: ReadonlyArray<WirePoint>;
};

/**
 * Rebuild a planned strand against the live endpoints. The hub-side lead is
 * projected onto the hub axis, which absorbs the few-px delta between the
 * node-derived anchor the plan used and the DOM-measured handle centre. The
 * emitted path always runs source to target.
 */
export function stitchStrand(
  strand: LoomStrand,
  ends: {
    readonly sourceX: number;
    readonly sourceY: number;
    readonly targetX: number;
    readonly targetY: number;
  },
): LoomStitch {
  const source: WirePoint = { x: ends.sourceX, y: ends.sourceY };
  const target: WirePoint = { x: ends.targetX, y: ends.targetY };
  const fromTarget = strand.hubEnd === "target";
  const hub = fromTarget ? target : source;
  const far = fromTarget ? source : target;
  const frame = axisVectors(strand.hubAxis);
  const dx = far.x - hub.x;
  const dy = far.y - hub.y;
  const perp = dx * frame.v.x + dy * frame.v.y;

  const spine: WirePoint[] = [
    hub,
    framePoint(hub, frame, strand.splayAt, 0),
    framePoint(hub, frame, strand.splayAt, strand.laneOffset),
    framePoint(hub, frame, strand.stationAt, strand.laneOffset),
    framePoint(hub, frame, strand.stationAt, perp),
    far,
  ];
  const lead = Math.max(0, Math.min(TAIL_LEAD, strand.stationAt - strand.splayAt));
  const tail: WirePoint[] = [
    framePoint(hub, frame, strand.stationAt - lead, strand.laneOffset),
    framePoint(hub, frame, strand.stationAt, strand.laneOffset),
    framePoint(hub, frame, strand.stationAt, perp),
    far,
  ];

  const points = simplifyPolyline(fromTarget ? [...spine].reverse() : spine);
  const tailPoints = simplifyPolyline(fromTarget ? [...tail].reverse() : tail);
  const label = polylineMidpoint(tailPoints);
  return {
    path: roundedOrthogonalPath(points, SPINE_RADIUS),
    tailPath: roundedOrthogonalPath(tailPoints, SPINE_RADIUS),
    labelX: label.x,
    labelY: label.y,
    points,
  };
}
