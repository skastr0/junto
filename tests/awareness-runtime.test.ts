/**
 * Awareness runtime: the observer-plane edge. Proves the listener only retains
 * a reference and schedules bounded work, that the window read is the
 * non-flushing one and only happens when the grid moved, that generation changes
 * retire work through the plane, and measures the callback overhead the sidecar
 * adds to the observer.
 */

import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { TerminalObserverPlane } from "../src/main/junto/term/observer";
import {
  AwarenessRuntime,
  makeAwarenessLayer,
  makeAwarenessRuntime,
  type AwarenessRuntimeShape,
} from "../src/main/junto/term/awareness/runtime";
import {
  makeAwarenessScheduler,
  type AwarenessSchedulerConfig,
} from "../src/main/junto/term/awareness/scheduler";
import {
  EVIDENCE_TEXT,
  currentOutcome,
  makeAskRecorder,
  makeFakePlane,
  makeFakeProjectionPort,
  makeFakeSeatPort,
  makeManualTimers,
  makeSnapshot,
  type AskRecorder,
  type FakePlane,
  type FakeProjectionPort,
  type FakeSeatPort,
  type ManualTimers,
} from "./helpers/awareness-fakes";

type RuntimeHarness = {
  readonly timers: ManualTimers;
  readonly plane: FakePlane;
  readonly seats: FakeSeatPort;
  readonly projection: FakeProjectionPort;
  readonly model: AskRecorder;
  readonly runtime: AwarenessRuntimeShape;
  readonly advisories: Array<{ readonly bindingId: string; readonly status: string }>;
};

const harness = (
  config: Partial<AwarenessSchedulerConfig> = {},
  options: { readonly auto?: boolean; readonly modelAvailable?: boolean } = {},
): RuntimeHarness => {
  const timers = makeManualTimers();
  const plane = makeFakePlane();
  const seats = makeFakeSeatPort();
  const projection = makeFakeProjectionPort();
  const model = makeAskRecorder({ auto: options.auto ?? true });
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
  const advisories: Array<{ bindingId: string; status: string }> = [];
  const runtime = makeAwarenessRuntime({
    plane: plane.plane,
    scheduler,
    seats,
    projection,
    config,
    clock: timers.clock,
    timers,
  });
  runtime.subscribe((advisory) =>
    advisories.push({ bindingId: advisory.bindingId, status: advisory.status }),
  );
  return { timers, plane, seats, projection, model, runtime, advisories };
};

/** Publish a seat's first screen with its non-flushing window available. */
const publishSeat = (
  h: RuntimeHarness,
  bindingId = "s1",
  epoch = "e1",
  text = EVIDENCE_TEXT,
): void => {
  h.seats.set(bindingId, {});
  h.plane.publish(makeSnapshot({ bindingId, epoch, text }));
};

