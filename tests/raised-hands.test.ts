/**
 * Raised hands: the in-memory index of open blocked / escalate signals that an
 * agent's `announces` wire into a relay watches.
 */
import { describe, expect, it } from "vitest";
import type { AgentSignal, AgentSignalKind, AgentSignalState } from "../src/shared/agent-signals";
import { makeRaisedHands, raisesHand } from "../src/main/junto/signals/raised-hands";

const signal = (
  signalId: string,
  nodeId: string,
  kind: AgentSignalKind,
  state: AgentSignalState = "open",
  canvasName = "factory",
): AgentSignal => ({
  signalId,
  canvasName,
  nodeId,
  kind,
  text: "need you",
  createdAt: 1,
  state,
  ...(state === "open" ? {} : { closedAt: 2 }),
});

describe("raisesHand", () => {
  it("counts only open blocked and escalate signals", () => {
    expect(raisesHand(signal("s1", "a", "blocked"))).toBe(true);
    expect(raisesHand(signal("s2", "a", "escalate"))).toBe(true);
    expect(raisesHand(signal("s3", "a", "feedback"))).toBe(false);
    for (const state of ["answered", "dismissed", "withdrawn"] as const) {
      expect(raisesHand(signal("s4", "a", "blocked", state))).toBe(false);
    }
  });
});

describe("makeRaisedHands", () => {
  it("raises on an open blocked or escalate signal, never on feedback", () => {
    const hands = makeRaisedHands();
    hands.note(signal("s1", "a", "blocked"));
    hands.note(signal("s2", "b", "escalate"));
    hands.note(signal("s3", "c", "feedback"));
    expect([...hands.snapshot("factory")].sort()).toEqual(["a", "b"]);
  });

  it("lowers when the signal is answered, dismissed or withdrawn", () => {
    for (const state of ["answered", "dismissed", "withdrawn"] as const) {
      const hands = makeRaisedHands();
      hands.note(signal("s1", "a", "blocked"));
      hands.note(signal("s1", "a", "blocked", state));
      expect(hands.snapshot("factory").size, state).toBe(0);
    }
  });

  it("keeps a seat raised while any one of its hands is still open", () => {
    const hands = makeRaisedHands();
    hands.note(signal("s1", "a", "blocked"));
    hands.note(signal("s2", "a", "escalate"));
    hands.note(signal("s1", "a", "blocked", "answered"));
    expect([...hands.snapshot("factory")]).toEqual(["a"]);
    hands.note(signal("s2", "a", "escalate", "withdrawn"));
    expect(hands.snapshot("factory").size).toBe(0);
  });

  it("scopes the snapshot to one canvas", () => {
    const hands = makeRaisedHands();
    hands.note(signal("s1", "a", "blocked", "open", "factory"));
    hands.note(signal("s2", "a", "blocked", "open", "lab"));
    expect([...hands.snapshot("factory")]).toEqual(["a"]);
    expect([...hands.snapshot("lab")]).toEqual(["a"]);
    hands.note(signal("s2", "a", "blocked", "dismissed", "lab"));
    expect([...hands.snapshot("factory")]).toEqual(["a"]);
    expect(hands.snapshot("lab").size).toBe(0);
    expect(hands.snapshot("unknown").size).toBe(0);
  });

  it("hydrate loads hands raised before boot but never undoes a change note saw first", () => {
    const hands = makeRaisedHands();
    // Withdrawn after boot, before the hydrate query answered.
    hands.note(signal("s1", "a", "blocked", "withdrawn"));
    hands.hydrate([signal("s1", "a", "blocked"), signal("s2", "b", "escalate")]);
    expect([...hands.snapshot("factory")]).toEqual(["b"]);
  });

  it("notifies subscribers only when the raised set changes", () => {
    const hands = makeRaisedHands();
    let calls = 0;
    const unsubscribe = hands.subscribe(() => {
      calls += 1;
    });
    hands.note(signal("s1", "a", "blocked"));
    expect(calls).toBe(1);
    hands.note(signal("s1", "a", "blocked"));
    expect(calls).toBe(1);
    hands.note(signal("s2", "b", "feedback"));
    expect(calls).toBe(1);
    hands.note(signal("s1", "a", "blocked", "answered"));
    expect(calls).toBe(2);
    hands.hydrate([signal("s3", "c", "escalate")]);
    expect(calls).toBe(3);
    hands.hydrate([]);
    expect(calls).toBe(3);
    unsubscribe();
    hands.note(signal("s4", "d", "blocked"));
    expect(calls).toBe(3);
  });
});
