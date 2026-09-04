import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { Task, TasksContract } from "../src/shared/work-model";
import { ActorRef, ActorSeatId } from "../src/shared/work-protocol";
import {
  currentTaskOwner,
  taskCommentRecipient,
} from "../src/shared/task-owner";

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

  it("makes the operator the owner at a Me board", () => {
    const contract: TasksContract = {
      incoming: { admission: "operator" },
    };
    expect(currentTaskOwner(task({ state: "submitted" }), contract)).toEqual({
      kind: "operator",
    });
    // Even a previously claimed row at a Me board belongs to the operator.
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

describe("taskCommentRecipient", () => {
  const OTHER = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"b".repeat(64)}`);
  const ref = (seatId: typeof SEAT, nodeId: string, canvasName = "alpha") =>
    Schema.decodeUnknownSync(ActorRef)({ seatId, canvasName, nodeId });

  it("delivers to the live owning seat when someone else comments", () => {
    const recipient = taskCommentRecipient(
      task({ claimedBy: SEAT }),
      undefined,
      { seatId: OTHER },
      [ref(SEAT, "agent-node")],
      "alpha",
    );
    expect(recipient?.nodeId).toBe("agent-node");
  });

  it("never echoes the sender commenting on their own task", () => {
    expect(
      taskCommentRecipient(
        task({ claimedBy: SEAT }),
        undefined,
        { seatId: SEAT },
        [ref(SEAT, "agent-node")],
        "alpha",
      ),
    ).toBeUndefined();
  });

  it("stays silent for unclaimed, Me-board, terminal, and dead-seat rows", () => {
    const contract: TasksContract = {
      incoming: { admission: "operator" },
    };
    // Unclaimed: no owner.
    expect(
      taskCommentRecipient(task(), undefined, { seatId: OTHER }, [ref(SEAT, "n")], "alpha"),
    ).toBeUndefined();
    // Me board: the operator has no mailbox seat.
    expect(
      taskCommentRecipient(
        task({ claimedBy: SEAT }),
        contract,
        { seatId: OTHER },
        [ref(SEAT, "n")],
        "alpha",
      ),
    ).toBeUndefined();
    // Terminal: finished work notifies nobody.
    expect(
      taskCommentRecipient(
        task({ state: "completed", claimedBy: SEAT }),
        undefined,
        { seatId: OTHER },
        [ref(SEAT, "n")],
        "alpha",
      ),
    ).toBeUndefined();
    // Owner not live on this canvas: no terminal to notify.
    expect(
      taskCommentRecipient(
        task({ claimedBy: SEAT }),
        undefined,
        { seatId: OTHER },
        [ref(SEAT, "n", "beta")],
        "alpha",
      ),
    ).toBeUndefined();
  });
});
