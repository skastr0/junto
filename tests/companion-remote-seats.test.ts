/**
 * A seat that runs on another machine reads on the phone as that machine
 * last reported it over the link, as the window's cards do.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { companionSeat } from "../src/shared/companion-seats";
import {
  mergeSeatStateSnapshot,
  publishRemoteSeatState,
  remoteSeatOccupied,
  resetRemoteSeatState,
} from "../src/main/junto/term/remote-seat-state";

const remote = (state: AgentSeatStateEvent["state"]): AgentSeatStateEvent => ({
  bindingId: "mini-seat", epoch: "e1", state, reason: "", confidence: "high", at: 42, harness: "claude",
});

const seatInput = {
  seat: { nodeId: "worker", name: "Worker", portraitIdentity: "worker", harness: "claude" },
  region: { regionId: null, label: "", path: [] },
};

afterEach(() => resetRemoteSeatState());

describe("a seat on another machine, seen from the phone", () => {
  it("is occupied while its machine reports an occupant, and not once it reports gone", () => {
    expect(remoteSeatOccupied("mini-seat")).toBe(false);
    publishRemoteSeatState(remote("working"));
    expect(remoteSeatOccupied("mini-seat")).toBe(true);
    publishRemoteSeatState(remote("gone"));
    expect(remoteSeatOccupied("mini-seat")).toBe(false);
  });

  it("reads working with its machine's state, where this machine alone said not running", () => {
    publishRemoteSeatState(remote("working"));
    const control = mergeSeatStateSnapshot([]).find((event) => event.bindingId === "mini-seat");
    expect(control?.state).toBe("working");
    const seat = companionSeat({ ...seatInput, control: control!, process: remoteSeatOccupied("mini-seat") ? "running" : "stopped" });
    expect(seat).toMatchObject({ state: "working", line: "working", lastActivityAt: 42 });
    expect(companionSeat({ ...seatInput, process: "stopped" }).state).toBe("stopped");
  });

  it("lets this machine's own reading win when both hold the binding", () => {
    publishRemoteSeatState(remote("working"));
    const merged = mergeSeatStateSnapshot([{ ...remote("idle"), at: 7 }]);
    expect(merged.find((event) => event.bindingId === "mini-seat")?.state).toBe("idle");
  });
});
