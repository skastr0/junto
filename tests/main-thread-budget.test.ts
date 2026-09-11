/**
 * The 4 ms main-thread budget assertion.
 *
 * The assertion is a dev-mode instrument, so the tests below pin the two
 * things that make it trustworthy: it is SILENT unless armed, and when armed
 * it names the operation that blew the budget instead of a time window.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAIN_THREAD_BUDGET_MS,
  armMainThreadBudget,
  mainThreadBudgetArmed,
  mainThreadBudgetViolations,
  noteSyncSpan,
  onMainThreadBudgetViolation,
  resetMainThreadBudget,
  withinBudget,
  type BudgetViolation,
} from "../src/main/vellum-command/observability/main-thread-budget";

const seen: Array<BudgetViolation> = [];

const arm = (options: { throwOnViolation?: boolean } = {}): void => {
  armMainThreadBudget({
    enabled: true,
    force: true,
    report: (violation) => seen.push(violation),
    ...(options.throwOnViolation === undefined
      ? {}
      : { throwOnViolation: options.throwOnViolation }),
  });
};

/** Hold the thread for real: the assertion measures wall time, so must this. */
const block = (ms: number): number => {
  const startedAt = performance.now();
  let spins = 0;
  while (performance.now() - startedAt < ms) spins += 1;
  return spins;
};

beforeEach(() => {
  seen.length = 0;
  resetMainThreadBudget();
});

afterEach(() => {
  resetMainThreadBudget();
});

describe("the 4ms main-thread budget", () => {
  it("is silent, and costs nothing, until it is armed", () => {
    armMainThreadBudget({ enabled: false, force: true });
    expect(mainThreadBudgetArmed()).toBe(false);

    const result = withinBudget("slow.operation", () => {
      block(MAIN_THREAD_BUDGET_MS * 3);
      return "value";
    });

    expect(result).toBe("value");
    expect(mainThreadBudgetViolations()).toEqual([]);
    expect(noteSyncSpan("slow.operation", 500)).toBe(false);
  });

  it("names the operation that held the thread past the budget", () => {
    arm();

    withinBudget(
      "kernel.tick.simulation",
      () => block(MAIN_THREAD_BUDGET_MS * 2),
      "cycle",
    );

    const violations = mainThreadBudgetViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]?.operation).toBe("kernel.tick.simulation");
    expect(violations[0]?.detail).toBe("cycle");
    expect(violations[0]?.budgetMs).toBe(MAIN_THREAD_BUDGET_MS);
    expect(violations[0]?.ms).toBeGreaterThanOrEqual(MAIN_THREAD_BUDGET_MS);
    expect(seen).toEqual(violations);
  });

  it("says nothing about an operation inside the budget", () => {
    arm();

    const result = withinBudget("fast.operation", () => 42);

    expect(result).toBe(42);
    expect(mainThreadBudgetViolations()).toEqual([]);
  });

  it("publishes each violation to subscribers", () => {
    arm();
    const heard: Array<string> = [];
    const unsubscribe = onMainThreadBudgetViolation((violation) => {
      heard.push(violation.operation);
    });

    noteSyncSpan("canvas.read", 23.3, "factory");
    unsubscribe();
    noteSyncSpan("canvas.read", 23.3, "factory");

    expect(heard).toEqual(["canvas.read"]);
    expect(mainThreadBudgetViolations()).toHaveLength(2);
  });

  it("reports but never throws by default, so a loaded dev box still runs", () => {
    arm();
    expect(() => noteSyncSpan("slow.operation", 900)).not.toThrow();
    expect(mainThreadBudgetViolations()).toHaveLength(1);
  });

  it("throws in strict mode, which is what a gated run wants", () => {
    arm({ throwOnViolation: true });

    expect(() => noteSyncSpan("slow.operation", 900)).toThrow(
      /held the main thread/,
    );
    expect(() =>
      withinBudget("slow.operation", () => block(MAIN_THREAD_BUDGET_MS * 2)),
    ).toThrow(/held the main thread/);
  });

  it("never masks a real failure with a timing complaint", () => {
    arm({ throwOnViolation: true });

    expect(() =>
      withinBudget("failing.operation", () => {
        block(MAIN_THREAD_BUDGET_MS * 2);
        throw new Error("the real failure");
      }),
    ).toThrow("the real failure");

    // The overrun is still recorded — it is just not allowed to replace the
    // one fact worth keeping.
    expect(mainThreadBudgetViolations()).toHaveLength(1);
    expect(mainThreadBudgetViolations()[0]?.operation).toBe(
      "failing.operation",
    );
  });

  it("keeps the retained tape bounded on a long dev run", () => {
    arm();
    for (let i = 0; i < 500; i += 1) noteSyncSpan(`op-${i}`, 10);

    const violations = mainThreadBudgetViolations();
    expect(violations.length).toBeLessThanOrEqual(200);
    // Oldest dropped first: the newest violation is always retained.
    expect(violations[violations.length - 1]?.operation).toBe("op-499");
  });

  it("survives a broken observer", () => {
    arm();
    onMainThreadBudgetViolation(() => {
      throw new Error("bad observer");
    });

    expect(() => noteSyncSpan("watched.operation", 10)).not.toThrow();
    expect(mainThreadBudgetViolations()).toHaveLength(1);
  });
});
