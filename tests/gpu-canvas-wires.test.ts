import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routeWire, type WireDirection, type WireRect } from "../src/shared/wire-route";
import { wireSides } from "../src/shared/wire-sides";
import { themeRuntime } from "../src/shared/theme";
import { flattenWirePath, TRACK_PERIOD, TRACK_PERIOD_MS, TRACK_SCALE, trackRuns, trackHeight } from "../src/window/lib/flow-track";
import { planLoom, stitchStrand, type LoomEdgeInput, type LoomObstacle } from "../src/window/lib/wire-loom";
import { pulseMover, pulsePlan, WIRE_PULSE_MS, WIRE_PULSE_WIDTH } from "../src/window/lib/wire-pulse";
import type { WireMode } from "../src/window/canvas/contract";
import {
  buildStrip,
  buildTrackStrip,
  chooseRoute,
  cubicBezier,
  deriveBreath,
  elbowPath,
  elbowPoints,
  glowCoverage,
  glowHalfWidth,
  handleEnd,
  joinStrips,
  lineBounds,
  markCentres,
  pickWire,
  PULSE_HALF_WIDTH,
  pulseHold,
  pulseSpan,
  pulseToken,
  REST_VIEW,
  routeOfElbow,
  routeOfPlanned,
  routeOfStrand,
  routePath,
  STRIP_FLOATS,
  STRIP_STRIDE,
  stripTriangles,
  tokenRgba,
  trackLayout,
  trackPhase,
  trackTileSvg,
  viewOfMode,
  WIRE_HALF_WIDTH,
  WIRE_TOKEN,
  WIRE_UNSET_TOKEN,
  wireDistance,
  wireHit,
  wireLine,
  wirePaint,
  type WireLine,
  type WireRoute,
  type WireStrip,
} from "../src/window/canvas/paint/wires";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32), so a failing case can be replayed. */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Card = WireRect & { readonly id: string };

/** A board of cards on a jittered grid, never overlapping (pitch is wider than any card plus jitter). */
const board = (random: () => number, count: number): Card[] => {
  const sizes = [
    { width: 260, height: 96 },
    { width: 180, height: 120 },
    { width: 120, height: 64 },
    { width: 220, height: 150 },
  ];
  const cols = Math.ceil(Math.sqrt(count * 1.6));
  const cells = new Set<number>();
  const cards: Card[] = [];
  while (cards.length < count) {
    const cell = Math.floor(random() * cols * cols);
    if (cells.has(cell)) continue;
    cells.add(cell);
    const size = sizes[Math.floor(random() * sizes.length)]!;
    cards.push({
      id: `n${cards.length}`,
      x: (cell % cols) * 340 + Math.round(random() * 60) - 1200,
      y: Math.floor(cell / cols) * 230 + Math.round(random() * 40) - 900,
      ...size,
    });
  }
  return cards;
};

const sideMid = (rect: WireRect, side: WireDirection) => {
  switch (side) {
    case "left":
      return { x: rect.x, y: rect.y + rect.height / 2 };
    case "right":
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
    case "top":
      return { x: rect.x + rect.width / 2, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
  }
};

/** Exactly what planStandaloneRoutes asks the router for (loom-view.ts:196-210). */
const plan = (cards: ReadonlyArray<Card>, from: Card, to: Card) => {
  const sides = wireSides(from, to);
  return {
    sides,
    routed: routeWire({
      source: sideMid(from, sides.source),
      target: sideMid(to, sides.target),
      obstacles: cards.filter((card) => card !== from && card !== to),
      padding: 14,
      borderRadius: 8,
      sourceDirection: sides.source,
      targetDirection: sides.target,
    }),
  };
};

type Tri = readonly [number, number, number, number, number, number];

const trianglesOf = (strip: { readonly vertices: Float32Array; readonly count: number }): Tri[] => {
  const v = strip.vertices;
  const at = (i: number) => [v[i * STRIP_FLOATS]!, v[i * STRIP_FLOATS + 1]!] as const;
  return stripTriangles(strip.count)
    .map(([a, b, c]) => [...at(a), ...at(b), ...at(c)] as const)
    .filter(([ax, ay, bx, by, cx, cy]) => Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) > 1e-7);
};

/**
 * Two triangles share interior when no edge normal of either separates them
 * by more than `EPS` (separating axis theorem). A thousandth of a board unit
 * is far under a pixel at the closest zoom (2.5) and well over float32
 * rounding at board coordinates of a few thousand.
 */
const EPS = 1e-3;
const separated = (p: Tri, q: Tri): boolean => {
  for (const tri of [p, q]) {
    for (let e = 0; e < 3; e += 1) {
      const ax = tri[e * 2]!;
      const ay = tri[e * 2 + 1]!;
      const bx = tri[((e + 1) % 3) * 2]!;
      const by = tri[((e + 1) % 3) * 2 + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len === 0) continue;
      const nx = -(by - ay) / len;
      const ny = (bx - ax) / len;
      let pMin = Infinity;
      let pMax = -Infinity;
      let qMin = Infinity;
      let qMax = -Infinity;
      for (let k = 0; k < 3; k += 1) {
        const pp = p[k * 2]! * nx + p[k * 2 + 1]! * ny;
        const qq = q[k * 2]! * nx + q[k * 2 + 1]! * ny;
        pMin = Math.min(pMin, pp);
        pMax = Math.max(pMax, pp);
        qMin = Math.min(qMin, qq);
        qMax = Math.max(qMax, qq);
      }
      if (pMax - qMin <= EPS || qMax - pMin <= EPS) return true;
    }
  }
  return false;
};

/** Pairs of triangles of one strip that cover the same ground. */
const selfOverlaps = (strip: WireStrip): Array<[number, number]> => {
  const tris = trianglesOf(strip);
  const cell = 8;
  const grid = new Map<string, number[]>();
  const found: Array<[number, number]> = [];
  tris.forEach((tri, index) => {
    const xs = [tri[0], tri[2], tri[4]];
    const ys = [tri[1], tri[3], tri[5]];
    const seen = new Set<number>();
    for (let gx = Math.floor(Math.min(...xs) / cell); gx <= Math.floor(Math.max(...xs) / cell); gx += 1) {
      for (let gy = Math.floor(Math.min(...ys) / cell); gy <= Math.floor(Math.max(...ys) / cell); gy += 1) {
        const key = `${gx}:${gy}`;
        const bucket = grid.get(key) ?? [];
        for (const other of bucket) {
          if (seen.has(other)) continue;
          seen.add(other);
          if (!separated(tri, tris[other]!)) found.push([other, index]);
        }
        bucket.push(index);
        grid.set(key, bucket);
      }
    }
  });
  return found;
};

const samplesOf = (line: WireLine) =>
  Array.from({ length: line.count }, (_, i) => ({ x: line.x[i]!, y: line.y[i]! }));

/** flattenWirePath's points with exact repeats dropped, as wireLine keeps them. */
const flattened = (path: string) =>
  flattenWirePath(path).filter((p, i, all) => i === 0 || p.x !== all[i - 1]!.x || p.y !== all[i - 1]!.y);

/** Many routes from the real router over random boards, with the boards they came from. */
const routerRoutes = (() => {
  const out: Array<{ route: WireRoute; path: string; cards: Card[] }> = [];
  const random = prng(20261113);
  for (let b = 0; b < 40 && out.length < 400; b += 1) {
    const cards = board(random, 8 + Math.floor(random() * 10));
    for (let w = 0; w < 24; w += 1) {
      const from = cards[Math.floor(random() * cards.length)]!;
      const to = cards[Math.floor(random() * cards.length)]!;
      if (from === to) continue;
      const { routed } = plan(cards, from, to);
      if (routed) out.push({ route: routeOfPlanned(routed), path: routed.path, cards });
    }
  }
  return out;
})();

