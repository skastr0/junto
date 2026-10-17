/**
 * seatNeedsOf: a seat's needs read straight from its event's snapshot, which
 * main folds declared signals and the operator's view into.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { encodeAgentSeatStatus, type AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import {
  initialSnapshot,
  reduceSeatSignals,
  topNeed,
  type SeatSignal,
  type SignalEnvelope,
  type SignalSource,
} from "../src/shared/harness-domain";
import { projectNeeds, ROLLUP_FROM_NEED } from "../src/shared/need-surfaces";
import { BindingId } from "../src/shared/terminal-session-domain";
import { seatNeedsOf } from "../src/renderer/lib/agent-seat-state";

const seat = Schema.decodeSync(BindingId)("b-n");
let clock = 1_000;
const at = (signal: SeatSignal, source: SignalSource = "screen"): SignalEnvelope => ({
  seat,
  at: (clock += 10),
  source,
  fidelity: "native",
  signal,
});

const eventOf = (...signals: SignalEnvelope[]): AgentSeatStateEvent => {
  const snapshot = reduceSeatSignals(initialSnapshot(seat, 0), signals);
  return {
    bindingId: "b-n",
    epoch: "e1",
    state: "idle",
    reason: "test",
    confidence: "high",
    at: clock,
    status: encodeAgentSeatStatus({ snapshot, need: topNeed(snapshot) }),
  };
};

const tier = (event: AgentSeatStateEvent | undefined) => {
  const needs = seatNeedsOf(event);
  return needs ? projectNeeds(needs, ROLLUP_FROM_NEED) : undefined;
};

describe("seatNeedsOf", () => {
  it("is undefined for a seat whose event carries no snapshot, so the harness fallback decides", () => {
    expect(seatNeedsOf(undefined)).toBeUndefined();
    const remote: AgentSeatStateEvent = { bindingId: "b-r", epoch: "e1", state: "working", reason: "link", confidence: "high", at: 1 };
    expect(seatNeedsOf(remote)).toBeUndefined();
  });

  it("a declared blocked signal in the snapshot reaches the rollup", () => {
    const working = at({ _tag: "TurnStarted" });
    expect(tier(eventOf(working))).toBe("working");
    const report = at({ _tag: "SeatReported", kind: "blocked", signalId: "s1", state: "open" }, "seat");
    expect(tier(eventOf(working, report))).toBe("blocked");
  });

  it("an unread turn is ready until the operator views the seat", () => {
    const turn = [at({ _tag: "TurnStarted" }), at({ _tag: "TurnEnded", outcome: "completed" })];
    expect(tier(eventOf(...turn))).toBe("ready");
    expect(tier(eventOf(...turn, at({ _tag: "OperatorViewed" }, "system")))).toBe("idle");
  });
});
