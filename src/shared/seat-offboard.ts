/**
 * Operator offboard: cutting a seat's session from outside it.
 *
 * Seats are permanent and sessions grow. A harness keeps a session cheap to
 * continue only while its provider cache is warm; a seat that sat still past
 * that window pays for its whole history again on its next turn. So the
 * operator can cut sessions two ways, on one seat or many:
 *
 *   ask   the seat's agent is asked to offboard (it writes notes, and a
 *         continuation). Costs one turn: right while the cache is warm.
 *   now   Junto ends the session itself. No turn, no notes, no tokens. Only
 *         for a seat that is idle, offline or resting. Right once the cache
 *         window has passed.
 *
 * Two rules do the same by themselves: the idle nudge asks, the auto
 * offboard ends. The cache window is the rule behind both, which is why the
 * nudge must fire inside it and the auto offboard at or after it.
 *
 * This module is the contract: the rules and their checks, and the shapes of
 * the one operation the buttons, the overseer CLI and the automatic rules all
 * go through. Pure, no Node imports (renderer and CLI safe).
 */
import { Schema } from "effect";
import { HARNESS_IDS, type HarnessId } from "./managed-terminal-templates";
import type { OffboardMode } from "./seat-sessions";

// ── Rules ──────────────────────────────────────────────────────────────────

/** Rule intervals are whole minutes, from one minute to seven days. */
export const OFFBOARD_MINUTES_MIN = 1;
export const OFFBOARD_MINUTES_MAX = 7 * 24 * 60;

const Minutes = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(OFFBOARD_MINUTES_MIN),
    Schema.isLessThanOrEqualTo(OFFBOARD_MINUTES_MAX),
  ),
);

const OffboardRule = Schema.Struct({
  enabled: Schema.Boolean,
  minutes: Minutes,
});
const OffboardRulePatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  minutes: Schema.optionalKey(Minutes),
});

/** What one harness may set differently from the installation. */
export const OffboardHarnessOverride = Schema.Struct({
  cacheWindowMinutes: Schema.optionalKey(Minutes),
  auto: Schema.optionalKey(OffboardRulePatch),
  nudge: Schema.optionalKey(OffboardRulePatch),
});
export type OffboardHarnessOverride = typeof OffboardHarnessOverride.Type;

/**
 * The installation's offboard rules, with optional overrides per harness
 * (each harness has its own cache lifetime). Override keys are harness ids;
 * an unknown key is ignored when the rules are applied.
 */
export const OffboardRules = Schema.Struct({
  /** How long a still seat stays cheap to give a turn. */
  cacheWindowMinutes: Minutes,
  /** End a motionless seat's session, with no turn and no notes. */
  auto: OffboardRule,
  /** Ask a motionless seat's agent to offboard and continue. */
  nudge: OffboardRule,
  harness: Schema.optionalKey(Schema.Record(Schema.String, OffboardHarnessOverride)),
});
export type OffboardRules = typeof OffboardRules.Type;

/** The effective rules for one seat: no overrides left to apply. */
export type OffboardRuleSet = Omit<OffboardRules, "harness">;

/**
 * A partial change. A harness key set to `null` removes that override; an
 * override given replaces the fields it names and keeps the rest.
 */
export const OffboardRulesPatch = Schema.Struct({
  cacheWindowMinutes: Schema.optionalKey(Minutes),
  auto: Schema.optionalKey(OffboardRulePatch),
  nudge: Schema.optionalKey(OffboardRulePatch),
  harness: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(OffboardHarnessOverride)),
  ),
});
export type OffboardRulesPatch = typeof OffboardRulesPatch.Type;

/**
 * The defaults follow the cache window: ask while a turn is cheap (40 min,
 * off until the operator turns it on), end the session once it is not (2 h).
 */
export const DEFAULT_OFFBOARD_RULES: OffboardRules = {
  cacheWindowMinutes: 60,
  auto: { enabled: true, minutes: 120 },
  nudge: { enabled: false, minutes: 40 },
};

export const defaultOffboardRules = (): OffboardRules => ({
  cacheWindowMinutes: DEFAULT_OFFBOARD_RULES.cacheWindowMinutes,
  auto: { ...DEFAULT_OFFBOARD_RULES.auto },
  nudge: { ...DEFAULT_OFFBOARD_RULES.nudge },
});

