/**
 * Awareness scheduler: cadence, coalescing, in-flight limits, caps, budget,
 * cache, cancellation on generation change, stale rejection, retention expiry,
 * backoff, and the authority boundary that keeps every failure out of the
 * deterministic path.
 *
 * The evidence projection is the real one (workstream C's `selectAwarenessInput`
 * and `computeWindowDigest`), so the cache key material and the window digest in
 * these tests are the production values.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AWARENESS_SCHEDULER_CONFIG,
  estimateAwarenessCallCost,
  makeAwarenessScheduler,
  type AwarenessAdvisory,
  type AwarenessSchedulerConfig,
  type AwarenessSchedulerShape,
} from "../src/main/junto/term/awareness/scheduler";
import type { AwarenessEvidenceWindow } from "../src/main/junto/term/awareness/select-input";
import type { AwarenessAsk, AwarenessAskOutcome } from "../src/main/junto/term/awareness/jev-client";
import type { ObserverGridSnapshot } from "../src/main/junto/term/observer";
import {
  EVIDENCE_TEXT,
  abstainedOutcome,
  currentOutcome,
  makeAskRecorder,
  makeFakeProjectionPort,
  makeFakeSeatPort,
  makeManualTimers,
  makeSnapshot,
  mixedOutcome,
  negativesOnlyOutcome,
  rejectedOutcome,
  type AskRecorder,
  type FakeProjectionPort,
  type FakeSeatPort,
  type ManualTimers,
  unansweredOutcome,
} from "./helpers/awareness-fakes";

type Harness = {
  readonly timers: ManualTimers;
  readonly seats: FakeSeatPort;
  readonly projection: FakeProjectionPort;
  readonly model: AskRecorder;
  readonly scheduler: AwarenessSchedulerShape;
  readonly advisories: ReadonlyArray<AwarenessAdvisory>;
  readonly config: AwarenessSchedulerConfig;
  /** Publish one observation with a fresh sequence and its non-flushing window. */
  readonly observe: (
    bindingId: string,
    text?: string,
    epoch?: string,
    options?: { readonly window?: boolean },
  ) => void;
};

const windowFor = (snapshot: ObserverGridSnapshot, observedAt: number): AwarenessEvidenceWindow => ({
  bindingId: snapshot.bindingId,
  epoch: snapshot.epoch,
  cols: snapshot.cols,
  rows: snapshot.rows,
  seq: snapshot.seq,
  lines: snapshot.lines,
  totalLines: snapshot.lines.length,
  truncated: false,
  observedAt,
});

const harness = (
  config: Partial<AwarenessSchedulerConfig> = {},
  options: {
    readonly modelAvailable?: boolean;
    readonly auto?: boolean;
    readonly build?: (ask: AwarenessAsk) => AwarenessAskOutcome;
  } = {},
): Harness => {
  const timers = makeManualTimers();
  const seats = makeFakeSeatPort();
  const projection = makeFakeProjectionPort();
  const model = makeAskRecorder({ auto: options.auto ?? true, build: options.build });
  const advisories: AwarenessAdvisory[] = [];
  const scheduler = makeAwarenessScheduler({
    ask: model.ask,
    unavailable: model.unavailable,
    modelId: "jev-latest",
    modelAvailable: options.modelAvailable ?? true,
    modelUnavailableReason:
      options.modelAvailable === false ? "no Jev API key configured" : undefined,
    seats,
    projection,
    config,
    clock: timers.clock,
    timers,
    random: () => 0.5,
  });
  scheduler.subscribe((advisory) => advisories.push(advisory));
  let seq = 1n;
  return {
    timers,
    seats,
    projection,
    model,
    scheduler,
    advisories,
    config: { ...DEFAULT_AWARENESS_SCHEDULER_CONFIG, ...config },
    observe: (bindingId, text = EVIDENCE_TEXT, epoch = "e1", observeOptions = {}) => {
      seq += 1n;
      const snapshot = makeSnapshot({ bindingId, epoch, text, seq });
      scheduler.observe(
        snapshot,
        observeOptions.window === false ? undefined : windowFor(snapshot, timers.clock()),
      );
    },
  };
};

const freePricing = { inputUsdPerMTokens: 0, outputUsdPerMTokens: 0 };

