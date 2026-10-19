import { observe } from "@legendapp/state";
import { afterEach, describe, expect, it } from "vitest";
import { seatStandingOf } from "../src/renderer/components/SeatRing";
import { agentSeat$ } from "../src/renderer/lib/agent-seat-state";
import { Palette } from "../src/shared/wire/urgency";
import { seat } from "./support/model-nodes";

// The palette ranks seats by what the seat itself reports, and re-ranks when
// a store it read changes.
describe("seatStandingOf", () => {
  const ada = seat("ada", { label: "Ada" });
  const binding = ada.bindingId;
  const event = (state: "working" | "idle" | "attention", at: number) => ({
    bindingId: binding,
    epoch: "e1",
    state,
    reason: "test",
    confidence: "high" as const,
    at,
  });

  afterEach(() => {
    agentSeat$.byBindingId[binding].delete();
    agentSeat$.needsLookByBindingId[binding].delete();
    agentSeat$.doneAtByBindingId[binding].delete();
  });

  it("a working seat ranks working, since its event", () => {
    agentSeat$.byBindingId[binding].set(event("working", 40));
    expect(seatStandingOf(ada)).toEqual({ group: Palette.group.working, since: 40 });
  });

  it("an idle seat the operator has not read ranks done, since its finished turn", () => {
    agentSeat$.byBindingId[binding].set(event("idle", 90));
    agentSeat$.needsLookByBindingId[binding].set(true);
    agentSeat$.doneAtByBindingId[binding].set(75);
    expect(seatStandingOf(ada)).toEqual({ group: Palette.group.done, since: 75 });
  });

  it("re-evaluates inside a tracked read when the seat changes state", () => {
    agentSeat$.byBindingId[binding].set(event("working", 1));
    const seen: string[] = [];
    const stop = observe(() => {
      seen.push(seatStandingOf(ada).group);
    });
    agentSeat$.byBindingId[binding].set(event("attention", 2));
    stop();
    expect(seen).toEqual([Palette.group.working, Palette.group.waiting]);
  });
});
