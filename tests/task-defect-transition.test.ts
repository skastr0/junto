import { describe, expect, it } from "vitest";
import {
  canTransitionTaskState,
  taskWithTransitionState,
} from "../src/shared/task";
import { taskItem } from "./helpers/task-fixtures";
import type { ActorSeatId } from "../src/shared/actor-seat";

// Defect-back semantics: rejected work with a prior passage re-homes to the
// previous journey sink as submitted (epoch bump owned by the work service).
// The generic transition matrix keeps "rejected" terminal (archive only) so
// no caller can resurrect a rejected task in place; the pipeline's re-home
// of a rejected passage row back to submitted is authorized locally by
// repository.forwardTask on a later forward through that station (see
// tests/work-pipeline-repository.test.ts), not opened here.

describe("rejected transition", () => {
  it("stays terminal in the generic matrix — only archive is a legal exit", () => {
    expect(canTransitionTaskState("rejected", "archived")).toBe(true);
    expect(canTransitionTaskState("rejected", "submitted")).toBe(false);
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
