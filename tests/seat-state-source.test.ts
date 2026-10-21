import { Clock, Effect, Fiber, Queue, Stream } from "effect";
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
import {
  localSeatStateFeeds,
  makeSeatStateSource,
  remoteSeatStateFeedsOf,
  type SeatStateFeed,
} from "../src/main/junto/automation/seat-state-source";
import {
  onRemoteSeatFeed,
  publishRemoteSeatState,
  remoteSeatLinkLost,
  remoteSeatStateFeeds,
  resetRemoteSeatState,
  type RemoteSeatFeed,
} from "../src/main/junto/term/remote-seat-state";

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

const show = (feed: SeatStateFeed): string =>
  feed.kind === "lost" ? `${feed.machine} lost` : `${feed.machine} ${feed.kind} ${feed.event.bindingId} ${feed.event.state}`;

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
    // About 3.5 CPU-s, but 66 s wall at load 195.
  }, 300_000);

  it("drops a re-published state and still emits what the fold of every event emits", async () => {
    // Attention re-published every 800 ms, idle and working repeated, across a new epoch.
    const repeats = (bindingId: string, epoch: string, state: AgentSeatState, from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ev(bindingId, epoch, state, from + i * 800));
    const run: Script = {
      seeds: [ev("seat-b", "e1", "idle", 0)],
      live: [
        ...repeats("seat-a", "e1", "attention", 1_000, 5),
        ...repeats("seat-a", "e1", "idle", 10_000, 10),
        ...repeats("seat-b", "e1", "idle", 20_000, 4),
        ...repeats("seat-a", "e1", "working", 60_000, 50),
        ...repeats("seat-a", "e2", "working", 110_000, 5),
        ...repeats("seat-a", "e2", "attention", 120_000, 5),
        ...repeats("seat-a", "e2", "gone", 130_000, 5),
      ].sort((a, b) => a.at - b.at),
      end: 130_000 + GRACE * 2,
    };
    const emitted = await runService(run);
    expect(byKey(emitted)).toEqual(byKey(fold(run)));
    expect(emitted.map((f) => `${f.seat} ${f.becomes}`)).toEqual([
      "seat-a attention",
      "seat-a idle",
      "seat-a working",
      "seat-a attention",
      "seat-a gone",
    ]);
  });

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
    expect(feeds.map(show)).toEqual([
      "inst-test seed seat-a idle",
      "inst-test seed seat-b working",
      "inst-test live seat-a working",
    ]);
    expect(unsubscribed).toBe(true);
  });
});

const REMOTE = InstallationId.make("inst-remote");

