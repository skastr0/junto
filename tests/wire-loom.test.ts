import { describe, expect, it } from "vitest";
import {
  LANE_GAP,
  LOOM_LEAD,
  planLoom,
  stitchStrand,
  type LoomEdgeInput,
  type LoomObstacle,
  type LoomPlan,
  type LoomStrand,
} from "../src/renderer/lib/wire-loom";
import type { WirePoint } from "../src/renderer/lib/wire-route";

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
