import { describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import { seatToolPreamble } from "../src/shared/preamble";
import {
  PREAMBLE_FRESH_MS,
  healthPreamble,
  seatStatePreamble,
  signalPreamble,
  wirePreambles,
} from "../src/renderer/lib/preamble-sources";

const NOW = 5_000_000;

const signal = (fields: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId: "s1",
  canvasName: "c",
  nodeId: "seat",
  kind: "blocked",
  text: "need the prod DB password",
  createdAt: NOW - 1_000,
  state: "open",
  ...fields,
});

describe("seat tool calls", () => {
  it("tells only deliverables; routine reads and chores say nothing", () => {
    const at = { preambleId: "x", canvasName: "c", nodeId: "seat", now: NOW };
    expect(seatToolPreamble({ ...at, op: "artifact.publish" })).toMatchObject({
      text: "published an artifact", provenance: "agent", action: "tool", tone: "indigo",
    });
    expect(seatToolPreamble({ ...at, op: "verdict.post" })?.text).toBe("posted a verdict");
    for (const op of [
      "msg.read", "msg.list", "tasks.claim", "tasks.list", "tasks.update", "board.list", "pad.patch",
      "ping", "preamble", "signal.raise", "signal.clear", "msg.send", "overseer",
    ]) {
      expect(seatToolPreamble({ ...at, op })).toBeUndefined();
    }
  });
});

describe("signals", () => {
  it("a fresh raise is the agent's, in the kind's hue, with its sentence", () => {
    expect(signalPreamble(undefined, signal(), NOW)).toMatchObject({
      text: "blocked: need the prod DB password", provenance: "agent", action: "signal", tone: "crimson",
    });
    expect(signalPreamble(undefined, signal({ kind: "escalate" }), NOW)?.tone).toBe("amber");
    expect(signalPreamble(undefined, signal({ kind: "feedback" }), NOW)?.tone).toBe("cyan");
  });

  it("hydration and history are silent", () => {
    expect(signalPreamble(undefined, signal({ createdAt: NOW - PREAMBLE_FRESH_MS - 1 }), NOW)).toBeUndefined();
    expect(signalPreamble(undefined, signal({ state: "answered", closedAt: NOW }), NOW)).toBeUndefined();
    expect(signalPreamble(signal(), signal(), NOW)).toBeUndefined();
  });

  it("closing says who closed it", () => {
    const open = signal();
    expect(
      signalPreamble(open, signal({ state: "answered", closedAt: NOW, response: { text: "it is in 1Password", at: NOW } }), NOW),
    ).toMatchObject({ provenance: "operator", action: "signal-clear", text: "answered: it is in 1Password" });
    expect(signalPreamble(open, signal({ state: "dismissed", closedAt: NOW }), NOW)).toMatchObject({
      provenance: "operator", tone: "steel",
    });
    expect(signalPreamble(open, signal({ state: "withdrawn", closedAt: NOW }), NOW)).toMatchObject({
      provenance: "agent", tone: "green", text: "cleared: need the prod DB password",
    });
  });
});

describe("thread health", () => {
  const base = { canvasName: "c", nodeId: "seat", observedAt: NOW, now: NOW };
  it("tells trouble setting in, amber, as the AI's", () => {
    expect(healthPreamble({ ...base, prior: "steady", value: "thrashing" })).toMatchObject({
      text: "thrashing", provenance: "ai", action: "health", tone: "amber",
    });
    expect(healthPreamble({ ...base, prior: "going_well", value: "stuck" })?.tone).toBe("amber");
  });
  it("tells work turning notably good, green", () => {
    expect(healthPreamble({ ...base, prior: "steady", value: "exceeding" })).toMatchObject({
      text: "exceeding expectations", tone: "green",
    });
    expect(healthPreamble({ ...base, prior: "stuck", value: "succeeding" })?.tone).toBe("green");
  });
  it("drift within a band, ordinary readings and old readings are silent", () => {
    expect(healthPreamble({ ...base, prior: "stuck", value: "looping" })).toBeUndefined();
    expect(healthPreamble({ ...base, prior: "succeeding", value: "exceeding" })).toBeUndefined();
    expect(healthPreamble({ ...base, prior: "stuck", value: "steady" })).toBeUndefined();
    expect(healthPreamble({ ...base, prior: "steady", value: "going_well" })).toBeUndefined();
    expect(healthPreamble({ ...base, prior: "steady", value: "waiting_on_operator" })).toBeUndefined();
    expect(healthPreamble({ ...base, prior: undefined, value: "stuck" })).toBeUndefined();
    expect(healthPreamble({ ...base, prior: "stuck", value: "stuck" })).toBeUndefined();
    expect(healthPreamble({ ...base, prior: "steady", value: "stuck", observedAt: NOW - PREAMBLE_FRESH_MS * 5 })).toBeUndefined();
  });
});

