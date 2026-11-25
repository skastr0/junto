/**
 * A feed card's place among the seat's signals (signalOrderOf in
 * src/shared/operator-feed.ts), on remote-security's terms: the thread and the
 * signal it follows, and what it comes after, counted only as the same seat's
 * own; an id held as another seat's is no dependency; an id not held holds
 * nothing back and is named as not received; at most eight are read.
 */
import { describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import { signalOrderOf } from "../src/shared/operator-feed";

const SEAT = "seat-a";
const signal = (signalId: string, more: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId,
  canvasName: "c",
  nodeId: SEAT,
  kind: "blocked",
  text: signalId,
  createdAt: 1,
  state: "open",
  ...more,
});
const heldOf = (...signals: AgentSignal[]) => new Map(signals.map((one) => [one.signalId, one] as const));

describe("a feed card's order among the seat's signals", () => {
  it("is ready with nothing to wait on, and says nothing", () => {
    expect(signalOrderOf(signal("S1"), heldOf())).toEqual({});
  });

  it("waits on the seat's own open signals, and not on those closed", () => {
    const card = signal("S3", { dependsOn: ["S1", "S2", "S1"] });
    const held = heldOf(signal("S1"), signal("S2", { state: "answered" }), card);
    expect(signalOrderOf(card, held)).toEqual({ dependsOn: ["S1", "S2"], ready: false, waitingOn: ["S1"] });
    expect(signalOrderOf(card, heldOf(signal("S1", { state: "withdrawn" }), signal("S2", { state: "dismissed" })))).toEqual({
      dependsOn: ["S1", "S2"],
      ready: true,
    });
  });

  it("drops an id held as another seat's or an automation's, and names one not held as not received", () => {
    const card = signal("S4", { dependsOn: ["S1", "S2", "S9"] });
    const held = heldOf(signal("S1", { nodeId: "seat-b" }), signal("S2", { source: { kind: "automation" } as never }));
    expect(signalOrderOf(card, held)).toEqual({ dependsOn: ["S9"], ready: true, notReceived: ["S9"] });
  });

  it("reads at most eight", () => {
    const ids = Array.from({ length: 10 }, (_, n) => `D${String(n)}`);
    const read = signalOrderOf(signal("S1", { dependsOn: ids }), heldOf());
    expect(read.dependsOn).toEqual(ids.slice(0, 8));
  });

  it("gives its thread only once its mail is here and paired, and what it follows only as the seat's own", () => {
    const head = signal("S1", { state: "answered", threadId: "T1" });
    const card = signal("S2", { threadId: "T1", messageId: "M2", followsSignalId: "S1", paired: true });
    expect(signalOrderOf(card, heldOf(head, card))).toEqual({
      threadId: "T1",
      followsSignalId: "S1",
      follows: { kind: "blocked", text: "S1" },
      threadSignals: 2,
    });
    // Another seat's signal is never what it follows; one not held is left out.
    expect(signalOrderOf(card, heldOf({ ...head, nodeId: "seat-b" }, card))).toEqual({ threadId: "T1" });
    expect(signalOrderOf(card, heldOf(card))).toEqual({ threadId: "T1" });
    // Its mail not here yet: no thread link, and it still says what it follows.
    const { paired: _paired, ...alone } = card;
    expect(signalOrderOf(alone, heldOf(head, alone))).toEqual({
      followsSignalId: "S1",
      follows: { kind: "blocked", text: "S1" },
      threadSignals: 2,
    });
  });

  it("never follows itself", () => {
    const card = signal("S2", { threadId: "T1", followsSignalId: "S2" });
    expect(signalOrderOf(card, heldOf(card))).toEqual({});
  });
});
