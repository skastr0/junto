/**
 * Durable writes are attributed to the operation that made them.
 *
 * Each synchronous SQL call is timed, not a yielding Effect transaction's
 * wall time. SQL transaction control reports slowness without throwing after
 * a successful BEGIN/COMMIT, which would corrupt the driver's lifecycle.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StatementSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it, vi } from "vitest";
import {
  armMainThreadBudget,
  resetMainThreadBudget,
  type BudgetViolation,
} from "../src/main/junto/observability/main-thread-budget";
import {
  makeStateEngineLive,
} from "../src/main/junto/state/engine";
import { StateTransactionOperation } from "../src/main/junto/state/service";

const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  resetMainThreadBudget();
  while (runtimes.length > 0) await runtimes.pop()!.dispose();
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

const openEngine = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-write-budget-"));
  roots.push(root);
  const runtime = ManagedRuntime.make(
    makeStateEngineLive(join(root, "state", "junto.db")),
  );
  runtimes.push(runtime);
  return runtime;
};

it.each(["execute", "values", "raw"] as const)("names the owner of a slow SQL call through %s", async (mode) => {
  const runtime = await openEngine();
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  let elapsed = 100;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const all = StatementSync.prototype.all;
  vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (this: StatementSync, ...args) {
    const result = all.apply(this, args);
    elapsed += 7;
    return result;
  });
  const seen: Array<BudgetViolation> = [];
  armMainThreadBudget({
    enabled: true,
    force: true,
    budgetMs: 1,
    report: (violation) => seen.push(violation),
  });

  const statement = sql`SELECT 1 AS n`;
  const query = mode === "values" ? statement.values : mode === "raw" ? statement.raw : statement;
  await runtime.runPromise(sql.withTransaction(query).pipe(
    Effect.provideService(StateTransactionOperation, "test.slow-write"),
  ));
  expect(seen).toMatchObject([{ operation: "state.test.slow-write", ms: 7, budgetMs: 1 }]);
});

it("stays silent for cheap SQL even when the transaction yields for longer than the budget", async () => {
  const runtime = await openEngine();
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  let elapsed = 100;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const seen: Array<BudgetViolation> = [];
  armMainThreadBudget({
    enabled: true,
    force: true,
    report: (violation) => seen.push(violation),
  });

  await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
    yield* sql`SELECT 1 AS n`;
    yield* Effect.yieldNow;
    elapsed += 100;
    yield* sql`SELECT 2 AS n`;
  })).pipe(Effect.provideService(StateTransactionOperation, "test.fast-write")));

  expect(seen).toEqual([]);
});

it("strict budget reports slow transaction control without leaking a transaction or permit", async () => {
  const runtime = await openEngine();
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(sql`CREATE TEMP TABLE budget_probe (n INTEGER)`);
  let elapsed = 100;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const run = StatementSync.prototype.run;
  vi.spyOn(StatementSync.prototype, "run").mockImplementation(function (this: StatementSync, ...args) {
    const result = run.apply(this, args);
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(this.sourceSQL)) elapsed += 7;
    return result;
  });
  const seen: Array<BudgetViolation> = [];
  armMainThreadBudget({ enabled: true, force: true, throwOnViolation: true, budgetMs: 1,
    report: (violation) => seen.push(violation) });
  await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO budget_probe VALUES (13)`;
    expect(yield* Effect.result(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO budget_probe VALUES (29)`;
      return yield* Effect.fail("discard savepoint");
    })))).toMatchObject({ _tag: "Failure", failure: "discard savepoint" });
    yield* sql.withTransaction(sql`INSERT INTO budget_probe VALUES (41)`);
  })));
  expect(await runtime.runPromise(Effect.result(sql.withTransaction(Effect.fail("discard outer")))))
    .toMatchObject({ _tag: "Failure", failure: "discard outer" });
  await runtime.runPromise(sql.withTransaction(sql`INSERT INTO budget_probe VALUES (59)`));
  expect(await runtime.runPromise(sql`SELECT n FROM budget_probe ORDER BY n`))
    .toEqual([{ n: 13 }, { n: 41 }, { n: 59 }]);
  expect(seen.length).toBeGreaterThanOrEqual(4);
  expect(seen.every((violation) => violation.ms === 7)).toBe(true);
});

it("strict budget rolls back a slow statement but preserves the statement's own SQL error", async () => {
  const runtime = await openEngine();
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(sql`CREATE TEMP TABLE budget_probe (n INTEGER CHECK (n > 0))`);
  let elapsed = 100;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const run = StatementSync.prototype.run;
  vi.spyOn(StatementSync.prototype, "run").mockImplementation(function (this: StatementSync, ...args) {
    try {
      return run.apply(this, args);
    } finally {
      if (this.sourceSQL.startsWith("INSERT")) elapsed += 7;
    }
  });
  armMainThreadBudget({ enabled: true, force: true, throwOnViolation: true, budgetMs: 1, report: () => {} });
  expect(await runtime.runPromise(Effect.result(sql.withTransaction(sql`INSERT INTO budget_probe VALUES (3)`))))
    .toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("[budget]") } });
  expect(await runtime.runPromise(Effect.result(sql.withTransaction(sql`INSERT INTO budget_probe VALUES (-3)`))))
    .toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("CHECK constraint failed") } });
  expect(await runtime.runPromise(sql`SELECT n FROM budget_probe`)).toEqual([]);
});
