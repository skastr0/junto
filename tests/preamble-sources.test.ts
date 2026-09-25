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
  it("tells writes in indigo and reads in steel; protocol and covered ops say nothing", () => {
    const at = { preambleId: "x", canvasName: "c", nodeId: "seat", now: NOW };
    expect(seatToolPreamble({ ...at, op: "tasks.claim" })).toMatchObject({
      text: "claimed a task", provenance: "agent", action: "tool", tone: "indigo",
    });
    expect(seatToolPreamble({ ...at, op: "board.list" })).toMatchObject({ tone: "steel" });
    for (const op of ["ping", "preamble", "signal.raise", "signal.clear", "msg.send", "overseer"]) {
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
  it("tells a changed reading as the AI's, trouble amber and good green", () => {
    expect(healthPreamble({ ...base, prior: "steady", value: "thrashing" })).toMatchObject({
      text: "thrashing", provenance: "ai", action: "health", tone: "amber",
    });
    expect(healthPreamble({ ...base, prior: "stuck", value: "going_well" })?.tone).toBe("green");
  });
  it("never crimson, silent when unchanged or old", () => {
    for (const value of ["stuck", "looping", "thrashing", "confused", "overwhelmed"] as const) {
      expect(healthPreamble({ ...base, prior: "steady", value })?.tone).not.toBe("crimson");
    }
    expect(healthPreamble({ ...base, prior: "stuck", value: "stuck" })).toBeUndefined();
    expect(healthPreamble({ ...base, prior: "steady", value: "stuck", observedAt: NOW - PREAMBLE_FRESH_MS * 5 })).toBeUndefined();
  });
});

describe("control state", () => {
  const at = { canvasName: "c", nodeId: "seat", now: NOW };
  const m = (state: "idle" | "working" | "attention" | "unknown" | "gone", needsLook = false, reason = "") => ({
    state, needsLook, reason,
  });
  it("tells the transitions worth telling, as Junto", () => {
    expect(seatStatePreamble({ ...at, prior: m("idle"), next: m("working") })).toMatchObject({
      text: "picked up work", provenance: "system", action: "state",
    });
    expect(seatStatePreamble({ ...at, prior: m("unknown"), next: m("working") })?.text).toBe("started up");
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("attention") })?.text).toBe("waiting on you");
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("attention", false, "turn-stalled") })?.text).toBe(
      "stalled, needs a look",
    );
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("idle", true) })).toMatchObject({
      text: "done, ready for review", tone: "green",
    });
    expect(seatStatePreamble({ ...at, prior: m("idle"), next: m("gone") })?.text).toBe("went offline");
  });
  it("first sight and non-events are silent", () => {
    expect(seatStatePreamble({ ...at, prior: undefined, next: m("working") })).toBeUndefined();
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("working") })).toBeUndefined();
    expect(seatStatePreamble({ ...at, prior: m("working"), next: m("idle") })).toBeUndefined();
  });
});

describe("mail", () => {
  const title = (id: string) => ({ planner: "planner", builder: "builder" })[id];
  it("tells both ends of a peer's mail", () => {
    const [inbound, outbound] = wirePreambles(
      { canvasName: "c", toNodeId: "builder", fromNodeId: "planner", kind: "notice", messageId: "m", preview: "rebase is done", at: NOW },
      title,
      NOW,
    );
    expect(inbound).toMatchObject({ nodeId: "builder", text: "mail from planner: rebase is done", action: "mail-in", provenance: "agent" });
    expect(outbound).toMatchObject({ nodeId: "planner", text: "mailed builder: rebase is done", action: "mail-out" });
  });
  it("operator prompts are the operator's; system notices are Junto's", () => {
    const [prompt] = wirePreambles({ canvasName: "c", toNodeId: "builder", kind: "prompt", messageId: "m", at: NOW }, title, NOW);
    expect(prompt).toMatchObject({ provenance: "operator", text: "prompt from you" });
    const notice = wirePreambles({ canvasName: "c", toNodeId: "builder", kind: "notice", messageId: "m", at: NOW }, title, NOW);
    expect(notice).toHaveLength(1);
    expect(notice[0]?.provenance).toBe("system");
  });
});
