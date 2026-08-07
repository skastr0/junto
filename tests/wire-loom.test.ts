import { describe, expect, it } from "vitest";
import {
  corridorsClearOf,
  LANE_GAP,
  LOOM_LEAD,
  planLoom,
  stitchStrand,
  type LoomEdgeInput,
  type LoomObstacle,
  type LoomPlan,
  type LoomStrand,
} from "../src/renderer/lib/wire-loom";
import { routeWire } from "../src/renderer/lib/wire-route";
import type { WirePoint, WireRect } from "../src/renderer/lib/wire-route";

const HUB: WirePoint = { x: 0, y: 0 };

/** One member of a right-side source fan on the node "hub". */
function fanEdge(
  id: string,
  farNodeId: string,
  far: WirePoint,
  blocked = false,
): LoomEdgeInput {
  return {
    id,
    blocked,
    sourceNodeId: "hub",
    sourceSide: "right",
    sourceAnchor: HUB,
    targetNodeId: farNodeId,
    targetSide: "left",
    targetAnchor: far,
  };
}

/** A right-side fan whose far endpoints sit at x=400, spread over y. */
function fanOf(ys: ReadonlyArray<number>): LoomEdgeInput[] {
  return ys.map((y, index) => fanEdge(`e${index}`, `n${index}`, { x: 400, y }));
}

const FIVE_FAN_YS = [-200, -100, 0, 100, 200] as const;

