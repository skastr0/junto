import { describe, expect, it } from "vitest";
import { stepUrgencyWalk, type UrgencyWalk } from "../src/renderer/lib/urgency-step";

describe("stepUrgencyWalk", () => {
  const order = ["blocked", "waiting", "working"];

  it("starts at the most urgent agent", () => {
    expect(stepUrgencyWalk(null, order, "")).toEqual({ ids: order, index: 0 });
  });

  it("walks the order it started with, even when urgency has changed since", () => {
    let walk: UrgencyWalk | null = stepUrgencyWalk(null, order, "");
    const reshuffled = ["working", "blocked", "waiting"];
    walk = stepUrgencyWalk(walk, reshuffled, "blocked");
    expect(walk).toEqual({ ids: order, index: 1 });
    walk = stepUrgencyWalk(walk, reshuffled, "waiting");
    expect(walk).toEqual({ ids: order, index: 2 });
  });

  it("starts again from the most urgent at the end of a walk", () => {
    const fresh = ["waiting", "working", "blocked"];
    expect(stepUrgencyWalk({ ids: order, index: 2 }, fresh, "working")).toEqual({ ids: fresh, index: 0 });
  });

  it("starts a new walk once the operator selects something else", () => {
    expect(stepUrgencyWalk({ ids: order, index: 0 }, order, "a-note")).toEqual({ ids: order, index: 0 });
  });

  it("does not start a walk on the agent the operator is already on", () => {
    expect(stepUrgencyWalk(null, order, "blocked")).toEqual({ ids: order, index: 1 });
    expect(stepUrgencyWalk(null, ["only"], "only")).toEqual({ ids: ["only"], index: 0 });
  });

  it("steps over an agent deleted since the walk began", () => {
    expect(stepUrgencyWalk({ ids: order, index: 0 }, ["blocked", "working"], "blocked")).toEqual({
      ids: order,
      index: 2,
    });
  });

  it("goes nowhere with no agent on the canvas", () => {
    expect(stepUrgencyWalk(null, [], "")).toBeNull();
    expect(stepUrgencyWalk({ ids: order, index: 0 }, [], "blocked")).toBeNull();
  });
});
