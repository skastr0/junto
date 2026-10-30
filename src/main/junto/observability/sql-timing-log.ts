import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { machineLogDir } from "./log-file";
import { mainThreadBudgetArmed, statementTimingSummary, statementTimingTop } from "./main-thread-budget";

/**
 * The top of the per-statement aggregate, on disk, for an app nobody can
 * attach a profiler to: `<home>/.junto/logs/sql-timing.json`, rewritten every
 * minute and when the process exits. The numbers are cumulative since
 * `since`, so a rate is `count / (at - since)`; read the file twice for a
 * window. Armed by the same switch as the budget (JUNTO_BUDGET): disarmed,
 * nothing starts and nothing is written.
 */
export const SQL_TIMING_FILE = "sql-timing.json";
export const SQL_TIMING_INTERVAL_MS = 60_000;
export const SQL_TIMING_TOP = 20;

export type SqlTimingLogOptions = {
  readonly home: string;
  readonly intervalMs?: number;
};

const round = (ms: number): number => Math.round(ms * 100) / 100;

export const sqlTimingReport = (now: number): string => {
  const summary = statementTimingSummary();
  return JSON.stringify({
    at: new Date(now).toISOString(),
    since: new Date(summary.sinceMs).toISOString(),
    seconds: round((now - summary.sinceMs) / 1000),
    keys: summary.keys,
    top: statementTimingTop(SQL_TIMING_TOP).map((row) => ({
      operation: row.operation,
      sql: row.sql,
      count: row.count,
      totalMs: round(row.totalMs),
      meanMs: round(row.totalMs / Math.max(1, row.count)),
      maxMs: round(row.maxMs),
      rows: row.rows,
    })),
  }, null, 1);
};

/** Start the writer; returns a stop that writes once more. A no-op when the budget is not armed. */
export const startSqlTimingLog = (options: SqlTimingLogOptions): (() => void) => {
  if (!mainThreadBudgetArmed()) return () => undefined;
  const dir = machineLogDir(options.home);
  const path = join(dir, SQL_TIMING_FILE);
  let failing = false;
  const write = (): void => {
    if (statementTimingSummary().keys === 0) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const pending = `${path}.pending`;
      writeFileSync(pending, sqlTimingReport(Date.now()), { mode: 0o600 });
      renameSync(pending, path);
      failing = false;
    } catch (cause) {
      // Reported once; a diagnostic file must never take the app down.
      if (!failing) console.error("[budget] could not write sql-timing.json", cause);
      failing = true;
    }
  };
  const timer = setInterval(write, options.intervalMs ?? SQL_TIMING_INTERVAL_MS);
  timer.unref();
  process.once("exit", write);
  return () => {
    clearInterval(timer);
    process.off("exit", write);
    write();
  };
};