function entriesOf(plan: LoomPlan): Array<readonly [string, LoomStrand]> {
  return [...plan.strands.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function byLane(plan: LoomPlan): LoomStrand[] {
  return [...plan.strands.values()].sort((a, b) => a.laneIndex - b.laneIndex);
}

function contains(rect: { x: number; y: number; width: number; height: number }, p: WirePoint) {
  return (
    p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
  );
}

type Segment = { readonly a: WirePoint; readonly b: WirePoint; readonly edgeId: string };

function turn(o: WirePoint, a: WirePoint, b: WirePoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Transversal intersection only — a shared point or a collinear run is not a crossing. */
function crosses(s: Segment, t: Segment): boolean {
  const d1 = turn(s.a, s.b, t.a);
  const d2 = turn(s.a, s.b, t.b);
  const d3 = turn(t.a, t.b, s.a);
  const d4 = turn(t.a, t.b, s.b);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/** Every strand of the fan, stitched against its own far endpoint. */
function fanSegments(ys: ReadonlyArray<number>): Segment[] {
  const plan = planLoom({ edges: fanOf(ys), obstacles: [] });
  expect(plan.strands.size).toBe(ys.length);
  const out: Segment[] = [];
  for (const [edgeId, strand] of plan.strands) {
    const stitched = stitchStrand(strand, {
      sourceX: HUB.x,
      sourceY: HUB.y,
      targetX: 400,
      targetY: ys[Number(edgeId.slice(1))]!,
    });
    for (let i = 0; i < stitched.points.length - 1; i++) {
      out.push({ a: stitched.points[i]!, b: stitched.points[i + 1]!, edgeId });
    }
  }
  return out;
}

function crossingCount(segments: ReadonlyArray<Segment>): number {
  let found = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const s = segments[i]!;
      const t = segments[j]!;
      if (s.edgeId === t.edgeId) continue;
      if (crosses(s, t)) found++;
    }
  }
  return found;
}

/** A three-member right-side fan hubbed on `nodeId`, far endpoints at x=700. */
function fanFrom(nodeId: string, hub: WirePoint): LoomEdgeInput[] {
  return [-100, 0, 100].map((offset, index) => ({
    id: `${nodeId}${index}`,
    blocked: false,
    sourceNodeId: nodeId,
    sourceSide: "right",
    sourceAnchor: hub,
    targetNodeId: `${nodeId}n${index}`,
    targetSide: "left",
    targetAnchor: { x: 700, y: hub.y + offset },
  }));
}

describe("wire-loom planning", () => {
  it("needs three unblocked members before a fan becomes a cable", () => {
    const two = planLoom({ edges: fanOf([-100, 100]), obstacles: [] });
    expect(two.strands.size).toBe(0);

    const three = planLoom({ edges: fanOf([-100, 0, 100]), obstacles: [] });
    expect(three.strands.size).toBe(3);
  });

  it("groups by node, side and role", () => {
    const right = fanOf([-100, 0, 100]);
    const bottom = [-100, 0, 100].map((x, index): LoomEdgeInput => ({
      id: `b${index}`,
      blocked: false,
      sourceNodeId: "hub",
      sourceSide: "bottom",
      sourceAnchor: HUB,
      targetNodeId: `m${index}`,
      targetSide: "top",
      targetAnchor: { x, y: 400 },
    }));

    const plan = planLoom({ edges: [...right, ...bottom], obstacles: [] });
    expect(plan.strands.size).toBe(6);
    expect(plan.strands.get("e0")!.bundleKey).toBe("hub|right|s");
    expect(plan.strands.get("b0")!.bundleKey).toBe("hub|bottom|s");
    // Same node, different side is a different fan — never one shared cable.
    expect(plan.strands.get("e0")!.bundleKey).not.toBe(plan.strands.get("b0")!.bundleKey);
  });

  it("lays five lanes at an even gap, monotone in far-endpoint perp", () => {
    const plan = planLoom({ edges: fanOf([...FIVE_FAN_YS]), obstacles: [] });
    expect(byLane(plan).map((s) => s.laneOffset)).toEqual([-6, -3, 0, 3, 6]);
    // Lane order follows the far endpoints, so the trunk cannot self-cross.
    expect(byLane(plan).map((s) => s.edgeId)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
  });

  it("is independent of input edge order", () => {
    const edges = fanOf([...FIVE_FAN_YS]);
    const forward = planLoom({ edges, obstacles: [] });
    const shuffled = planLoom({ edges: [edges[3]!, edges[0]!, edges[4]!, edges[2]!, edges[1]!], obstacles: [] });

    expect(entriesOf(shuffled)).toEqual(entriesOf(forward));
    expect(shuffled.corridors).toEqual(forward.corridors);
  });

  it("holds lane assignment through sub-pixel jitter", () => {
    const edges = fanOf([...FIVE_FAN_YS]);
    const settled = planLoom({ edges, obstacles: [] });
    const jittered = planLoom({
      edges: edges.map((e) =>
        e.id === "e2" ? { ...e, targetAnchor: { x: 401, y: 1 } } : e,
      ),
      obstacles: [],
    });

    for (const [id, strand] of entriesOf(settled)) {
      expect(jittered.strands.get(id)!.laneIndex).toBe(strand.laneIndex);
    }
    // The jitter is absorbed, not merely tolerated: no strand changed sides.
    expect(byLane(jittered).map((s) => s.edgeId)).toEqual(byLane(settled).map((s) => s.edgeId));
  });

  it("is deterministic across runs on identical input", () => {
    const edges = fanOf([...FIVE_FAN_YS]);
    const first = planLoom({ edges, obstacles: [] });
    const second = planLoom({ edges, obstacles: [] });
    expect(entriesOf(second)).toEqual(entriesOf(first));
    expect(second.corridors).toEqual(first.corridors);
  });

  it("ejects a blocked wire into a reserved lane hole", () => {
    const clear = planLoom({ edges: fanOf([-150, -50, 50, 150]), obstacles: [] });
    expect(clear.strands.size).toBe(4);

    const blocked = planLoom({
      edges: fanOf([-150, -50, 50, 150]).map((e) => (e.id === "e1" ? { ...e, blocked: true } : e)),
      obstacles: [],
    });
    expect(blocked.strands.size).toBe(3);
    expect(blocked.strands.has("e1")).toBe(false);
    // The survivors keep their exact offsets: stoppage does not reshuffle.
    for (const id of ["e0", "e2", "e3"]) {
      expect(blocked.strands.get(id)!.laneOffset).toBe(clear.strands.get(id)!.laneOffset);
      expect(blocked.strands.get(id)!.laneCount).toBe(4);
    }
  });

  it("plans nothing for an all-blocked fan", () => {
    const plan = planLoom({
      edges: fanOf([-150, -50, 50, 150]).map((e) => ({ ...e, blocked: true })),
      obstacles: [],
    });
    expect(plan.strands.size).toBe(0);
    expect(plan.corridors).toEqual([]);
  });

  it("reports corridors that cover the trunk", () => {
    const plan = planLoom({ edges: fanOf([...FIVE_FAN_YS]), obstacles: [] });
    const trunkEnd = Math.max(...[...plan.strands.values()].map((s) => s.stationAt));
    const trunkMid: WirePoint = { x: trunkEnd / 2, y: 0 };

    expect(plan.corridors.length).toBeGreaterThan(0);
    expect(plan.corridors.every((r) => r.width > 0 && r.height > 0)).toBe(true);
    expect(plan.corridors.some((r) => contains(r, trunkMid))).toBe(true);
    // Corridors are the cable footprint, not the whole canvas.
    expect(plan.corridors.some((r) => contains(r, { x: -400, y: -400 }))).toBe(false);
  });

  it("gives a dual-membership edge exactly one fan", () => {
    // Four out of A on the right, three into D on the left: the larger wins.
    const larger: LoomEdgeInput[] = [
      { id: "A-D", blocked: false, sourceNodeId: "A", sourceSide: "right", sourceAnchor: HUB, targetNodeId: "D", targetSide: "left", targetAnchor: { x: 400, y: 0 } },
      { id: "A-E", blocked: false, sourceNodeId: "A", sourceSide: "right", sourceAnchor: HUB, targetNodeId: "E", targetSide: "left", targetAnchor: { x: 400, y: 100 } },
      { id: "A-F", blocked: false, sourceNodeId: "A", sourceSide: "right", sourceAnchor: HUB, targetNodeId: "F", targetSide: "left", targetAnchor: { x: 400, y: 200 } },
      { id: "A-G", blocked: false, sourceNodeId: "A", sourceSide: "right", sourceAnchor: HUB, targetNodeId: "G", targetSide: "left", targetAnchor: { x: 400, y: -100 } },
      { id: "B-D", blocked: false, sourceNodeId: "B", sourceSide: "right", sourceAnchor: { x: 0, y: 200 }, targetNodeId: "D", targetSide: "left", targetAnchor: { x: 400, y: 0 } },
      { id: "C-D", blocked: false, sourceNodeId: "C", sourceSide: "right", sourceAnchor: { x: 0, y: -200 }, targetNodeId: "D", targetSide: "left", targetAnchor: { x: 400, y: 0 } },
    ];
    const bySize = planLoom({ edges: larger, obstacles: [] });
    expect(bySize.strands.get("A-D")!.bundleKey).toBe("A|right|s");
    expect(bySize.strands.size).toBe(4);
    expect(bySize.strands.has("B-D")).toBe(false);

    // Three out of Z, three into M: the tie breaks on the smaller bundle key.
    const tied: LoomEdgeInput[] = [
      { id: "Z-M", blocked: false, sourceNodeId: "Z", sourceSide: "right", sourceAnchor: { x: 0, y: -100 }, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 500, y: 0 } },
      { id: "Z-N", blocked: false, sourceNodeId: "Z", sourceSide: "right", sourceAnchor: { x: 0, y: -100 }, targetNodeId: "N", targetSide: "left", targetAnchor: { x: 500, y: -300 } },
      { id: "Z-P", blocked: false, sourceNodeId: "Z", sourceSide: "right", sourceAnchor: { x: 0, y: -100 }, targetNodeId: "P", targetSide: "left", targetAnchor: { x: 500, y: -500 } },
      { id: "Q-M", blocked: false, sourceNodeId: "Q", sourceSide: "right", sourceAnchor: { x: 0, y: 0 }, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 500, y: 0 } },
      { id: "R-M", blocked: false, sourceNodeId: "R", sourceSide: "right", sourceAnchor: { x: 0, y: 100 }, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 500, y: 0 } },
    ];
    const byKey = planLoom({ edges: tied, obstacles: [] });
    expect(byKey.strands.get("Z-M")!.bundleKey).toBe("M|left|t");
    expect(byKey.strands.get("Z-M")!.hubEnd).toBe("target");
    expect(byKey.strands.size).toBe(3);
    expect(byKey.strands.has("Z-N")).toBe(false);
  });

  it("dissolves the whole fan when an obstacle sits on the trunk", () => {
    const wall: LoomObstacle = { nodeId: "wall", x: 150, y: -20, width: 40, height: 40 };
    const blockedSpine = planLoom({ edges: fanOf([...FIVE_FAN_YS]), obstacles: [wall] });
    expect(blockedSpine.strands.size).toBe(0);
    expect(blockedSpine.corridors).toEqual([]);

    // The same node clear of the corridor leaves the cable intact.
    const clear = planLoom({
      edges: fanOf([...FIVE_FAN_YS]),
      obstacles: [{ ...wall, y: 400 }],
    });
    expect(clear.strands.size).toBe(5);
  });

  it("turns the extreme strand of a group off the trunk first", () => {
    const plan = planLoom({ edges: fanOf([...FIVE_FAN_YS]), obstacles: [] });
    const minus = ["e0", "e1"].map((id) => plan.strands.get(id)!);
    const plus = ["e2", "e3", "e4"].map((id) => plan.strands.get(id)!);

    expect(plan.strands.get("e0")!.stationAt).toBe(Math.min(...minus.map((s) => s.stationAt)));
    expect(plan.strands.get("e4")!.stationAt).toBe(Math.min(...plus.map((s) => s.stationAt)));
    // The least extreme rides the trunk to its end; the reverse order crosses.
    expect(plan.strands.get("e2")!.stationAt).toBe(Math.max(...plus.map((s) => s.stationAt)));
  });

  it("turns the outermost lane off the axis first, so the comb reads as one cable", () => {
    const plan = planLoom({ edges: fanOf([...FIVE_FAN_YS]), obstacles: [] });
    const bySplay = [...plan.strands.values()].sort((a, b) => a.splayAt - b.splayAt);
    // Splay is monotone DOWN in |laneOffset|: the extreme strand leaves the
    // axis first, so its jog only sweeps lanes that have not settled yet.
    expect(bySplay.map((s) => Math.abs(s.laneOffset))).toEqual([6, 6, 3, 3, 0]);
    expect(bySplay[0]!.splayAt).toBe(LOOM_LEAD);

    expect(crossingCount(fanSegments(FIVE_FAN_YS))).toBe(0);
    // A dense fan is where the braid would show: twelve strands, still planar.
    const twelve = Array.from({ length: 12 }, (_, index) => (index - 5.5) * 40);
    expect(crossingCount(fanSegments(twelve))).toBe(0);
  });

  it("resolves fan membership from topology alone, never from stoppage", () => {
    // A-right and M-left both hold four candidates, so A wins on the key. e4
    // going into stoppage must not hand e1 and e2 to a trunk 600px away.
    const edges: LoomEdgeInput[] = [
      { id: "e1", blocked: false, sourceNodeId: "A", sourceSide: "right", sourceAnchor: HUB, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 600, y: 0 } },
      { id: "e2", blocked: false, sourceNodeId: "A", sourceSide: "right", sourceAnchor: HUB, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 600, y: 0 } },
      { id: "e3", blocked: false, sourceNodeId: "A", sourceSide: "right", sourceAnchor: HUB, targetNodeId: "X", targetSide: "left", targetAnchor: { x: 600, y: 300 } },
      { id: "e4", blocked: false, sourceNodeId: "A", sourceSide: "right", sourceAnchor: HUB, targetNodeId: "Y", targetSide: "left", targetAnchor: { x: 600, y: -300 } },
      { id: "e5", blocked: false, sourceNodeId: "B", sourceSide: "right", sourceAnchor: { x: 0, y: 300 }, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 600, y: 0 } },
      { id: "e6", blocked: false, sourceNodeId: "C", sourceSide: "right", sourceAnchor: { x: 0, y: -300 }, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 600, y: 0 } },
    ];
    const clear = planLoom({ edges, obstacles: [] });
    expect(clear.strands.size).toBe(4);

    const stopped = planLoom({
      edges: edges.map((e) => (e.id === "e4" ? { ...e, blocked: true } : e)),
      obstacles: [],
    });
    expect(stopped.strands.size).toBe(3);
    for (const id of ["e1", "e2", "e3"]) {
      const before = clear.strands.get(id)!;
      const after = stopped.strands.get(id)!;
      // Same cable, same lane, same trunk: the ejected wire leaves a hole and
      // nothing else in the document moves.
      expect(after.bundleKey).toBe(before.bundleKey);
      expect(after.laneOffset).toBe(before.laneOffset);
      expect(after.stationAt).toBe(before.stationAt);
    }
  });

  it("keeps unrelated fans in one corridor on parallel lanes", () => {
    // Two hubs 6px apart on the same axis — an s-handle and a t-handle share a
    // node side this closely. Proximity must never merge them into one cable.
    const plan = planLoom({
      edges: [...fanFrom("A", { x: 200, y: 50 }), ...fanFrom("B", { x: 200, y: 56 })],
      obstacles: [],
    });
    expect(plan.strands.size).toBe(6);
    expect(plan.strands.get("A0")!.bundleKey).not.toBe(plan.strands.get("B0")!.bundleKey);

    const lanes = [...plan.strands.entries()]
      .map(([id, strand]) => (id.startsWith("A") ? 50 : 56) + strand.laneOffset)
      .sort((a, b) => a - b);
    for (let i = 1; i < lanes.length; i++) {
      // Consistent spacing across the whole corridor, and never coincident.
      expect(lanes[i]! - lanes[i - 1]!).toBeCloseTo(LANE_GAP, 6);
    }

    // A fan with the corridor to itself stays centred on its own hub axis.
    const alone = planLoom({ edges: fanFrom("A", { x: 200, y: 50 }), obstacles: [] });
    expect(byLane(alone).map((s) => s.laneOffset)).toEqual([-3, 0, 3]);
  });

  it("plans the spine around every card, its own far endpoints included", () => {
    // D is the far node of a member of this very fan, and it sits on the
    // trunk. Edges paint below nodes, so a spine planned blind to D would
    // disappear into the card.
    const edges: LoomEdgeInput[] = [
      ...[0, 1, 2].map((index): LoomEdgeInput => ({
        id: `f${index}`,
        blocked: false,
        sourceNodeId: "hub",
        sourceSide: "right",
        sourceAnchor: HUB,
        targetNodeId: `n${index}`,
        targetSide: "left",
        targetAnchor: { x: 500, y: (index - 1) * 60 },
      })),
      { id: "fD", blocked: true, sourceNodeId: "hub", sourceSide: "right", sourceAnchor: HUB, targetNodeId: "D", targetSide: "left", targetAnchor: { x: 120, y: 100 } },
    ];
    const onTrunk: LoomObstacle = { nodeId: "D", x: 120, y: -10, width: 200, height: 220 };
    expect(planLoom({ edges, obstacles: [onTrunk] }).strands.size).toBe(0);

    // The same card clear of the spine leaves the cable intact.
    const aside = planLoom({ edges, obstacles: [{ ...onTrunk, y: 300 }] });
    expect(aside.strands.size).toBe(3);
  });
});

