import { afterEach, describe, expect, it } from "vitest";
import { asCanvasName, asNodeId } from "../src/shared/model";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { applyAgentSeatStateEvent, resetAgentSeatState } from "../src/window/lib/agent-seat-state";
import { regionUrgency$, seatUrgency$ } from "../src/window/lib/region-urgency";
import { state$ } from "../src/window/lib/state";
import { modelStore } from "../src/window/lib/use-model";
import { retainCanvasFeed, retainSceneOps } from "../src/window/canvas/feed";
import type { SceneOp } from "../src/window/canvas/contract";
import { note, region, seat } from "./support/model-nodes";

/**
/// The feed's done-test (canvas-gpu-plan.md, track E): with every canvas card
/// unmounted, a seat report still moves the minimap's seat colours
/// (`seatUrgency$`, what CanvasBottomBar's seatMarkOf reads) and the regions'
/// urgency (`regionUrgency$`), and a model `Changed` emits one scene op per
/// row it names — never a rebuild.
 */

const CANVAS = "feed-test";

const seatEvent = (partial: Partial<AgentSeatStateEvent> & { bindingId: string; state: AgentSeatStateEvent["state"] }): AgentSeatStateEvent => ({
  epoch: "e1",
  reason: partial.state,
  confidence: "high",
  at: 1_700_000_000_000,
  ...partial,
});

const releases: Array<() => void> = [];

afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  resetAgentSeatState();
  seatUrgency$.set({});
  regionUrgency$.set({});
  state$.regionSeverityByNodeId.set({});
  state$.regionCountsByNodeId.set({});
});

describe("canvas feed with no card mounted", () => {
  it("a seat report moves the minimap's seat colours and the region's urgency", () => {
    state$.canvasName.set(CANVAS);
    // The seat sits inside the region geometrically: the region holds it.
    const releaseModel = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      nodes: [
        region("r1", { x: 0, y: 0, width: 800, height: 600 }),
        seat("seat1", { x: 40, y: 40, z: 1 }),
      ],
      wires: [],
    });
    releases.push(releaseModel);
    releases.push(retainCanvasFeed(CANVAS));

    expect(seatUrgency$["seat1"].peek()).toBeUndefined();
    expect(regionUrgency$["r1"].peek()).toBeUndefined();

    // The seat asks for the operator: attention is the ring's "call".
    applyAgentSeatStateEvent(seatEvent({ bindingId: "binding-seat1", state: "attention", reason: "permission" }));

    expect(seatUrgency$["seat1"].peek()).toBe("needs-you");
    expect(regionUrgency$["r1"].peek()).toEqual({ urgency: "needs-you", reach: "direct" });
  });
});

describe("scene ops", () => {
  it("a model Changed touches only the rows it names, one op per row", () => {
    state$.canvasName.set(CANVAS);
    const releaseModel = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      nodes: [note("n1", "one"), note("n2", "two"), note("n3", "three")],
      wires: [],
    });
    releases.push(releaseModel);

    const ops: SceneOp[] = [];
    releases.push(retainSceneOps(CANVAS, (batch) => ops.push(...batch)));

    // The open pass: one load with every card, then the standing observers'
    // first emissions (theme, selection). Clear them before the change.
    expect(ops.some((op) => op.kind === "load" && op.cards.length === 3)).toBe(true);
    ops.length = 0;

    // A Changed naming two rows: two card ops, nothing else.
    const moved1 = note("n1", "one, moved");
    const moved2 = note("n2", "two, moved");
    modelStore.applyChanged({
      canvas: asCanvasName(CANVAS),
      seq: 1,
      nodes: [moved1, moved2],
      wires: [],
      removedNodes: [],
      removedWires: [],
    });
    const cardOps = ops.filter((op) => op.kind === "card");
    expect(cardOps.map((op) => (op.kind === "card" ? op.fact.id : ""))).toEqual(["n1", "n2"]);
    expect(ops.every((op) => op.kind === "card")).toBe(true);
    ops.length = 0;

    // A Changed naming a removal and an addition: one op each.
    modelStore.applyChanged({
      canvas: asCanvasName(CANVAS),
      seq: 2,
      nodes: [note("n4", "four")],
      wires: [],
      removedNodes: [asNodeId("n3")],
      removedWires: [],
    });
    expect(ops.map((op) => op.kind).sort()).toEqual(["card", "removeCard"]);
    ops.length = 0;

    // A Changed naming nothing the feed draws: no ops at all.
    modelStore.applyChanged({
      canvas: asCanvasName(CANVAS),
      seq: 3,
      nodes: [],
      wires: [],
      removedNodes: [],
      removedWires: [],
    });
    expect(ops).toEqual([]);
  });
});