const isHarness = (key: string): key is HarnessId =>
  (HARNESS_IDS as ReadonlyArray<string>).includes(key);

const overlay = (base: OffboardRuleSet, over: OffboardHarnessOverride | undefined): OffboardRuleSet =>
  over === undefined
    ? base
    : {
        cacheWindowMinutes: over.cacheWindowMinutes ?? base.cacheWindowMinutes,
        auto: { ...base.auto, ...over.auto },
        nudge: { ...base.nudge, ...over.nudge },
      };

/** The rules in force for a seat on this harness. */
export const offboardRulesFor = (
  rules: OffboardRules,
  harness: string | undefined,
): OffboardRuleSet => {
  const base: OffboardRuleSet = {
    cacheWindowMinutes: rules.cacheWindowMinutes,
    auto: rules.auto,
    nudge: rules.nudge,
  };
  return harness !== undefined && isHarness(harness)
    ? overlay(base, rules.harness?.[harness])
    : base;
};

const isEmptyOverride = (over: OffboardHarnessOverride): boolean =>
  over.cacheWindowMinutes === undefined &&
  (over.auto === undefined || Object.keys(over.auto).length === 0) &&
  (over.nudge === undefined || Object.keys(over.nudge).length === 0);

/** Apply a partial change. Pure; validate the result with `offboardRulesProblem`. */
export const applyOffboardRulesPatch = (
  rules: OffboardRules,
  patch: OffboardRulesPatch,
): OffboardRules => {
  const harness: Record<string, OffboardHarnessOverride> = { ...rules.harness };
  for (const [key, over] of Object.entries(patch.harness ?? {})) {
    if (over === null) {
      delete harness[key];
      continue;
    }
    const prior = harness[key] ?? {};
    const next: OffboardHarnessOverride = {
      ...(over.cacheWindowMinutes !== undefined || prior.cacheWindowMinutes !== undefined
        ? { cacheWindowMinutes: over.cacheWindowMinutes ?? prior.cacheWindowMinutes! }
        : {}),
      ...(over.auto !== undefined || prior.auto !== undefined
        ? { auto: { ...prior.auto, ...over.auto } }
        : {}),
      ...(over.nudge !== undefined || prior.nudge !== undefined
        ? { nudge: { ...prior.nudge, ...over.nudge } }
        : {}),
    };
    if (isEmptyOverride(next)) delete harness[key];
    else harness[key] = next;
  }
  return {
    cacheWindowMinutes: patch.cacheWindowMinutes ?? rules.cacheWindowMinutes,
    auto: { ...rules.auto, ...patch.auto },
    nudge: { ...rules.nudge, ...patch.nudge },
    ...(Object.keys(harness).length > 0 ? { harness } : {}),
  };
};

const minutesProblem = (label: string, minutes: number): string | undefined =>
  Number.isInteger(minutes) && minutes >= OFFBOARD_MINUTES_MIN && minutes <= OFFBOARD_MINUTES_MAX
    ? undefined
    : `${label} must be a whole number of minutes, from ${String(OFFBOARD_MINUTES_MIN)} to ${String(OFFBOARD_MINUTES_MAX)}.`;

const setProblem = (set: OffboardRuleSet, who: string): string | undefined => {
  const window = set.cacheWindowMinutes;
  return (
    minutesProblem(`The cache window${who}`, window) ??
    minutesProblem(`The idle nudge${who}`, set.nudge.minutes) ??
    minutesProblem(`The auto offboard${who}`, set.auto.minutes) ??
    // A rule that is off is judged too, so turning it on later cannot break.
    (set.nudge.minutes >= window
      ? `The idle nudge${who} must come before the cache window (${String(window)} min): it asks the agent for a turn, which is only cheap while the cache is warm.`
      : undefined) ??
    (set.auto.minutes < window
      ? `The auto offboard${who} must come at or after the cache window (${String(window)} min): before that the session is still cheap to continue.`
      : undefined)
  );
};

/**
 * Why these rules cannot be saved, in plain words, or undefined when they
 * can. Checked for the installation and for every harness with an override.
 */
export const offboardRulesProblem = (rules: OffboardRules): string | undefined => {
  const base = setProblem(offboardRulesFor(rules, undefined), "");
  if (base) return base;
  for (const key of Object.keys(rules.harness ?? {})) {
    if (!isHarness(key)) continue;
    const problem = setProblem(offboardRulesFor(rules, key), ` for ${key}`);
    if (problem) return problem;
  }
  return undefined;
};

