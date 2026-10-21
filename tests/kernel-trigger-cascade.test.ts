import { describe, expect, it } from "vitest";
import { collectTriggerCascadeTargets } from "../src/main/junto/kernel/effects";
import { canvasOf, cron, relay, wire } from "./support/model-nodes";

describe("trigger cascade over a canvas", () => {
  it("follows only chains wires that leave the scheduler", () => {
    const canvas = canvasOf(
      [cron("c1"), relay("r1"), relay("r2")],
      [wire("e1", "c1", "r1", "chains"), wire("e2", "r2", "c1", "chains")],
    );
    expect(collectTriggerCascadeTargets(canvas, "c1")).toEqual(["r1"]);
    expect(collectTriggerCascadeTargets(canvas, "r1")).toEqual([]);
    expect(collectTriggerCascadeTargets(canvas, "missing")).toEqual([]);
  });
});
