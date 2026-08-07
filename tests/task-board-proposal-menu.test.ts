import { describe, expect, it } from "vitest";
import { canTransitionTaskState } from "../src/shared/task";
import { proposalAsDisplayTask } from "../src/renderer/components/work/TaskBoard";
import { Schema } from "effect";
import { ActorSeatId } from "../src/shared/actor-seat";

const seat = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"c".repeat(64)}`);

/**
 * Mirror TaskActionsMenu terminalActions filtering: proposals are display-mapped
 * to submitted tasks, so without an isProposal gate, Delete from board appears
 * and calls workTaskTransition with a proposal id.
 */
const terminalActionsFor = (isProposal: boolean, displayState: string) => {
  if (isProposal) return [] as string[];
  return (
    [
      "completed",
      "failed",
      "rejected",
      "canceled",
      "archived",
    ] as const
  ).filter((state) =>
    canTransitionTaskState(displayState as "submitted", state),
  );
};

describe("proposal card menu must not offer task transitions", () => {
  it("maps proposals to submitted for display, which is archive-legal for real tasks", () => {
    const display = proposalAsDisplayTask({
      id: "01KYWFY6RM38QG3EGW3WPCFZ8D",
      state: "pending",
      brief: {
        messageId: "b1",
        role: "user",
        parts: [{ kind: "text", text: "x" }],
        taskId: "01KYWFY6RM38QG3EGW3WPCFZ8D",
        contextId: "Vellum",
      },
      proposedBy: {
        seatId: seat,
        canvasName: "factory",
        nodeId: "agent-1",
      },
    });
    expect(display.state).toBe("submitted");
    expect(canTransitionTaskState(display.state, "archived")).toBe(true);
    // Bug: without isProposal gate, Delete from board would appear.
    expect(terminalActionsFor(false, display.state)).toContain("archived");
    // Fix: proposals get no task terminal actions.
    expect(terminalActionsFor(true, display.state)).toEqual([]);
  });
});