// ── The operation ──────────────────────────────────────────────────────────

/** Who ended a session from outside it. An agent's own offboard is not one of these. */
export const OFFBOARD_BY = ["operator", "overseer", "automatic"] as const;
export type OffboardBy = (typeof OFFBOARD_BY)[number];

export const SEAT_OFFBOARD_ACTIONS = ["ask", "now"] as const;
export type SeatOffboardAction = (typeof SEAT_OFFBOARD_ACTIONS)[number];

/** Most seats one call may name. */
export const SEAT_OFFBOARD_MAX_SEATS = 200;

export type SeatOffboardRunInput = {
  readonly canvasName: string;
  /** Canvas node ids of agent seats. Rows come back in this order. */
  readonly seatIds: ReadonlyArray<string>;
  readonly action: SeatOffboardAction;
  /** For `ask` only. Default `continue`. */
  readonly mode?: OffboardMode;
};

/**
 * Why a seat was not offboarded. A code to count by; the row's `reason` is
 * the sentence to show.
 *
 *   working      a turn is running (offboard now never cuts a turn)
 *   attention    a dialog is up or a turn has stalled: the seat needs the operator
 *   closing      an offboard is already under way for this seat
 *   not-a-seat   no agent seat with that id on that canvas
 *   not-local    the seat runs on another installation
 *   undelivered  the ask could not be delivered
 *   failed       the close did not go through
 */
export const OFFBOARD_REFUSAL_CODES = [
  "working",
  "attention",
  "closing",
  "not-a-seat",
  "not-local",
  "undelivered",
  "failed",
] as const;
export type OffboardRefusalCode = (typeof OFFBOARD_REFUSAL_CODES)[number];

export type SeatOffboardRunRow =
  | {
      readonly seatId: string;
      readonly title?: string;
      readonly ok: true;
      readonly action: SeatOffboardAction;
      readonly outcome: "asked" | "closed";
      /** The seat had sat still past its harness's cache window. */
      readonly pastWindow: boolean;
    }
  | {
      readonly seatId: string;
      readonly title?: string;
      readonly ok: false;
      readonly code: OffboardRefusalCode;
      /** A full sentence for the operator, shown as is. */
      readonly reason: string;
      readonly pastWindow?: boolean;
    };

export type SeatOffboardRunResult = {
  readonly results: ReadonlyArray<SeatOffboardRunRow>;
  readonly closed: number;
  readonly asked: number;
  readonly refused: number;
};

/** What a seat's offboard buttons should say before they are pressed. */
export type SeatOffboardStatus = {
  readonly seatId: string;
  readonly now:
    | { readonly allowed: true }
    | { readonly allowed: false; readonly code: OffboardRefusalCode; readonly reason: string };
  /** When the seat last moved (epoch ms). Absent while it is not motionless. */
  readonly motionlessSince?: number;
  /** Whole minutes the seat has sat still. Null while it is not motionless. */
  readonly idleMinutes: number | null;
  readonly pastWindow: boolean;
  /** `now` once the cache window has passed, `ask` while a turn is still cheap. */
  readonly preferred: SeatOffboardAction;
};

/** The sentence for each refusal. One place, so every surface says the same. */
export const OFFBOARD_REFUSAL_REASON: Readonly<Record<OffboardRefusalCode, string>> = {
  working:
    "This seat is working. Offboard now only closes a seat that is idle, offline or resting.",
  attention:
    "This seat is waiting on you. Offboard now only closes a seat that is idle, offline or resting.",
  closing: "This seat is already offboarding.",
  "not-a-seat": "Junto could not find that seat.",
  "not-local": "This seat runs on another installation.",
  undelivered: "Junto could not send the offboard prompt.",
  failed: "The session could not be closed.",
};

/** Count the rows of a run. */
export const summarizeOffboardRun = (
  results: ReadonlyArray<SeatOffboardRunRow>,
): SeatOffboardRunResult => ({
  results,
  closed: results.filter((row) => row.ok && row.outcome === "closed").length,
  asked: results.filter((row) => row.ok && row.outcome === "asked").length,
  refused: results.filter((row) => !row.ok).length,
});

/** Whole minutes between two instants, never negative. */
export const wholeMinutesBetween = (from: number, to: number): number =>
  Math.max(0, Math.floor((to - from) / 60_000));