describe("stoppage clearance", () => {
  const trunk: WireRect = { x: 0, y: -6, width: 352, height: 12 };
  const crossing: WireRect = { x: 352, y: -206, width: 48, height: 412 };

  it("hands an ejected wire only the cables it does not start inside", () => {
    // A blocked member holds its lane hole, so it leaves the same handle its
    // fan's trunk starts at: that corridor holds its own endpoint.
    const kept = corridorsClearOf([trunk, crossing], [HUB, { x: 400, y: 320 }]);
    expect(kept).toEqual([crossing]);
    // A wire with no stake in either corridor still treats both as furniture.
    expect(corridorsClearOf([trunk, crossing], [{ x: 0, y: 400 }, { x: 400, y: 500 }])).toEqual([
      trunk,
      crossing,
    ]);
  });

  it("lets an ejected wire leave along its own port", () => {
    const routed = routeWire({
      source: HUB,
      target: { x: 400, y: 320 },
      obstacles: corridorsClearOf([trunk, crossing], [HUB, { x: 400, y: 320 }]),
      padding: 14,
      borderRadius: 8,
      sourceDirection: "right",
      targetDirection: "left",
    });
    const lead = routed!.path.match(/^M (-?[\d.]+),(-?[\d.]+) L (-?[\d.]+),(-?[\d.]+)/);
    expect(lead).not.toBeNull();
    const [, x0, y0, x1, y1] = lead!.map(Number);
    // The first move runs out of the right-side handle, not down its border.
    expect(y1).toBe(y0);
    expect(x1!).toBeGreaterThan(x0!);
  });
});