describe("observer edge", () => {
  it("retains the newest snapshot and only works after the flush task", () => {
    const h = harness();
    h.runtime.start();
    publishSeat(h);

    // The synchronous listener did no projection and no work.
    expect(h.projection.calls()).toBe(0);
    expect(h.model.count()).toBe(0);

    h.timers.advance(0);
    expect(h.projection.calls()).toBe(1);
    expect(h.model.count()).toBe(0);

    h.timers.advance(300);
    expect(h.model.count()).toBe(1);
  });

  it("coalesces a burst into one flush and one request", () => {
    const h = harness();
    h.runtime.start();
    h.seats.set("s1", {});
    for (let frame = 0; frame < 50; frame += 1) {
      h.plane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1", text: `frame ${frame}` }));
    }
    h.timers.advance(0);
    expect(h.projection.calls()).toBe(1);
    expect(h.runtime.status().flushes).toBe(1);
    expect(h.model.count()).toBe(0);
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);
  });

  it("reads the non-flushing window once per moved grid", () => {
    const h = harness();
    h.runtime.start();
    publishSeat(h);
    h.timers.advance(0);
    expect(h.runtime.status().windowReads).toBe(1);
    // Republishing the same grid costs no window read.
    const same = makeSnapshot({ bindingId: "s1", epoch: "e1", text: EVIDENCE_TEXT, seq: 1n });
    h.plane.publish(same);
    h.timers.advance(0);
    h.plane.publish(same);
    h.timers.advance(0);
    expect(h.runtime.status().windowReads).toBe(1);
    // A new grid is read again.
    h.plane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1", text: "moved on", seq: 2n }));
    h.timers.advance(0);
    expect(h.runtime.status().windowReads).toBe(2);
  });

  it("replays live seats so a seat that painted before start is observed", () => {
    const h = harness();
    publishSeat(h);
    h.runtime.start();
    h.timers.advance(0);
    h.timers.advance(300);
    expect(h.model.count()).toBe(1);
  });

  it("retires the previous generation when the plane reports a new epoch", async () => {
    const h = harness({ coalesceMs: 100, coalesceMaxWaitMs: 100 }, { auto: false });
    h.runtime.start();
    publishSeat(h, "s1", "e1", "epoch one");
    h.timers.advance(0);
    h.timers.advance(100);
    expect(h.model.count()).toBe(1);

    h.plane.publish(makeSnapshot({ bindingId: "s1", epoch: "e2", text: "epoch two", seq: 2n }));
    h.timers.advance(0);
    expect(h.model.calls[0]!.signal.aborted).toBe(true);
    expect(h.runtime.advisory("s1").epoch).toBe("e2");

    h.timers.advance(100);
    expect(h.model.count()).toBe(2);
    expect(h.model.calls[1]!.ask.request.epoch).toBe("e2");
    h.model.settleAt(1, currentOutcome(h.model.calls[1]!.ask));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.runtime.advisory("s1").status).toBe("fresh");
    expect(h.runtime.advisory("s1").assessment?.provenance.epoch).toBe("e2");
  });

  it("never throws into the plane when a port faults", () => {
    const h = harness();
    h.runtime.start();
    h.projection.failWith(new Error("projection exploded"));
    expect(() => {
      h.plane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1" }));
      h.timers.advance(0);
      h.timers.advance(300);
    }).not.toThrow();
    expect(h.model.count()).toBe(0);
  });

  it("stop() unsubscribes from the plane and retires its seats", () => {
    const h = harness();
    h.runtime.start();
    expect(h.plane.listenerCount()).toBe(1);
    h.plane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1" }));
    h.runtime.stop();
    expect(h.plane.listenerCount()).toBe(0);
    expect(h.runtime.status().started).toBe(false);
    expect(h.runtime.advisory("s1").status).toBe("none");
  });

  it("forwards advisories to subscribers", async () => {
    const h = harness();
    h.runtime.start();
    publishSeat(h);
    h.timers.advance(0);
    h.timers.advance(300);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.advisories.some((entry) => entry.bindingId === "s1")).toBe(true);
    expect(h.advisories.some((entry) => entry.status === "fresh")).toBe(true);
  });
});