describe("control state", () => {
  const at = { canvasName: "c", nodeId: "seat", now: NOW };
  const m = (state: "idle" | "working" | "attention" | "unknown" | "gone", needsLook = false, reason = "") => ({
    state, needsLook, reason,
  });
  it("tells waiting on you, done, and dropping out mid-work, as Junto", () => {
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("attention") })).toMatchObject({
      text: "waiting on you", provenance: "system", action: "state",
    });
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("attention", false, "turn-stalled") })?.text).toBe(
      "stalled, needs a look",
    );
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("idle", true) })).toMatchObject({
      text: "done", tone: "green",
    });
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("gone") })?.text).toBe("dropped out mid-work");
  });
  it("routine motion, first sight and non-events are silent", () => {
    expect(seatStatePreamble({ ...at, prior: m("idle"), next: m("working") })).toBeUndefined();
    expect(seatStatePreamble({ ...at, prior: m("unknown"), next: m("working") })).toBeUndefined();
    expect(seatStatePreamble({ ...at, prior: m("attention"), next: m("working") })).toBeUndefined();
    expect(seatStatePreamble({ ...at, prior: m("idle"), next: m("gone") })).toBeUndefined();
    expect(seatStatePreamble({ ...at, prior: undefined, next: m("attention") })).toBeUndefined();
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("working") })).toBeUndefined();
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("idle") })).toBeUndefined();
  });
});

describe("mail", () => {
  const title = (id: string) => ({ planner: "planner", builder: "builder" })[id];
  const event = { canvasName: "c", toNodeId: "builder", messageId: "m", at: NOW } as const;
  it("tells a peer's mail on the receiver only", () => {
    const told = wirePreambles({ ...event, fromNodeId: "planner", kind: "notice", preview: "rebase is done" }, title, NOW);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ nodeId: "builder", text: "mail from planner: rebase is done", action: "mail-in", provenance: "agent" });
    const [asked] = wirePreambles({ ...event, fromNodeId: "planner", kind: "prompt", preview: "review it" }, title, NOW);
    expect(asked?.text).toBe("asked by planner: review it");
  });
  it("the operator's own prompts and answers, and Junto's notices, are not echoed", () => {
    expect(wirePreambles({ ...event, kind: "prompt", fromName: "operator", preview: "do the thing" }, title, NOW)).toEqual([]);
    expect(wirePreambles({ ...event, kind: "answer", fromName: "operator" }, title, NOW)).toEqual([]);
    expect(wirePreambles({ ...event, kind: "notice", preview: "Your connections changed." }, title, NOW)).toEqual([]);
  });
  it("tells mail that failed to land, crimson, whoever sent it", () => {
    const [peer] = wirePreambles({ ...event, fromNodeId: "planner", kind: "notice", preview: "rebase", failed: true }, title, NOW);
    expect(peer).toMatchObject({
      nodeId: "builder", text: "mail from planner did not land, retrying: rebase", action: "mail-failed", tone: "crimson",
    });
    const [unsent] = wirePreambles({ ...event, kind: "prompt", failed: true }, title, NOW);
    expect(unsent?.text).toBe("mail did not land, retrying");
  });
});
