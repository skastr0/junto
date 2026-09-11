/**
 * The 4 ms main-thread budget, asserted at the source.
 *
 * THE INVARIANT: no synchronous operation on the main thread may exceed 4 ms,
 * at any factory size. The main process owns SQLite, the PTYs, and every IPC
 * reply, so a synchronous block there is felt directly as input lag.
 *
 * WHY AN ASSERTION AND NOT ONLY A PROBE. `observability/perf-probe.ts` answers
 * "what blocked the loop, historically" from timer lateness — after the fact,
 * off a 50 ms threshold, in a log file someone reads weeks later. This module
 * answers a different question at the moment it happens: "this operation, this
 * call, spent more than the budget." It names the operation instead of the
 * window, so a regression is attributed to the code that caused it while that
 * code is still on screen. The two are complementary, not redundant.
 *
 * WHEN IT IS ARMED. Development only, and by default off everywhere else. The
 * gate resolves once at module load:
 *
 *   VELLUM_COMMAND_BUDGET=0 | off      forced off
 *   VELLUM_COMMAND_BUDGET=1 | on       forced on, report only
 *   VELLUM_COMMAND_BUDGET=strict       forced on, and a violation THROWS
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
  const raw = process.env.VELLUM_COMMAND_BUDGET?.trim().toLowerCase();
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
 * An explicit `VELLUM_COMMAND_BUDGET` wins over `enabled` /
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
};

export const mainThreadBudgetArmed = (): boolean => enabled;

export const mainThreadBudgetMs = (): number => budgetMs;

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
    } catch {
      // A broken observer must never break the operation it is watching.
    }
  }
  if (throwOnViolation && allowThrow) {
    throw new Error(
      `[budget] ${operation} held the main thread ${ms.toFixed(2)}ms, over the ${budgetMs}ms budget`,
    );
  }
  return true;
};

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
 */
export const withinBudget = <A>(
  operation: string,
  run: () => A,
  detail?: string,
): A => {
  if (!enabled) return run();
  const startedAt = performance.now();
  let failed = false;
  try {
    return run();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    recordSpan(operation, performance.now() - startedAt, detail, !failed);
  }
};