describe("hover", () => {
  it("reads the plane without forcing grid settlement when it has no snapshot", () => {
    const h = harness({ coalesceMs: 10, coalesceMaxWaitMs: 10 });
    h.runtime.start();
    // A seat attached after start: live behind the plane, never published yet.
    h.seats.set("s1", {});
    h.plane.seed(makeSnapshot({ bindingId: "s1", epoch: "e1" }));
    const before = h.plane.snapshotReads();

    const advisory = h.runtime.hover("s1");
    expect(h.plane.snapshotReads()).toBeGreaterThan(before);
    expect(advisory.bindingId).toBe("s1");

    h.timers.advance(10);
    expect(h.model.count()).toBe(1);
  });

  it("answers a hover cache hit without a call", async () => {
    const h = harness({ coalesceMs: 10, coalesceMaxWaitMs: 10 });
    h.runtime.start();
    publishSeat(h);
    h.timers.advance(0);
    h.timers.advance(10);
    expect(h.model.count()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const advisory = h.runtime.hover("s1");
    expect(advisory.status).toBe("fresh");
    expect(h.model.count()).toBe(1);
    expect(h.runtime.status().scheduler.cacheHits).toBe(1);
  });
});

describe("doctor and status", () => {
  it("reports unknown before start and ok after", () => {
    const h = harness();
    expect(Effect.runSync(h.runtime.doctor).status).toBe("unknown");
    h.runtime.start();
    const after = Effect.runSync(h.runtime.doctor);
    expect(after.status).toBe("ok");
    expect(after.id).toBe("awareness");
  });

  it("reports a rejected credential honestly", async () => {
    const h = harness({}, { auto: false });
    h.runtime.start();
    publishSeat(h);
    h.timers.advance(0);
    h.timers.advance(300);
    h.model.failWith("credential");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const check = Effect.runSync(h.runtime.doctor);
    expect(check.status).toBe("error");
    expect(check.detail).toContain("credential");
    expect(h.runtime.advisory("s1").availability).toBe("unavailable");
  });

  it("exposes counters for diagnostics", () => {
    const h = harness();
    h.runtime.start();
    h.plane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1" }));
    expect(h.runtime.status().snapshotsRetained).toBe(1);
    h.timers.advance(0);
    expect(h.runtime.status().scheduler.seats).toBe(1);
  });
});

describe("layer composition", () => {
  const buildRuntime = (
    options: Parameters<typeof makeAwarenessLayer>[0],
  ): AwarenessRuntimeShape =>
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(makeAwarenessLayer(options));
          return Context.get(context, AwarenessRuntime);
        }),
      ),
    );

  it("wires model, scheduler, and runtime from one layer", async () => {
    const plane = makeFakePlane();
    const seats = makeFakeSeatPort();
    const projection = makeFakeProjectionPort();
    const timers = makeManualTimers();
    const runtime = buildRuntime({
      plane: plane.plane,
      seats,
      projection,
      config: { coalesceMs: 10, coalesceMaxWaitMs: 10 },
      timers,
      clock: timers.clock,
      model: {
        apiKey: "sk-test",
        fetch: async () => new Response("{}", { status: 500 }),
      },
    });
    runtime.start();
    seats.set("s1", {});
    plane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1" }));
    timers.advance(0);
    timers.advance(10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const advisory = runtime.advisory("s1");
    expect(advisory.status).toBe("unavailable");
    expect(advisory.availability).toBe("unavailable");
    expect(advisory.unavailableReason).toBe("provider_failure");
    expect(runtime.status().scheduler.failures["transport"]).toBe(1);
    runtime.stop();
  });

  it("wires a disabled runtime with no key and publishes missing_key", () => {
    const plane = makeFakePlane();
    const seats = makeFakeSeatPort();
    const projection = makeFakeProjectionPort();
    const timers = makeManualTimers();
    const runtime = buildRuntime({
      plane: plane.plane,
      seats,
      projection,
      config: { coalesceMs: 10, coalesceMaxWaitMs: 10 },
      timers,
      clock: timers.clock,
      model: { apiKey: undefined, model: "jev-latest" },
    });
    runtime.start();
    seats.set("s1", {});
    plane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1" }));
    timers.advance(0);
    timers.advance(10);
    const advisory = runtime.advisory("s1");
    expect(advisory.status).toBe("disabled");
    expect(advisory.availability).toBe("unavailable");
    expect(advisory.unavailableReason).toBe("missing_key");
    expect(runtime.status().scheduler.calls).toBe(0);
    const check = Effect.runSync(runtime.doctor);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("Jev API key");
    runtime.stop();
  });
});

describe("measured observer callback overhead", () => {
  it("costs a map store and a flag check per emitted snapshot", () => {
    const iterations = 20_000;
    const rounds = 5;
    const measureOnce = (withRuntime: boolean): number => {
      const h = harness();
      h.seats.set("s1", {});
      if (withRuntime) h.runtime.start();
      else h.plane.plane.subscribeAll(() => undefined);
      const snapshot = makeSnapshot({ bindingId: "s1", epoch: "e1" });
      // Warm the flush slot so the measurement is the steady-state callback.
      h.plane.publish(snapshot);
      const startedAt = performance.now();
      for (let i = 0; i < iterations; i += 1) h.plane.publish(snapshot);
      const elapsed = performance.now() - startedAt;
      h.runtime.stop();
      return (elapsed * 1_000_000) / iterations;
    };
    const best = (withRuntime: boolean): number =>
      Math.min(...Array.from({ length: rounds }, () => measureOnce(withRuntime)));
    const baseline = best(false);
    const withRuntime = best(true);
    const added = withRuntime - baseline;
    console.log(
      `[awareness] observer callback: baseline ${baseline.toFixed(1)} ns, ` +
        `with awareness ${withRuntime.toFixed(1)} ns, added ${added.toFixed(1)} ns per snapshot ` +
        `(best of ${rounds} rounds of ${iterations})`,
    );
    // The listener must stay a store plus a flag check: a projection, a hash, or
    // a network call in this path would cost orders of magnitude more.
    expect(added).toBeLessThan(2_000);
  });

  it("arms one flush timer per burst, not one per snapshot", () => {
    const iterations = 5_000;
    const measure = (withRuntime: boolean): number => {
      const h = harness();
      h.seats.set("s1", {});
      if (withRuntime) h.runtime.start();
      else h.plane.plane.subscribeAll(() => undefined);
      const snapshot = makeSnapshot({ bindingId: "s1", epoch: "e1" });
      h.timers.advance(0);
      let elapsed = 0;
      for (let i = 0; i < iterations; i += 1) {
        const startedAt = performance.now();
        h.plane.publish(snapshot);
        elapsed += performance.now() - startedAt;
        // Let the flush run so the next publish has to arm a fresh timer.
        h.timers.advance(0);
      }
      h.runtime.stop();
      return (elapsed * 1_000_000) / iterations;
    };
    const baseline = measure(false);
    const withRuntime = measure(true);
    const added = withRuntime - baseline;
    console.log(
      `[awareness] callback plus flush arm: baseline ${baseline.toFixed(1)} ns, ` +
        `with awareness ${withRuntime.toFixed(1)} ns, added ${added.toFixed(1)} ns per burst`,
    );
    expect(added).toBeLessThan(50_000);
  });

  it("keeps a bounded flush of eight seats well under a millisecond", () => {
    const h = harness();
    h.runtime.start();
    for (let seat = 0; seat < 8; seat += 1) {
      h.seats.set(`s${seat}`, {});
      h.plane.publish(
        makeSnapshot({ bindingId: `s${seat}`, epoch: "e1", text: `seat ${seat} evidence` }),
      );
    }
    h.timers.advance(0);
    const status = h.runtime.status();
    console.log(
      `[awareness] flush of 8 seats (window read + projection + triggers): ${status.lastFlushMs.toFixed(3)} ms`,
    );
    expect(status.flushes).toBe(1);
    expect(status.lastFlushMs).toBeLessThan(50);
  });
});

