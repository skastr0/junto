import { Effect, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import type { AgentSeatState, AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { InstallationId } from "../src/shared/installation-id";
import {
  emptySeatTriggers,
  SEAT_TRIGGER_GONE_GRACE_MS as GRACE,
  SEAT_TRIGGER_HOLD_MS as HOLD,
  seedSeatTriggers,
  stepSeatTriggers,
  type SeatStateFiring,
  type SeatTriggerInput,
  type SeatTriggers,
} from "../src/shared/seat-state-trigger";
import { localSeatStateFeeds, makeSeatStateSource, type SeatStateFeed } from "../src/main/junto/automation/seat-state-source";

const MACHINE = InstallationId.make("inst-test");

const ev = (bindingId: string, epoch: string, state: AgentSeatState, at: number): AgentSeatStateEvent => ({
  bindingId,
  epoch,
  state,
  reason: `r-${state}`,
  confidence: "high",
  at,
});

/** Let every fiber run until nothing is left to do at this instant. */
const settle = Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, { discard: true });

/** Move the test clock to `at`, running every timer due on the way. */
const advanceTo = (at: number) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    yield* settle;
  });

type Script = { readonly seeds: readonly AgentSeatStateEvent[]; readonly live: readonly AgentSeatStateEvent[]; readonly end: number };

/** What the service emits for a script, run on the test clock: seeds at time 0, each live event at its time. */
const runService = (script: Script) =>
  Effect.gen(function* () {
    const feeds = yield* Queue.unbounded<SeatStateFeed>();
    const source = yield* makeSeatStateSource(Stream.fromQueue(feeds));
    const out: SeatStateFiring[] = [];
    yield* source.firings.pipe(
      Stream.runForEach((firing) => Effect.sync(() => out.push(firing))),
      Effect.forkScoped,
    );
    yield* settle;
    for (const event of script.seeds) yield* Queue.offer(feeds, { machine: MACHINE, kind: "seed", event });
    yield* settle;
    for (const event of script.live) {
      yield* advanceTo(event.at);
      yield* Queue.offer(feeds, { machine: MACHINE, kind: "live", event });
      yield* settle;
    }
    yield* advanceTo(script.end);
    return out;
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

/** The same script folded straight through the pure machine. */
const fold = (script: Script): SeatStateFiring[] => {
  let state: SeatTriggers = seedSeatTriggers(script.seeds, 0, emptySeatTriggers);
  const out: SeatStateFiring[] = [];
  const inputs: SeatTriggerInput[] = [...script.live.map((event) => ({ _tag: "Event", event }) as const), { _tag: "Tick", now: script.end }];
  for (const input of inputs) {
    const step = stepSeatTriggers(state, input);
    state = step.state;
    out.push(...step.firings);
  }
  return out;
};

const byKey = (firings: readonly SeatStateFiring[]) => [...firings].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/** A small seeded generator, so a failing run can be replayed by its seed. */
const random = (seed: number) => {
  let s = seed >>> 0 || 1;
  return (n: number): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) % n;
  };
};

const STATES: readonly AgentSeatState[] = ["idle", "working", "attention", "unknown", "gone"];
const GAPS = [0, 400, 800, 5_000, 29_000, 31_000, 45_000, 59_000, 61_000, 90_000];

const script = (seed: number): Script => {
  const pick = random(seed);
  const seats = ["seat-a", "seat-b", "seat-c"].slice(0, 1 + pick(3));
  const epochs = new Map(seats.map((seat) => [seat, 1]));
  const seeds = seats.filter(() => pick(2) === 0).map((seat) => ev(seat, "e1", STATES[pick(STATES.length)]!, 0));
  const live: AgentSeatStateEvent[] = [];
  let at = 1;
  for (let i = 0; i < 6 + pick(20); i += 1) {
    at += GAPS[pick(GAPS.length)]!;
    const seat = seats[pick(seats.length)]!;
    if (pick(8) === 0) epochs.set(seat, epochs.get(seat)! + 1);
    live.push(ev(seat, `e${epochs.get(seat)}`, STATES[pick(STATES.length)]!, at));
  }
  return { seeds, live, end: at + GRACE * 2 };
};