/** Elbows between random cards, ends where React Flow puts them. */
const elbowRoutes = (() => {
  const out: Array<{ route: WireRoute }> = [];
  const random = prng(7);
  for (let b = 0; b < 30; b += 1) {
    const cards = board(random, 10);
    for (let w = 0; w < 10; w += 1) {
      const from = cards[Math.floor(random() * cards.length)]!;
      const to = cards[Math.floor(random() * cards.length)]!;
      if (from === to) continue;
      const sides = wireSides(from, to);
      out.push({
        route: routeOfElbow({
          source: handleEnd(from, sides.source, "source"),
          sourceSide: sides.source,
          target: handleEnd(to, sides.target, "target"),
          targetSide: sides.target,
        }),
      });
    }
  }
  return out;
})();

/** Cable strands from the loom: right-side fans to columns of far cards, with blockers. */
const strandRoutes = (() => {
  const out: Array<{ route: WireRoute; path: string }> = [];
  const random = prng(99);
  for (let b = 0; b < 12; b += 1) {
    const fan = 3 + Math.floor(random() * 6);
    const hub = { x: 0, y: 0 };
    const edges: LoomEdgeInput[] = [];
    const obstacles: LoomObstacle[] = [{ nodeId: "hub", x: -260, y: -48, width: 260, height: 96 }];
    for (let i = 0; i < fan; i += 1) {
      const far = { x: 420 + Math.round(random() * 300), y: (i - fan / 2) * 140 + Math.round(random() * 30) };
      edges.push({
        id: `e${i}`,
        sourceNodeId: "hub",
        sourceSide: "right",
        sourceAnchor: hub,
        targetNodeId: `n${i}`,
        targetSide: "left",
        targetAnchor: far,
      });
      obstacles.push({ nodeId: `n${i}`, x: far.x, y: far.y - 48, width: 260, height: 96 });
    }
    if (random() < 0.6) obstacles.push({ nodeId: "block", x: 140, y: -60 + Math.round(random() * 60), width: 120, height: 80 });
    const loom = planLoom({ edges, obstacles });
    for (const edge of edges) {
      const strand = loom.strands.get(edge.id);
      if (!strand) continue;
      const stitch = stitchStrand(strand, {
        sourceX: edge.sourceAnchor.x,
        sourceY: edge.sourceAnchor.y + (random() - 0.5) * 2,
        targetX: edge.targetAnchor.x,
        targetY: edge.targetAnchor.y,
      });
      out.push({ route: routeOfStrand(stitch), path: stitch.path });
    }
  }
  return out;
})();

