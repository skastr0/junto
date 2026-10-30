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
  MainThreadBudgetExceeded,
  MAX_STATEMENT_KEYS,
  normalizeStatementSql,
  resetMainThreadBudget,
  statementTimingSummary,
  statementTimingTop,
  withinBudget,
  type BudgetViolation,
} from "../src/main/junto/observability/main-thread-budget";

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
    expect(() => noteSyncSpan("slow.operation", 900)).toThrow(MainThreadBudgetExceeded);
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

describe("the per-statement aggregate", () => {
  const run = (operation: string, sql: string, rows = 0, ms = 0) =>
    withinBudget(operation, () => {
      if (ms > 0) block(ms);
      return Array.from({ length: rows }, (_, i) => i);
    }, undefined, true, sql);

  it("records nothing, and keeps nothing, until it is armed", () => {
    armMainThreadBudget({ enabled: false, force: true });
    run("state.read", "SELECT 1", 3);
    expect(statementTimingTop()).toEqual([]);
    expect(statementTimingSummary().keys).toBe(0);
  });

  it("counts a statement once however it is spaced and however long its IN list is", () => {
    arm();
    run("state.read", "SELECT id FROM t\n  WHERE id IN (?, ?, ?)", 3);
    run("state.read", "SELECT id FROM t WHERE id IN (?,?,?,?,?)", 5);
    run("state.read", "  SELECT id FROM t WHERE   id IN (?)", 1);

    const top = statementTimingTop();
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ operation: "state.read", sql: "SELECT id FROM t WHERE id IN (?*)", count: 3, rows: 9 });
    expect(top[0]!.totalMs).toBeGreaterThanOrEqual(top[0]!.maxMs);
  });

  it("keeps a different operation, or a different statement, apart", () => {
    arm();
    run("state.read", "SELECT 1");
    run("state.write", "SELECT 1");
    run("state.read", "SELECT 2");
    expect(statementTimingTop().map((row) => `${row.operation} ${row.sql}`).sort()).toEqual([
      "state.read SELECT 1",
      "state.read SELECT 2",
      "state.write SELECT 1",
    ]);
  });

  it("orders by total time, longest first, and tracks the longest single run", () => {
    arm();
    run("op", "fast", 0, 0);
    run("op", "slow", 0, 3);
    run("op", "slow", 0, 1);
    const [first, second] = statementTimingTop();
    expect(first?.sql).toBe("slow");
    expect(first?.count).toBe(2);
    expect(first!.maxMs).toBeGreaterThanOrEqual(3);
    expect(first!.totalMs).toBeGreaterThanOrEqual(4);
    expect(second?.sql).toBe("fast");
  });

  it("folds IN lists of host parameters and leaves a subquery alone", () => {
    expect(normalizeStatementSql("a IN (?, ?2, :name, @n, $v) AND b in (?)")).toBe("a IN (?*) AND b IN (?*)");
    expect(normalizeStatementSql("a IN (SELECT x FROM y)")).toBe("a IN (SELECT x FROM y)");
    expect(normalizeStatementSql("x".repeat(300))).toHaveLength(100);
  });

  it("is bounded: past the cap, new statements are counted in one other row", () => {
    arm();
    for (let i = 0; i < MAX_STATEMENT_KEYS + 25; i += 1) run("op", `SELECT ${i}`);
    run("op", "SELECT 0");

    const all = statementTimingTop(10_000);
    expect(statementTimingSummary().keys).toBe(MAX_STATEMENT_KEYS);
    expect(all).toHaveLength(MAX_STATEMENT_KEYS + 1);
    expect(all[all.length - 1]).toMatchObject({ operation: "(other)", count: 25 });
    expect(all.find((row) => row.sql === "SELECT 0")?.count).toBe(2);
  });

  it("counts a statement that threw, with no rows, and still throws", () => {
    arm();
    expect(() => withinBudget("op", () => {
      throw new Error("no such table");
    }, undefined, true, "SELECT * FROM missing")).toThrow("no such table");
    expect(statementTimingTop()[0]).toMatchObject({ sql: "SELECT * FROM missing", count: 1, rows: 0 });
  });

  it("records the statement before a strict violation throws", () => {
    arm({ throwOnViolation: true });
    expect(() => run("op", "SELECT slow", 0, MAIN_THREAD_BUDGET_MS + 3)).toThrow(MainThreadBudgetExceeded);
    expect(statementTimingTop()[0]).toMatchObject({ sql: "SELECT slow", count: 1 });
  });

  it("starts again from nothing on reset", () => {
    arm();
    run("op", "SELECT 1");
    resetMainThreadBudget();
    expect(statementTimingTop()).toEqual([]);
  });
});
