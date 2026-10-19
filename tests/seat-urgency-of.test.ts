import { afterEach, describe, expect, it } from "vitest";
import { seatUrgencyOf } from "../src/renderer/components/SeatRing";
import { agentSeat$ } from "../src/renderer/lib/agent-seat-state";
import { compareView, SeatUrgency } from "../src/shared/wire/urgency";
import { seat } from "./support/model-nodes";

// The step key, the agent switcher and the rail read urgency off the seat
// itself, by its binding.
describe("seatUrgencyOf", () => {
  const ada = seat("ada", { label: "Ada" });
  const binding = ada.bindingId;

  afterEach(() => {
    agentSeat$.byBindingId[binding].delete();
    agentSeat$.needsLookByBindingId[binding].delete();
  });

  it("follows the seat's state, by its binding", () => {
    const resting = seatUrgencyOf(ada);
    agentSeat$.byBindingId[binding].set({
      bindingId: binding,
      epoch: "e1",
      state: "attention",
      reason: "needs you",
      confidence: "high",
      at: 2,
    });
    const compare = compareView(SeatUrgency);
    // A seat asking for input is more urgent than a resting one, and in the waiting group.
    expect(compare(seatUrgencyOf(ada), resting)).toBeLessThan(0);
    expect(seatUrgencyOf(ada)).toBe(SeatUrgency.group.waiting);
  });
});