describe("trigger discipline", () => {
  it("spends one call on the first stable screen, after coalescing", async () => {
    const h = harness();
    h.observe("s1");
    expect(h.model.count()).toBe(0);
    h.timers.advance(299);
    expect(h.model.count()).toBe(0);
    h.timers.advance(1);
    expect(h.model.count()).toBe(1);
    await h.scheduler.drain();
    const advisory = h.scheduler.advisory("s1");
    expect(advisory.status).toBe("fresh");
    expect(advisory.availability).toBe("current");
    expect(advisory.trigger).toBe("first-screen");
    expect(advisory.assessment?.concerns.map((concern) => concern.concern)).toEqual([
      "approval_requested",
    ]);
  });

  it("costs nothing for an unchanged idle seat", async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
    for (let i = 0; i < 20; i += 1) h.observe("s1");
    h.timers.advance(120_000);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
    expect(h.scheduler.stats().cacheHits).toBe(0);
  });

  it("never triggers on byte increments or spinner animation", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
    // Twenty repaints of the same material screen: new bytes, same digest.
    for (let frame = 0; frame < 20; frame += 1) {
      h.observe("s1");
      h.timers.advance(16);
    }
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
  });

  it("asks about a material revision that arrived while the floor was closed, even if the seat then goes quiet", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);

    // The screen changes inside the interval floor: the ask is suppressed.
    h.observe("s1", `${EVIDENCE_TEXT}\n12 tests failed in auth.spec.ts`);
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);

    // No further bytes arrive — the seat is blocked on the dialog it just
    // printed. The floor expiring is the only event left, and it must ask.
    h.timers.advance(61_000);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
  });

  it("never triggers on an attention heartbeat", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
    h.seats.set("s1", { attention: true });
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
    for (let beat = 0; beat < 5; beat += 1) {
      h.seats.set("s1", { attention: true });
      h.observe("s1");
      h.timers.advance(1_000);
    }
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
  });

  it("triggers on a material control transition", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
  });

  it("still evaluates deterministic facts when the grid did not move", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1", EVIDENCE_TEXT, "e1", { window: false });
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
  });

  it("spends one priority refresh per stall or delivery episode", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    h.seats.set("s1", { episode: "stall-1" });
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
    for (let beat = 0; beat < 3; beat += 1) {
      h.observe("s1");
      h.timers.advance(300);
    }
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
    h.seats.set("s1", { episode: "delivery-1" });
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(3);
  });

  it("asks about materially different working text at most once per 60s", async () => {
    const h = harness();
    h.observe("s1", "screen a");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);

    h.timers.advance(10_000);
    h.observe("s1", "screen b");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);

    h.timers.advance(50_000);
    h.observe("s1", "screen b");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);

    h.timers.advance(60_000);
    h.observe("s1", "screen c");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(3);
  });
});

describe("coalescing", () => {
  it("collapses a burst into one request", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(50);
    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1");
    h.timers.advance(50);
    h.seats.set("s1", { attention: true });
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
    expect(h.model.calls[0]!.ask.request.questions.length).toBeGreaterThan(0);
  });

  it("never waits longer than the maximum wait", async () => {
    const h = harness({ coalesceMs: 300, coalesceMaxWaitMs: 500 });
    h.observe("s1");
    for (let i = 0; i < 4; i += 1) {
      h.timers.advance(100);
      h.seats.set("s1", { controlRevision: i + 1 });
      h.observe("s1");
      expect(h.model.count()).toBe(0);
    }
    h.timers.advance(100);
    expect(h.model.count()).toBe(1);
    await h.scheduler.drain();
    expect(h.scheduler.stats().refusals["queue full"]).toBeUndefined();
  });

  it("holds one replaceable pending observation per seat", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(100);
    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1");
    h.timers.advance(100);
    h.seats.set("s1", { controlRevision: 2 });
    h.observe("s1");
    expect(h.scheduler.stats().queued).toBe(1);
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
  });
});

