import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_URGENCY,
  collectAlertSignals,
  collectReadyWorkingSignals,
  mergeCycleSignals,
  observeAlertSignals,
  resetAlertQueue,
} from "../src/renderer/lib/alert-attention";
import { alertId, type AlertKind, type AlertSignal } from "../src/renderer/lib/alert-queue";
import { SEAT_URGENCY } from "../src/renderer/lib/seat-line";
import * as sound from "../src/renderer/lib/sound";
import type { RegionRollup } from "../src/shared/region-rollup";
import type { CanvasNode } from "../src/shared/canvas";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";

const rollup = (members: RegionRollup["members"]): RegionRollup => ({
  regionId: "r1",
  label: "forge",
  severity: "attention",
  counts: { total: members.length, blocked: 0, attention: 0, working: 0, ready: 0 },
  members,
});

const signal = (nodeId: string, kind: AlertKind): AlertSignal => ({
  id: alertId.node(nodeId),
  kind,
  subjectKey: nodeId,
  urgency: ALERT_URGENCY[kind],
});

describe("how urgent each kind is", () => {
  it("reads the one urgency table", () => {
    expect(ALERT_URGENCY).toEqual({
      blocked: SEAT_URGENCY.blocked,
      attention: SEAT_URGENCY.waiting,
      ready: SEAT_URGENCY.review,
      working: SEAT_URGENCY.working,
    });
  });
});

describe("collectAlertSignals", () => {
  it("builds one signal per member that is blocked, wants input, or is working", () => {
    const signals = collectAlertSignals([
      rollup([
        { nodeId: "n-attention", label: "review", kind: "agent", severity: "attention", reasons: [] },
        { nodeId: "n-blocked", label: "deploy", kind: "task", severity: "blocked", reasons: [] },
        { nodeId: "n-working", label: "build", kind: "agent", severity: "working", reasons: [] },
        { nodeId: "n-idle", label: "idle", kind: "agent", severity: "idle", reasons: [] },
      ]),
    ]);
    expect(signals).toEqual([signal("n-attention", "attention"), signal("n-blocked", "blocked"), signal("n-working", "working")]);
  });

  it("a node in overlapping regions keeps its most urgent state", () => {
    const signals = collectAlertSignals([
      rollup([{ nodeId: "shared", label: "first", kind: "agent", severity: "attention", reasons: [] }]),
      rollup([{ nodeId: "shared", label: "second", kind: "agent", severity: "blocked", reasons: [] }]),
      rollup([{ nodeId: "shared", label: "third", kind: "agent", severity: "working", reasons: [] }]),
    ]);
    expect(signals).toEqual([signal("shared", "blocked")]);
  });
});

describe("observeAlertSignals", () => {
  afterEach(() => {
    resetAlertQueue();
    vi.restoreAllMocks();
  });

  it("baselines, then sounds a rise with the cue of its kind", () => {
    const play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
    observeAlertSignals([signal("n", "blocked")]);
    expect(play).not.toHaveBeenCalled();
    observeAlertSignals([]);
    observeAlertSignals([signal("n", "blocked")]);
    expect(play).toHaveBeenCalledWith("blocked", { subject: "n" });
  });

  it("sounds waiting on you for an attention rise", () => {
    const play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
    observeAlertSignals([]);
    observeAlertSignals([signal("n1", "attention")]);
    expect(play).toHaveBeenCalledWith("waiting", { subject: "n1" });
  });

  it("sounds done and started working, each for its own seat", () => {
    const play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
    observeAlertSignals([]);
    observeAlertSignals([signal("r", "ready"), signal("w", "working")]);
    expect(play).toHaveBeenCalledWith("done", { subject: "r" });
    expect(play).toHaveBeenCalledWith("working", { subject: "w" });
  });

  it("stays quiet when a seat calms down (done back to working), and sounds when it gets urgent again", () => {
    const play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
    observeAlertSignals([signal("s", "ready")]);
    observeAlertSignals([signal("s", "working")]);
    expect(play).not.toHaveBeenCalled();
    observeAlertSignals([signal("s", "attention")]);
    expect(play).toHaveBeenCalledWith("waiting", { subject: "s" });
  });

  it("another canvas's seats are not news, and nothing sounds before the seats have loaded", () => {
    const play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
    observeAlertSignals([], { scope: "one" });
    observeAlertSignals([signal("x", "blocked")], { scope: "two" });
    expect(play).not.toHaveBeenCalled();
    observeAlertSignals([signal("y", "blocked")], { scope: "two", settled: false });
    observeAlertSignals([signal("y", "blocked")], { scope: "two", settled: true });
    expect(play).not.toHaveBeenCalled();
  });
});

describe("seats anywhere on the canvas", () => {
  it("collectReadyWorkingSignals maps a seat's done to ready, and its attention and working", async () => {
    const { agentSeat$, resetAgentSeatState } = await import(
      "../src/renderer/lib/agent-seat-state"
    );
    resetAgentSeatState();
    agentSeat$.bindingIdByNodeId.set({
      "agent-1": "bind-1",
      "agent-2": "bind-2",
      "agent-3": "bind-3",
    });
    try {
      const nodes = ["agent-1", "agent-2", "agent-3"].map((id) => ({ id, type: "text", x: 0, y: 0, width: 80, height: 40, text: id })) as unknown as ReadonlyArray<CanvasNode>;
      const at = (bindingId: string, state: AgentSeatStateEvent["state"]): AgentSeatStateEvent => ({
        bindingId,
        epoch: "e",
        state,
        reason: "r",
        confidence: "high",
        at: 1,
      });
      const seats: Record<string, AgentSeatStateEvent> = {
        "bind-1": at("bind-1", "idle"),
        "bind-2": at("bind-2", "working"),
        "bind-3": at("bind-3", "attention"),
      };
      const signals = collectReadyWorkingSignals(nodes, seats, {
        "bind-1": true,
      });
      // A freestanding seat is heard too, not only region members.
      expect(signals).toEqual([signal("agent-1", "ready"), signal("agent-2", "working"), signal("agent-3", "attention")]);
    } finally {
      resetAgentSeatState();
    }
  });

  it("a seat that is both a region member and freestanding keeps its most urgent state", () => {
    const merged = mergeCycleSignals(
      collectAlertSignals([rollup([{ nodeId: "a", label: "a", kind: "agent", severity: "working", reasons: [] }])]),
      [signal("a", "ready"), signal("b", "working")],
    );
    expect(merged).toEqual([signal("a", "ready"), signal("b", "working")]);
  });
});
