import { describe, expect, it, beforeEach } from "vitest";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { CanvasNode } from "../src/shared/canvas";
import {
  applyAgentSeatStateEvent,
  clueFromAgentSeat,
  decodeAgentSeatStateEvent,
  harnessFromSeatState,
  resetAgentSeatState,
  terminalStatusByNodeIdFromSeats,
  workSurfaceFromSeat,
  agentSeat$,
} from "../src/renderer/lib/agent-seat-state";

const event = (partial: Partial<AgentSeatStateEvent> & { bindingId: string; state: AgentSeatStateEvent["state"] }): AgentSeatStateEvent => ({
  epoch: "e1",
  reason: partial.state,
  confidence: "high",
  at: 1_700_000_000_000,
  ...partial,
});

const terminalNode = (id: string, bindingId: string): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "terminal" },
    terminal: { bindingId, label: id },
  },
});

describe("decodeAgentSeatStateEvent", () => {
  it("accepts a full event", () => {
    const decoded = decodeAgentSeatStateEvent(
      event({ bindingId: "b1", state: "attention", reason: "permission", harness: "claude" }),
    );
    expect(decoded).toMatchObject({
      bindingId: "b1",
      state: "attention",
      reason: "permission",
      harness: "claude",
    });
  });

  it("rejects partial lifecycle events without epoch or confidence", () => {
    expect(decodeAgentSeatStateEvent({
      bindingId: "b2",
      state: "attention",
      reason: "nudge",
      at: 42,
    })).toBeUndefined();
  });

  it("rejects missing bindingId or invalid state", () => {
    expect(decodeAgentSeatStateEvent({ state: "attention" })).toBeUndefined();
    expect(decodeAgentSeatStateEvent({ bindingId: "b", state: "blocked" })).toBeUndefined();
    expect(decodeAgentSeatStateEvent(null)).toBeUndefined();
  });
});

describe("harnessFromSeatState / clueFromAgentSeat", () => {
  it("maps product states to occupancy harness vocabulary", () => {
    expect(harnessFromSeatState("attention")).toBe("attention");
    expect(harnessFromSeatState("working")).toBe("working");
    expect(harnessFromSeatState("idle")).toBe("idle");
    expect(harnessFromSeatState("unknown")).toBe("unknown");
    expect(harnessFromSeatState("gone")).toBe("unknown");
  });

  it("builds an occupancy clue with process-bind presence", () => {
    const clue = clueFromAgentSeat(event({ bindingId: "b1", state: "attention", at: 99 }));
    expect(clue).toEqual({
      hasOccupant: true,
      activity: { harness: "attention" },
      lastSeenAtMs: 99,
    });
    expect(clueFromAgentSeat(undefined)).toBeUndefined();
  });

  it("turns a gone generation into an explicit vacant-seat clue", () => {
    expect(
      clueFromAgentSeat(
        event({ bindingId: "b1", state: "gone", at: 100 }),
      ),
    ).toEqual({
      hasOccupant: false,
      activity: { harness: "unknown" },
      lastSeenAtMs: 100,
    });
  });

  it("workSurfaceFromSeat marks session running for rollups", () => {
    expect(workSurfaceFromSeat(event({ bindingId: "b1", state: "working" }))).toEqual({
      session: "running",
      harness: "working",
      source: "native",
    });
    expect(
      workSurfaceFromSeat(event({ bindingId: "b1", state: "gone" })),
    ).toEqual({
      session: "exited",
      harness: "unknown",
      source: "native",
    });
  });
});

describe("applyAgentSeatStateEvent + terminalStatusByNodeIdFromSeats", () => {
  beforeEach(() => {
    resetAgentSeatState();
  });

  it("stores by bindingId", () => {
    applyAgentSeatStateEvent(event({ bindingId: "b1", state: "working" }));
    expect(agentSeat$.byBindingId.b1.peek()?.state).toBe("working");
  });

  it("does not let an older generation event replace a newer tombstone", () => {
    applyAgentSeatStateEvent(
      event({ bindingId: "b1", epoch: "e2", state: "gone", at: 20 }),
    );
    applyAgentSeatStateEvent(
      event({ bindingId: "b1", epoch: "e1", state: "attention", at: 10 }),
    );
    expect(agentSeat$.byBindingId.b1.peek()).toMatchObject({
      epoch: "e2",
      state: "gone",
    });
  });

  it("builds terminalStatusByNodeId from doc + seat map", () => {
    const map = terminalStatusByNodeIdFromSeats(
      [terminalNode("n1", "bind-a"), terminalNode("n2", "bind-b"), terminalNode("n3", "missing")],
      {
        "bind-a": event({ bindingId: "bind-a", state: "attention" }),
        "bind-b": event({ bindingId: "bind-b", state: "gone" }),
      },
    );
    expect(map.get("n1")).toEqual({
      session: "running",
      harness: "attention",
      source: "native",
    });
    expect(map.get("n2")).toMatchObject({
      session: "exited",
      harness: "unknown",
    });
    expect(map.has("n3")).toBe(false);
  });
});
