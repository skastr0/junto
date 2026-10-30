/**
 * The host's tick source (src/main/junto/fleet/tick-clock.ts): periods from
 * elapsed time, so a late timer and a stalled event loop are counted when
 * they end. The lease side also counts the wall clock, so a sleep ends a
 * lease; the election side counts the monotonic clock alone, so no wall step
 * makes a follower stand early.
 */
import { expect, it } from "vitest";
import { makeTickClock } from "../src/main/junto/fleet/tick-clock";

it("counts whole periods on both sides and carries the rest", () => {
  const clock = makeTickClock(1_000, 0, 0);
  expect(clock.periods(600, 600)).toEqual({ lease: 0, election: 0 });
  expect(clock.periods(1_500, 1_500)).toEqual({ lease: 1, election: 1 });
  expect(clock.periods(2_000, 2_000)).toEqual({ lease: 1, election: 1 });
});

it("counts a stall when it ends, on both sides", () => {
  const clock = makeTickClock(1_000, 0, 0);
  expect(clock.periods(25_000, 25_000)).toEqual({ lease: 25, election: 25 });
});

it("counts a sleep the monotonic clock did not see on the lease side only", () => {
  const clock = makeTickClock(1_000, 0, 0);
  // macOS stops the monotonic clock while asleep: an hour passes on the wall only.
  expect(clock.periods(1_000, 3_601_000)).toEqual({ lease: 3_601, election: 1 });
});

it("never counts a wall clock stepped forward on the election side", () => {
  const clock = makeTickClock(1_000, 0, 0);
  // An NTP correction or a clock set by hand, thirty periods ahead.
  expect(clock.periods(1_000, 31_000)).toEqual({ lease: 31, election: 1 });
});

it("counts nothing backward when the wall clock is set back, and keeps the monotonic time", () => {
  const clock = makeTickClock(1_000, 0, 10_000_000);
  expect(clock.periods(2_000, 10_000_000 - 3_600_000)).toEqual({ lease: 2, election: 2 });
  expect(clock.periods(2_500, 10_000_000 - 3_600_000 + 500)).toEqual({ lease: 0, election: 0 });
});