describe("stitchStrand", () => {
  it("pins both ends to the live endpoints from either hub", () => {
    const fromSource = planLoom({ edges: fanOf([...FIVE_FAN_YS]), obstacles: [] }).strands.get("e0")!;
    expect(fromSource.hubEnd).toBe("source");
    // A few px of drift between the node-derived anchor and the DOM handle.
    const sourceEnds = { sourceX: 3, sourceY: -3, targetX: 403, targetY: -197 };
    const stitchedFromSource = stitchStrand(fromSource, sourceEnds);
    expect(stitchedFromSource.points[0]).toEqual({ x: 3, y: -3 });
    expect(stitchedFromSource.points[stitchedFromSource.points.length - 1]).toEqual({
      x: 403,
      y: -197,
    });

    const tied: LoomEdgeInput[] = [
      { id: "Z-M", blocked: false, sourceNodeId: "Z", sourceSide: "right", sourceAnchor: { x: 0, y: -100 }, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 500, y: 0 } },
      { id: "Q-M", blocked: false, sourceNodeId: "Q", sourceSide: "right", sourceAnchor: { x: 0, y: 0 }, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 500, y: 0 } },
      { id: "R-M", blocked: false, sourceNodeId: "R", sourceSide: "right", sourceAnchor: { x: 0, y: 100 }, targetNodeId: "M", targetSide: "left", targetAnchor: { x: 500, y: 0 } },
    ];
    const fromTarget = planLoom({ edges: tied, obstacles: [] }).strands.get("Z-M")!;
    expect(fromTarget.hubEnd).toBe("target");
    const stitchedFromTarget = stitchStrand(fromTarget, {
      sourceX: -3,
      sourceY: -103,
      targetX: 497,
      targetY: 3,
    });
    // Still source to target, so markerEnd and the spark keep their direction.
    expect(stitchedFromTarget.points[0]).toEqual({ x: -3, y: -103 });
    expect(
      stitchedFromTarget.points[stitchedFromTarget.points.length - 1],
    ).toEqual({ x: 497, y: 3 });
    expect(stitchedFromTarget.path.startsWith("M -3,-103")).toBe(true);
  });

  it("puts every label on its own tail, off the shared trunk", () => {
    const plan = planLoom({ edges: fanOf([...FIVE_FAN_YS]), obstacles: [] });
    const trunkEnd = Math.max(...[...plan.strands.values()].map((s) => s.stationAt));
    expect(trunkEnd).toBeGreaterThan(LOOM_LEAD);
    const trunkMid: WirePoint = { x: trunkEnd / 2, y: 0 };

    const labels = [...plan.strands.values()].map((strand) => {
      const far = FIVE_FAN_YS[strand.laneIndex]!;
      const stitched = stitchStrand(strand, {
        sourceX: HUB.x,
        sourceY: HUB.y,
        targetX: 400,
        targetY: far,
      });
      return { x: stitched.labelX, y: stitched.labelY };
    });

    for (const label of labels) {
      expect(Math.hypot(label.x - trunkMid.x, label.y - trunkMid.y)).toBeGreaterThan(LANE_GAP);
    }
    // Hit targets never stack: no two strands land on the same label point.
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i]!;
        const b = labels[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(LANE_GAP);
      }
    }
  });
});