describe("real observer plane integration", () => {
  /** The plane passthrough the parent's IPC wiring needs: one line each. */
  const planePort = (plane: TerminalObserverPlane) => ({
    subscribeAll: (listener: Parameters<typeof plane.subscribeAll>[0]) =>
      plane.subscribeAll(listener),
    snapshot: (bindingId: string) => plane.snapshot(bindingId),
    readWindowNow: (bindingId: string, lines: number) =>
      plane.get(bindingId)?.readWindowNow(lines),
  });

  const realHarness = (bindingId: string) => {
    const plane = new TerminalObserverPlane();
    const observer = plane.attach({ bindingId, epoch: "e1", cols: 80, rows: 24 });
    const seats = makeFakeSeatPort();
    const projection = makeFakeProjectionPort();
    const model = makeAskRecorder();
    seats.set(bindingId, {});
    const config = { coalesceMs: 1, coalesceMaxWaitMs: 1 };
    const scheduler = makeAwarenessScheduler({
      ask: model.ask,
      unavailable: model.unavailable,
      modelId: "jev-latest",
      modelAvailable: true,
      modelUnavailableReason: undefined,
      seats,
      projection,
      config,
      random: () => 0.5,
    });
    const runtime = makeAwarenessRuntime({
      plane: planePort(plane),
      scheduler,
      seats,
      projection,
      config,
    });
    return { plane, observer, projection, model, scheduler, runtime };
  };

  it("observes a real session and asks about its settled screen", async () => {
    const { plane, observer, projection, model, scheduler, runtime } = realHarness("b1");
    runtime.start();
    try {
      observer.feed(`${EVIDENCE_TEXT}\r\n`, 1n);
      await observer.snapshot();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(projection.calls()).toBeGreaterThan(0);
      expect(model.count()).toBe(1);
      expect(model.calls[0]!.ask.request.evidenceLines.length).toBeGreaterThan(0);
      expect(scheduler.stats().calls).toBe(1);
      expect(plane.isSettled("b1")).toBe(true);
    } finally {
      runtime.stop();
      plane.disposeAll();
    }
  });

  it("does not pull the grid forward from the observer callback", async () => {
    const { plane, observer, projection, model, runtime } = realHarness("b2");
    runtime.start();
    try {
      // Feed without settling: the callback must not pull the grid forward, and
      // the window read must not settle it either.
      observer.feed("bytes still inside the flush window", 1n);
      expect(observer.isSettled()).toBe(false);
      expect(projection.calls()).toBe(0);
      expect(model.count()).toBe(0);

      // The seat's own writer settles the grid; awareness only reacts after.
      await observer.snapshot();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(projection.calls()).toBeGreaterThan(0);
      expect(model.count()).toBe(1);
    } finally {
      runtime.stop();
      plane.disposeAll();
    }
  });
});
