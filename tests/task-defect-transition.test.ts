import { describe, expect, it } from "vitest";
import {
  canTransitionTaskState,
  taskWithTransitionState,
} from "../src/shared/task";
import { taskItem } from "./helpers/task-fixtures";
import type { ActorSeatId } from "../src/shared/actor-seat";

// Send-back semantics: rejected work with a prior visit returns to the
// previous board as submitted (epoch bump owned by the work service).
// The generic transition matrix keeps "rejected" terminal (archive only) so
// no caller can resurrect a rejected task in place; the task path re-home
// of a rejected visit row back to submitted is authorized locally by
// repository.sendTaskOn on a later send-on through that board (see
// tests/work-path-repository.test.ts), not opened here.

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
