/**
 * Operator offboard: cutting a seat's session from outside it.
 *
 * Seats are permanent and sessions grow. A harness keeps a session cheap to
 * continue only while its provider cache is warm; a seat that sat still past
 * that window pays for its whole history again on its next turn. So once a
 * seat has been still for its cache window, Junto ends its session by itself,
 * with no turn, no notes and no tokens, and the next message starts a fresh
 * one. The cache window is the one rule: one for every harness, and one per
 * harness where it differs. It is declared and set, never inferred. Each
 * machine keeps its own, because a seat's session is cut where it runs.
 *
 * The operator can also cut sessions two ways, on one seat or many:
 *
 *   ask   the seat's agent is asked to offboard (it writes notes, and a
 *         continuation). Costs one turn: right while the cache is warm.
 *   now   Junto ends the session itself. No turn, no notes, no tokens. Only
 *         for a seat that is idle, not running or resting. Right once the cache
 *         window has passed.
 *
 * This module is the contract: the rules and their checks, and the shapes of
 * the one operation the buttons, the overseer CLI and the automatic cut all
 * go through. Pure, no Node imports (renderer and CLI safe).
 */
import { Schema } from "effect";
import { HARNESS_IDS, type HarnessId } from "./managed-terminal-templates";
import type { OffboardMode } from "./seat-sessions";

// ── Rules ──────────────────────────────────────────────────────────────────

/** A cache window is whole minutes, from one minute to seven days. */
export const OFFBOARD_MINUTES_MIN = 1;
export const OFFBOARD_MINUTES_MAX = 7 * 24 * 60;

/** A cache window: whole minutes, from one minute to seven days. */
export const CacheWindowMinutes = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(OFFBOARD_MINUTES_MIN),
    Schema.isLessThanOrEqualTo(OFFBOARD_MINUTES_MAX),
  ),
);

/**
 * When a session is worth cutting by itself: it worked for `workMinutes`, or
 * its transcript has grown to about `tokens`. Either is enough. A session that
 * has not worked at all never qualifies, and size does not count when the
 * transcript cannot be found. The cut never recycles an empty or tiny
 * session, whose cold resume is cheap anyway. An internal guard, not a
 * setting; the operator's own buttons are not held to it.
 */
export type OffboardWorth = {
  /** Time the seat spent working in the session, in whole minutes. */
  readonly workMinutes: number;
  /** The session's transcript on disk, as a token estimate. */
  readonly tokens: number;
};
export const OFFBOARD_WORTH: OffboardWorth = { workMinutes: 30, tokens: 200_000 };

/**
 * What one harness sets differently from the machine: its own cache window.
 * Absent on an override saved before the cache window was the one rule; such
 * an override sets nothing.
 */
export const OffboardHarnessOverride = Schema.Struct({
  cacheWindowMinutes: Schema.optionalKey(CacheWindowMinutes),
});
export type OffboardHarnessOverride = typeof OffboardHarnessOverride.Type;

/**
 * A machine's offboard rules: its cache window, with an override per harness
 * (each harness has its own cache lifetime). Override keys are harness ids;
 * an unknown key is ignored when the rules are applied. Rules saved before
 * this shape also carry `auto`, `nudge` and `worth`; the stored row decodes
 * dropping them, and the next save writes it clean.
 */
export const OffboardRules = Schema.Struct({
  /** How long a still seat stays cheap to give a turn. */
  cacheWindowMinutes: CacheWindowMinutes,
  harness: Schema.optionalKey(Schema.Record(Schema.String, OffboardHarnessOverride)),
});
export type OffboardRules = typeof OffboardRules.Type;

/** The effective rules for one seat: its harness's cache window, and the worth guard. */
export type OffboardRuleSet = {
  readonly cacheWindowMinutes: number;
  readonly worth: OffboardWorth;
};

/**
 * A partial change. A harness key set to `null` removes that override, so the
 * harness follows the machine's window again.
 */
export const OffboardRulesPatch = Schema.Struct({
  cacheWindowMinutes: Schema.optionalKey(CacheWindowMinutes),
  harness: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(Schema.Struct({ cacheWindowMinutes: CacheWindowMinutes }))),
  ),
});
export type OffboardRulesPatch = typeof OffboardRulesPatch.Type;

