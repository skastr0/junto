/**
 * The 4 ms main-thread budget, asserted at the source.
 *
 * THE INVARIANT: no synchronous operation on the main thread may exceed 4 ms,
 * at any factory size. The main process owns SQLite, the PTYs, and every IPC
 * reply, so a synchronous block there is felt directly as input lag.
 *
 * WHY AN ASSERTION. It answers at the moment it happens: "this operation,
 * this call, spent more than the budget." It names the operation instead of a
 * window, so a regression is attributed to the code that caused it while that
 * code is still on screen.
 *
 * WHEN IT IS ARMED. Development only, and by default off everywhere else. The
 * gate resolves once at module load:
 *
 *   JUNTO_BUDGET=0 | off      forced off
 *   JUNTO_BUDGET=1 | on       forced on, report only
 *   JUNTO_BUDGET=strict       forced on, and a violation THROWS
 *   unset                              on when NODE_ENV is "development"
 *
 * Main boot calls `armMainThreadBudget({ enabled: !app.isPackaged })`, so a dev
 * run is armed whatever NODE_ENV says and a packaged app is not.
 *
 * WHY REPORTING IS THE DEFAULT AND THROWING IS OPT-IN. A dev machine under
 * load genuinely blocks past 4 ms sometimes — another agent's build, a cold
 * page cache. Turning that into a crash would train everyone to disarm the
 * assertion, which is worse than not having one. `strict` exists for the run
 * that must fail loudly: CI, a scale gate, a regression hunt.
 *
 * COST WHEN DISARMED: one boolean test per call site, and the wrapped function
 * is invoked directly with no timing calls at all.
 */
import { performance } from "node:perf_hooks";
import { Schema } from "effect";

/** Strict mode only: a synchronous operation held the main thread past its budget. */
export class MainThreadBudgetExceeded extends Schema.TaggedError<MainThreadBudgetExceeded>()("MainThreadBudgetExceeded", {
  operation: Schema.String,
  heldMs: Schema.Number,
  budgetMs: Schema.Number,
  message: Schema.String,
}) {}

/** The invariant, as one number. */
export const MAIN_THREAD_BUDGET_MS = 4;

/** Bound the retained tape so a long dev run cannot grow memory. */
const MAX_RETAINED_VIOLATIONS = 200;

export type BudgetViolation = {
  /** What ran. A stable name, not a message — it is grouped on. */
  readonly operation: string;
  readonly ms: number;
  readonly budgetMs: number;
  /** Optional call-specific discriminator (a key, a canvas name). */
  readonly detail?: string;
  readonly at: string;
};

export type MainThreadBudgetOptions = {
  readonly enabled?: boolean;
  readonly throwOnViolation?: boolean;
  readonly budgetMs?: number;
  readonly report?: (violation: BudgetViolation) => void;
};

const envGate = (): {
  enabled: boolean;
  strict: boolean;
  /** True when the operator named a value. Boot must not override it. */
  forced: boolean;
} => {
  const raw = process.env.JUNTO_BUDGET?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") {
    return { enabled: false, strict: false, forced: true };
  }
  if (raw === "strict") return { enabled: true, strict: true, forced: true };
  if (raw === "1" || raw === "on" || raw === "true") {
    return { enabled: true, strict: false, forced: true };
  }
  return {
    enabled: process.env.NODE_ENV === "development",
    strict: false,
    forced: false,
  };
};

const initial = envGate();

const defaultReport = (violation: BudgetViolation): void => {
  const where =
    violation.detail === undefined ? "" : ` (${violation.detail})`;
  console.error(
    `[budget] ${violation.operation}${where} held the main thread ${violation.ms.toFixed(2)}ms, over the ${violation.budgetMs}ms budget`,
  );
};

let enabled = initial.enabled;
let throwOnViolation = initial.strict;
let envForced = initial.forced;
let budgetMs = MAIN_THREAD_BUDGET_MS;
let report = defaultReport;
let violations: Array<BudgetViolation> = [];
const listeners = new Set<(violation: BudgetViolation) => void>();