// React Flow's getSmoothStepPath (borderRadius 8, @xyflow/system 0.0.79) for
// a source at (10, 20) and every side pair, captured once so this test keeps
// holding after React Flow is deleted: [sourceSide, targetSide, targetX, targetY, path, labelX, labelY].
const RF_SMOOTH_STEP: ReadonlyArray<readonly [WireDirection, WireDirection, number, number, string, number, number]> = [
  ["left", "left", 310, 140, "M10 20L -2,20Q -10,20 -10,28L -10,132Q -10,140 -2,140L290 140L310 140", 140, 140],
  ["left", "left", -250, 60, "M10 20L-10 20L -262,20Q -270,20 -270,28L -270,52Q -270,60 -262,60L-250 60", -140, 20],
  ["left", "left", 10.4, 230, "M10 20L -2,20Q -10,20 -10,28L -10,222Q -10,230 -2,230L9.4 230L10.4 230", -10, 125],
  ["left", "left", 25, 23, "M10 20L -8.5,20Q -10,20 -10,21.5L -10,21.5Q -10,23 -8.5,23L10 23L25 23", 0, 23],
  ["left", "left", 150, 19.4, "M10 20L -9.7,20Q -10,20 -10,19.7L -10,19.7Q -10,19.4 -9.7,19.4L130 19.4L150 19.4", 60, 19.4],
  ["left", "left", -20, -160, "M10 20L-10 20L -32,20Q -40,20 -40,12L -40,-152Q -40,-160 -32,-160L-20 -160", -40, -70],
  ["left", "right", 310, 140, "M10 20L -2,20Q -10,20 -10,28L -10,72Q -10,80 -2,80L 322,80Q 330,80 330,88L 330,132Q 330,140 322,140L310 140", 160, 80],
  ["left", "right", -250, 60, "M10 20L-10 20L -112,20Q -120,20 -120,28L -120,52Q -120,60 -128,60L-230 60L-250 60", -120, 40],
  ["left", "right", 10.4, 230, "M10 20L -2,20Q -10,20 -10,28L -10,117Q -10,125 -2,125L 22.4,125Q 30.4,125 30.4,133L 30.4,222Q 30.4,230 22.4,230L10.4 230", 10.2, 125],
  ["left", "right", 25, 23, "M10 20L -9.25,20Q -10,20 -10,20.75L -10,20.75Q -10,21.5 -9.25,21.5L 44.25,21.5Q 45,21.5 45,22.25L 45,22.25Q 45,23 44.25,23L25 23", 17.5, 21.5],
  ["left", "right", 150, 19.4, "M10 20L -9.85,20Q -10,20 -10,19.85L -10,19.85Q -10,19.7 -9.85,19.7L 169.85,19.7Q 170,19.7 170,19.549999999999997L 170,19.549999999999997Q 170,19.4 169.85,19.4L150 19.4", 80, 19.7],
  ["left", "right", -20, -160, "M10 20L -2,20Q -10,20 -10,12L -10,-65Q -10,-70 -5,-70L -5,-70Q 0,-70 0,-75L 0,-152Q 0,-160 -8,-160L-20 -160", -5, -70],
  ["left", "top", 310, 140, "M10 20L -2,20Q -10,20 -10,28L -10,112Q -10,120 -2,120L 302,120Q 310,120 310,128L310 140", 150, 120],
  ["left", "top", -250, 60, "M10 20L-10 20L -242,20Q -250,20 -250,28L-250 40L-250 60", -130, 20],
  ["left", "top", 10.4, 230, "M10 20L -2,20Q -10,20 -10,28L -10,202Q -10,210 -2,210L 2.4000000000000004,210Q 10.4,210 10.4,218L10.4 230", -10, 115],
  ["left", "top", 25, 23, "M10 20L -2,20Q -10,20 -10,12L -10,11Q -10,3 -2,3L 17,3Q 25,3 25,11L25 23", 7.5, 3],
  ["left", "top", 150, 19.4, "M10 20L -2,20Q -10,20 -10,12L -10,7.399999999999999Q -10,-0.6000000000000014 -2,-0.6000000000000014L 142,-0.6000000000000014Q 150,-0.6000000000000014 150,7.399999999999999L150 19.4", 70, -0.6000000000000014],
  ["left", "top", -20, -160, "M10 20L -2,20Q -10,20 -10,12L -10,-175Q -10,-180 -15,-180L -15,-180Q -20,-180 -20,-175L-20 -160", -10, -80],
  ["left", "bottom", 310, 140, "M10 20L -2,20Q -10,20 -10,28L -10,152Q -10,160 -2,160L 302,160Q 310,160 310,152L310 140", 150, 160],
  ["left", "bottom", -250, 60, "M10 20L -2,20Q -10,20 -10,28L -10,72Q -10,80 -18,80L -242,80Q -250,80 -250,72L-250 60", -130, 80],
  ["left", "bottom", 10.4, 230, "M10 20L -2,20Q -10,20 -10,28L -10,242Q -10,250 -2,250L 2.4000000000000004,250Q 10.4,250 10.4,242L10.4 230", -10, 135],
  ["left", "bottom", 25, 23, "M10 20L -2,20Q -10,20 -10,28L -10,35Q -10,43 -2,43L 17,43Q 25,43 25,35L25 23", 7.5, 43],
  ["left", "bottom", 150, 19.4, "M10 20L -2,20Q -10,20 -10,28L -10,31.4Q -10,39.4 -2,39.4L 142,39.4Q 150,39.4 150,31.4L150 19.4", 70, 39.4],
  ["left", "bottom", -20, -160, "M10 20L-10 20L -15,20Q -20,20 -20,15L-20 -140L-20 -160", -20, -60],
  ["right", "left", 310, 140, "M10 20L30 20L 152,20Q 160,20 160,28L 160,132Q 160,140 168,140L290 140L310 140", 160, 80],
  ["right", "left", -250, 60, "M10 20L 22,20Q 30,20 30,28L 30,32Q 30,40 22,40L -262,40Q -270,40 -270,48L -270,52Q -270,60 -262,60L-250 60", -120, 40],
  ["right", "left", 10.4, 230, "M10 20L 22,20Q 30,20 30,28L 30,117Q 30,125 22,125L -1.5999999999999996,125Q -9.6,125 -9.6,133L -9.6,222Q -9.6,230 -1.5999999999999996,230L10.4 230", 10.2, 125],
  ["right", "left", 25, 23, "M10 20L 29.25,20Q 30,20 30,20.75L 30,20.75Q 30,21.5 29.25,21.5L 5.75,21.5Q 5,21.5 5,22.25L 5,22.25Q 5,23 5.75,23L25 23", 17.5, 21.5],
  ["right", "left", 150, 19.4, "M10 20L30 20L 79.7,20Q 80,20 80,19.7L 80,19.7Q 80,19.4 80.3,19.4L130 19.4L150 19.4", 80, 19.7],
  ["right", "left", -20, -160, "M10 20L 22,20Q 30,20 30,12L 30,-62Q 30,-70 22,-70L -32,-70Q -40,-70 -40,-78L -40,-152Q -40,-160 -32,-160L-20 -160", -5, -70],
  ["right", "right", 310, 140, "M10 20L30 20L 322,20Q 330,20 330,28L 330,132Q 330,140 322,140L310 140", 180, 20],
  ["right", "right", -250, 60, "M10 20L 22,20Q 30,20 30,28L 30,52Q 30,60 22,60L-230 60L-250 60", -100, 60],
  ["right", "right", 10.4, 230, "M10 20L11 20L 22.4,20Q 30.4,20 30.4,28L 30.4,222Q 30.4,230 22.4,230L10.4 230", 30.4, 125],
  ["right", "right", 25, 23, "M10 20L25 20L 43.5,20Q 45,20 45,21.5L 45,21.5Q 45,23 43.5,23L25 23", 35, 20],
  ["right", "right", 150, 19.4, "M10 20L30 20L 169.7,20Q 170,20 170,19.7L 170,19.7Q 170,19.4 169.7,19.4L150 19.4", 100, 20],
  ["right", "right", -20, -160, "M10 20L 22,20Q 30,20 30,12L 30,-152Q 30,-160 22,-160L0 -160L-20 -160", 30, -70],
  ["right", "top", 310, 140, "M10 20L30 20L 302,20Q 310,20 310,28L310 120L310 140", 170, 20],
  ["right", "top", -250, 60, "M10 20L 22,20Q 30,20 30,28L 30,32Q 30,40 22,40L -242,40Q -250,40 -250,48L-250 60", -110, 40],
  ["right", "top", 10.4, 230, "M10 20L 22,20Q 30,20 30,28L 30,202Q 30,210 22,210L 18.4,210Q 10.4,210 10.4,218L10.4 230", 30, 115],
  ["right", "top", 25, 23, "M10 20L 22,20Q 30,20 30,12L 30,5.5Q 30,3 27.5,3L 27.5,3Q 25,3 25,5.5L25 23", 30, 11.5],
  ["right", "top", 150, 19.4, "M10 20L 22,20Q 30,20 30,12L 30,7.399999999999999Q 30,-0.6000000000000014 38,-0.6000000000000014L 142,-0.6000000000000014Q 150,-0.6000000000000014 150,7.399999999999999L150 19.4", 90, -0.6000000000000014],
  ["right", "top", -20, -160, "M10 20L 22,20Q 30,20 30,12L 30,-172Q 30,-180 22,-180L -12,-180Q -20,-180 -20,-172L-20 -160", 30, -80],
  ["right", "bottom", 310, 140, "M10 20L 22,20Q 30,20 30,28L 30,152Q 30,160 38,160L 302,160Q 310,160 310,152L310 140", 170, 160],
  ["right", "bottom", -250, 60, "M10 20L 22,20Q 30,20 30,28L 30,72Q 30,80 22,80L -242,80Q -250,80 -250,72L-250 60", -110, 80],
  ["right", "bottom", 10.4, 230, "M10 20L 22,20Q 30,20 30,28L 30,242Q 30,250 22,250L 18.4,250Q 10.4,250 10.4,242L10.4 230", 30, 135],
  ["right", "bottom", 25, 23, "M10 20L 22,20Q 30,20 30,28L 30,40.5Q 30,43 27.5,43L 27.5,43Q 25,43 25,40.5L25 23", 30, 31.5],
  ["right", "bottom", 150, 19.4, "M10 20L 22,20Q 30,20 30,28L 30,31.4Q 30,39.4 38,39.4L 142,39.4Q 150,39.4 150,31.4L150 19.4", 90, 39.4],
  ["right", "bottom", -20, -160, "M10 20L 22,20Q 30,20 30,12L 30,-132Q 30,-140 22,-140L -12,-140Q -20,-140 -20,-148L-20 -160", 30, -60],
  ["top", "left", 310, 140, "M10 20L 10,8Q 10,0 18,0L 282,0Q 290,0 290,8L 290,132Q 290,140 298,140L310 140", 150, 0],
  ["top", "left", -250, 60, "M10 20L 10,8Q 10,0 2,0L -262,0Q -270,0 -270,8L -270,52Q -270,60 -262,60L-250 60", -130, 0],
  ["top", "left", 10.4, 230, "M10 20L 10,8Q 10,0 2,0L -1.5999999999999996,0Q -9.6,0 -9.6,8L -9.6,222Q -9.6,230 -1.5999999999999996,230L10.4 230", -9.6, 115],
  ["top", "left", 25, 23, "M10 20L 10,2.5Q 10,0 7.5,0L 7.5,0Q 5,0 5,2.5L 5,15Q 5,23 13,23L25 23", 5, 11.5],
  ["top", "left", 150, 19.4, "M10 20L 10,8Q 10,0 18,0L 122,0Q 130,0 130,8L 130,11.399999999999999Q 130,19.4 138,19.4L150 19.4", 70, 0],
  ["top", "left", -20, -160, "M10 20L 10,8Q 10,0 2,0L -32,0Q -40,0 -40,-8L -40,-152Q -40,-160 -32,-160L-20 -160", -40, -80],
  ["top", "right", 310, 140, "M10 20L 10,8Q 10,0 18,0L 322,0Q 330,0 330,8L 330,132Q 330,140 322,140L310 140", 170, 0],
  ["top", "right", -250, 60, "M10 20L 10,8Q 10,0 2,0L -222,0Q -230,0 -230,8L -230,52Q -230,60 -238,60L-250 60", -110, 0],
  ["top", "right", 10.4, 230, "M10 20L 10,8Q 10,0 18,0L 22.4,0Q 30.4,0 30.4,8L 30.4,222Q 30.4,230 22.4,230L10.4 230", 30.4, 115],
  ["top", "right", 25, 23, "M10 20L 10,8Q 10,0 18,0L 37,0Q 45,0 45,8L 45,15Q 45,23 37,23L25 23", 27.5, 0],
  ["top", "right", 150, 19.4, "M10 20L 10,8Q 10,0 18,0L 162,0Q 170,0 170,8L 170,11.399999999999999Q 170,19.4 162,19.4L150 19.4", 90, 0],
  ["top", "right", -20, -160, "M10 20L10 0L 10,-155Q 10,-160 5,-160L0 -160L-20 -160", 10, -80],
  ["top", "top", 310, 140, "M10 20L 10,8Q 10,0 18,0L 302,0Q 310,0 310,8L310 120L310 140", 160, 0],
  ["top", "top", -250, 60, "M10 20L 10,8Q 10,0 2,0L -242,0Q -250,0 -250,8L-250 40L-250 60", -120, 0],
  ["top", "top", 10.4, 230, "M10 20L 10,0.20000000000000018Q 10,0 10.2,0L 10.2,0Q 10.4,0 10.4,0.20000000000000018L10.4 210L10.4 230", 10.4, 105],
  ["top", "top", 25, 23, "M10 20L 10,7.5Q 10,0 17.5,0L 17.5,0Q 25,0 25,7.5L25 20L25 23", 25, 10],
  ["top", "top", 150, 19.4, "M10 20L10 19L 10,7.399999999999999Q 10,-0.6000000000000014 18,-0.6000000000000014L 142,-0.6000000000000014Q 150,-0.6000000000000014 150,7.399999999999999L150 19.4", 80, -0.6000000000000014],
  ["top", "top", -20, -160, "M10 20L10 0L 10,-172Q 10,-180 2,-180L -12,-180Q -20,-180 -20,-172L-20 -160", 10, -90],
  ["top", "bottom", 310, 140, "M10 20L 10,8Q 10,0 18,0L 152,0Q 160,0 160,8L 160,152Q 160,160 168,160L 302,160Q 310,160 310,152L310 140", 160, 80],
  ["top", "bottom", -250, 60, "M10 20L 10,8Q 10,0 2,0L -112,0Q -120,0 -120,8L -120,72Q -120,80 -128,80L -242,80Q -250,80 -250,72L-250 60", -120, 40],
  ["top", "bottom", 10.4, 230, "M10 20L 10,0.09999999999999964Q 10,0 10.1,0L 10.1,0Q 10.2,0 10.2,0.09999999999999964L 10.2,249.9Q 10.2,250 10.3,250L 10.3,250Q 10.4,250 10.4,249.9L10.4 230", 10.2, 125],
  ["top", "bottom", 25, 23, "M10 20L 10,3.75Q 10,0 13.75,0L 13.75,0Q 17.5,0 17.5,3.75L 17.5,39.25Q 17.5,43 21.25,43L 21.25,43Q 25,43 25,39.25L25 23", 17.5, 21.5],
  ["top", "bottom", 150, 19.4, "M10 20L 10,8Q 10,0 18,0L 72,0Q 80,0 80,8L 80,31.4Q 80,39.4 88,39.4L 142,39.4Q 150,39.4 150,31.4L150 19.4", 80, 19.7],
  ["top", "bottom", -20, -160, "M10 20L10 0L 10,-62Q 10,-70 2,-70L -12,-70Q -20,-70 -20,-78L-20 -140L-20 -160", -5, -70],
  ["bottom", "left", 310, 140, "M10 20L10 40L 10,132Q 10,140 18,140L290 140L310 140", 150, 140],
  ["bottom", "left", -250, 60, "M10 20L 10,32Q 10,40 2,40L -262,40Q -270,40 -270,48L -270,52Q -270,60 -262,60L-250 60", -130, 40],
  ["bottom", "left", 10.4, 230, "M10 20L 10,32Q 10,40 2,40L -1.5999999999999996,40Q -9.6,40 -9.6,48L -9.6,222Q -9.6,230 -1.5999999999999996,230L10.4 230", -9.6, 135],
  ["bottom", "left", 25, 23, "M10 20L 10,37.5Q 10,40 7.5,40L 7.5,40Q 5,40 5,37.5L 5,31Q 5,23 13,23L25 23", 5, 31.5],
  ["bottom", "left", 150, 19.4, "M10 20L 10,32Q 10,40 18,40L 122,40Q 130,40 130,32L 130,27.4Q 130,19.4 138,19.4L150 19.4", 70, 40],
  ["bottom", "left", -20, -160, "M10 20L 10,32Q 10,40 2,40L -32,40Q -40,40 -40,32L -40,-152Q -40,-160 -32,-160L-20 -160", -40, -60],
  ["bottom", "right", 310, 140, "M10 20L 10,32Q 10,40 18,40L 322,40Q 330,40 330,48L 330,132Q 330,140 322,140L310 140", 170, 40],
  ["bottom", "right", -250, 60, "M10 20L10 40L 10,52Q 10,60 2,60L-230 60L-250 60", -110, 60],
  ["bottom", "right", 10.4, 230, "M10 20L 10,32Q 10,40 18,40L 22.4,40Q 30.4,40 30.4,48L 30.4,222Q 30.4,230 22.4,230L10.4 230", 30.4, 135],
  ["bottom", "right", 25, 23, "M10 20L 10,32Q 10,40 18,40L 37,40Q 45,40 45,32L 45,31Q 45,23 37,23L25 23", 27.5, 40],
  ["bottom", "right", 150, 19.4, "M10 20L 10,32Q 10,40 18,40L 162,40Q 170,40 170,32L 170,27.4Q 170,19.4 162,19.4L150 19.4", 90, 40],
  ["bottom", "right", -20, -160, "M10 20L 10,35Q 10,40 5,40L 5,40Q 0,40 0,35L 0,-152Q 0,-160 -8,-160L-20 -160", 0, -60],
  ["bottom", "top", 310, 140, "M10 20L10 40L 10,72Q 10,80 18,80L 302,80Q 310,80 310,88L310 120L310 140", 160, 80],
  ["bottom", "top", -250, 60, "M10 20L 10,32Q 10,40 2,40L-120 40L-120 40L -242,40Q -250,40 -250,48L-250 60", -120, 40],
  ["bottom", "top", 10.4, 230, "M10 20L10 40L 10,124.8Q 10,125 10.2,125L 10.2,125Q 10.4,125 10.4,125.2L10.4 210L10.4 230", 10.2, 125],
  ["bottom", "top", 25, 23, "M10 20L 10,36.25Q 10,40 13.75,40L 13.75,40Q 17.5,40 17.5,36.25L 17.5,6.75Q 17.5,3 21.25,3L 21.25,3Q 25,3 25,6.75L25 23", 17.5, 21.5],
  ["bottom", "top", 150, 19.4, "M10 20L 10,32Q 10,40 18,40L 72,40Q 80,40 80,32L 80,7.399999999999999Q 80,-0.6000000000000014 88,-0.6000000000000014L 142,-0.6000000000000014Q 150,-0.6000000000000014 150,7.399999999999999L150 19.4", 80, 19.7],
  ["bottom", "top", -20, -160, "M10 20L 10,32.5Q 10,40 2.5,40L 2.5,40Q -5,40 -5,32.5L -5,-172.5Q -5,-180 -12.5,-180L -12.5,-180Q -20,-180 -20,-172.5L-20 -160", -5, -70],
  ["bottom", "bottom", 310, 140, "M10 20L10 40L 10,152Q 10,160 18,160L 302,160Q 310,160 310,152L310 140", 160, 160],
  ["bottom", "bottom", -250, 60, "M10 20L10 40L 10,72Q 10,80 2,80L -242,80Q -250,80 -250,72L-250 60", -120, 80],
  ["bottom", "bottom", 10.4, 230, "M10 20L10 40L 10,249.8Q 10,250 10.2,250L 10.2,250Q 10.4,250 10.4,249.8L10.4 230", 10, 145],
  ["bottom", "bottom", 25, 23, "M10 20L10 23L 10,35.5Q 10,43 17.5,43L 17.5,43Q 25,43 25,35.5L25 23", 10, 33],
  ["bottom", "bottom", 150, 19.4, "M10 20L 10,32Q 10,40 18,40L 142,40Q 150,40 150,32L150 20.4L150 19.4", 80, 40],
  ["bottom", "bottom", -20, -160, "M10 20L 10,32Q 10,40 2,40L -12,40Q -20,40 -20,32L-20 -140L-20 -160", -20, -50],
];

