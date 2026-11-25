/**
 * What a card says it follows (signalOrderOf in src/shared/operator-feed.ts):
 * the earlier signal named by its kind and sentence, closed or open, and how
 * many of the seat's own signals its thread holds, itself counted.
 */
import { describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import { signalOrderOf } from "../src/shared/operator-feed";

const signal = (signalId: string, more: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId,
  canvasName: "c",
  nodeId: "seat-a",
  kind: "blocked",
  text: `Sentence of ${signalId}`,
  createdAt: 1,
  state: "open",
  ...more,
});
const heldOf = (...signals: AgentSignal[]) => new Map(signals.map((one) => [one.signalId, one] as const));

describe("what a card follows", () => {
  it("names the earlier signal by its kind and sentence although it is closed, and counts the thread", () => {
    const head = signal("S1", { kind: "escalate", state: "answered", threadId: "T1" });
    const card = signal("S3", { threadId: "T1", followsSignalId: "S2" });
    const middle = signal("S2", { state: "dismissed", threadId: "T1", followsSignalId: "S1" });
    const read = signalOrderOf(card, heldOf(head, middle, card));
    expect(read.followsSignalId).toBe("S2");
    expect(read.follows).toEqual({ kind: "blocked", text: "Sentence of S2" });
    expect(read.threadSignals).toBe(3);
    expect(signalOrderOf(middle, heldOf(head, middle, card)).follows).toEqual({ kind: "escalate", text: "Sentence of S1" });
  });

  it("counts only the seat's own signals in its thread, and says nothing without a thread", () => {
    const card = signal("S2", { threadId: "T1", followsSignalId: "S1" });
    const held = heldOf(
      signal("S1", { threadId: "T1" }),
      card,
      signal("X", { nodeId: "seat-b", threadId: "T1" }),
      signal("Y", { threadId: "T1", source: { kind: "automation" } as never }),
    );
    expect(signalOrderOf(card, held).threadSignals).toBe(2);
    const unthreaded = signal("S3", { followsSignalId: "S1" });
    const read = signalOrderOf(unthreaded, heldOf(signal("S1"), unthreaded));
    expect(read.follows).toBeDefined();
    expect(read.threadSignals).toBeUndefined();
  });

  it("says nothing of a signal it does not follow", () => {
    const read = signalOrderOf(signal("S1"), heldOf());
    expect(read.follows).toBeUndefined();
    expect(read.threadSignals).toBeUndefined();
  });
});
