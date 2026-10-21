import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import type { NodeKind } from "../src/shared/model/kinds";
import type { ReachCanvas, ReachNode } from "../src/shared/region-reach";
import { nodeReachChanges, reachChange, reachChangeSummary } from "../src/shared/reach-preview";

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

const movedTo = (canvas: ReachCanvas, id: string, x: number, y: number): ReachCanvas => ({
  nodes: new Map([...canvas.nodes].map(([key, n]) => [key, n.id === id ? { ...n, x, y } : n])),
});

// A and B are siblings; S sits in A with TA; TB sits in B; TR is loose.
const canvas = canvasOf(
  node("A", "region", 0, 0, 400, 400),
  node("B", "region", 500, 0, 400, 400),
  node("S", "agent", 20, 20),
  node("TA", "task", 100, 20),
  node("TB", "task", 520, 20),
  node("TR", "artifacts", -200, -200),
  node("P", "peer", 120, 120),
);

const id = asNodeId;

describe("reach change while dragging", () => {
  it("is empty when nothing moved", () => {
    expect(reachChange(canvas, canvas)).toEqual([]);
  });

  it("a seat dragged to a sibling region gains its resources and leaves the old ones", () => {
    const after = movedTo(canvas, "S", 520, 120);
    expect(reachChange(canvas, after)).toEqual([
      { seat: id("S"), resource: id("TA"), change: "loses" },
      { seat: id("S"), resource: id("TB"), change: "gains" },
    ]);
  });

  it("the task node a seat holds an open task on is kept by assignment, not lost", () => {
    const after = movedTo(canvas, "S", 520, 120);
    const changes = reachChange(canvas, after, (seat) => (seat === id("S") ? id("TA") : undefined));
    expect(changes).toContainEqual({ seat: id("S"), resource: id("TA"), change: "held" });
    expect(reachChangeSummary(changes)).toBe("1 comes into reach, 1 kept by assignment");
  });

  it("a resource dragged into a region leaves the sibling's seat", () => {
    const after = movedTo(canvas, "TR", 520, 200);
    // Loose TR was on every line; inside B it leaves S in A.
    expect(reachChange(canvas, after)).toEqual([{ seat: id("S"), resource: id("TR"), change: "loses" }]);
  });

  it("a region dragged off its contents changes pairs neither end of which moved", () => {
    // B leaves TB behind, so TB falls to the root, on one line with S.
    const after = movedTo(canvas, "B", -10, -10);
    expect(reachChange(canvas, after)).toEqual([{ seat: id("S"), resource: id("TB"), change: "gains" }]);
  });

  it("a peer never acts, so it never shows a change", () => {
    const after = movedTo(canvas, "P", 520, 120);
    expect(reachChange(canvas, after)).toEqual([]);
  });

  it("an overseer reaches every Tasks node wherever it is dropped", () => {
    const overseer = canvasOf(...canvas.nodes.values(), { ...node("O", "agent", 20, 300), overseer: true } as ReachNode);
    const after = movedTo(overseer, "O", 520, 300);
    expect(reachChange(overseer, after).filter((c) => c.seat === id("O"))).toEqual([]);
  });

  it("marks each end once, and a node that both gains and loses as both", () => {
    const after = movedTo(canvas, "S", 520, 120);
    const marks = nodeReachChanges(reachChange(canvas, after));
    expect(marks.get(id("S"))).toBe("both");
    expect(marks.get(id("TA"))).toBe("loses");
    expect(marks.get(id("TB"))).toBe("gains");
    expect(reachChangeSummary([])).toBe("reach unchanged");
  });
});