describe("in-flight limits", () => {
  it("keeps one in-flight request per seat", async () => {
    const h = harness({}, { auto: false });
    h.observe("s1");
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);

    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1");
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);

    h.model.settleAt(0, currentOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    h.timers.advance(300);
    expect(h.model.count()).toBe(2);
    h.model.settleAt(1, currentOutcome(h.model.calls[1]!.ask));
    await h.scheduler.drain();
    expect(h.scheduler.stats().inFlight).toBe(0);
  });

  it("caps the station at four in-flight requests", async () => {
    const h = harness({}, { auto: false });
    for (let seat = 0; seat < 6; seat += 1) h.observe(`s${seat}`, `evidence for seat ${seat}`);
    h.timers.advance(300);
    expect(h.model.count()).toBe(4);
    expect(h.scheduler.stats().inFlight).toBe(4);
    expect(h.scheduler.stats().queued).toBe(2);

    for (let index = 0; index < 4; index += 1) {
      h.model.settleAt(index, currentOutcome(h.model.calls[index]!.ask));
    }
    await h.scheduler.drain();
    expect(h.model.count()).toBe(6);
    for (let index = 4; index < 6; index += 1) {
      h.model.settleAt(index, currentOutcome(h.model.calls[index]!.ask));
    }
    await h.scheduler.drain();
    expect(h.scheduler.stats().inFlight).toBe(0);
    expect(h.scheduler.stats().queued).toBe(0);
  });

  it("serves the fair queue in arrival order, and hover before a waiting concern", async () => {
    const h = harness(
      { maxInFlightStation: 1, coalesceMs: 100, coalesceMaxWaitMs: 100 },
      { auto: false },
    );
    h.observe("a", "evidence a");
    h.timers.advance(1);
    h.observe("b", "evidence b");
    h.observe("c", "evidence c");
    h.timers.advance(100);
    expect(h.model.count()).toBe(1);
    expect(h.model.calls[0]!.ask.request.bindingId).toBe("a");

    // A hover on a third seat outranks the waiting concerns. It coalesces
    // first, then wins the queue when the station slot frees.
    h.scheduler.hover("c");
    h.timers.advance(100);
    h.model.settleAt(0, currentOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
    expect(h.model.calls[1]!.ask.request.bindingId).toBe("c");

    h.model.settleAt(1, currentOutcome(h.model.calls[1]!.ask));
    await h.scheduler.drain();
    expect(h.model.count()).toBe(3);
    expect(h.model.calls[2]!.ask.request.bindingId).toBe("b");
  });

  it("bounds the queue and lets a hover displace the lowest concern", async () => {
    const h = harness(
      { maxInFlightStation: 1, maxQueuedSeats: 1, coalesceMs: 100, coalesceMaxWaitMs: 100 },
      { auto: false },
    );
    h.observe("a", "evidence a");
    h.timers.advance(1);
    h.observe("b", "evidence b");
    expect(h.scheduler.stats().refusals["queue full"]).toBe(1);
    expect(h.scheduler.stats().queued).toBe(1);

    h.observe("c", "evidence c");
    expect(h.scheduler.stats().refusals["queue full"]).toBe(2);
    h.scheduler.hover("c");
    expect(h.scheduler.stats().queued).toBe(1);

    h.timers.advance(100);
    expect(h.model.count()).toBe(1);
    expect(h.model.calls[0]!.ask.request.bindingId).toBe("c");
  });
});

/**
 * The reservation one real request makes, measured through the scheduler
 * rather than estimated from a guessed size, so a pack that grows or shrinks
 * cannot silently move these ceilings.
 */
const measuredCallCost = async (
  pricing: { readonly inputUsdPerMTokens: number; readonly outputUsdPerMTokens: number },
  evidence?: string,
): Promise<number> => {
  const probe = harness({ pricing });
  if (evidence === undefined) probe.observe("s1");
  else probe.observe("s1", evidence);
  probe.timers.advance(300);
  await probe.scheduler.drain();
  const perCall = probe.scheduler.stats().spentUsd;
  expect(perCall).toBeGreaterThan(0);
  expect(perCall).toBeGreaterThanOrEqual(
    estimateAwarenessCallCost({ requestBytes: 0, questionCount: 1 }, probe.config),
  );
  return perCall;
};