export const DEFAULT_CACHE_WINDOW_MINUTES = 60;

export const defaultOffboardRules = (): OffboardRules => ({
  cacheWindowMinutes: DEFAULT_CACHE_WINDOW_MINUTES,
});

const isHarness = (key: string): key is HarnessId =>
  (HARNESS_IDS as ReadonlyArray<string>).includes(key);

/** The rules in force for a seat on this harness. */
export const offboardRulesFor = (
  rules: OffboardRules,
  harness: string | undefined,
): OffboardRuleSet => ({
  cacheWindowMinutes:
    (harness !== undefined && isHarness(harness) ? rules.harness?.[harness]?.cacheWindowMinutes : undefined) ??
    rules.cacheWindowMinutes,
  worth: OFFBOARD_WORTH,
});

/** Apply a partial change. Pure; validate the result with `offboardRulesProblem`. */
export const applyOffboardRulesPatch = (
  rules: OffboardRules,
  patch: OffboardRulesPatch,
): OffboardRules => {
  const harness: Record<string, OffboardHarnessOverride> = {};
  // An override that sets nothing is not kept.
  for (const [key, over] of Object.entries(rules.harness ?? {})) {
    if (over.cacheWindowMinutes !== undefined) harness[key] = { cacheWindowMinutes: over.cacheWindowMinutes };
  }
  for (const [key, over] of Object.entries(patch.harness ?? {})) {
    if (over === null) delete harness[key];
    else harness[key] = { cacheWindowMinutes: over.cacheWindowMinutes };
  }
  return {
    cacheWindowMinutes: patch.cacheWindowMinutes ?? rules.cacheWindowMinutes,
    ...(Object.keys(harness).length > 0 ? { harness } : {}),
  };
};

const minutesProblem = (label: string, minutes: number): string | undefined =>
  Number.isInteger(minutes) && minutes >= OFFBOARD_MINUTES_MIN && minutes <= OFFBOARD_MINUTES_MAX
    ? undefined
    : `${label} must be a whole number of minutes, from ${String(OFFBOARD_MINUTES_MIN)} to ${String(OFFBOARD_MINUTES_MAX)}.`;

/**
 * Why these rules cannot be saved, in plain words, or undefined when they
 * can. Checked for the machine and for every harness with an override.
 */
export const offboardRulesProblem = (rules: OffboardRules): string | undefined => {
  const base = minutesProblem("The cache window", rules.cacheWindowMinutes);
  if (base) return base;
  for (const [key, over] of Object.entries(rules.harness ?? {})) {
    if (!isHarness(key) || over.cacheWindowMinutes === undefined) continue;
    const problem = minutesProblem(`The cache window for ${key}`, over.cacheWindowMinutes);
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
  /**
   * Time the seat has spent working in its current session, in whole
   * minutes. Main always sends it.
   */
  readonly workMinutes?: number;
  /** The session's transcript as a token estimate. Absent when it cannot be located. */
  readonly sessionTokens?: number;
  /**
   * The session has done enough for the automatic rules to act on it. The
   * buttons are not held to this; it tells the operator what the rules see.
   * Main always sends it.
   */
  readonly worthCutting?: boolean;
};

/**
 * Has this session done enough to be worth cutting by itself? It must have
 * worked at all; then either measure past its threshold is enough. An
 * unknown size simply does not count.
 */
export const sessionWorthCutting = (
  worth: OffboardWorth,
  session: { readonly workMs: number; readonly tokens?: number },
): boolean =>
  session.workMs > 0 &&
  (session.workMs >= worth.workMinutes * 60_000 ||
    (session.tokens !== undefined && session.tokens >= worth.tokens));

/** The sentence for each refusal. One place, so every surface says the same. */
export const OFFBOARD_REFUSAL_REASON: Readonly<Record<OffboardRefusalCode, string>> = {
  working:
    "This seat is working. Offboard now only closes a seat that is idle, not running or resting.",
  attention:
    "This seat is waiting on you. Offboard now only closes a seat that is idle, not running or resting.",
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
