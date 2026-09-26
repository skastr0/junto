import { describe, expect, it } from "vitest";
import type { AgentSignal } from "@shared/agent-signals";
import { ALERT_CUE, signalCue } from "../src/renderer/lib/sound/director";
import { CUES } from "../src/renderer/lib/sound/cues";

const signal = (over: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId: "s1",
  canvasName: "main",
  nodeId: "seat",
  kind: "escalate",
  text: "Which branch?",
  createdAt: 1,
  state: "open",
  ...over,
});

describe("sound director", () => {
  it("sounds a new signal by its kind, loudest for blocked", () => {
    expect(signalCue(undefined, signal({ kind: "blocked" }))).toBe("blocked");
    expect(signalCue(undefined, signal({ kind: "escalate" }))).toBe("waiting");
    expect(signalCue(undefined, signal({ kind: "feedback" }))).toBe("review");
  });

  it("stays quiet when an open signal is only re-sent", () => {
    expect(signalCue(signal(), signal({ text: "Which branch, main?" }))).toBeUndefined();
  });

  it("sounds the answer landing, and nothing for a dismissal or withdrawal", () => {
    expect(signalCue(signal(), signal({ state: "answered" }))).toBe("answered");
    expect(signalCue(signal(), signal({ state: "dismissed" }))).toBeUndefined();
    expect(signalCue(signal(), signal({ state: "withdrawn" }))).toBeUndefined();
    expect(signalCue(undefined, signal({ state: "answered" }))).toBeUndefined();
  });

  it("maps the alert ladder onto cues that get louder as it climbs", () => {
    const ladder = (["working", "ready", "attention", "blocked"] as const).map((kind) => CUES[ALERT_CUE[kind]].level);
    expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
  });
});