describe("caps and budget", () => {
  it("stops a seat at its hourly call cap and counts refused attempts", async () => {
    const h = harness({ seatCallsPerHour: 2, pricing: freePricing });
    h.observe("s1", "screen 1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);

    for (const round of [1, 2]) {
      h.observe("s1", `screen ${round + 1}`);
      h.seats.set("s1", { controlRevision: round });
      h.timers.advance(60_000);
      h.observe("s1", `screen ${round + 1}`);
      h.timers.advance(300);
      await h.scheduler.drain();
    }

    expect(h.model.count()).toBe(2);
    // Two refusals, not one: each round suppresses a material revision behind
    // the interval floor, and when the floor expires the scheduler makes that
    // attempt even though the seat then goes quiet. Both attempts are real asks
    // the cap declined; the cap still holds the seat at two calls.
    expect(h.scheduler.stats().refusals["seat call cap"]).toBe(2);
    const refused = h.scheduler.advisory("s1");
    expect(refused.status).toBe("refused");
    expect(refused.reason).toBe("seat call cap");
    // A cap refusal never replaces a judgment the seat already holds.
    expect(refused.availability).toBe("current");
    expect(refused.unavailableReason).toBeNull();
    expect(refused.assessment?.unavailableReason).toBeUndefined();
  });

  it("publishes a budget refusal as a real unavailable assessment when nothing is displayable", async () => {
    const pricing = { inputUsdPerMTokens: 0.042, outputUsdPerMTokens: 0 };
    const h = harness({ seatUsdPerHour: 0, pricing });
    h.observe("s1", "screen 1");
    h.timers.advance(300);
    await h.scheduler.drain();

    // The bound declined before sending: no call, no charge.
    expect(h.model.count()).toBe(0);
    expect(h.scheduler.stats().refusals["seat budget"]).toBe(1);
    const refused = h.scheduler.advisory("s1");
    expect(refused.status).toBe("refused");
    expect(refused.reason).toBe("seat budget");
    // One vocabulary end to end: the refusal is a real assessment the parent's
    // IPC forwards as it stands, with no reason of its own to synthesize.
    expect(refused.availability).toBe("unavailable");
    expect(refused.unavailableReason).toBe("budget_exhausted");
    expect(refused.assessment?.availability).toBe("unavailable");
    expect(refused.assessment?.unavailableReason).toBe("budget_exhausted");
  });

  it("stops the station at its hourly call cap", async () => {
    const h = harness({ stationCallsPerHour: 1, pricing: freePricing }, { auto: false });
    h.observe("a", "evidence a");
    h.observe("b", "evidence b");
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);
    h.model.settleAt(0, currentOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    h.timers.advance(1);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
    expect(h.scheduler.stats().refusals["station call cap"]).toBe(1);
  });

  it("reserves conservatively before sending and stops at the seat ceiling", async () => {
    const pricing = { inputUsdPerMTokens: 0.042, outputUsdPerMTokens: 0 };
    const perCall = await measuredCallCost(pricing, "evidence round 0");
    expect(perCall).toBeGreaterThan(0);

    // Allow exactly two reservations, no more.
    const h = harness({ seatUsdPerHour: perCall * 2 + perCall / 2, pricing });
    for (let round = 0; round < 3; round += 1) {
      h.seats.set("s1", { controlRevision: round });
      h.observe("s1", `evidence round ${round}`);
      h.timers.advance(300);
      await h.scheduler.drain();
    }
    expect(h.model.count()).toBe(2);
    expect(h.scheduler.stats().refusals["seat budget"]).toBe(1);
  });

  it("charges the reservation for a failed attempt", async () => {
    const pricing = { inputUsdPerMTokens: 0.042, outputUsdPerMTokens: 0 };
    const perCall = await measuredCallCost(pricing);
    const h = harness(
      { seatUsdPerHour: perCall * 2 + perCall / 2, pricing },
      { auto: false },
    );
    h.observe("s1");
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);
    // The failed attempt has already spent its reservation.
    h.model.failWith("transport");
    await h.scheduler.drain();
    expect(h.scheduler.stats().calls).toBe(1);
    expect(h.scheduler.stats().spentUsd).toBeGreaterThan(0);

    h.timers.advance(2_000);
    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1");
    h.timers.advance(300);
    expect(h.model.count()).toBe(2);
    h.model.settleAt(1, currentOutcome(h.model.calls[1]!.ask));
    await h.scheduler.drain();

    // Two reservations are spent, one by a failed attempt: the third is refused.
    h.seats.set("s1", { controlRevision: 2 });
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
    expect(h.scheduler.stats().refusals["seat budget"]).toBe(1);
  });

  it("stops the station at its daily ceiling", async () => {
    const pricing = { inputUsdPerMTokens: 0.042, outputUsdPerMTokens: 0 };
    const perCall = await measuredCallCost(pricing);
    const h = harness({
      stationCallsPerHour: 1_000,
      stationUsdPerHour: 100,
      stationUsdPerDay: perCall * 1.5,
      pricing,
    });
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);

    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
    expect(h.scheduler.stats().refusals["station daily budget"]).toBe(1);
  });

  it("makes no call and reserves nothing when the window carries no lines", async () => {
    const h = harness();
    h.timers.advance(0);
    const snapshot = makeSnapshot({ bindingId: "s1", epoch: "e1", lines: [] });
    h.scheduler.observe(snapshot, windowFor(snapshot, h.timers.clock()));
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(0);
    expect(h.scheduler.stats().refusals).toEqual({});
    expect(h.scheduler.advisory("s1").status).toBe("none");
  });
});