/**
 * Arm or disarm the assertion. Called once from main boot with the real dev
 * signal; tests call it directly. Unspecified fields keep their current value.
 *
 * An explicit `JUNTO_BUDGET` wins over `enabled` /
 * `throwOnViolation`: an operator who armed the assertion by hand must not
 * have it switched off again by whatever boot decided. `force` overrides that
 * for tests, which need a deterministic state whatever the environment holds.
 */
export const armMainThreadBudget = (
  options: MainThreadBudgetOptions & { readonly force?: boolean } = {},
): void => {
  const mayOverrideGate = options.force === true || !envForced;
  if (options.force === true) envForced = false;
  if (mayOverrideGate) {
    if (options.enabled !== undefined) enabled = options.enabled;
    if (options.throwOnViolation !== undefined) {
      throwOnViolation = options.throwOnViolation;
    }
  }
  if (options.budgetMs !== undefined) budgetMs = options.budgetMs;
  if (options.report !== undefined) report = options.report;
};

/** Restore the module to its environment-resolved state. Test seam. */
export const resetMainThreadBudget = (): void => {
  const gate = envGate();
  enabled = gate.enabled;
  throwOnViolation = gate.strict;
  envForced = gate.forced;
  budgetMs = MAIN_THREAD_BUDGET_MS;
  report = defaultReport;
  violations = [];
  listeners.clear();
  resetStatementTiming();
};

export const mainThreadBudgetArmed = (): boolean => enabled;

/** Violations retained since the last reset, oldest first. */
export const mainThreadBudgetViolations =
  (): ReadonlyArray<BudgetViolation> => [...violations];

