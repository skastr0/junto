import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AGENT_SIGNAL_MAX_TEXT_LENGTH,
  AgentSignal,
  composeSignalAnswerMail,
  normalizeSignalText,
  rollupSeatSignals,
  type AgentSignal as AgentSignalT,
} from "../src/shared/agent-signals";

const signal = (over: Partial<AgentSignalT>): AgentSignalT => ({
  signalId: "s1",
  canvasName: "portfolio",
  nodeId: "a",
  kind: "feedback",
  text: "ready for review",
  createdAt: 1,
  state: "open",
  ...over,
});

describe("AgentSignal schema", () => {
  const decode = Schema.decodeUnknownSync(AgentSignal);

  it("accepts a bounded one-line signal", () => {
    expect(decode(signal({})).kind).toBe("feedback");
  });

  it("refuses empty and over-long text", () => {
    expect(() => decode(signal({ text: "" }))).toThrow();
    expect(() =>
      decode(signal({ text: "x".repeat(AGENT_SIGNAL_MAX_TEXT_LENGTH + 1) })),
    ).toThrow();
  });

  it("refuses unknown kinds and states", () => {
    expect(() => decode({ ...signal({}), kind: "urgent" })).toThrow();
    expect(() => decode({ ...signal({}), state: "closed" })).toThrow();
  });
});

describe("normalizeSignalText", () => {
  it("reads as one line", () => {
    expect(normalizeSignalText("  waiting\n on  you ")).toBe("waiting on you");
  });
});

describe("rollupSeatSignals", () => {
  it("keeps the worst open kind per seat: blocked over escalate over feedback", () => {
    const rollup = rollupSeatSignals([
      signal({ signalId: "f", kind: "feedback", createdAt: 3 }),
      signal({ signalId: "b", kind: "blocked", createdAt: 1 }),
      signal({ signalId: "e", kind: "escalate", createdAt: 2 }),
      signal({ signalId: "o", nodeId: "b", kind: "escalate" }),
    ]);
    expect(rollup.get("a")).toMatchObject({ kind: "blocked", openCount: 3 });
    expect(rollup.get("a")?.signal.signalId).toBe("b");
    expect(rollup.get("b")?.kind).toBe("escalate");
  });

  it("breaks a tie with the newest signal", () => {
    const rollup = rollupSeatSignals([
      signal({ signalId: "old", kind: "escalate", createdAt: 1 }),
      signal({ signalId: "new", kind: "escalate", createdAt: 5 }),
    ]);
    expect(rollup.get("a")?.signal.signalId).toBe("new");
  });

  it("ignores answered, dismissed, and withdrawn signals", () => {
    const rollup = rollupSeatSignals([
      signal({ state: "answered", kind: "blocked" }),
      signal({ state: "dismissed" }),
      signal({ state: "withdrawn" }),
    ]);
    expect(rollup.size).toBe(0);
  });
});

describe("composeSignalAnswerMail", () => {
  it("names the signal it answers, then the operator's words", () => {
    expect(
      composeSignalAnswerMail(
        { signalId: "01J", kind: "blocked", text: "need the key" },
        "  it is in 1Password under staging  ",
      ),
    ).toBe(
      'The operator answered your blocked signal (01J): "need the key"\n\nit is in 1Password under staging',
    );
  });
});
