import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { canvasFromDocument } from "../src/shared/model/from-document";
import { collectTriggerCascadeTargets } from "../src/main/junto/kernel/effects";

const scheduler = (id: string, kind: "cron" | "relay"): CanvasNode =>
  ({
    id,
    type: "text",
    text: id,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    ether: { entity: { kind }, host: "local" },
  }) as CanvasNode;

describe("trigger cascade over a canvas", () => {
  it("follows only chains wires that leave the scheduler", () => {
    const doc = {
      nodes: [scheduler("c1", "cron"), scheduler("r1", "relay"), scheduler("r2", "relay")],
      edges: [
        { id: "e1", fromNode: "c1", toNode: "r1", ether: { verb: "chains" } },
        { id: "e2", fromNode: "r2", toNode: "c1", ether: { verb: "chains" } },
      ],
    } as unknown as CanvasDoc;
    const canvas = canvasFromDocument("factory", doc);
    expect(collectTriggerCascadeTargets(canvas, "c1")).toEqual(["r1"]);
    expect(collectTriggerCascadeTargets(canvas, "r1")).toEqual([]);
    expect(collectTriggerCascadeTargets(canvas, "missing")).toEqual([]);
  });
});