// ---------------------------------------------------------------------------
// Routes as points
// ---------------------------------------------------------------------------

describe("the elbow is React Flow's smooth step, as points", () => {
  it("draws the same path and label as getSmoothStepPath for every side pair", () => {
    for (const [sourceSide, targetSide, tx, ty, path, labelX, labelY] of RF_SMOOTH_STEP) {
      const elbow = elbowPoints({ source: { x: 10, y: 20 }, sourceSide, target: { x: tx, y: ty }, targetSide });
      expect(elbowPath(elbow.points), `${sourceSide} to ${targetSide} at ${tx},${ty}`).toBe(path);
      expect(elbow.label).toEqual({ x: labelX, y: labelY });
    }
  });

  it("applies a pair lane to both ends before bending", () => {
    const plain = routeOfElbow({ source: { x: 0, y: 0 }, sourceSide: "right", target: { x: 200, y: 80 }, targetSide: "left" });
    const laned = routeOfElbow(
      { source: { x: 0, y: 0 }, sourceSide: "right", target: { x: 200, y: 80 }, targetSide: "left" },
      { source: { x: 0, y: -7 }, target: { x: 0, y: 7 } },
    );
    expect(plain.points[0]).toEqual({ x: 0, y: 0 });
    expect(laned.points[0]).toEqual({ x: 0, y: -7 });
    expect(laned.points[laned.points.length - 1]).toEqual({ x: 200, y: 87 });
  });

  it("ends a wire where React Flow's handle box ends", () => {
    const rect = { x: 100, y: 200, width: 260, height: 96 };
    expect(handleEnd(rect, "right", "source")).toEqual({ x: 366.5, y: 248 });
    expect(handleEnd(rect, "left", "target")).toEqual({ x: 98.5, y: 248 });
    expect(handleEnd(rect, "top", "source")).toEqual({ x: 230, y: 193.5 });
    expect(handleEnd(rect, "bottom", "target")).toEqual({ x: 230, y: 297.5 });
  });
});

