import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAlertSignals,
  collectReadyWorkingSignals,
  heldSeatSignalIds,
  mergeAlertSignals,
  observeAlertSignals,
  resetAlertQueue,
} from "../src/renderer/lib/alert-attention";
import { alertId, compareAlerts, type AlertSignal } from "../src/renderer/lib/alert-queue";
import { AlertKind } from "../src/shared/wire/urgency";
import * as sound from "../src/renderer/lib/sound";
import type { RegionRollup } from "../src/shared/region-rollup";
import { note, seat, terminal } from "./support/model-nodes";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";

const rollup = (members: RegionRollup["members"]): RegionRollup => ({
  regionId: "r1",
  label: "forge",
  severity: "attention",
  counts: { total: members.length, blocked: 0, attention: 0, escalated: 0, working: 0, ready: 0 },
  members,
});

const signal = (nodeId: string, kind: "blocked" | "attention" | "ready" | "working"): AlertSignal => ({
  id: alertId.node(nodeId),
  kind: AlertKind.group[kind],
  subjectKey: nodeId,
});

describe("how urgent each kind is", () => {
  it("reads the alert view of the one urgency ladder", () => {
    const climb = (["working", "ready", "attention", "blocked"] as const).map((kind) => AlertKind.group[kind]);
    expect([...climb].sort(compareAlerts)).toEqual([...climb].reverse());
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
  const at = (bindingId: string, state: AgentSeatStateEvent["state"]): AgentSeatStateEvent => ({
    bindingId, epoch: "e", state, reason: "r", confidence: "high", at: 1,
  });

  it("collectReadyWorkingSignals maps native seats' done, attention and working by their own bindings", () => {
    const done = seat("agent-1");
    const working = terminal("terminal-2");
    const attention = seat("agent-3");
    const nodes = [done, working, attention, note("note")];
    const events = {
      [done.bindingId]: at(done.bindingId, "idle"),
      [working.bindingId]: at(working.bindingId, "working"),
      [attention.bindingId]: at(attention.bindingId, "attention"),
    };
    expect(collectReadyWorkingSignals(nodes, events, { [done.bindingId]: true })).toEqual([
      signal(done.id, "ready"), signal(working.id, "working"), signal(attention.id, "attention"),
    ]);
  });

  it("holds only the native seats whose own bindings have an unknown state", () => {
    const unknown = seat("unknown");
    const known = terminal("known");
    const events = {
      [unknown.bindingId]: at(unknown.bindingId, "unknown"),
      [known.bindingId]: at(known.bindingId, "idle"),
    };
    expect(heldSeatSignalIds([unknown, known, note("note")], events)).toEqual(new Set([alertId.node(unknown.id)]));
  });

  it("a seat that is both a region member and freestanding keeps its most urgent state", () => {
    const merged = mergeAlertSignals(
      collectAlertSignals([rollup([{ nodeId: "a", label: "a", kind: "agent", severity: "working", reasons: [] }])]),
      [signal("a", "ready"), signal("b", "working")],
    );
    expect(merged).toEqual([signal("a", "ready"), signal("b", "working")]);
  });
});