describe("seat-state source: the service is the pure fold with its timer", () => {
  it("emits what folding stepSeatTriggers over the same inputs emits, for 150 random scripts", async () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const run = script(seed);
      const emitted = await runService(run);
      expect(byKey(emitted), `seed ${seed}`).toEqual(byKey(fold(run)));
      emitted.forEach((firing, i) => i > 0 && expect(firing.at, `seed ${seed}`).toBeGreaterThanOrEqual(emitted[i - 1]!.at));
    }
  }, 60_000);

  it("fires a hold on its timer, with no later event to settle it", async () => {
    const emitted = await runService({ seeds: [], live: [ev("seat-a", "e1", "idle", 1_000)], end: 1_000 + HOLD });
    expect(emitted.map((f) => `${f.becomes}@${f.at}`)).toEqual([`idle@${1_000 + HOLD}`]);
  });

  it("fires gone on its timer after the grace", async () => {
    const emitted = await runService({ seeds: [], live: [ev("seat-a", "e1", "gone", 1_000)], end: 1_000 + GRACE });
    expect(emitted.map((f) => `${f.becomes}@${f.at}`)).toEqual([`gone@${1_000 + GRACE}`]);
  });
});

describe("seat-state source: restart seeding", () => {
  it("a seeded seat fires nothing for the state it already had", async () => {
    const seeds = [ev("seat-a", "e1", "idle", 0), ev("seat-b", "e1", "attention", 0)];
    const live = [ev("seat-a", "e1", "idle", 1_000), ev("seat-b", "e1", "attention", 1_500)];
    expect(await runService({ seeds, live, end: HOLD * 4 })).toEqual([]);
  });

  it("a seeded seat still fires a real change after it", async () => {
    const emitted = await runService({ seeds: [ev("seat-a", "e1", "idle", 0)], live: [ev("seat-a", "e1", "working", 2_000)], end: HOLD * 4 });
    expect(emitted.map((f) => `${f.seat} ${f.becomes}@${f.at}`)).toEqual([`seat-a working@${2_000 + HOLD}`]);
  });

  it("a seed heard mid-stream settles that seat and fires nothing", async () => {
    const emitted = await Effect.gen(function* () {
      const feeds = yield* Queue.unbounded<SeatStateFeed>();
      const source = yield* makeSeatStateSource(Stream.fromQueue(feeds));
      const out: SeatStateFiring[] = [];
      yield* source.firings.pipe(Stream.runForEach((f) => Effect.sync(() => out.push(f))), Effect.forkScoped);
      yield* settle;
      yield* Queue.offer(feeds, { machine: MACHINE, kind: "live", event: ev("seat-a", "e1", "working", 0) });
      yield* settle;
      yield* advanceTo(10_000);
      yield* Queue.offer(feeds, { machine: MACHINE, kind: "seed", event: ev("seat-b", "e1", "attention", 10_000) });
      yield* settle;
      yield* advanceTo(HOLD * 3);
      return out;
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);
    expect(emitted.map((f) => `${f.seat} ${f.becomes}`)).toEqual(["seat-a working"]);
  });
});

describe("seat-state source: this machine's feed", () => {
  it("seeds every current seat, then streams live events, and unsubscribes when closed", async () => {
    let listener: ((event: AgentSeatStateEvent) => void) | undefined;
    let unsubscribed = false;
    const runtime = {
      currentEvents: () => [ev("seat-a", "e1", "idle", 0), ev("seat-b", "e1", "working", 0)],
      subscribe: (next: (event: AgentSeatStateEvent) => void) => {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
    };
    const feeds = await Effect.gen(function* () {
      const fiber = yield* localSeatStateFeeds(MACHINE, runtime).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* settle;
      listener!(ev("seat-a", "e1", "working", 5));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.runPromise);
    expect(feeds.map((f) => `${f.machine} ${f.kind} ${f.event.bindingId} ${f.event.state}`)).toEqual([
      "inst-test seed seat-a idle",
      "inst-test seed seat-b working",
      "inst-test live seat-a working",
    ]);
    expect(unsubscribed).toBe(true);
  });
});
