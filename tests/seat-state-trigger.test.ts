import { Option } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentSeatState, AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { SeatBecomes } from "../src/shared/automation";
import { drainKeyOf } from "../src/shared/seat-drain";
import {
  emptySeatTriggers,
  nextSeatTriggerDue,
  SEAT_TRIGGER_GONE_GRACE_MS as GRACE,
  SEAT_TRIGGER_HOLD_MS as HOLD,
  seatKeyOf,
  seedSeatTriggers,
  stepSeatTriggers,
  type SeatKey,
  type SeatStateFiring,
  type SeatTriggerInput,
  type SeatTriggers,
  type SeatTriggerState,
} from "../src/shared/seat-state-trigger";

const event = (state: AgentSeatState, at: number, over: Partial<AgentSeatStateEvent> = {}): SeatTriggerInput => ({
  _tag: "Event",
  event: { bindingId: "seat-a", epoch: "e1", state, reason: `r-${state}`, confidence: "high", at, ...over },
});
const tick = (now: number): SeatTriggerInput => ({ _tag: "Tick", now });

/** Fold inputs from `start`; every firing, in order. */
const run = (inputs: readonly SeatTriggerInput[], start: SeatTriggers = emptySeatTriggers) => {
  let state = start;
  const firings: SeatStateFiring[] = [];
  for (const input of inputs) {
    const step = stepSeatTriggers(state, input);
    state = step.state;
    firings.push(...step.firings);
  }
  return { state, firings, fired: firings.map((f) => `${f.seat}/${f.epoch} ${f.becomes}@${f.at}`) };
};

describe("seat-state triggers: types", () => {
  it("fires on every seat state but unknown", () => {
    expectTypeOf<SeatTriggerState>().toEqualTypeOf<Exclude<AgentSeatState, "unknown">>();
  });

  it("fires on exactly the states an automation's seat watch names", () => {
    expectTypeOf<SeatTriggerState>().toEqualTypeOf<SeatBecomes>();
  });

  it("a seat key is branded, so a bare binding id or drain key is not one", () => {
    expectTypeOf<string>().not.toMatchTypeOf<SeatKey>();
    expectTypeOf<SeatStateFiring["seat"]>().toEqualTypeOf<SeatKey>();
  });

  it("a drain key never names a seat", () => {
    expect(Option.isNone(seatKeyOf(drainKeyOf("seat-a", "e1")))).toBe(true);
    expect(Option.getOrThrow(seatKeyOf("seat-a"))).toBe("seat-a");
  });
});

describe("seat-state triggers: idle and working hold 30 s", () => {
  it("idle fires once it has held for 30 s, not before", () => {
    const early = run([event("idle", 1_000), tick(1_000 + HOLD - 1)]);
    expect(early.fired).toEqual([]);
    expect(run([event("idle", 1_000), tick(1_000 + HOLD)]).fired).toEqual([`seat-a/e1 idle@${1_000 + HOLD}`]);
  });

  it("working to idle for the rings' 700 ms and back fires nothing new", () => {
    const { fired } = run([event("working", 0), tick(HOLD), event("idle", HOLD + 100), event("working", HOLD + 800), tick(HOLD * 3)]);
    expect(fired).toEqual([`seat-a/e1 working@${HOLD}`]);
  });

  it("another known state cancels the hold; re-publishing the same state keeps it", () => {
    expect(run([event("idle", 0), event("idle", 10_000), tick(HOLD)]).fired).toEqual([`seat-a/e1 idle@${HOLD}`]);
    expect(run([event("idle", 0), event("working", 10_000), tick(HOLD)]).fired).toEqual([]);
  });

  it("unknown neither fires nor resets a hold", () => {
    const { fired } = run([event("idle", 0), event("unknown", 10_000), event("unknown", 20_000), tick(HOLD), tick(HOLD * 5)]);
    expect(fired).toEqual([`seat-a/e1 idle@${HOLD}`]);
  });

  it("fires on transitions only: a state that settles again fires nothing", () => {
    const { fired } = run([event("idle", 0), tick(HOLD), event("idle", HOLD + 1), tick(HOLD * 3)]);
    expect(fired).toEqual([`seat-a/e1 idle@${HOLD}`]);
  });

  it("idle to working to idle, each held, fires each change", () => {
    const { fired } = run([event("idle", 0), tick(HOLD), event("working", 40_000), tick(70_000), event("idle", 80_000), tick(110_000)]);
    expect(fired).toEqual([`seat-a/e1 idle@${HOLD}`, "seat-a/e1 working@70000", "seat-a/e1 idle@110000"]);
  });

  it("a later event settles a hold that came due before it, at the hold's time", () => {
    const { fired } = run([event("idle", 0), event("working", HOLD + 5_000)]);
    expect(fired).toEqual([`seat-a/e1 idle@${HOLD}`]);
  });
});