describe("routes as points", () => {
  it("keeps today's precedence: strand, then planned route, then elbow", () => {
    const elbow = { source: { x: 0, y: 0 }, sourceSide: "right" as const, target: { x: 300, y: 40 }, targetSide: "left" as const };
    const planned = routeWire({ source: { x: 0, y: 0 }, target: { x: 300, y: 40 }, obstacles: [{ x: 120, y: -30, width: 60, height: 120 }] })!;
    const stitch = strandRoutes[0]!;
    expect(chooseRoute({ elbow }).kind).toBe("elbow");
    expect(chooseRoute({ elbow, planned }).kind).toBe("route");
    expect(chooseRoute({ elbow, planned, strand: { path: stitch.path, tailPath: "", labelX: 0, labelY: 0, points: stitch.route.points } }).kind).toBe(
      "strand",
    );
    expect(routeOfPlanned(planned).label).toEqual({ x: planned.labelX, y: planned.labelY });
  });

  it("flattens a planned route to exactly the samples the DOM's track reads from its path", () => {
    expect(routerRoutes.length).toBeGreaterThan(200);
    for (const { route, path } of routerRoutes) {
      expect(routePath(route)).toBe(path);
      expect(samplesOf(wireLine(route))).toEqual(flattened(path));
    }
  });

  it("flattens strands and elbows the same way", () => {
    expect(strandRoutes.length).toBeGreaterThan(20);
    for (const { route, path } of strandRoutes) {
      expect(routePath(route)).toBe(path);
      expect(samplesOf(wireLine(route))).toEqual(flattened(path));
    }
    for (const { route } of elbowRoutes) expect(samplesOf(wireLine(route))).toEqual(flattened(routePath(route)));
  });

  it("walks the distance and unit tangents along the centreline", () => {
    for (const { route } of routerRoutes.slice(0, 50)) {
      const l = wireLine(route);
      for (let i = 1; i < l.count; i += 1) {
        expect(l.s[i]!).toBeGreaterThan(l.s[i - 1]!);
        expect(Math.hypot(l.tx[i]!, l.ty[i]!)).toBeCloseTo(1, 9);
      }
      expect(l.length).toBe(l.s[l.count - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Strips
// ---------------------------------------------------------------------------

describe("strips never overlap themselves", () => {
  const widths = [
    ["hairline", WIRE_HALF_WIDTH],
    ["pulse", PULSE_HALF_WIDTH],
    ["reduced-motion hold", 1.2],
  ] as const;

  for (const [name, half] of widths) {
    it(`for every router route, at the ${name} width`, () => {
      for (const { route } of routerRoutes) {
        const strip = buildStrip(wireLine(route), half);
        expect(strip.folded).toBe(false);
        expect(selfOverlaps(strip)).toEqual([]);
      }
    });
  }

  it("for every cable strand and every elbow between cards", () => {
    for (const { route } of [...strandRoutes, ...elbowRoutes]) {
      for (const half of [WIRE_HALF_WIDTH, PULSE_HALF_WIDTH]) {
        const strip = buildStrip(wireLine(route), half);
        expect(strip.folded).toBe(false);
        expect(selfOverlaps(strip)).toEqual([]);
      }
    }
  });

  it("where a jog is shorter than the stroke is wide, by cutting the inner fold", () => {
    // Two cards a hair off line: the elbow steps sideways by less than the hairline is wide.
    for (const jog of [0.05, 0.3, 0.6, 0.9, 1.2, 2, 3.5, 6]) {
      for (const half of [WIRE_HALF_WIDTH, PULSE_HALF_WIDTH, 4]) {
        const route = routeOfElbow({ source: { x: 0, y: 0 }, sourceSide: "right", target: { x: 240, y: jog }, targetSide: "left" });
        const strip = buildStrip(wireLine(route), half);
        expect(strip.folded, `jog ${jog} half ${half}`).toBe(false);
        expect(selfOverlaps(strip), `jog ${jog} half ${half}`).toEqual([]);
      }
    }
  });

  it("where the router doubles back on itself, covering the retraced run once", () => {
    /** Triangles of a strip holding a point strictly inside. */
    const cover = (strip: WireStrip, p: { x: number; y: number }) =>
      trianglesOf(strip).filter(([ax, ay, bx, by, cx, cy]) => {
        const d1 = (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax);
        const d2 = (cx - bx) * (p.y - by) - (cy - by) * (p.x - bx);
        const d3 = (ax - cx) * (p.y - cy) - (ay - cy) * (p.x - cx);
        return (d1 > 1e-9 && d2 > 1e-9 && d3 > 1e-9) || (d1 < -1e-9 && d2 < -1e-9 && d3 < -1e-9);
      }).length;
    // Real router output (seed 20261113): a stub past the target that returns to it, and a nub mid-wire.
    const end = routeOfPlanned({
      path: "", labelX: 0, labelY: 0, detoured: true,
      points: [{ x: -621, y: 127 }, { x: -537, y: 127 }, { x: -537, y: -552 }, { x: -39, y: -552 }, { x: -39, y: -518 }, { x: -39, y: -538 }],
    });
    const nub = routeOfPlanned({
      path: "", labelX: 0, labelY: 0, detoured: true,
      points: [{ x: -1101, y: 29 }, { x: -1101, y: 9 }, { x: -526, y: 9 }, { x: -526, y: 39 }, { x: -526, y: -843 }, { x: -482, y: -843 }],
    });
    for (const half of [WIRE_HALF_WIDTH, PULSE_HALF_WIDTH, 1.2]) {
      const a = buildStrip(wireLine(end), half);
      const b = buildStrip(wireLine(nub), half);
      expect(selfOverlaps(a)).toEqual([]);
      expect(selfOverlaps(b)).toEqual([]);
      // Down the stub and back: painted once, out to the cusp four units short of the corner.
      for (const y of [-540.3, -530.3, -522.6]) expect(cover(a, { x: -39.1, y }), `stub ${y} at ${half}`).toBe(1);
      expect(cover(a, { x: -39.1, y: -521.9 + half })).toBe(0);
      // The nub, the long run and the wire that joins them from the side, each once.
      for (const p of [{ x: -526.1, y: 30 }, { x: -526.1, y: 12 }, { x: -526.1, y: -400 }, { x: -600, y: 9.1 }, { x: -528.1, y: 11.1 }]) {
        expect(cover(b, p), `nub ${p.x},${p.y}`).toBe(1);
      }
    }
  });

  it("for a glow strip wider than the corner radius", () => {
    const route = routeOfPlanned(routeWire({ source: { x: 0, y: 0 }, target: { x: 300, y: 160 }, obstacles: [{ x: 100, y: -40, width: 80, height: 120 }] })!);
    const half = glowHalfWidth(wirePaint({ ...REST_VIEW, loupe: true }, { selected: true, hovered: false, inCone: false, verb: "messages" }).glow);
    expect(half).toBeGreaterThan(8);
    const strip = buildStrip(wireLine(route), half);
    expect(strip.folded).toBe(false);
    expect(selfOverlaps(strip)).toEqual([]);
  });
});

describe("strip geometry", () => {
  const corner = routeOfPlanned(
    routeWire({ source: { x: 0, y: 0 }, target: { x: 100, y: 100 }, obstacles: [{ x: 0, y: 20, width: 60, height: 60 }] })!,
  );

  it("documents a 28 byte vertex of seven floats", () => {
    expect(STRIP_FLOATS).toBe(7);
    expect(STRIP_STRIDE).toBe(28);
  });

  it("puts a cross-section at every sample plus one per round cap, plus side first", () => {
    const line = wireLine(corner);
    const strip = buildStrip(line, WIRE_HALF_WIDTH, { slot: 5 });
    expect(strip.count).toBe((line.count + 2) * 2);
    const v = strip.vertices;
    const vertex = (i: number) => Array.from(v.subarray(i * STRIP_FLOATS, (i + 1) * STRIP_FLOATS));
    // Caps: half a width past each end, `along` running on.
    expect(vertex(0)[4]).toBeCloseTo(-WIRE_HALF_WIDTH, 6);
    expect(vertex(strip.count - 1)[4]).toBeCloseTo(line.length + WIRE_HALF_WIDTH, 5);
    for (let k = 1; k <= line.count; k += 1) {
      const plus = vertex(k * 2);
      const minus = vertex(k * 2 + 1);
      const cx = line.x[k - 1]!;
      const cy = line.y[k - 1]!;
      expect(plus[5]).toBeCloseTo(WIRE_HALF_WIDTH, 6);
      expect(minus[5]).toBeCloseTo(-WIRE_HALF_WIDTH, 6);
      expect(plus[4]).toBeCloseTo(line.s[k - 1]!, 4);
      expect(plus[6]).toBe(5);
      // Every vertex sits half a width from its sample, along its extrude vector.
      expect(Math.hypot(plus[0]! - cx, plus[1]! - cy)).toBeCloseTo(WIRE_HALF_WIDTH, 4);
      expect(plus[0]!).toBeCloseTo(cx + plus[2]! * WIRE_HALF_WIDTH, 4);
      expect(minus[1]!).toBeCloseTo(cy + minus[3]! * WIRE_HALF_WIDTH, 4);
    }
  });

  it("rounds a corner with the router's radius and keeps the outer side on its arc", () => {
    const line = wireLine(corner);
    const strip = buildStrip(line, PULSE_HALF_WIDTH, { caps: "butt" });
    expect(strip.count).toBe(line.count * 2);
    // Corner samples are eight per corner and lie off the sharp polyline.
    const sharp = corner.points;
    expect(sharp.length).toBeGreaterThanOrEqual(3);
    expect(line.count).toBe(2 + (sharp.length - 2) * 9);
  });

  it("cuts the inner side of a tight jog to one shared point", () => {
    const route = routeOfElbow({ source: { x: 0, y: 0 }, sourceSide: "right", target: { x: 240, y: 0.6 }, targetSide: "left" });
    const strip = buildStrip(wireLine(route), PULSE_HALF_WIDTH);
    const v = strip.vertices;
    const plusPoints = new Set<string>();
    for (let i = 0; i < strip.count; i += 2) plusPoints.add(`${v[i * STRIP_FLOATS]},${v[i * STRIP_FLOATS + 1]}`);
    expect(plusPoints.size).toBeLessThan(strip.count / 2);
  });

  it("joins strips with zero-area triangles only", () => {
    const a = buildStrip(wireLine(routerRoutes[0]!.route), WIRE_HALF_WIDTH, { slot: 1 });
    const b = buildStrip(wireLine(routerRoutes[1]!.route), WIRE_HALF_WIDTH, { slot: 2 });
    const joined = joinStrips([a, b]);
    const count = joined.length / STRIP_FLOATS;
    expect(count).toBe(a.count + b.count + 2);
    expect(trianglesOf({ vertices: joined, count }).length).toBe(trianglesOf(a).length + trianglesOf(b).length);
  });
});

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

describe("style facts", () => {
  const look = { selected: false, hovered: false, inCone: false, verb: "messages" as const };

  it("paints each verb in its theme token, the one factory-grammar.css names", () => {
    const css = readFileSync("src/window/styles/factory-grammar.css", "utf8");
    for (const [verb, token] of Object.entries(WIRE_TOKEN)) {
      expect(css).toContain(`--wire-verb-${verb}: var(--color-${token});`);
    }
    expect(css).toContain(`--wire-verb-unset: var(--color-${WIRE_UNSET_TOKEN});`);
    for (const mode of ["dark", "bright"] as const) {
      const runtime = themeRuntime(mode);
      for (const token of [...Object.values(WIRE_TOKEN), WIRE_UNSET_TOKEN, pulseToken("notice"), pulseToken("prompt"), pulseToken("answer")]) {
        expect(runtime[token], `${mode} ${token}`).toBeDefined();
        const rgba = tokenRgba(token, mode);
        expect(rgba.every((c) => c >= 0 && c <= 1)).toBe(true);
      }
    }
    expect([pulseToken("notice"), pulseToken("prompt"), pulseToken("answer")]).toEqual(["violet", "amber-hi", "green"]);
  });

  it("gives today's opacity in every wire mode", () => {
    const table: Array<[WireMode, boolean, number]> = [
      ["rest", false, 0.07],
      ["loupe", false, 0.9],
      ["connecting", false, 0.9],
      ["cone", true, 1],
      ["cone", false, 0.07 * 0.12],
      ["far", false, 0.07 * 0.4],
      ["overview", false, 0],
    ];
    for (const [mode, inCone, opacity] of table) {
      expect(wirePaint(viewOfMode(mode), { ...look, inCone }).opacity, `${mode} ${inCone}`).toBeCloseTo(opacity, 10);
    }
    // The modes compose: the loupe at far, the loupe outside a cone.
    expect(wirePaint(viewOfMode("loupe", "far"), look).opacity).toBeCloseTo(0.9 * 0.4, 10);
    expect(wirePaint({ ...viewOfMode("cone"), loupe: true }, look).opacity).toBeCloseTo(0.9 * 0.12, 10);
    // Selected is always shown in full, but still steps back outside a cone.
    expect(wirePaint(viewOfMode("rest"), { ...look, selected: true }).opacity).toBe(1);
    expect(wirePaint(viewOfMode("cone"), { ...look, selected: true }).opacity).toBeCloseTo(0.12, 10);
    // A track's hairline is never painted; its track is, in its verb's ink.
    const flows = wirePaint(viewOfMode("loupe"), { ...look, verb: "flows" });
    expect(flows.opacity).toBe(0);
    expect(flows.track?.token).toBe("wire-flows");
    expect(wirePaint(viewOfMode("rest"), { ...look, verb: undefined }).token).toBe("wire-unset");
  });

  it("lets a wire take the pointer only in loupe or in the cone, never at overview unless it holds a track", () => {
    expect(wirePaint(viewOfMode("rest"), look).pickable).toBe(false);
    expect(wirePaint(viewOfMode("connecting"), look).pickable).toBe(false);
    expect(wirePaint(viewOfMode("loupe"), look).pickable).toBe(true);
    expect(wirePaint(viewOfMode("cone"), { ...look, inCone: true }).pickable).toBe(true);
    expect(wirePaint(viewOfMode("cone"), look).pickable).toBe(false);
    expect(wirePaint({ ...viewOfMode("loupe"), tier: "overview" }, look).pickable).toBe(false);
    expect(wirePaint({ ...viewOfMode("loupe"), tier: "overview" }, { ...look, verb: "derives" }).pickable).toBe(true);
  });

  it("glows in its own hue on hover and selection, from the GLOW tokens, faded with the wire", () => {
    expect(wirePaint(viewOfMode("loupe"), { ...look, hovered: true }).glow).toEqual([{ sigma: 2, alpha: 0.5 * 0.9 }]);
    expect(wirePaint(viewOfMode("rest"), { ...look, hovered: true }).glow).toEqual([]);
    expect(wirePaint(viewOfMode("rest"), { ...look, selected: true, hovered: true }).glow).toEqual([
      { sigma: 1, alpha: 1 },
      { sigma: 5, alpha: 0.6 },
    ]);
    const track = wirePaint(viewOfMode("rest"), { ...look, verb: "flows", selected: true });
    expect(track.glow).toEqual([]);
    expect(track.track?.glow).toEqual([{ sigma: 2, alpha: 0.6 }]);
    expect(glowCoverage(0, 0.6, 0)).toBe(1);
    expect(glowCoverage(0, 0.6, 1)).toBeGreaterThan(glowCoverage(2, 0.6, 1));
  });

  it("shows a pulse at near only, dimmed outside a cone", () => {
    expect(wirePaint(viewOfMode("rest"), look).pulseOpacity).toBe(1);
    expect(wirePaint(viewOfMode("rest", "mid"), look).pulseOpacity).toBe(0);
    expect(wirePaint(viewOfMode("cone"), look).pulseOpacity).toBe(0.12);
    expect(wirePaint(viewOfMode("cone"), { ...look, inCone: true }).pulseOpacity).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** A reference cubic-bezier solved by plain bisection to 1e-12, independent of ease.ts. */
const referenceBezier = (x1: number, y1: number, x2: number, y2: number) => (x: number) => {
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
};

describe("easing", () => {
  it("solves cubic-bezier as a browser does", () => {
    for (const curve of [
      [0.45, 0, 0.55, 1],
      [0.42, 0, 0.58, 1],
      [0.22, 0.61, 0.36, 1],
      [0, 0, 0.58, 1],
    ] as const) {
      const ease = cubicBezier(curve);
      const reference = referenceBezier(...(curve as [number, number, number, number]));
      for (let x = 0; x <= 1.0001; x += 0.01) expect(ease(x)).toBeCloseTo(reference(Math.min(1, x)), 6);
    }
  });
});

describe("track phase on the wall clock", () => {
  const route = routerRoutes.find(({ route }) => wireLine(route).length > 400)!.route;

  /**
   * Today's DOM, at document time `now`, for a run whose phase was synced at
   * `syncedAt` (FlowTrack.tsx:139-144, :90-96; flow-track.css:40-59): the
   * mover starts at `-(run.at % period) - period` with delay
   * `-round(syncedAt % 450)` ms and slides one period per 450 ms; each tile's
   * mark is centred half a period in. Mark centres along the wire, within the run.
   */
  const domCentres = (run: { at: number; length: number }, period: number, syncedAt: number, now: number, slides: boolean) => {
    const elapsed = now - syncedAt + Math.round(syncedAt % TRACK_PERIOD_MS);
    const progress = slides ? (elapsed % TRACK_PERIOD_MS) / TRACK_PERIOD_MS : 0;
    const left = -(run.at % period) - period + progress * period;
    const out: number[] = [];
    for (let k = 0; left + k * period + period / 2 <= run.length + 1e-9; k += 1) {
      const centre = left + k * period + period / 2;
      if (centre >= -1e-9) out.push(run.at + centre);
    }
    return out;
  };

  for (const tier of ["near", "mid", "far", "overview"] as const) {
    it(`puts every flows mark where the DOM does at a frozen clock, at ${tier}`, () => {
      const runs = trackLayout(route, tier);
      const period = TRACK_PERIOD * TRACK_SCALE[tier];
      expect(runs).toEqual(trackRuns(routePath(route), period, trackHeight(TRACK_SCALE[tier]) / 2));
      for (const now of [1_763_000_000_000, 1_763_000_000_123, 1_763_000_000_449, 1_763_000_017_777]) {
        for (const syncedAt of [now, now - 5_000, now - 1]) {
          const phase = trackPhase("flows", tier, now);
          for (const run of runs) {
            const ours = markCentres(phase, run.at, run.at + run.length);
            const dom = domCentres(run, period, syncedAt, now, true);
            expect(ours.length).toBe(dom.length);
            ours.forEach((centre, index) => expect(centre).toBeCloseTo(dom[index]!, 4));
          }
        }
      }
    });
  }

  it("holds derives marks still and breathes them 1, 0.4, 1 over 1600 ms, ease-in-out each half", () => {
    const base = 1_763_000_000_000 - (1_763_000_000_000 % 1600);
    const runs = trackLayout(route, "near");
    for (const run of runs) {
      expect(markCentres(trackPhase("derives", "near", base + 777), run.at, run.at + run.length)).toEqual(
        domCentres(run, TRACK_PERIOD, base, base + 777, false).map((c) => expect.closeTo(c, 4)),
      );
    }
    expect(trackPhase("derives", "near", base).opacity).toBeCloseTo(1, 9);
    expect(trackPhase("derives", "near", base + 400).opacity).toBeCloseTo(0.7, 9);
    expect(trackPhase("derives", "near", base + 800).opacity).toBeCloseTo(0.4, 9);
    expect(trackPhase("derives", "near", base + 1200).opacity).toBeCloseTo(0.7, 9);
    expect(deriveBreath(0.1)).toBeCloseTo(1 - 0.6 * referenceBezier(0.42, 0, 0.58, 1)(0.2), 6);
  });

  it("is continuous in time: never stepped", () => {
    let previous = trackPhase("flows", "near", 1_763_000_000_000).offset;
    for (let now = 1_763_000_000_000; now < 1_763_000_000_900; now += 1) {
      const offset = trackPhase("flows", "near", now + 1).offset;
      const step = (offset - previous + TRACK_PERIOD) % TRACK_PERIOD;
      expect(step).toBeCloseTo(TRACK_PERIOD / TRACK_PERIOD_MS, 4);
      previous = offset;
    }
  });

  it("stops where it starts under reduced motion", () => {
    expect(trackPhase("flows", "near", 1_763_000_000_123, true)).toEqual({ period: 18, offset: 9, opacity: 1 });
  });

  it("lays the track as one rectangle per run, carrying its fit, and its tile is today's art", () => {
    const runs = trackLayout(route, "far");
    const strip = buildTrackStrip(runs, "far", { slot: 3 });
    expect(strip.count).toBe(runs.length * 4 + (runs.length - 1) * 2);
    expect(strip.vertices[2]).toBe(3);
    expect(strip.vertices[4]).toBeCloseTo(runs[0]!.at, 4);
    expect(strip.vertices[5]).toBeCloseTo(trackHeight(3) / 2, 5);
    expect(trackTileSvg("near", 1, "flows")).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="18" height="12.4"/);
    expect(trackTileSvg("near", 1, "derives")).toContain("<path");
  });
});

describe("pulse phase on the wall clock", () => {
  const route = routerRoutes.find(({ route }) => wireLine(route).length > 300)!.route;
  const path = routePath(route);
  const domPlan = pulsePlan(path);
  const ease = referenceBezier(0.45, 0, 0.55, 1);

  /**
   * Today's DOM (WirePulseView.tsx:45-63, wire-pulse.css:26-47): each leg's
   * mover sits at `pulseMover().left` and translates `travel` times the eased
   * progress; the dash (caps included) is at its left edge. The dash's core
   * along the wire is the leg's `at` plus the mover's left plus half a weight.
   */
  const domSpan = (reverse: boolean, elapsed: number) => {
    const leg = domPlan.legs[0]!;
    const mover = pulseMover(domPlan, leg, reverse);
    const travel = mover.travel * ease(elapsed / WIRE_PULSE_MS) * (reverse ? -1 : 1);
    const from = leg.at + mover.left + WIRE_PULSE_WIDTH / 2 + travel;
    return { from, to: from + mover.dash - WIRE_PULSE_WIDTH };
  };

  it("runs the dash where the DOM does at a frozen clock, both ways", () => {
    const startedAt = 1_763_000_000_000;
    for (const reverse of [false, true]) {
      for (const elapsed of [0, 1, 90, 300, 450, 451, 600, 899]) {
        const ours = pulseSpan(domPlan.length, reverse, startedAt, startedAt + elapsed)!;
        const dom = domSpan(reverse, elapsed);
        expect(ours.from).toBeCloseTo(dom.from, 3);
        expect(ours.to).toBeCloseTo(dom.to, 3);
      }
    }
    // Forward it enters at the source end and leaves past the target end.
    expect(pulseSpan(domPlan.length, false, startedAt, startedAt)!.to).toBeCloseTo(0, 9);
    expect(pulseSpan(domPlan.length, false, startedAt, startedAt + 450)!.from).toBeCloseTo((domPlan.length * 0.84) / 2, 6);
    expect(pulseSpan(domPlan.length, false, startedAt, startedAt + WIRE_PULSE_MS)).toBeUndefined();
    expect(pulseSpan(domPlan.length, false, startedAt, startedAt - 1)).toBeUndefined();
  });

  it("measures the wire as the DOM's pulse planner does, to well under a unit", () => {
    expect(wireLine(route).length).toBeCloseTo(domPlan.length, 1);
  });

  it("holds the wire for 700 ms under reduced motion", () => {
    expect(pulseHold(0, 0)).toBe(0.85);
    expect(pulseHold(0, 699)).toBe(0.85);
    expect(pulseHold(0, 700)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

describe("wire picking", () => {
  const straight = routeOfPlanned({ path: "", labelX: 50, labelY: 0, detoured: false, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
  const line = wireLine(straight);

  it("measures distance to the centreline and how far along it the nearest point is", () => {
    expect(wireDistance(line, { x: 40, y: 7 })).toEqual({ distance: 7, along: 40, pastEnd: false });
    expect(wireDistance(line, { x: -3, y: 4 })).toEqual({ distance: 5, along: 0, pastEnd: true });
  });

  it("picks within half today's 20 unit hit stroke, butt ended", () => {
    expect(straight.hitHalfWidth).toBe(10);
    expect(wireHit(line, { x: 60, y: 10 }, straight.hitHalfWidth)).not.toBeNull();
    expect(wireHit(line, { x: 60, y: 10.01 }, straight.hitHalfWidth)).toBeNull();
    expect(wireHit(line, { x: -0.5, y: 0 }, straight.hitHalfWidth)).toBeNull();
    expect(wireHit(line, { x: 100.5, y: 0 }, straight.hitHalfWidth)).toBeNull();
  });

  it("picks a cable member only within its lane", () => {
    const member = strandRoutes[0]!.route;
    expect(member.hitHalfWidth).toBe(1.5);
    const l = wireLine(member);
    const mid = Math.floor(l.count / 2);
    const nx = -l.ty[mid]!;
    const ny = l.tx[mid]!;
    expect(wireHit(l, { x: l.x[mid]! + nx * 1.4, y: l.y[mid]! + ny * 1.4 }, member.hitHalfWidth)).not.toBeNull();
    expect(wireHit(l, { x: l.x[mid]! + nx * 1.6, y: l.y[mid]! + ny * 1.6 }, member.hitHalfWidth)).toBeNull();
  });

  it("measures round a corner, and the topmost of overlapping wires wins", () => {
    const corner = wireLine(routeOfPlanned({ path: "", labelX: 0, labelY: 0, detoured: false, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] }));
    // The sharp corner is cut by the quadratic: its midpoint is r / (2 sqrt 2) * 2 inside the corner.
    expect(wireDistance(corner, { x: 100, y: 0 }).distance).toBeCloseTo((8 * Math.SQRT2) / 4, 1);
    const parallel = wireLine(routeOfPlanned({ path: "", labelX: 0, labelY: 0, detoured: false, points: [{ x: 0, y: 7 }, { x: 100, y: 7 }] }));
    const candidates = [
      { id: "under", line, hitHalfWidth: 10, bounds: lineBounds(line) },
      { id: "over", line: parallel, hitHalfWidth: 10, bounds: lineBounds(parallel) },
    ];
    expect(pickWire(candidates, { x: 50, y: 1 })?.id).toBe("over");
    expect(pickWire(candidates, { x: 50, y: -5 })?.id).toBe("under");
    expect(pickWire(candidates, { x: 50, y: 40 })).toBeNull();
  });

  it("anchors the label where today's midpoint button sits", () => {
    expect(straight.label).toEqual({ x: 50, y: 0 });
  });
});
