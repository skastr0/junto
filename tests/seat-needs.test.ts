/**
 * seatNeedsOf: a seat's needs from its event's snapshot, plus the two facts
 * the renderer holds and main does not feed yet (declared signals, whether
 * the operator has seen the finished turn).
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
} from "../src/shared/harness-domain";
import { projectNeeds, ROLLUP_FROM_NEED } from "../src/shared/need-surfaces";
import { BindingId } from "../src/shared/terminal-session-domain";
import { seatNeedsOf } from "../src/renderer/lib/agent-seat-state";

const seat = Schema.decodeSync(BindingId)("b-n");
let clock = 1_000;
const at = (signal: SeatSignal): SignalEnvelope => ({ seat, at: (clock += 10), source: "screen", fidelity: "native", signal });

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

const tier = (needs: ReturnType<typeof seatNeedsOf>) => (needs ? projectNeeds(needs, ROLLUP_FROM_NEED) : undefined);

describe("seatNeedsOf", () => {
  it("is undefined before an event carries a snapshot", () => {
    expect(seatNeedsOf(undefined, false)).toBeUndefined();
  });

  it("a declared blocked signal reaches the rollup", () => {
    const event = eventOf(at({ _tag: "TurnStarted" }));
    expect(tier(seatNeedsOf(event, false))).toBe("working");
    const declared = { kind: "blocked" as const, signalId: "s1", text: "need creds", createdAt: clock };
    expect(tier(seatNeedsOf(event, false, declared))).toBe("blocked");
  });

  it("an unread turn is ready only while the operator has not looked", () => {
    const event = eventOf(at({ _tag: "TurnStarted" }), at({ _tag: "TurnEnded", outcome: "completed" }));
    expect(tier(seatNeedsOf(event, true))).toBe("ready");
    expect(tier(seatNeedsOf(event, false))).toBe("idle");
  });
});