describe("seat-state triggers: attention fires at once, once per episode", () => {
  it("fires on entry and ignores the 800 ms re-publish", () => {
    const { fired, firings } = run([event("working", 0), event("attention", 5_000), event("attention", 5_800), event("attention", 6_600), tick(HOLD * 4)]);
    expect(fired).toEqual(["seat-a/e1 attention@5000"]);
    expect(firings[0]!.since).toBe(5_000);
  });

  it("cancels a pending hold", () => {
    expect(run([event("idle", 0), event("attention", 1_000), tick(HOLD * 2)]).fired).toEqual(["seat-a/e1 attention@1000"]);
  });

  it("unknown does not end the episode", () => {
    expect(run([event("attention", 0), event("unknown", 1_000), event("attention", 2_000)]).fired).toEqual(["seat-a/e1 attention@0"]);
  });

  it("idle or working ends the episode, and the next attention is a new one", () => {
    const { fired } = run([event("attention", 0), event("working", 1_000), event("attention", 4_000)]);
    expect(fired).toEqual(["seat-a/e1 attention@0", "seat-a/e1 attention@4000"]);
  });

  it("each episode has its own key", () => {
    const { firings } = run([event("attention", 0), event("idle", 1_000), event("attention", 2_000)]);
    expect(new Set(firings.map((f) => f.key)).size).toBe(2);
  });
});

describe("seat-state triggers: gone waits 60 s for a new generation", () => {
  it("fires 60 s after gone when no generation takes the seat", () => {
    expect(run([event("working", 0), event("gone", 10_000), tick(10_000 + GRACE - 1)]).fired).toEqual([]);
    expect(run([event("working", 0), event("gone", 10_000), tick(10_000 + GRACE)]).fired).toEqual([`seat-a/e1 gone@${10_000 + GRACE}`]);
  });

  it("a new epoch on the seat within 60 s cancels it", () => {
    const { fired } = run([event("gone", 0), event("unknown", 3_000, { epoch: "e2", reason: "generation_replaced" }), tick(GRACE * 3)]);
    expect(fired).toEqual([]);
  });

  it("a new epoch after 60 s comes too late", () => {
    const { fired } = run([event("gone", 0), event("unknown", GRACE + 1, { epoch: "e2" })]);
    expect(fired).toEqual([`seat-a/e1 gone@${GRACE}`]);
  });

  it("the gone generation's own late events do not cancel it", () => {
    const { fired } = run([event("gone", 0), event("idle", 1_000), event("gone", 2_000), tick(GRACE)]);
    expect(fired).toEqual([`seat-a/e1 gone@${GRACE}`]);
  });

  it("cancels a pending hold and ends an episode", () => {
    expect(run([event("idle", 0), event("gone", 1_000), tick(1_000 + GRACE)]).fired).toEqual([`seat-a/e1 gone@${1_000 + GRACE}`]);
  });

  it("another seat's new generation does not cancel it", () => {
    const { fired } = run([event("gone", 0), event("unknown", 1_000, { bindingId: "seat-b", epoch: "e9" }), tick(GRACE)]);
    expect(fired).toEqual([`seat-a/e1 gone@${GRACE}`]);
  });
});

