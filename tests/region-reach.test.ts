import { describe, expect, expectTypeOf, it } from "vitest";
import { asNodeId, type NodeId } from "../src/shared/model";
import type { NodeKind } from "../src/shared/model/kinds";
import {
  automationTargets,
  isResourceKind,
  onOneLine,
  positionsOf,
  reaches,
  resourcesInReach,
  seatsInReach,
  type Positions,
  type ReachCanvas,
  type ReachNode,
  type RegionId,
  type ResourceKind,
} from "../src/shared/region-reach";

const node = (id: string, kind: NodeKind, x: number, y: number, width = 50, height = 50): ReachNode => ({
  id: asNodeId(id),
  kind,
  x,
  y,
  width,
  height,
});

const canvasOf = (...nodes: ReadonlyArray<ReachNode>): ReachCanvas => ({
  nodes: new Map(nodes.map((n) => [n.id, n])),
});

// root: loose seat L, task T0
// A                       B (sibling of A)
// ├─ A1: S1, T1           └─ TB
// ├─ A2: S2, T2
// └─ SA, TA, automation AU
// X and Y overlap partly; SXY sits in both, SX in X only.
const canvas = canvasOf(
  node("L", "agent", -500, -500),
  node("T0", "task", -400, -500),
  node("A", "region", 0, 0, 1000, 1000),
  node("A1", "region", 10, 10, 400, 400),
  node("A2", "region", 500, 10, 400, 400),
  node("SA", "agent", 100, 800),
  node("TA", "task", 200, 800),
  node("AU", "note", 300, 800),
  node("S1", "agent", 20, 20),
  node("T1", "task", 100, 20),
  node("A1a", "region", 20, 200, 150, 150),
  node("T1a", "task", 30, 210),
  node("S2", "agent", 520, 20),
  node("T2", "artifacts", 600, 20),
  node("B", "region", 2000, 0, 500, 500),
  node("TB", "task", 2010, 10),
  node("SB", "agent", 2100, 10),
  node("X", "region", 3000, 0, 300, 300),
  node("Y", "region", 3200, 0, 300, 300),
  node("SXY", "agent", 3210, 10),
  node("SX", "agent", 3010, 10),
  node("TX", "task", 3010, 200),
  node("TY", "task", 3400, 200),
);

const ids = (nodes: ReadonlyArray<ReachNode>): ReadonlyArray<string> => nodes.map((n) => n.id);
const id = asNodeId;

