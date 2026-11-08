import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import type { NodeKind } from "../src/shared/model/kinds";
import type { ReachCanvas, ReachNode } from "../src/shared/region-reach";
import type { ResourceActor, ResourceRef } from "../src/shared/resource-command";
import { rulingContextOf } from "../src/shared/ruling-context";

const node = (id: string, kind: NodeKind, x: number, y: number, width = 50, height = 50): ReachNode => ({
  id: asNodeId(id),
  kind,
  x,
  y,
  width,
  height,
});

// A holds seat SA, task TA and automation AU; A1 inside A holds seat S1 and task T1; B, a sibling of A, holds TB.
const canvas: ReachCanvas = {
  nodes: new Map(
    [
      node("A", "region", 0, 0, 1000, 1000),
      node("A1", "region", 10, 10, 400, 400),
      node("B", "region", 2000, 0, 500, 500),
      node("SA", "agent", 600, 600),
      node("TA", "task", 700, 600),
      node("AU", "note", 800, 600), // no automation node kind yet; reach reads only its frame
      node("S1", "agent", 20, 20),
      node("T1", "task", 100, 20),
      node("TB", "task", 2100, 100),
      node("P1", "peer", 200, 20),
    ].map((n) => [n.id, n]),
  ),
};

const target = (nodeId: string): ResourceRef => ({ kind: "task", nodeId: nodeId as never });
const seatActor = (nodeId: string): ResourceActor => ({ kind: "seat", seatId: `seat_${"1".repeat(64)}` as never, nodeId: nodeId as never });
const automation: ResourceActor = { kind: "automation", nodeId: "AU" as never, automationId: "01M5EWQ00000000000000000A1" as never };

describe("reach at ruling", () => {
  const byOperator = rulingContextOf(canvas, () => ({ kind: "operator" }));

  it("gives a seat its own region, those below and above, never a sibling", () => {
    expect(byOperator.inReach(seatActor("SA"), target("TA"))).toBe(true);
    expect(byOperator.inReach(seatActor("SA"), target("T1"))).toBe(true);
    expect(byOperator.inReach(seatActor("S1"), target("TA"))).toBe(true);
    expect(byOperator.inReach(seatActor("SA"), target("TB"))).toBe(false);
  });

  it("lets only an agent act, and nothing reaches a node the canvas does not hold", () => {
    expect(byOperator.inReach(seatActor("P1"), target("T1"))).toBe(false);
    expect(byOperator.inReach(seatActor("TA"), target("T1"))).toBe(false);
    expect(byOperator.inReach(seatActor("SA"), target("gone"))).toBe(false);
    expect(byOperator.inReach({ kind: "operator" }, target("gone"))).toBe(false);
  });

  it("gives the operator every node", () => {
    expect(byOperator.inReach({ kind: "operator" }, target("TB"))).toBe(true);
  });

  it("gives an automation its region and below, narrowed by an overseer author, and nothing without an author", () => {
    expect(byOperator.inReach(automation, target("TA"))).toBe(true);
    expect(byOperator.inReach(automation, target("T1"))).toBe(true);
    expect(byOperator.inReach(automation, target("TB"))).toBe(false);
    const byOverseerInA1 = rulingContextOf(canvas, () => ({ kind: "seat", seat: asNodeId("S1") }));
    expect(byOverseerInA1.inReach(automation, target("T1"))).toBe(true);
    expect(rulingContextOf(canvas, () => undefined).inReach(automation, target("TA"))).toBe(false);
  });
});
