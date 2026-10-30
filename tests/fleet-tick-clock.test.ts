/**
 * The host's tick source (src/main/junto/fleet/tick-clock.ts): periods from
 * elapsed time, so a late timer, a stalled event loop and a sleeping Mac are
 * all counted when they end, and a clock set back counts nothing.
 */
import { expect, it } from "vitest";
import { makeTickClock } from "../src/main/junto/fleet/tick-clock";

it("counts whole periods and carries the rest", () => {
  const clock = makeTickClock(1_000, 0, 0);
  expect(clock.periods(600, 600)).toBe(0);
  expect(clock.periods(1_500, 1_500)).toBe(1);
  expect(clock.periods(2_000, 2_000)).toBe(1);
});

it("counts a stall when it ends", () => {
  const clock = makeTickClock(1_000, 0, 0);
  expect(clock.periods(25_000, 25_000)).toBe(25);
});

it("counts a sleep the monotonic clock did not see, by the wall clock", () => {
  const clock = makeTickClock(1_000, 0, 0);
  // macOS stops the monotonic clock while asleep: an hour passes on the wall only.
  expect(clock.periods(1_000, 3_601_000)).toBe(3_601);
});

it("counts nothing backward when the wall clock is set back, and keeps the monotonic time", () => {
  const clock = makeTickClock(1_000, 0, 10_000_000);
  expect(clock.periods(2_000, 10_000_000 - 3_600_000)).toBe(2);
  expect(clock.periods(2_500, 10_000_000 - 3_600_000 + 500)).toBe(0);
});