/** What the service emits for timed feeds, run on the test clock. */
const runFeeds = (timed: ReadonlyArray<readonly [number, SeatStateFeed]>, end: number) =>
  Effect.gen(function* () {
    const feeds = yield* Queue.unbounded<SeatStateFeed>();
    const source = yield* makeSeatStateSource(Stream.fromQueue(feeds));
    const out: SeatStateFiring[] = [];
    yield* source.firings.pipe(Stream.runForEach((f) => Effect.sync(() => out.push(f))), Effect.forkScoped);
    yield* settle;
    for (const [at, feed] of timed) {
      yield* advanceTo(at);
      yield* Queue.offer(feeds, feed);
      yield* settle;
    }
    yield* advanceTo(end);
    return out.map((f) => `${f.seat} ${f.becomes}@${f.at}`);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

const live = (event: AgentSeatStateEvent, machine = REMOTE) => [event.at, { machine, kind: "live", event }] as const;
const lost = (at: number, machine = REMOTE) => [at, { machine, kind: "lost" }] as const;

describe("seat-state source: a lost link is not gone", () => {
  it("a seat reported gone while its link is up fires after the grace", async () => {
    expect(await runFeeds([live(ev("seat-r", "e1", "gone", 1_000))], 1_000 + GRACE * 2)).toEqual([`seat-r gone@${1_000 + GRACE}`]);
  });

  it("a link drop longer than the grace fires no gone, before or after it comes back", async () => {
    const timed = [
      live(ev("seat-r", "e1", "working", 0)),
      lost(HOLD * 2),
      live(ev("seat-r", "e1", "working", HOLD * 2 + GRACE + 30_000)),
    ];
    expect(await runFeeds(timed, HOLD * 2 + GRACE * 4)).toEqual([`seat-r working@${HOLD}`]);
  });

  it("a gone grace running when the link drops ends unfired", async () => {
    const timed = [live(ev("seat-r", "e1", "gone", 1_000)), lost(20_000)];
    expect(await runFeeds(timed, GRACE * 4)).toEqual([]);
  });

  it("a hold running when the link drops ends unfired; the seat's next event after it comes back is its seed", async () => {
    const timed = [
      live(ev("seat-r", "e1", "idle", 0)),
      lost(10_000),
      live(ev("seat-r", "e1", "idle", 100_000)),
      live(ev("seat-r", "e1", "working", 110_000)),
    ];
    expect(await runFeeds(timed, 110_000 + HOLD * 2)).toEqual([`seat-r working@${110_000 + HOLD}`]);
  });

  it("a gone the machine reports after it comes back fires after the grace from then", async () => {
    const timed = [
      live(ev("seat-r", "e1", "working", 0)),
      lost(HOLD * 2),
      live(ev("seat-r", "e1", "working", 200_000)),
      live(ev("seat-r", "e1", "gone", 210_000)),
    ];
    expect(await runFeeds(timed, 210_000 + GRACE * 2)).toEqual([`seat-r working@${HOLD}`, `seat-r gone@${210_000 + GRACE}`]);
  });

  it("a seat that went while its link was down fires gone a grace after the link is back", async () => {
    const back = HOLD * 2 + 200_000;
    // The machine's gone is stamped in the outage; it arrives at reconnect.
    const timed = [
      live(ev("seat-r", "e1", "working", 0)),
      lost(HOLD * 2),
      [back, { machine: REMOTE, kind: "live", event: ev("seat-r", "e1", "gone", HOLD * 2 + 5_000) }] as const,
    ];
    expect(await runFeeds(timed, back + GRACE * 2)).toEqual([`seat-r working@${HOLD}`, `seat-r gone@${back + GRACE}`]);
  });

  it("a seat that went in a new generation during the outage still fires gone", async () => {
    const back = 300_000;
    const timed = [live(ev("seat-r", "e1", "idle", 0)), lost(HOLD * 2), [back, { machine: REMOTE, kind: "live", event: ev("seat-r", "e2", "gone", 100_000) }] as const];
    expect(await runFeeds(timed, back + GRACE * 2)).toEqual([`seat-r idle@${HOLD}`, `seat-r gone@${back + GRACE}`]);
  });

  it("a seat already gone before the outage fires nothing new when it comes back gone", async () => {
    const back = 1_000 + GRACE + 100_000;
    const timed = [live(ev("seat-r", "e1", "gone", 1_000)), lost(1_000 + GRACE + 10_000), [back, { machine: REMOTE, kind: "live", event: ev("seat-r", "e1", "gone", 1_000) }] as const];
    expect(await runFeeds(timed, back + GRACE * 3)).toEqual([`seat-r gone@${1_000 + GRACE}`]);
  });

  it("a gone grace started at reconnect ends unfired when the link drops again", async () => {
    const timed = [
      live(ev("seat-r", "e1", "working", 0)),
      lost(HOLD * 2),
      [200_000, { machine: REMOTE, kind: "live", event: ev("seat-r", "e1", "gone", 100_000) }] as const,
      lost(230_000),
    ];
    expect(await runFeeds(timed, 200_000 + GRACE * 3)).toEqual([`seat-r working@${HOLD}`]);
  });

  it("a gone grace started at reconnect ends when a new generation takes the seat", async () => {
    const timed = [
      live(ev("seat-r", "e1", "working", 0)),
      lost(HOLD * 2),
      [200_000, { machine: REMOTE, kind: "live", event: ev("seat-r", "e1", "gone", 100_000) }] as const,
      live(ev("seat-r", "e2", "working", 220_000)),
    ];
    expect(await runFeeds(timed, 200_000 + GRACE * 3)).toEqual([`seat-r working@${HOLD}`]);
  });

  it("a hold that came due with the link up fires when its timer is late and the lost link is taken first", async () => {
    let wall = 0;
    // A timer that never wakes: the lost link is taken before any tick.
    const lateTimers: Clock.Clock = {
      currentTimeMillisUnsafe: () => wall,
      currentTimeMillis: Effect.sync(() => wall),
      currentTimeNanosUnsafe: () => BigInt(wall) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(wall) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => BigInt(wall) * 1_000_000n,
      monotonicTimeNanos: Effect.sync(() => BigInt(wall) * 1_000_000n),
      sleep: () => Effect.never,
    };
    const emitted = await Effect.gen(function* () {
      const feeds = yield* Queue.unbounded<SeatStateFeed>();
      const source = yield* makeSeatStateSource(Stream.fromQueue(feeds));
      const out: SeatStateFiring[] = [];
      yield* source.firings.pipe(Stream.runForEach((f) => Effect.sync(() => out.push(f))), Effect.forkScoped);
      yield* settle;
      yield* Queue.offer(feeds, { machine: REMOTE, kind: "live", event: ev("seat-r", "e1", "idle", 0) });
      yield* settle;
      wall = HOLD + 10_000;
      yield* Queue.offer(feeds, { machine: REMOTE, kind: "lost" });
      yield* settle;
      return out.map((f) => `${f.seat} ${f.becomes}@${f.at}`);
    }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, lateTimers), Effect.runPromise);
    expect(emitted).toEqual([`seat-r idle@${HOLD}`]);
  });

  it("a lost link touches only the seats of that machine", async () => {
    const timed = [
      live(ev("seat-l", "e1", "gone", 1_000), MACHINE),
      live(ev("seat-r", "e1", "gone", 1_000)),
      lost(2_000),
    ];
    expect(await runFeeds(timed, GRACE * 3)).toEqual([`seat-l gone@${1_000 + GRACE}`]);
  });
});

describe("seat-state source: the seats link's feed", () => {
  it("seeds each remote seat's last state, then streams states and lost links, and unsubscribes when closed", async () => {
    let listener: ((feed: RemoteSeatFeed) => void) | undefined;
    let unsubscribed = false;
    const remote = {
      current: () => [{ machine: REMOTE, event: ev("seat-r", "e1", "idle", 0) }],
      subscribe: (next: (feed: RemoteSeatFeed) => void) => {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
    };
    const feeds = await Effect.gen(function* () {
      const fiber = yield* remoteSeatStateFeedsOf(remote).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* settle;
      listener!({ _tag: "State", machine: REMOTE, event: ev("seat-r", "e1", "working", 5) });
      listener!({ _tag: "Lost", machine: REMOTE });
      return yield* Fiber.join(fiber);
    }).pipe(Effect.runPromise);
    expect(feeds.map(show)).toEqual(["inst-remote seed seat-r idle", "inst-remote live seat-r working", "inst-remote lost"]);
    expect(unsubscribed).toBe(true);
  });

  it("a peer whose clock runs 5 min ahead moves no local hold", async () => {
    let listener: ((feed: RemoteSeatFeed) => void) | undefined;
    let wall = 0;
    const remote = {
      current: () => [],
      subscribe: (next: (feed: RemoteSeatFeed) => void) => {
        listener = next;
        return () => {};
      },
    };
    const AHEAD = 5 * 60_000;
    const emitted = await Effect.gen(function* () {
      const local = yield* Queue.unbounded<SeatStateFeed>();
      const source = yield* makeSeatStateSource(Stream.merge(Stream.fromQueue(local), remoteSeatStateFeedsOf(remote, () => wall)));
      const out: string[] = [];
      yield* source.firings.pipe(Stream.runForEach((f) => Effect.sync(() => out.push(`${f.seat} ${f.becomes}@${f.at}`))), Effect.forkScoped);
      const at = (time: number) =>
        Effect.gen(function* () {
          wall = time;
          yield* advanceTo(time);
        });
      yield* settle;
      yield* at(1_000);
      yield* Queue.offer(local, { machine: MACHINE, kind: "live", event: ev("seat-l", "e1", "idle", 1_000) });
      yield* settle;
      yield* at(2_000);
      listener!({ _tag: "State", machine: REMOTE, event: ev("seat-r", "e1", "working", 2_000 + AHEAD) });
      yield* settle;
      yield* at(HOLD);
      const beforeDue = [...out];
      yield* at(40_000);
      yield* Queue.offer(local, { machine: MACHINE, kind: "live", event: ev("seat-l", "e1", "working", 40_000) });
      yield* settle;
      yield* at(40_000 + HOLD * 2);
      return { beforeDue, out };
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);
    expect(emitted.beforeDue).toEqual([]);
    expect(emitted.out).toEqual([`seat-l idle@${1_000 + HOLD}`, `seat-r working@${2_000 + HOLD}`, `seat-l working@${40_000 + HOLD}`]);
  });

  it("stamps a remote seed and state with this machine's clock when heard", async () => {
    let listener: ((feed: RemoteSeatFeed) => void) | undefined;
    const remote = {
      current: () => [{ machine: REMOTE, event: ev("seat-r", "e1", "idle", 900_000) }],
      subscribe: (next: (feed: RemoteSeatFeed) => void) => {
        listener = next;
        return () => {};
      },
    };
    let wall = 7;
    const feeds = await Effect.gen(function* () {
      const fiber = yield* remoteSeatStateFeedsOf(remote, () => wall).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* settle;
      wall = 11;
      listener!({ _tag: "State", machine: REMOTE, event: ev("seat-r", "e1", "working", 900_500) });
      return yield* Fiber.join(fiber);
    }).pipe(Effect.runPromise);
    expect(feeds.map((feed) => (feed.kind === "lost" ? "lost" : `${feed.kind} ${feed.event.state}@${feed.event.at}`))).toEqual([
      "seed idle@7",
      "live working@11",
    ]);
  });

  it("a remote state names its machine only when the link says which", () => {
    resetRemoteSeatState();
    const heard: RemoteSeatFeed[] = [];
    const stop = onRemoteSeatFeed((feed) => heard.push(feed));
    publishRemoteSeatState(ev("seat-r", "e1", "idle", 1), REMOTE);
    publishRemoteSeatState(ev("seat-x", "e1", "idle", 2));
    remoteSeatLinkLost(REMOTE);
    stop();
    expect(heard.map((f) => (f._tag === "Lost" ? `lost ${f.machine}` : `${f.machine} ${f.event.bindingId}`))).toEqual([
      "inst-remote seat-r",
      "lost inst-remote",
    ]);
    expect(remoteSeatStateFeeds().map(({ machine, event }) => `${machine} ${event.bindingId}`)).toEqual(["inst-remote seat-r"]);
    resetRemoteSeatState();
  });
});