describe("cache", () => {
  it("treats a hover cache hit as not a new assessment, keeping its observation", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
    const first = h.scheduler.advisory("s1");
    const observedAt = first.assessment?.provenance.observedAt;

    const advisory = h.scheduler.hover("s1");
    expect(advisory.status).toBe("fresh");
    expect(advisory.assessmentId).toBe(first.assessmentId);
    // A replayed cache hit keeps its own observedAt and digest.
    expect(advisory.assessment?.provenance.observedAt).toBe(observedAt);
    expect(advisory.evidenceDigest).toBe(first.evidenceDigest);
    expect(h.model.count()).toBe(1);
    expect(h.scheduler.stats().cacheHits).toBe(1);
  });

  it("calls on a hover cache miss when budget permits", async () => {
    const h = harness();
    h.observe("s1", "screen a");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);
    h.observe("s1", "screen b");
    h.scheduler.hover("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);
  });

  it("expires retained advisory content after about five minutes", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.scheduler.advisory("s1").status).toBe("fresh");
    h.timers.advance(299_999);
    expect(h.scheduler.advisory("s1").status).toBe("fresh");
    h.timers.advance(1);
    const expired = h.scheduler.advisory("s1");
    expect(expired.status).toBe("expired");
    expect(expired.assessment).toBeUndefined();
    expect(expired.availability).toBeUndefined();
    expect(h.advisories.some((entry) => entry.status === "expired")).toBe(true);
  });

  it("keys on the window digest, harness, geometry, observations, and bucket", async () => {
    const h = harness();
    h.observe("s1", "screen one");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(1);

    // Same evidence, different geometry: a different key, so a real call.
    h.seats.set("s1", { controlRevision: 1 });
    const wider = makeSnapshot({ bindingId: "s1", epoch: "e1", text: "screen one", cols: 120, rows: 40 });
    h.scheduler.observe(wider, windowFor(wider, h.timers.clock()));
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(2);

    // Same evidence and geometry, a different harness: a new key.
    h.seats.set("s1", { harness: "codex", controlRevision: 2 });
    h.observe("s1", "screen one");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(3);

    // Same everything, a new temporal bucket: a new key.
    h.timers.advance(60_000);
    h.seats.set("s1", { controlRevision: 3 });
    h.observe("s1", "screen one");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(4);
  });
});

describe("generation retirement", () => {
  it("cancels in flight work and rejects the retired epoch's response", async () => {
    const h = harness({}, { auto: false });
    h.observe("s1", "epoch one", "e1");
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);
    expect(h.model.calls[0]!.signal.aborted).toBe(false);

    h.observe("s1", "epoch two", "e2");
    expect(h.model.calls[0]!.signal.aborted).toBe(true);

    // The retired response arrives after the epoch changed.
    h.model.settleAt(0, currentOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    expect(h.scheduler.stats().droppedStale).toBe(1);
    expect(h.scheduler.stats().cacheEntries).toBe(0);
    expect(h.scheduler.advisory("s1").assessment).toBeUndefined();
    expect(h.scheduler.advisory("s1").epoch).toBe("e2");

    // The new generation gets its own request and its own display.
    h.timers.advance(300);
    expect(h.model.count()).toBe(2);
    expect(h.model.calls[1]!.ask.request.epoch).toBe("e2");
    h.model.settleAt(1, currentOutcome(h.model.calls[1]!.ask));
    await h.scheduler.drain();
    const advisory = h.scheduler.advisory("s1");
    expect(advisory.epoch).toBe("e2");
    expect(advisory.status).toBe("fresh");
    expect(advisory.assessment?.provenance.epoch).toBe("e2");
  });

  it("retire() drops the seat, its pending work, and its cache", async () => {
    const h = harness();
    h.observe("s1");
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.scheduler.stats().cacheEntries).toBe(1);
    h.scheduler.retire("s1");
    expect(h.scheduler.stats().cacheEntries).toBe(0);
    expect(h.scheduler.stats().seats).toBe(0);
    expect(h.scheduler.advisory("s1").status).toBe("none");
  });
});

