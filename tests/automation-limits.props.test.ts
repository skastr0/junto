import { describe, expect, it } from "vitest";
import { limitSkip, MAX_PER_HOUR_CEILING, type AutomationLimits } from "../src/shared/automation";

// The firing limits (07), by simulation: an automation that fires whenever
// `limitSkip` allows, over random clocks, never breaks either limit and is
// never stuck. Seeded: a failure names the seed that replays it.

const HOUR = 60 * 60_000;

const rng = (seed: number) => {
  let s = seed >>> 0;
  return (below: number): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) % below;
};

const limitsOf = (next: (below: number) => number): AutomationLimits => ({
  minIntervalMs: [0, 1_000, 60_000, 5 * 60_000, 20 * 60_000, 24 * HOUR][next(6)]!,
  maxPerHour: [1, 2, 12, 30, MAX_PER_HOUR_CEILING][next(5)]!,
});

/** Fire whenever allowed, over ticks of random size; the clock may step back when `stepBack`. */
const simulate = (seed: number, stepBack: boolean) => {
  const next = rng(seed);
  const limits = limitsOf(next);
  const fired: number[] = [];
  const clock: number[] = [];
  let now = 1_000_000 + next(10_000);
  for (let i = 0; i < 400; i++) {
    now += stepBack && next(12) === 0 ? -next(2 * HOUR) : [1, 1_000, 30_000, 61_000, 5 * 60_000, 17 * 60_000, HOUR + 1][next(7)]!;
    now = Math.max(now, 0);
    clock.push(now);
    if (limitSkip(limits, fired, now) === undefined) fired.push(now);
  }
  return { limits, fired, clock };
};

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
const forall = (check: (seed: number) => ReadonlyArray<string>) => () => {
  const violations: string[] = [];
  for (const seed of SEEDS) for (const v of check(seed)) if (violations.length < 10) violations.push(`seed ${seed}: ${v}`);
  expect(violations).toEqual([]);
};

describe("the simulations are not vacuous", () => {
  it("fire, and hit both limits, across the seeds", () => {
    let fires = 0;
    const skips = new Set<string>();
    for (const seed of SEEDS) {
      const { limits, fired, clock } = simulate(seed, false);
      fires += fired.length;
      for (const now of clock) {
        const reason = limitSkip(limits, fired.filter((at) => at < now), now);
        if (reason !== undefined) skips.add(reason);
      }
    }
    expect(fires).toBeGreaterThan(1_000);
    expect([...skips].sort()).toEqual(["max_per_hour", "min_interval"]);
  });
});

describe("firing limits", () => {
  it("never fire closer than the minimum interval, on a clock that only moves forward", forall((seed) => {
    const { limits, fired } = simulate(seed, false);
    const out: string[] = [];
    fired.forEach((at, i) => {
      if (i > 0 && at - fired[i - 1]! < limits.minIntervalMs) out.push(`gap ${at - fired[i - 1]!} under ${limits.minIntervalMs}`);
    });
    return out;
  }));

  it("never fire more than maxPerHour in any hour, on a clock that only moves forward", forall((seed) => {
    const { limits, fired } = simulate(seed, false);
    const out: string[] = [];
    fired.forEach((at, i) => {
      const inHour = fired.filter((other, j) => j <= i && other > at - HOUR).length;
      if (inHour > limits.maxPerHour) out.push(`${inHour} in the hour to ${at}, cap ${limits.maxPerHour}`);
    });
    return out;
  }));

  it("never burst when the clock steps back: nothing fires until it passes the last firing by the minimum interval", forall((seed) => {
    const { limits, fired, clock } = simulate(seed, true);
    const out: string[] = [];
    const seen: number[] = [];
    for (const now of clock) {
      const allowed = limitSkip(limits, seen, now) === undefined;
      const latest = seen.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...seen);
      if (allowed && now - latest < limits.minIntervalMs) out.push(`allowed at ${now} within ${limits.minIntervalMs} of ${latest}`);
      if (fired.includes(now) && allowed) seen.push(now);
    }
    return out;
  }));

  it("allow the first firing, whatever the limits and the clock", forall((seed) => {
    const next = rng(seed);
    const limits = limitsOf(next);
    return limitSkip(limits, [], next(2 ** 31)) === undefined ? [] : ["blocked an automation that never fired"];
  }));

  it("do not depend on the order the firings are listed in", forall((seed) => {
    const { limits, fired, clock } = simulate(seed, false);
    const now = clock[clock.length - 1]! + 1_000;
    return limitSkip(limits, fired, now) === limitSkip(limits, [...fired].reverse(), now) ? [] : ["order changed the answer"];
  }));

  it("name the minimum interval before the hourly cap when both apply", () => {
    const limits: AutomationLimits = { minIntervalMs: 60_000, maxPerHour: 2 };
    const now = 10 * HOUR;
    expect(limitSkip(limits, [now - 2_000, now - 30_000], now)).toBe("min_interval");
    expect(limitSkip(limits, [now - 120_000, now - 61_000], now)).toBe("max_per_hour");
    expect(limitSkip(limits, [now - 120_000], now)).toBeUndefined();
  });

  it("are never stuck: after both the interval and the hour have passed since the last firing, it fires", forall((seed) => {
    const { limits, fired } = simulate(seed, false);
    if (fired.length === 0) return [];
    const wait = Math.max(limits.minIntervalMs, HOUR);
    const now = Math.max(...fired) + wait;
    return limitSkip(limits, fired, now) === undefined ? [] : [`still skipped ${wait}ms after the last firing`];
  }));

  it("count a firing exactly an hour old as out of the hour", () => {
    const limits: AutomationLimits = { minIntervalMs: 0, maxPerHour: 1 };
    const now = 5 * HOUR;
    expect(limitSkip(limits, [now - HOUR], now)).toBeUndefined();
    expect(limitSkip(limits, [now - HOUR + 1], now)).toBe("max_per_hour");
  });
});