export const onMainThreadBudgetViolation = (
  listener: (violation: BudgetViolation) => void,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Report an already-measured synchronous span. Use when the caller times the
 * span itself — the lane tick measures each key, so it reports rather than
 * re-wraps.
 *
 * Returns true when the span violated the budget.
 */
export const noteSyncSpan = (
  operation: string,
  ms: number,
  detail?: string,
): boolean => recordSpan(operation, ms, detail, true);

const recordSpan = (
  operation: string,
  ms: number,
  detail: string | undefined,
  allowThrow: boolean,
): boolean => {
  if (!enabled || ms <= budgetMs) return false;
  const violation: BudgetViolation = {
    operation,
    ms,
    budgetMs,
    at: new Date().toISOString(),
    ...(detail === undefined ? {} : { detail }),
  };
  if (violations.length >= MAX_RETAINED_VIOLATIONS) violations.shift();
  violations.push(violation);
  report(violation);
  for (const listener of listeners) {
    try {
      listener(violation);
    } catch (cause) {
      // A broken observer must never break the operation it is watching; it is logged instead.
      console.error("[budget] a violation observer failed", cause);
    }
  }
  if (throwOnViolation && allowThrow) {
    throw new MainThreadBudgetExceeded({
      operation,
      heldMs: ms,
      budgetMs,
      message: `[budget] ${operation} held the main thread ${ms.toFixed(2)}ms, over the ${budgetMs}ms budget`,
    });
  }
  return true;
};

// ── per-statement timing ──────────────────────────────────────────────────
//
// While the budget is armed, every SQL statement that runs under
// `withinBudget(..., sql)` is also folded into a bounded aggregate keyed by
// operation plus normalized SQL: how often it ran, how long it held the main
// thread in all, its longest run, and the rows it returned. The budget only
// names spans over 4 ms; this names the many short ones that add up (an idle
// app can spend hundreds of ms a second in statements that are each far under
// it). `startSqlTimingLog` writes the top of it to disk.

/** Keys kept; a statement past it is counted in one "other" row. */
export const MAX_STATEMENT_KEYS = 500;
const STATEMENT_SQL_CHARS = 100;
/** A host parameter inside an IN list: `?`, `?1`, `:name`, `@name`, `$name`. */
const IN_LIST = /\bIN\s*\(\s*(?:\?\d*|[:@$]\w+)(?:\s*,\s*(?:\?\d*|[:@$]\w+))*\s*\)/gi;

export type StatementTiming = {
  readonly operation: string;
  readonly sql: string;
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly rows: number;
};

type StatementStat = { operation: string; sql: string; count: number; totalMs: number; maxMs: number; rows: number };

const statementStats = new Map<string, StatementStat>();
let otherStatements: StatementStat | undefined;
/** Raw SQL to its key text: normalizing is a regex pass, and the same texts come back. */
const normalized = new Map<string, string>();
const MAX_NORMALIZED = 2_000;
let statementsSince = Date.now();

/** Whitespace collapsed, IN lists folded to `IN (?*)`, cut to 100 characters. */
export const normalizeStatementSql = (sql: string): string => {
  const known = normalized.get(sql);
  if (known !== undefined) return known;
  const text = sql.replace(/\s+/g, " ").trim().replace(IN_LIST, "IN (?*)").slice(0, STATEMENT_SQL_CHARS);
  if (normalized.size >= MAX_NORMALIZED) normalized.clear();
  normalized.set(sql, text);
  return text;
};

const noteStatement = (operation: string, sql: string, ms: number, rows: number): void => {
  const text = normalizeStatementSql(sql);
  const key = `${operation}\u0000${text}`;
  let stat = statementStats.get(key);
  if (stat === undefined) {
    if (statementStats.size >= MAX_STATEMENT_KEYS) {
      otherStatements ??= { operation: "(other)", sql: "(keys past the cap)", count: 0, totalMs: 0, maxMs: 0, rows: 0 };
      stat = otherStatements;
    } else {
      stat = { operation, sql: text, count: 0, totalMs: 0, maxMs: 0, rows: 0 };
      statementStats.set(key, stat);
    }
  }
  stat.count += 1;
  stat.totalMs += ms;
  if (ms > stat.maxMs) stat.maxMs = ms;
  stat.rows += rows;
};

/** The statements that held the main thread longest in all, longest first; the "other" row, when there is one, last. */
export const statementTimingTop = (limit = 20): ReadonlyArray<StatementTiming> => {
  const top = [...statementStats.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, limit);
  return otherStatements === undefined ? top : [...top, otherStatements];
};

/** How many distinct statements are kept, and when the aggregate began. */
export const statementTimingSummary = (): { readonly keys: number; readonly sinceMs: number; readonly otherCount: number } => ({
  keys: statementStats.size,
  sinceMs: statementsSince,
  otherCount: otherStatements?.count ?? 0,
});

export const resetStatementTiming = (): void => {
  statementStats.clear();
  otherStatements = undefined;
  normalized.clear();
  statementsSince = Date.now();
};

const rowsOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * Run a synchronous operation under the budget. Returns whatever it returns.
 *
 * The violation is reported AFTER the operation completes — nothing can
 * preempt synchronous JavaScript, so the assertion's job is to name the
 * offender, not to stop it mid-flight. In `strict` mode the throw happens
 * after the operation's own effects have landed, on purpose: a half-applied
 * mutation would be a far worse failure than a slow one.
 *
 * An operation that threw is reported but never converted into a budget
 * error: masking a real failure with a timing complaint would lose the one
 * fact worth keeping.
 * Set allowThrow=false for transaction control: a successful BEGIN or COMMIT
 * must not look failed to the resource owner after changing database state.
 * Pass `sql` for a statement: while armed it also feeds the per-statement
 * aggregate (`statementTimingTop`).
 */
export const withinBudget = <A>(
  operation: string,
  run: () => A,
  detail?: string,
  allowThrow = true,
  sql?: string,
): A => {
  if (!enabled) return run();
  const startedAt = performance.now();
  let failed = false;
  let value: A | undefined;
  try {
    value = run();
    return value;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const ms = performance.now() - startedAt;
    // Before the span is judged: a strict violation throws from recordSpan.
    if (sql !== undefined) noteStatement(operation, sql, ms, failed ? 0 : rowsOf(value));
    recordSpan(operation, ms, detail, !failed && allowThrow);
  }
};
