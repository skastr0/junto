import { afterEach, describe, expect, it } from "vitest";
import type { Node, Wire } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { authoring } from "../src/renderer/lib/authoring";
import { openModelCanvas } from "./support/open-model-canvas";
import { undo } from "../src/renderer/lib/mutations";
import {
  connectMesh,
  disconnectWithin,
  meshPlanOn,
  targetPlanOn,
  wireIdsWithin,
} from "../src/renderer/lib/edge-mutations";
import { canvasOf, region, seat, wire as modelWire } from "./support/model-nodes";
import { agentCountLabel, seatIdsAmong } from "../src/renderer/lib/multi-selection";
import { placeBesideRect } from "../src/renderer/lib/menu-placement";
import { state$ } from "../src/renderer/lib/state";

const nodes: ReadonlyArray<Node> = [seat("a"), seat("b"), seat("c"), seat("d"), region("region", { x: 0, y: 0, width: 400, height: 200 }, { label: "R" })];
const wire = (id: string, from: string, to: string): Wire => modelWire(id, from, to, "messages");
let close: (() => Promise<void>) | undefined;
const open = (wires: ReadonlyArray<Wire>) => { close = openModelCanvas("selection-mesh-test", nodes, wires); };
const wires = () => [...modelStore.canvasOf("selection-mesh-test").wires.values()];

const pairs = (plan: ReturnType<typeof meshPlanOn>) =>
  plan.toAdd.map((c) => [c.fromNode, c.toNode].sort().join("|")).sort();

afterEach(async () => { await close?.(); state$.error.set(""); });

describe("the same plans asked of the model canvas", () => {
  const canvas = canvasOf(
    [seat("a"), seat("b"), seat("c"), seat("d"), region("region", { x: 0, y: 0, width: 400, height: 200 })],
    [modelWire("in1", "a", "b", "messages"), modelWire("out", "c", "d", "messages")],
  );

  it("plans a mesh over what is not yet wired, and a region takes no wire", () => {
    expect(pairs(meshPlanOn(canvas, ["a", "b", "c"]))).toEqual(["a|c", "b|c"]);
    expect(targetPlanOn(canvas, ["a", "b"], "region").skipped.map((skip) => skip.reason)).toEqual(["invalid-target", "invalid-target"]);
    expect(targetPlanOn(canvas, ["a", "b"], "d").toAdd).toHaveLength(2);
  });

  it("finds the wires inside a selection and leaves the ones that cross out", () => {
    expect(wireIdsWithin(canvas, ["a", "b", "c"])).toEqual(["in1"]);
    expect(wireIdsWithin(canvas, ["a"])).toEqual([]);
  });
});

describe("meshPlanOn", () => {
  const seats = [seat("a"), seat("b"), seat("c"), seat("d")];

  it("wires one edge per unordered pair", () => {
    const plan = meshPlanOn(canvasOf(seats), ["a", "b", "c", "d"]);
    expect(pairs(plan)).toEqual(["a|b", "a|c", "a|d", "b|c", "b|d", "c|d"]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips pairs already wired in either direction", () => {
    const wired = canvasOf(seats, [modelWire("e1", "b", "a", "messages"), modelWire("e2", "a", "c", "messages")]);
    const plan = meshPlanOn(wired, ["a", "b", "c"]);
    expect(pairs(plan)).toEqual(["b|c"]);
    expect(plan.skipped.filter((s) => s.reason === "duplicate")).toHaveLength(2);
  });

  it("ignores repeated ids and plans nothing for fewer than two", () => {
    expect(meshPlanOn(canvasOf(seats), ["a", "a"]).toAdd).toEqual([]);
    expect(meshPlanOn(canvasOf(seats), []).toAdd).toEqual([]);
  });

  it("follows the pair grammar the single-target connect uses", () => {
    const plan = meshPlanOn(canvasOf(seats), ["a", "b"]);
    expect(plan.toAdd).toHaveLength(1);
    expect(typeof plan.toAdd[0]?.verb).toBe("string");
  });
});

describe("connectMesh", () => {
  it("commits the whole mesh as one undo step", async () => {
    open([wire("e1", "a", "b")]);
    const plan = connectMesh(["a", "b", "c"]);
    expect(plan.toAdd).toHaveLength(2);
    expect(wires()).toHaveLength(3);
    await authoring.idle();
    undo();
    await authoring.idle();
    expect(wires().map((e) => e.id)).toEqual(["e1"]);
  });

  it("reports an already-connected selection without writing", () => {
    open([wire("e1", "a", "b")]);
    connectMesh(["a", "b"]);
    expect(wires()).toHaveLength(1);
    expect(state$.error.peek()).toBe("Those agents are already connected.");
  });
});

describe("disconnect within a selection", () => {
  const edges = [wire("in1", "a", "b"), wire("in2", "c", "a"), wire("out", "a", "d")];

  it("removes inside edges in one write and keeps outside ones", async () => {
    open(edges);
    disconnectWithin(["a", "b", "c"]);
    expect(wires().map((e) => e.id)).toEqual(["out"]);
    await authoring.idle();
    undo();
    await authoring.idle();
    expect(wires()).toHaveLength(3);
  });
});

describe("agent seat helpers", () => {
  it("keeps agent seats only and counts them", () => {
    const held = [seat("a"), seat("b"), seat("c"), seat("d"), region("region", { x: 0, y: 0, width: 400, height: 200 })];
    expect(seatIdsAmong(held)).toEqual(["a", "b", "c", "d"]);
    expect(agentCountLabel(1)).toBe("1 agent");
    expect(agentCountLabel(3)).toBe("3 agents");
  });
});

describe("placeBesideRect", () => {
  const viewport = { width: 1200, height: 800 };
  const menu = { width: 240, height: 300 };

  it("prefers the right side, bottom-aligned with the rect", () => {
    expect(placeBesideRect({ left: 100, top: 100, right: 400, bottom: 500 }, menu, viewport)).toEqual({ x: 408, y: 200 });
  });

  it("falls to below when the right side is off-screen", () => {
    expect(placeBesideRect({ left: 700, top: 100, right: 1100, bottom: 400 }, menu, viewport)).toEqual({ x: 860, y: 408 });
  });

  it("clamps into the viewport when no side is clear", () => {
    const point = placeBesideRect({ left: 0, top: 0, right: 1200, bottom: 800 }, menu, viewport);
    expect(point).toEqual({ x: 952, y: 492 });
  });
});
