import { describe, expect, it } from "vitest";
import { Result } from "effect";
import type { Canvas } from "../src/shared/model";
import { TASK_REACH_OPS, isTargetWorkOp } from "../src/shared/physics";
import { TASKS_ENABLED } from "../src/shared/features";
import { admitOverseerWorkTarget, admitWorkTarget, kindAllowsOp } from "../src/main/junto/work/authz";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";

// Region R holds seat alpha and task node tasks-1; sibling region S holds seat
// gamma. No wire anywhere: reach alone admits (plan 04).
const box = (x: number, y: number, width = 50, height = 50) => ({ x, y, width, height });
const canvas = {
  nodes: new Map(
    [
      { id: "R", kind: "region", label: "R", ...box(0, 0, 500, 500) },
      { id: "S", kind: "region", label: "S", ...box(600, 0, 500, 500) },
      { id: "seat-a", kind: "agent", label: "alpha", agentKey: "a", ...box(10, 10) },
      { id: "seat-c", kind: "agent", label: "gamma", agentKey: "c", ...box(610, 10) },
      { id: "tasks-1", kind: "task", name: "CLI tasks", ...box(200, 200) },
    ].map((node) => [node.id, node]),
  ),
  wires: new Map(),
} as unknown as Canvas;

describe.runIf(TASKS_ENABLED)("task ops admitted by reach", () => {
  it("checks no port for any of them", () => {
    for (const op of TASK_REACH_OPS) expect(isTargetWorkOp(op)).toBe(false);
  });

  it("admits a seat whose reach holds the task node, with no edge", () => {
    for (const op of TASK_REACH_OPS) expect(Result.isSuccess(admitWorkTarget(canvas, "seat-a", "tasks-1", op))).toBe(true);
  });

  it("refuses a seat out of reach, and a target that is no task node", () => {
    // rules, wait and check moved to the task verbs, whose handler checks reach (task-control.test.ts).
    const far = admitWorkTarget(canvas, "seat-c", "tasks-1", "rulings");
    expect(Result.isFailure(far) && far.failure.details?.reason).toBe("out_of_reach");
    const seat = admitWorkTarget(canvas, "seat-a", "seat-c", "rulings");
    expect(Result.isFailure(seat) && seat.failure.type).toBe("ScopeError");
    expect(Result.isFailure(seat) && seat.failure.details?.missing).toBe("compatible target kind");
  });

  it("admits a live overseer seat to every task node on its canvas", () => {
    const flagged = (overseer: boolean) => {
      const nodes = new Map(canvas.nodes);
      nodes.set("seat-c" as never, { ...canvas.nodes.get("seat-c" as never)!, overseer } as never);
      return { ...canvas, nodes } as unknown as Canvas;
    };
    for (const op of TASK_REACH_OPS) expect(Result.isSuccess(admitWorkTarget(flagged(true), "seat-c", "tasks-1", op)), op).toBe(true);
    const off = admitWorkTarget(flagged(false), "seat-c", "tasks-1", "rulings");
    expect(Result.isFailure(off) && off.failure.details?.reason).toBe("out_of_reach");
    // Reach to every task node is not reach to a seat.
    expect(Result.isFailure(admitWorkTarget(flagged(true), "seat-c", "seat-a", "rulings"))).toBe(true);
  });

  it("admits the operator anywhere, and an overseer at a task node only", () => {
    expect(Result.isSuccess(admitWorkTarget(canvas, OPERATOR_SEAT_ID, "tasks-1", "rulings"))).toBe(true);
    expect(Result.isSuccess(admitOverseerWorkTarget(canvas, "tasks-1", "task.claim"))).toBe(true);
    expect(Result.isFailure(admitOverseerWorkTarget(canvas, "seat-a", "task.update"))).toBe(true);
    expect(kindAllowsOp("task", "rulings")).toBe(true);
    expect(kindAllowsOp("agent", "rulings")).toBe(false);
  });
});