describe("seat-state triggers: keyed by seat and epoch", () => {
  it("a new epoch drops the old hold and keeps what had settled", () => {
    const { fired } = run([
      event("idle", 0),
      tick(HOLD),
      event("working", 40_000),
      event("unknown", 50_000, { epoch: "e2", reason: "generation_replaced" }),
      tick(80_000),
      event("idle", 90_000, { epoch: "e2" }),
      tick(120_000),
      event("working", 130_000, { epoch: "e2" }),
      tick(160_000),
    ]);
    expect(fired).toEqual([`seat-a/e1 idle@${HOLD}`, "seat-a/e2 working@160000"]);
  });

  it("a cache cut of an idle seat is invisible: gone, a new epoch within 60 s, idle again fires nothing", () => {
    const { fired } = run([
      event("idle", 0),
      tick(HOLD),
      event("gone", 40_000, { reason: "generation_unbound" }),
      event("unknown", 45_000, { epoch: "e2", reason: "generation_replaced" }),
      event("idle", 50_000, { epoch: "e2" }),
      tick(50_000 + HOLD),
      tick(40_000 + GRACE * 2),
    ]);
    expect(fired).toEqual([`seat-a/e1 idle@${HOLD}`]);
  });

  it("an open attention episode ends with its generation", () => {
    const { fired } = run([event("attention", 0), event("unknown", 1_000, { epoch: "e2" }), event("attention", 2_000, { epoch: "e2" })]);
    expect(fired).toEqual(["seat-a/e1 attention@0", "seat-a/e2 attention@2000"]);
  });

  it("a seat that has gone fires its next generation's state after the hold", () => {
    const { fired } = run([event("idle", 0), tick(HOLD), event("gone", 40_000), tick(40_000 + GRACE), event("idle", 200_000, { epoch: "e2" }), tick(200_000 + HOLD)]);
    expect(fired).toEqual([`seat-a/e1 idle@${HOLD}`, `seat-a/e1 gone@${40_000 + GRACE}`, `seat-a/e2 idle@${200_000 + HOLD}`]);
  });

  it("a seat that went for good: its next generation's events after the first are not read as late", () => {
    const { fired } = run([
      event("idle", 0),
      tick(31_000),
      event("gone", 40_000),
      tick(101_000),
      event("unknown", 200_000, { epoch: "e2" }),
      event("working", 201_000, { epoch: "e2" }),
      tick(240_000),
    ]);
    expect(fired).toEqual([`seat-a/e1 idle@${HOLD}`, `seat-a/e1 gone@${40_000 + GRACE}`, `seat-a/e2 working@${201_000 + HOLD}`]);
  });

  it("an event with no epoch never stands for a new generation", () => {
    const { fired } = run([event("gone", 0), event("unknown", 1_000, { epoch: "" }), tick(GRACE)]);
    expect(fired).toEqual([`seat-a/e1 gone@${GRACE}`]);
  });

  it("a replaced generation's late events are ignored", () => {
    const after = run([event("idle", 0), event("unknown", 1_000, { epoch: "e2" }), event("attention", 2_000), tick(HOLD * 4)]);
    expect(after.fired).toEqual([]);
  });

  it("seats fire independently, in time order", () => {
    const { fired } = run([event("idle", 0), event("idle", 5_000, { bindingId: "seat-b" }), event("attention", 6_000, { bindingId: "seat-c" }), tick(HOLD * 2)]);
    expect(fired).toEqual(["seat-c/e1 attention@6000", `seat-a/e1 idle@${HOLD}`, `seat-b/e1 idle@${HOLD + 5_000}`]);
  });

  it("a firing's key is its seat, epoch, state and start", () => {
    const one = run([event("idle", 0), tick(HOLD)]).firings[0]!;
    const other = run([event("idle", 0, { epoch: "e2" }), tick(HOLD)]).firings[0]!;
    expect(one.key).not.toBe(other.key);
    expect(one).toMatchObject({ seat: "seat-a", epoch: "e1", becomes: "idle", since: 0, at: HOLD, reason: "r-idle" });
  });
});

describe("seat-state triggers: drain keys, seeding, time", () => {
  it("a draining session never fires, whatever it publishes", () => {
    const drain = drainKeyOf("seat-a", "e1");
    const { fired, state } = run([event("attention", 0, { bindingId: drain }), event("idle", 1_000, { bindingId: drain }), event("gone", 2_000, { bindingId: drain }), tick(GRACE * 2)]);
    expect(fired).toEqual([]);
    expect(state.seats.size).toBe(0);
  });

  it("after a rekey the seat's gone fires, and the drain key's events do not reach it", () => {
    const drain = drainKeyOf("seat-a", "e1");
    const { fired } = run([event("working", 0), event("gone", 1_000, { reason: "offboard_detached" }), event("working", 1_001, { bindingId: drain }), tick(1_000 + GRACE)]);
    expect(fired).toEqual([`seat-a/e1 gone@${1_000 + GRACE}`]);
  });

  it("a seeded seat's state is already settled: a restart re-fires nothing", () => {
    const seeded = seedSeatTriggers(
      [
        { bindingId: "seat-a", epoch: "e1", state: "idle", reason: "x", confidence: "high", at: 0 },
        { bindingId: "seat-b", epoch: "e1", state: "attention", reason: "x", confidence: "high", at: 0 },
        { bindingId: drainKeyOf("seat-a", "e0"), epoch: "e0", state: "idle", reason: "x", confidence: "high", at: 0 },
      ],
      1_000,
    );
    expect(seeded.seats.size).toBe(2);
    const { fired } = run([event("idle", 2_000), event("attention", 2_000, { bindingId: "seat-b" }), tick(HOLD * 3)], seeded);
    expect(fired).toEqual([]);
    expect(run([event("working", 2_000), tick(2_000 + HOLD)], seeded).fired).toEqual([`seat-a/e1 working@${2_000 + HOLD}`]);
  });

  it("time never runs backwards: a late event starts its hold at the latest time seen", () => {
    const { fired } = run([tick(50_000), event("idle", 10_000), tick(50_000 + HOLD - 1), tick(50_000 + HOLD)]);
    expect(fired).toEqual([`seat-a/e1 idle@${50_000 + HOLD}`]);
  });

  it("nextSeatTriggerDue names the earliest hold or grace", () => {
    expect(nextSeatTriggerDue(emptySeatTriggers)).toBeUndefined();
    const { state } = run([event("gone", 0), event("idle", 5_000, { bindingId: "seat-b" }), event("attention", 6_000, { bindingId: "seat-c" })]);
    expect(nextSeatTriggerDue(state)).toBe(5_000 + HOLD);
    expect(nextSeatTriggerDue(run([event("attention", 0)]).state)).toBeUndefined();
  });

  it("the input is closed", () => {
    expectTypeOf<SeatTriggerInput["_tag"]>().toEqualTypeOf<"Event" | "Tick">();
  });
});
