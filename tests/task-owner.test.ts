import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { Task, TasksSinkContract } from "../src/shared/work-model";
import { ActorSeatId } from "../src/shared/work-protocol";
import { currentTaskOwner } from "../src/shared/task-owner";

const task = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "01TASKOWNER000000000000000",
    state: "working",
    history: [
      {
        messageId: "01MSGOWNER0000000000000000",
        role: "user",
        parts: [{ kind: "text", text: "do the work" }],
      },
    ],
    ...overrides,
  }) as Task;

const SEAT = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`);

describe("currentTaskOwner", () => {
  it("names the claiming seat on a claimed live row", () => {
    expect(currentTaskOwner(task({ claimedBy: SEAT }), undefined)).toEqual({
      kind: "seat",
      seatId: SEAT,
    });
  });

  it("has no owner while the row is unclaimed", () => {
    expect(currentTaskOwner(task(), undefined)).toEqual({ kind: "none" });
    expect(currentTaskOwner(task({ state: "submitted" }), undefined)).toEqual({
      kind: "none",
    });
  });

  it("makes the operator the owner at an operator-owned station", () => {
    const contract: TasksSinkContract = {
      inbound: { admission: "operator-owned" },
    };
    expect(currentTaskOwner(task({ state: "submitted" }), contract)).toEqual({
      kind: "operator",
    });
    // Even a (historically) claimed row at an owned station routes to the
    // operator — the station's mind is the operator, full stop.
    expect(currentTaskOwner(task({ claimedBy: SEAT }), contract)).toEqual({
      kind: "operator",
    });
  });

  it("has no owner after terminal states, even with claimedBy on the record", () => {
    for (const state of [
      "completed",
      "canceled",
      "failed",
      "rejected",
      "archived",
    ] as const) {
      expect(
        currentTaskOwner(task({ state, claimedBy: SEAT }), undefined),
      ).toEqual({ kind: "none" });
    }
  });

  it("keeps the seat owner through input-required and auth-required", () => {
    for (const state of ["input-required", "auth-required"] as const) {
      expect(
        currentTaskOwner(task({ state, claimedBy: SEAT }), undefined),
      ).toEqual({ kind: "seat", seatId: SEAT });
    }
  });
});
