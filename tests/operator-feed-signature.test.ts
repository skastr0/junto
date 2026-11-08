import { beforeEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { canvasOf, seat, terminal } from "./support/model-nodes";
import { agentSeat$ } from "../src/window/lib/agent-seat-state";
import { seatAwareness$ } from "../src/window/lib/seat-awareness";
import {
  feedSeatSig,
  feedWantsSig,
  operatorFeedFor,
} from "../src/window/lib/operator-feed";
import {
  encodeAgentSeatStatus,
  type AgentSeatStateEvent,
} from "../src/shared/agent-seat-state";
import type { SeatAwarenessAssessment } from "../src/shared/seat-awareness-contract";
import {
  initialSnapshot,
  reduceSeatSignals,
  topNeed,
  type SeatSignal,
  type SignalSource,
  type SeatSnapshot,
} from "../src/shared/harness-domain";
import type { ThreadHealthReading } from "../src/shared/thread-health";
import { BindingId } from "../src/shared/terminal-session-domain";

/**
 * The live-seat signature is the gate every seat report pays: an equal
 * signature means an identical feed and no subscriber re-renders. This lock
 * mutates one seat-store field at a time and asserts the feed's output can
 * only differ when the signature does — a field operatorFeedFor reads that
 * the signature misses would leave the feed silently stale, and this test
 * fails first. Fields deriveNeeds reads inside the snapshot are covered by
 * construction: both sides run the same function on the same snapshot
 * object, so the asymmetric surface is attention, the status slice
 * feedStopOf reads, and the health reading with its freshness inputs.
 */

const NOW = 10 * 60_000;
const canvas = canvasOf([
  seat("a", { x: 10, y: 10, label: "A" }),
  seat("b", { x: 600, y: 600, label: "B" }),
]);

const snap = (bindingId: string, ...steps: ReadonlyArray<readonly [SignalSource, SeatSignal]>): SeatSnapshot =>
  reduceSeatSignals(
    initialSnapshot(Schema.decodeSync(BindingId)(bindingId), 0),
    steps.map(([source, signal], index) => ({
      seat: Schema.decodeSync(BindingId)(bindingId),
      at: 3_000 + index,
      source,
      fidelity: source === "screen" ? ("screen" as const) : ("native" as const),
      signal,
    })),
  );

const writeEvent = (bindingId: string, over: Partial<AgentSeatStateEvent> = {}): void => {
  agentSeat$.byBindingId[bindingId].set({
    bindingId,
    epoch: "e1",
    state: "working",
    reason: "probe",
    confidence: "high",
    at: 1_000,
    ...over,
  });
};

const writeStatus = (bindingId: string, snapshot: SeatSnapshot): void => {
  writeEvent(bindingId, {
    status: encodeAgentSeatStatus({ snapshot, need: topNeed(snapshot) }),
  });
};

const reading = (value: ThreadHealthReading["value"], observedAt: number): ThreadHealthReading => ({
  bindingId: "binding-a",
  value,
  confidence: 0.8,
  observedAt,
  provenance: { source: "jev", assessmentId: "as1", questionId: "q", packVersion: "1" },
  signals: [],
});

/** Only health and evidence.digest are read; the rest of the assessment is inert here. */
const assessment = (health: ThreadHealthReading | undefined, digest = "d1"): SeatAwarenessAssessment =>
  ({ health, evidence: { digest, capturedAt: 0, lines: [] } }) as unknown as SeatAwarenessAssessment;

const feedKey = (): string => JSON.stringify(operatorFeedFor("main", canvas, [], NOW));
const seatKey = (): string => feedSeatSig(canvas);

/** Every mutation in this file is meant to move the feed; both flags must flip. */
const check = (name: string, mutate: () => void): void => {
  const feed0 = feedKey();
  const sig0 = seatKey();
  mutate();
  const feedChanged = feedKey() !== feed0;
  const sigChanged = seatKey() !== sig0;
  expect(feedChanged, `${name}: the feed did not change`).toBe(true);
  expect(sigChanged, `${name}: feed changed but signature did not`).toBe(true);
};

beforeEach(() => {
  agentSeat$.byBindingId.set({});
  agentSeat$.rev.set(0);
  seatAwareness$.byBindingId.set({});
  seatAwareness$.windowDigestByBindingId.set({});
});

describe("the feed's seat signature covers what the feed reads", () => {
  it("attention arriving, re-wording, re-timing and leaving", () => {
    writeEvent("binding-a", { state: "attention", reason: "stall", at: 5_000 });
    check("attention arrives", () => writeEvent("binding-a", { state: "working" }));
    check("attention returns", () => writeEvent("binding-a", { state: "attention", reason: "stall", at: 5_000 }));
    check("stall reason rewords the row", () => writeEvent("binding-a", { state: "attention", reason: "dialog", at: 5_000 }));
    check("attention re-times the row", () => writeEvent("binding-a", { state: "attention", reason: "dialog", at: 6_000 }));
  });

  it("a stopped status appearing and its words changing", () => {
    check("usage limit stops the seat", () =>
      writeStatus("binding-a", snap("binding-a", ["screen", { _tag: "UsageLimitHit", scope: "weekly", message: "limit" }])));
    // A usage limit's message is not drawn; its reset time is.
    check("the limit's reset time rewords the row", () =>
      writeStatus("binding-a", snap("binding-a", ["screen", { _tag: "UsageLimitHit", scope: "weekly", resetsAt: NOW + 3_600_000, message: "limit" }])));
    check("an error's message changes the detail", () =>
      writeStatus("binding-a", snap("binding-a", ["transcript", { _tag: "ErrorRaised", kind: "auth", message: "m1" }])));
    check("an exit's code changes the detail", () =>
      writeStatus("binding-a", snap("binding-a", ["process", { _tag: "ProcessExited", code: 1, expected: false }])));
    check("the stop clears", () => writeEvent("binding-a", { state: "working" }));
  });

  it("the health reading and its freshness inputs, on a seat with a row", () => {
    writeEvent("binding-a", { state: "attention", reason: "stall", at: 5_000 });
    const old = NOW - 60 * 60_000;
    seatAwareness$.byBindingId["binding-a"].set(assessment(reading("going_well", old), "d1"));
    seatAwareness$.windowDigestByBindingId["binding-a"].set("d1");
    check("the reading's value re-words the row", () =>
      seatAwareness$.byBindingId["binding-a"].set(assessment(reading("stuck", old), "d1")));
    check("a stale reading's age moves", () =>
      seatAwareness$.byBindingId["binding-a"].set(assessment(reading("stuck", old - 60_000), "d1")));
    check("the live digest diverging stales it", () =>
      seatAwareness$.windowDigestByBindingId["binding-a"].set("d2"));
    check("the evidence digest moving stales it", () =>
      seatAwareness$.byBindingId["binding-a"].set(assessment(reading("stuck", old - 60_000), "d2")));
    check("the health leaving", () => seatAwareness$.byBindingId["binding-a"].set(assessment(undefined)));
  });

  it("fields the feed never reads move nothing", () => {
    writeEvent("binding-a", { state: "attention", reason: "stall", at: 5_000 });
    writeStatus("binding-a", snap("binding-a", ["screen", { _tag: "TurnStarted" }]));
    seatAwareness$.byBindingId["binding-a"].set(assessment(reading("going_well", NOW - 1_000)));
    const feed0 = feedKey();
    const sig0 = seatKey();
    // A bare rev bump and a done mark are not feed inputs.
    agentSeat$.rev.set(agentSeat$.rev.peek() + 1);
    agentSeat$.doneAtByBindingId["binding-a"].set(123);
    // An assessment field the health view never reads.
    seatAwareness$.byBindingId["binding-a"].set({
      ...(seatAwareness$.byBindingId["binding-a"].peek() as object),
      concerns: [{ kind: "x" }],
    } as unknown as SeatAwarenessAssessment);
    expect(feedKey()).toBe(feed0);
    expect(seatKey()).toBe(sig0);
  });

  it("the other seat's report moves the signature too", () => {
    writeEvent("binding-a", { state: "attention", reason: "stall", at: 5_000 });
    check("seat b attends", () => writeEvent("binding-b", { state: "attention", reason: "stall", at: 7_000 }));
  });
});

describe("the wants signature covers only what liveWantsInput reads", () => {
  const wantsCanvas = canvasOf([terminal("t", { x: 10, y: 10 })]);

  it("non-agent attention moves it; agent attention does not", () => {
    const key0 = feedWantsSig(wantsCanvas);
    // The terminal's binding is terminal-t; an agent seat's event is out of scope.
    writeEvent("binding-a", { state: "attention", reason: "stall", at: 5_000 });
    expect(feedWantsSig(wantsCanvas)).toBe(key0);
    writeEvent("terminal-t", { state: "attention", reason: "stall", at: 5_000 });
    expect(feedWantsSig(wantsCanvas)).not.toBe(key0);
  });
});