describe("failure paths never reach the deterministic path", () => {
  it("reports disabled, publishes missing_key, and calls nothing without a key", async () => {
    const h = harness({}, { modelAvailable: false });
    h.observe("s1");
    h.timers.advance(5_000);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(0);
    const advisory = h.scheduler.advisory("s1");
    expect(advisory.status).toBe("disabled");
    expect(advisory.availability).toBe("unavailable");
    expect(advisory.unavailableReason).toBe("missing_key");
    expect(advisory.reason).toBe("no Jev API key configured");
  });

  it("backs off after a transport failure and retries on its own", async () => {
    const h = harness({}, { auto: false });
    h.observe("s1");
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);
    h.model.failWith("transport");
    await h.scheduler.drain();
    const failed = h.scheduler.advisory("s1");
    expect(failed.status).toBe("unavailable");
    expect(failed.availability).toBe("unavailable");
    expect(failed.unavailableReason).toBe("provider_failure");
    expect(failed.reason).toBe("test transport");

    // A new concern inside the backoff window is gated, not sent.
    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1");
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);
    expect(h.scheduler.advisory("s1").reason).toBe("backing off after a failed Jev attempt");

    // The scheduler owns backoff: it wakes itself at the deadline.
    h.timers.advance(2_000);
    expect(h.model.count()).toBe(2);
    h.model.settleAt(1, currentOutcome(h.model.calls[1]!.ask));
    await h.scheduler.drain();
    expect(h.scheduler.advisory("s1").status).toBe("fresh");
  });

  it("keeps a displayable judgment while the attempt failed, and says so", async () => {
    const h = harness({}, { auto: false });
    h.observe("s1");
    h.timers.advance(300);
    h.model.settleAt(0, currentOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    expect(h.scheduler.advisory("s1").status).toBe("fresh");
    const observedAt = h.scheduler.advisory("s1").assessment?.provenance.observedAt;

    h.timers.advance(60_000);
    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1", "a different screen");
    h.timers.advance(300);
    h.model.failWith("timeout");
    await h.scheduler.drain();
    const stale = h.scheduler.advisory("s1");
    expect(stale.status).toBe("stale");
    // The judgment is still published as current; the renderer derives
    // staleness from the digest and the age, and the excerpt keeps its own
    // observation time.
    expect(stale.availability).toBe("current");
    expect(stale.assessment?.provenance.observedAt).toBe(observedAt);
    expect(stale.reason).toBe("test timeout");
  });

  it("reports unusable answers as unavailable without a transport failure", async () => {
    const h = harness({}, { auto: false, build: rejectedOutcome });
    h.observe("s1");
    h.timers.advance(300);
    h.model.settleAt(0, rejectedOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    const advisory = h.scheduler.advisory("s1");
    expect(advisory.status).toBe("unavailable");
    expect(advisory.availability).toBe("unavailable");
    expect(advisory.unavailableReason).toBe("provider_failure");
    expect(advisory.assessment?.unavailableReason).toBe("answers_rejected");
    // Nothing displayable was cached, so the same observation may be retried.
    expect(h.scheduler.stats().cacheEntries).toBe(0);
  });

  it("reports an abstention as abstained, not as a failure", async () => {
    const h = harness({}, { auto: false, build: abstainedOutcome });
    h.observe("s1");
    h.timers.advance(300);
    h.model.settleAt(0, abstainedOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    const advisory = h.scheduler.advisory("s1");
    expect(advisory.status).toBe("fresh");
    expect(advisory.availability).toBe("abstained");
    expect(advisory.unavailableReason).toBeNull();
  });

  it("opens a short circuit breaker after repeated transport failures", async () => {
    const h = harness(
      { backoffBaseMs: 100, transportBreakerFailures: 3, transportBreakerMs: 30_000 },
      { auto: false },
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.seats.set("s1", { controlRevision: attempt });
      h.observe("s1", `screen ${attempt}`);
      h.timers.advance(300);
      h.model.failWith("transport");
      await h.scheduler.drain();
      h.timers.advance(1_000);
      await h.scheduler.drain();
    }
    expect(h.model.count()).toBe(3);
    expect(h.scheduler.stats().breakerOpen).toBe(true);

    h.observe("s2", "other evidence");
    h.timers.advance(300);
    expect(h.model.count()).toBe(3);
    expect(h.scheduler.advisory("s2").reason).toBe("Jev transport circuit breaker open");
    expect(h.scheduler.advisory("s2").availability).toBe("unavailable");

    h.timers.advance(30_000);
    expect(h.model.count()).toBe(4);
  });

  it("stops calls on a rejected credential until reconfigured", async () => {
    const h = harness({}, { auto: false });
    h.observe("s1");
    h.timers.advance(300);
    h.model.failWith("credential");
    await h.scheduler.drain();
    expect(h.scheduler.stats().credentialBlocked).toBe(true);

    h.seats.set("s1", { controlRevision: 1 });
    h.observe("s1");
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);
    expect(h.scheduler.advisory("s1").reason).toBe("Jev rejected the credential");

    h.scheduler.reconfigure();
    h.seats.set("s1", { controlRevision: 2 });
    h.observe("s1");
    h.timers.advance(300);
    expect(h.model.count()).toBe(2);
  });

  it("survives a projection port fault without throwing", async () => {
    const h = harness();
    h.projection.failWith(new Error("projection exploded"));
    expect(() => h.observe("s1")).not.toThrow();
    h.timers.advance(300);
    await h.scheduler.drain();
    expect(h.model.count()).toBe(0);
  });

  it("survives a seat port fault without throwing", () => {
    const h = harness();
    h.seats.set("s1", {});
    expect(() => h.observe("s1")).not.toThrow();
    expect(h.model.count()).toBe(0);
  });
});