describe("region reach", () => {
  it("reaches its own region, regions above and regions below, never a sibling or a cousin", () => {
    expect(ids(resourcesInReach(canvas, id("S1")))).toEqual(["T0", "T1", "T1a", "TA"]);
    expect(ids(resourcesInReach(canvas, id("SA")))).toEqual(["T0", "T1", "T1a", "T2", "TA"]);
    expect(reaches(canvas, id("S1"), id("T2"))).toBe(false);
    expect(reaches(canvas, id("S1"), id("TB"))).toBe(false);
  });

  it("never reaches a cousin: a region inside a sibling", () => {
    expect(reaches(canvas, id("S1"), id("T1a"))).toBe(true);
    expect(reaches(canvas, id("S2"), id("T1a"))).toBe(false);
    expect(reaches(canvas, id("SB"), id("T1a"))).toBe(false);
  });

  it("lets only a seat reach resources: not a region, a task node or a peer row", () => {
    const withPeer = canvasOf(...canvas.nodes.values(), node("P1", "peer", 30, 30));
    expect(resourcesInReach(withPeer, id("A1"))).toEqual([]);
    expect(resourcesInReach(withPeer, id("T1"))).toEqual([]);
    expect(resourcesInReach(withPeer, id("P1"))).toEqual([]);
    expect(ids(seatsInReach(withPeer, id("T1")))).toContain("P1");
  });

  it("fails closed when held positions name a region that is gone", () => {
    const seat = positionsOf(canvas, id("S1"))!;
    const task = positionsOf(canvas, id("TA"))!;
    const without = canvasOf(...[...canvas.nodes.values()].filter((n) => n.id !== "A1"));
    expect(() => onOneLine(without, seat, task)).not.toThrow();
    expect(onOneLine(without, seat, task)).toBe(false);
  });

  it("puts a loose node at the root, on one line with everything", () => {
    expect(positionsOf(canvas, id("L"))?._tag).toBe("Root");
    expect(ids(resourcesInReach(canvas, id("L")))).toEqual(["T0", "T1", "T1a", "T2", "TA", "TB", "TX", "TY"]);
    expect(ids(seatsInReach(canvas, id("T0")))).toEqual(["L", "S1", "S2", "SA", "SB", "SX", "SXY"]);
  });

  it("lists the seats that reach a resource", () => {
    expect(ids(seatsInReach(canvas, id("T1")))).toEqual(["L", "S1", "SA"]);
    expect(ids(seatsInReach(canvas, id("TB")))).toEqual(["L", "SB"]);
  });

  it("gives a node inside two partly overlapping regions both positions, and they stay unrelated", () => {
    const at = positionsOf(canvas, id("SXY"));
    expect(at).toEqual({ _tag: "Regions", innermost: ["X", "Y"] });
    expect(ids(resourcesInReach(canvas, id("SXY")))).toEqual(["T0", "TX", "TY"]);
    expect(reaches(canvas, id("SX"), id("TY"))).toBe(false);
  });

  it("counts both of two regions with the same frame", () => {
    const twins = canvasOf(
      node("E2", "region", 0, 0, 200, 200),
      node("E1", "region", 0, 0, 200, 200),
      node("S", "agent", 10, 10),
    );
    expect(positionsOf(twins, id("S"))).toEqual({ _tag: "Regions", innermost: ["E1", "E2"] });
  });

  it("is symmetric, and missing nodes reach nothing", () => {
    const a = positionsOf(canvas, id("S1"))!;
    const b = positionsOf(canvas, id("TA"))!;
    expect(onOneLine(canvas, a, b)).toBe(onOneLine(canvas, b, a));
    expect(reaches(canvas, id("S1"), id("nope"))).toBe(false);
    expect(resourcesInReach(canvas, id("nope"))).toEqual([]);
  });

  it("follows the rectangles: moving a seat changes reach on the next read", () => {
    const moved = canvasOf(...[...canvas.nodes.values()].map((n) => (n.id === "S1" ? { ...n, x: 520, y: 100 } : n)));
    expect(reaches(moved, id("S1"), id("T2"))).toBe(true);
    expect(reaches(moved, id("S1"), id("T1"))).toBe(false);
  });

  it("drops a node that overhangs a region's edge to the region above", () => {
    const overhang = canvasOf(...[...canvas.nodes.values()].map((n) => (n.id === "S1" ? { ...n, x: 390 } : n)));
    expect(positionsOf(overhang, id("S1"))).toEqual({ _tag: "Regions", innermost: ["A"] });
  });
});

describe("automation targets", () => {
  it("are everything at or below the automation when the operator wrote it", () => {
    expect(ids(automationTargets(canvas, id("AU"), { kind: "operator" }))).toEqual([
      "S1", "S2", "SA", "T1", "T1a", "T2", "TA",
    ]);
  });

  it("stay inside the author's reach, so a seat cannot act on its siblings through a parent's automation", () => {
    expect(ids(automationTargets(canvas, id("AU"), { kind: "seat", seat: id("S1") }))).toEqual([
      "S1", "SA", "T1", "T1a", "TA",
    ]);
  });

  it("never reach above the automation, and a missing or non-seat author gets nothing", () => {
    const targets = ids(automationTargets(canvas, id("AU"), { kind: "operator" }));
    expect(targets).not.toContain("T0");
    expect(targets).not.toContain("L");
    expect(automationTargets(canvas, id("AU"), { kind: "seat", seat: id("gone") })).toEqual([]);
    expect(automationTargets(canvas, id("AU"), { kind: "seat", seat: id("T1") })).toEqual([]);
  });
});

describe("region reach types", () => {
  it("closes the contract at compile time", () => {
    // @ts-expect-error: positions are made only by positionsOf.
    const forged: Positions = { _tag: "Root" };
    void forged;
    const regionId = (value: RegionId) => value;
    // @ts-expect-error: a bare node id does not name a region.
    regionId(id("A"));
    const narrow = (kind: NodeKind) => {
      if (isResourceKind(kind)) expectTypeOf(kind).toEqualTypeOf<ResourceKind>();
    };
    narrow("task");
    // @ts-expect-error: a seat is not a resource kind.
    const notResource: ResourceKind = "agent";
    void notResource;
    expectTypeOf(reaches).parameters.toEqualTypeOf<[ReachCanvas, NodeId, NodeId]>();
  });
});
