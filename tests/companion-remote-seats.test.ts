/**
 * A seat that runs on another machine reads on the phone as that machine
 * last reported it over the link, as the window's cards do.
 */
import { describe, expect, it } from "vitest";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { companionSeat } from "../src/shared/companion-seats";
import {
  makeRemoteSeatState,
  mergeSeatStateSnapshot,
  remoteSeatOccupied,
} from "../src/core/term/remote-seat-state";

const makeState = makeRemoteSeatState;

const remote = (state: AgentSeatStateEvent["state"], epoch = "e1"): AgentSeatStateEvent => ({
  bindingId: "mini-seat", epoch, state, reason: "", confidence: "high", at: 42, harness: "claude",
});

const seatInput = {
  seat: { nodeId: "worker", name: "Worker", portraitIdentity: "worker", harness: "claude" },
  region: { regionId: null, label: "", path: [] },
};

describe("a seat on another machine, seen from the phone", () => {
  it("is occupied while its machine reports an occupant, and not once it reports gone", () => {
    const state = makeState();
    expect(remoteSeatOccupied("mini-seat", state.events())).toBe(false);
    state.publish(remote("working"));
    expect(remoteSeatOccupied("mini-seat", state.events())).toBe(true);
    state.publish(remote("gone", "e2"));
    expect(remoteSeatOccupied("mini-seat", state.events())).toBe(false);
  });

  it("reads working with its machine's state, where this machine alone said not running", () => {
    const state = makeState();
    state.publish(remote("working"));
    const control = mergeSeatStateSnapshot([], state.events()).find((event) => event.bindingId === "mini-seat");
    expect(control?.state).toBe("working");
    const seat = companionSeat({ ...seatInput, control: control!, process: remoteSeatOccupied("mini-seat", state.events()) ? "running" : "stopped" });
    expect(seat).toMatchObject({ state: "working", line: "working", lastActivityAt: 42 });
    expect(companionSeat({ ...seatInput, process: "stopped" }).state).toBe("stopped");
  });

  it("lets this machine's own reading win when both hold the binding", () => {
    const state = makeState();
    state.publish(remote("working"));
    const merged = mergeSeatStateSnapshot([{ ...remote("idle"), at: 7 }], state.events());
    expect(merged.find((event) => event.bindingId === "mini-seat")?.state).toBe("idle");
  });
});
