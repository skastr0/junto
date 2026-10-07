import { afterEach, describe, expect, it } from "vitest";
import { nodeToDocument } from "../src/shared/model/from-document";
import { seatUrgencyNow, seatUrgencyOf } from "../src/renderer/components/SeatRing";
import { agentSeat$ } from "../src/renderer/lib/agent-seat-state";
import { SEAT_URGENCY } from "../src/renderer/lib/seat-line";
import { seat } from "./support/model-nodes";

// The step key and the agent switcher read urgency off the seat itself; the
// rail and the command bar still read it off a document node. Both must say
// the same thing about the same seat, or the two orders drift apart.
describe("seatUrgencyOf", () => {
  const ada = seat("ada", { label: "Ada" });
  const binding = ada.bindingId;

  afterEach(() => {
    agentSeat$.byBindingId[binding].delete();
    agentSeat$.needsLookByBindingId[binding].delete();
  });

  const both = () => [seatUrgencyOf(ada), seatUrgencyNow(nodeToDocument(ada))];

  it("reads a seat with nothing known about it as the document reading does", () => {
    const [own, document] = both();
    expect(own).toBe(document);
  });

  it("follows the seat's state, by its binding, as the document reading does", () => {
    const resting = seatUrgencyOf(ada);
    for (const state of ["attention", "working", "idle"] as const) {
      agentSeat$.byBindingId[binding].set({
        bindingId: binding,
        epoch: "e1",
        state,
        reason: "",
        confidence: "high",
        at: 1,
      });
      const [own, document] = both();
      expect(own).toBe(document);
    }
    agentSeat$.byBindingId[binding].set({
      bindingId: binding,
      epoch: "e1",
      state: "attention",
      reason: "needs you",
      confidence: "high",
      at: 2,
    });
    expect(seatUrgencyOf(ada)).toBeLessThan(resting);
    expect(seatUrgencyOf(ada)).toBeLessThanOrEqual(SEAT_URGENCY.review);
  });
});