describe("cost estimate", () => {
  it("grows with the request payload and the question count", () => {
    const config = DEFAULT_AWARENESS_SCHEDULER_CONFIG;
    const small = estimateAwarenessCallCost({ requestBytes: 500, questionCount: 1 }, config);
    const typical = estimateAwarenessCallCost({ requestBytes: 4_000, questionCount: 12 }, config);
    expect(small).toBeGreaterThan(0);
    expect(typical).toBeGreaterThan(small);
    // At the published price a typical call reserves far less than one call's
    // share of the seat ceiling, so the call caps bind first.
    expect(typical).toBeLessThan(config.seatUsdPerHour / config.seatCallsPerHour);
  });

  it("counts a retired attempt against the call budget", async () => {
    const h = harness({}, { auto: false });
    h.observe("s1");
    h.timers.advance(300);
    expect(h.scheduler.stats().calls).toBe(1);
    h.scheduler.retire("s1");
    await h.scheduler.drain();
    expect(h.scheduler.stats().calls).toBe(1);
  });
});

describe("advisory emission", () => {
  it("emits pending before the answer and fresh after it", async () => {
    const h = harness({}, { auto: false });
    const seen: Array<{ readonly status: string; readonly pending: boolean }> = [];
    h.scheduler.subscribe((advisory) =>
      seen.push({ status: advisory.status, pending: advisory.pending }),
    );
    h.observe("s1");
    expect(seen.some((entry) => entry.pending)).toBe(true);
    h.timers.advance(300);
    h.model.settleAt(0, currentOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    const last = seen[seen.length - 1]!;
    expect(last.status).toBe("fresh");
    expect(last.pending).toBe(false);
  });

  it("does not re-emit an unchanged advisory", async () => {
    const h = harness();
    const before = h.advisories.length;
    h.observe("s1");
    for (let i = 0; i < 5; i += 1) h.observe("s1");
    expect(h.advisories.length).toBe(before + 1);
  });

  it("publishes the live window digest and the judged evidence digest separately", async () => {
    const h = harness({}, { auto: false });
    h.observe("s1", "screen a");
    h.timers.advance(300);
    h.model.settleAt(0, currentOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    const judged = h.scheduler.advisory("s1").evidenceDigest;
    expect(judged).toBeDefined();

    h.observe("s1", "screen b");
    const moved = h.scheduler.advisory("s1");
    expect(moved.windowDigest).not.toBe(judged);
    expect(moved.evidenceDigest).toBe(judged);
    expect(moved.windowCapturedAt).toBeDefined();
  });

  it("does not republish the window for a repaint that only moved chrome", async () => {
    const h = harness({}, { auto: false });
    h.observe("s1", "screen a");
    h.timers.advance(300);
    h.model.settleAt(0, currentOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    const judged = h.scheduler.advisory("s1");
    const before = h.advisories.length;

    // The same material screen, repainted: new grid sequences, one unchanged
    // normalized digest. The window's digest and capture time move together, so
    // neither moves and nothing reaches the display.
    h.timers.advance(5_000);
    for (let i = 0; i < 20; i += 1) h.observe("s1", "screen a");
    await h.scheduler.drain();
    const after = h.scheduler.advisory("s1");
    expect(after.windowDigest).toBe(judged.windowDigest);
    expect(after.windowCapturedAt).toBe(judged.windowCapturedAt);
    expect(h.advisories.length).toBe(before);
    expect(h.model.count()).toBe(1);
  });

  it("publishes concern absences as checked-and-clear, never activity cross-checks", async () => {
    const h = harness({}, { auto: false, build: negativesOnlyOutcome });
    h.observe("s1");
    h.timers.advance(300);
    h.model.settleAt(0, negativesOnlyOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    const advisory = h.scheduler.advisory("s1");
    // Nothing is raised, and the seat is not "not assessed": the display can say
    // the model looked and found nothing.
    expect(advisory.availability).toBe("current");
    expect(advisory.assessment?.concerns).toEqual([]);
    expect(advisory.absences).toEqual([{ concern: "execution_error", probability: 0.05 }]);
    // Absences are part of the display, so a change in them must reach it.
    expect(h.advisories.some((entry) => entry.absences.length === 1)).toBe(true);
  });

  it("carries unanswered concerns unfiltered so the weak claim is not read as clear", async () => {
    const h = harness({}, { auto: false, build: unansweredOutcome });
    h.observe("s1");
    h.timers.advance(300);
    h.model.settleAt(0, unansweredOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    const advisory = h.scheduler.advisory("s1");
    expect(advisory.availability).toBe("current");
    // One concern was ruled out and two were asked without an answer, so the
    // display must not claim checked and clear: both lists travel together.
    expect(advisory.absences).toEqual([{ concern: "execution_error", probability: 0.05 }]);
    // The projection's own list, unfiltered and in its own order.
    expect(advisory.unansweredConcerns).toEqual(["answer_requested", "access_problem"]);
    // Display content about concerns, so a change in it must reach the display.
    expect(h.advisories.some((entry) => entry.unansweredConcerns.length === 2)).toBe(true);
  });

  it("claims nothing unanswered before an assessment, and nothing from a failure", async () => {
    const h = harness({}, { auto: false });
    expect(h.scheduler.advisory("s1").unansweredConcerns).toEqual([]);
    h.observe("s1");
    h.timers.advance(300);
    h.model.failWith("transport");
    await h.scheduler.drain();
    const failed = h.scheduler.advisory("s1");
    // A failure notice carries no verdict, so it claims nothing about concerns.
    expect(failed.availability).toBe("unavailable");
    expect(failed.unansweredConcerns).toEqual([]);
  });

  it("carries accepted absences so checked-and-clear is distinguishable", async () => {
    const h = harness({}, { auto: false, build: mixedOutcome });
    h.observe("s1");
    h.timers.advance(300);
    h.model.settleAt(0, mixedOutcome(h.model.calls[0]!.ask));
    await h.scheduler.drain();
    const advisory = h.scheduler.advisory("s1");
    // A two-sided Noul's negative is an accepted absence, not an abstention, and
    // it is never filtered on the way to the display.
    expect(advisory.availability).toBe("current");
    expect(advisory.assessment?.concerns.map((concern) => concern.concern)).toEqual([
      "approval_requested",
    ]);
    expect(advisory.absences).toEqual([{ concern: "execution_error", probability: 0.05 }]);
    // The activity property's absence is a control-plane cross-check: it is
    // recorded on the assessment and never travels to the display.
    expect(
      advisory.assessment?.negatives.map((negative) => [
        negative.concern ?? negative.activity,
        negative.crossCheckOnly,
      ]),
    ).toEqual([
      ["execution_error", false],
      ["running_command", true],
    ]);
    // The only abstention is the temporal question the evidence could not
    // support; the negative is not reported as an abstention.
    expect(advisory.assessment?.abstentions.map((entry) => entry.questionId)).toEqual([
      "concern.repetition",
    ]);
  });
});
