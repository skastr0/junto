import { describe, expect, it } from "vitest";
import {
  canTransitionTaskState,
  taskWithTransitionState,
} from "../src/shared/task";
import { taskItem } from "./helpers/task-fixtures";
import type { ActorSeatId } from "../src/shared/actor-seat";

// Defect-back semantics: rejected work with a prior passage re-homes to the
// previous journey sink as submitted (epoch bump owned by the work service).

describe("rejected -> submitted transition", () => {
  it("is legal (defect-back re-home) while other rejected exits stay closed", () => {
    expect(canTransitionTaskState("rejected", "submitted")).toBe(true);
    expect(canTransitionTaskState("rejected", "archived")).toBe(true);
    expect(canTransitionTaskState("rejected", "working")).toBe(false);
    expect(canTransitionTaskState("rejected", "completed")).toBe(false);
  });

  it("returning a rejected task to submitted unclaims without QA requeue stamping", () => {
    const rejected = {
      ...taskItem("task-1", "Ship it", "rejected"),
      claimedBy: `seat_${"1".repeat(64)}` as ActorSeatId,
    };
    const resubmitted = taskWithTransitionState(rejected, "submitted");
    expect(resubmitted.state).toBe("submitted");
    expect(resubmitted.claimedBy).toBeUndefined();
    // rejectedTimes is the completed -> submitted QA counter only.
    expect(resubmitted.metadata?.rejectedTimes).toBeUndefined();
  });
});
