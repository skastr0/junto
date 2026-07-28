import { describe, expect, it } from "vitest";
import { isTaskClaimantRetired } from "../src/renderer/components/work/TaskBoard";

const activeSeat = "seat_active";
const retiredSeat = "seat_retired";

describe("TaskBoard claimant visibility", () => {
  it.each([
    "working",
    "input-required",
    "auth-required",
  ] as const)("marks an active %s task when its exact claimant is absent", (state) => {
    expect(
      isTaskClaimantRetired(state, retiredSeat, new Set([activeSeat])),
    ).toBe(true);
  });

  it("does not mark an active task whose exact claimant remains projected", () => {
    expect(
      isTaskClaimantRetired("working", activeSeat, new Set([activeSeat])),
    ).toBe(false);
  });

  it.each([
    "completed",
    "canceled",
    "failed",
    "rejected",
  ] as const)("keeps terminal %s history attributed without calling it stalled", (state) => {
    expect(
      isTaskClaimantRetired(state, retiredSeat, new Set([activeSeat])),
    ).toBe(false);
  });

  it("does not invent a retired claimant for an unclaimed task", () => {
    expect(
      isTaskClaimantRetired("submitted", undefined, new Set()),
    ).toBe(false);
  });
});
