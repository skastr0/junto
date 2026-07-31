import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { CanvasNode } from "../src/shared/canvas";
import {
  applyAgentSeatStateEvent,
  clueFromAgentSeat,
  decodeAgentSeatStateEvent,
  harnessFromSeatState,
  markAgentSeatSeen,
  presentationForSeat,
  resetAgentSeatState,
  subscribeAgentSeatState,
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
    expect(harnessFromSeatState("idle", true)).toBe("attention");
    expect(harnessFromSeatState("unknown")).toBe("unknown");
    expect(harnessFromSeatState("gone")).toBe("unknown");
  });

  it("presentationForSeat derives done from idle + needsLook", () => {
    expect(presentationForSeat("idle", true)).toBe("done");
    expect(presentationForSeat("idle", false)).toBe("idle");
    expect(presentationForSeat("working", true)).toBe("working");
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

  it("arms needsLook on working→idle and clears on mark seen", () => {
    applyAgentSeatStateEvent(event({ bindingId: "b1", state: "working", at: 1 }));
    expect(agentSeat$.needsLookByBindingId.b1.peek()).toBe(false);

    applyAgentSeatStateEvent(event({ bindingId: "b1", state: "idle", at: 2 }));
    expect(agentSeat$.needsLookByBindingId.b1.peek()).toBe(true);
    expect(presentationForSeat("idle", true)).toBe("done");
    expect(workSurfaceFromSeat(event({ bindingId: "b1", state: "idle" }), true)).toEqual({
      session: "running",
      harness: "attention",
      source: "native",
    });

    markAgentSeatSeen("b1");
    expect(agentSeat$.needsLookByBindingId.b1.peek()).toBe(false);
  });

  it("does not arm needsLook on first idle without prior work", () => {
    applyAgentSeatStateEvent(event({ bindingId: "b2", state: "idle", at: 1 }));
    expect(agentSeat$.needsLookByBindingId.b2.peek()).toBe(false);
  });

  it("clears needsLook on gone / new epoch", () => {
    applyAgentSeatStateEvent(event({ bindingId: "b3", state: "working", at: 1, epoch: "e1" }));
    applyAgentSeatStateEvent(event({ bindingId: "b3", state: "idle", at: 2, epoch: "e1" }));
    expect(agentSeat$.needsLookByBindingId.b3.peek()).toBe(true);

    applyAgentSeatStateEvent(event({ bindingId: "b3", state: "gone", at: 3, epoch: "e1" }));
    expect(agentSeat$.needsLookByBindingId.b3.peek()).toBe(false);

    applyAgentSeatStateEvent(event({ bindingId: "b3", state: "working", at: 4, epoch: "e2" }));
    applyAgentSeatStateEvent(event({ bindingId: "b3", state: "idle", at: 5, epoch: "e2" }));
    expect(agentSeat$.needsLookByBindingId.b3.peek()).toBe(true);
    applyAgentSeatStateEvent(
      event({ bindingId: "b3", state: "working", at: 6, epoch: "e3" }),
    );
    expect(agentSeat$.needsLookByBindingId.b3.peek()).toBe(false);
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

  it("projects idle unseen seats as node attention", () => {
    const map = terminalStatusByNodeIdFromSeats(
      [terminalNode("n-ready", "bind-ready")],
      { "bind-ready": event({ bindingId: "bind-ready", state: "idle" }) },
      { "bind-ready": true },
    );
    expect(map.get("n-ready")).toEqual({
      session: "running",
      harness: "attention",
      source: "native",
    });
  });
});

describe("subscribeAgentSeatState renderer hydration", () => {
  beforeEach(() => {
    resetAgentSeatState();
  });

  afterEach(() => {
    resetAgentSeatState();
    delete (globalThis as { window?: unknown }).window;
  });

  it("hydrates progress state already live in main after a renderer restart", async () => {
    const snapshot = event({
      bindingId: "b-live",
      state: "working",
      reason: "rule:osc_title_working",
      at: 20,
    });
    const unsubscribe = vi.fn();
    (globalThis as unknown as { window: { vellum: unknown } }).window = {
      vellum: {
        onAgentSeatStateChanged: vi.fn(() => unsubscribe),
        agentSeatStateSnapshot: vi.fn(async () => [snapshot]),
      },
    };

    const stop = subscribeAgentSeatState();
    await vi.waitFor(() => {
      expect(agentSeat$.byBindingId["b-live"].peek()).toEqual(snapshot);
    });

    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not let an older hydration overwrite a newer streamed event", async () => {
    let listener: ((raw: unknown) => void) | undefined;
    let resolveSnapshot:
      | ((events: ReadonlyArray<AgentSeatStateEvent>) => void)
      | undefined;
    const snapshot = new Promise<ReadonlyArray<AgentSeatStateEvent>>((resolve) => {
      resolveSnapshot = resolve;
    });
    (globalThis as unknown as { window: { vellum: unknown } }).window = {
      vellum: {
        onAgentSeatStateChanged: vi.fn((next: (raw: unknown) => void) => {
          listener = next;
          return () => undefined;
        }),
        agentSeatStateSnapshot: vi.fn(() => snapshot),
      },
    };

    const stop = subscribeAgentSeatState();
    listener?.(event({ bindingId: "b-race", state: "attention", at: 30 }));
    resolveSnapshot?.([
      event({ bindingId: "b-race", state: "working", at: 20 }),
    ]);
    await snapshot;
    await Promise.resolve();

    expect(agentSeat$.byBindingId["b-race"].peek()?.state).toBe("attention");
    stop();
  });
});
