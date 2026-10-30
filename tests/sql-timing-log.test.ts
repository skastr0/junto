import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armMainThreadBudget, resetMainThreadBudget, statementTimingTop, withinBudget } from "../src/main/junto/observability/main-thread-budget";
import { SQL_TIMING_FILE, SQL_TIMING_INTERVAL_MS, sqlTimingReport, startSqlTimingLog } from "../src/main/junto/observability/sql-timing-log";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";

let home: string;
const file = (): string => join(home, ".junto", "logs", SQL_TIMING_FILE);
const arm = (enabled = true): void => armMainThreadBudget({ enabled, force: true, report: () => undefined });
const statement = (sql: string, rows = 0): void => {
  withinBudget("state.test", () => Array.from({ length: rows }), undefined, true, sql);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "junto-sql-timing-"));
  resetMainThreadBudget();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetMainThreadBudget();
  rmSync(home, { recursive: true, force: true });
});

describe("sql-timing.json", () => {
  it("starts nothing and writes nothing while the budget is off", () => {
    arm(false);
    const stop = startSqlTimingLog({ home });
    statement("SELECT 1");
    vi.advanceTimersByTime(SQL_TIMING_INTERVAL_MS * 3);
    stop();
    expect(existsSync(file())).toBe(false);
  });

  it("writes the top statements every minute, owner only, and once more on stop", () => {
    arm();
    const stop = startSqlTimingLog({ home });
    vi.advanceTimersByTime(SQL_TIMING_INTERVAL_MS);
    expect(existsSync(file()), "nothing recorded, nothing written").toBe(false);

    statement("SELECT a FROM t WHERE id IN (?, ?)", 2);
    statement("SELECT a FROM t WHERE id IN (?)", 1);
    vi.advanceTimersByTime(SQL_TIMING_INTERVAL_MS - 1);
    expect(existsSync(file())).toBe(false);
    vi.advanceTimersByTime(1);

    const first = JSON.parse(readFileSync(file(), "utf8")) as { keys: number; top: Array<{ operation: string; sql: string; count: number; rows: number; meanMs: number }> };
    expect(first.keys).toBe(1);
    expect(first.top).toHaveLength(1);
    expect(first.top[0]).toMatchObject({ operation: "state.test", sql: "SELECT a FROM t WHERE id IN (?*)", count: 2, rows: 3 });
    expect(statSync(file()).mode & 0o777).toBe(0o600);

    statement("SELECT b FROM u");
    stop();
    const last = JSON.parse(readFileSync(file(), "utf8")) as { keys: number };
    expect(last.keys).toBe(2);
    vi.advanceTimersByTime(SQL_TIMING_INTERVAL_MS * 2);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual(last);
  });

  it("keeps at most twenty statements in the file", () => {
    arm();
    for (let i = 0; i < 40; i += 1) statement(`SELECT ${i}`);
    const report = JSON.parse(sqlTimingReport(Date.now())) as { keys: number; top: unknown[] };
    expect(report.keys).toBe(40);
    expect(report.top).toHaveLength(20);
  });
});

describe("the state client feeds the aggregate", () => {
  it("names a statement run through the client by its operation and its rows", () => {
    vi.useRealTimers();
    arm();
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(":memory:")),
        (opened) => Effect.sync(() => opened.close()),
      );
      const sql = yield* makeSqliteClient(database);
      yield* sql`CREATE TABLE entries (id INTEGER PRIMARY KEY)`;
      yield* sql`INSERT INTO entries VALUES (1), (2), (3)`;
      yield* sql`SELECT id FROM entries`;
      yield* sql`SELECT id FROM entries`;
      const select = statementTimingTop().find((row) => row.sql === "SELECT id FROM entries");
      expect(select).toMatchObject({ count: 2, rows: 6 });
      expect(select?.operation.startsWith("state.")).toBe(true);
    })).pipe(Effect.provide(Reactivity.layer)));
  });
});
