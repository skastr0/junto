/**
 * Token pressure: how full a seat's live context is, and the point at which
 * Junto asks the agent to offboard.
 *
 * The operator sets one default threshold in Settings and may override it per
 * seat (`ether.terminal.tokenPressure`). A threshold is either absolute tokens
 * or a percent of the model's context window. Absolute works wherever the
 * harness writes its usage to disk; percent works only where the window is
 * known too, and a seat whose window is unknown says so instead of guessing.
 *
 * Pressure is read from the live context the harness last sent, so the
 * harness's own compaction lowers it by itself. Junto never hooks compaction;
 * offboarding is a handoff, not a compaction replacement.
 *
 * Everything here is pure: main reads the session files and runs the clock,
 * the renderer paints the same numbers.
 */
import { Schema } from "effect";
import type { HarnessId } from "./managed-terminal-templates";

// ── Thresholds ──────────────────────────────────────────────────────────────

export const TOKEN_PRESSURE_BOUNDS = {
  percent: { min: 10, max: 99 },
  tokens: { min: 10_000, max: 10_000_000 },
  graceMinutes: { min: 1, max: 240 },
} as const;

const int = (min: number, max: number) =>
  Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: min, maximum: max })));

export const TokenPressurePercent = Schema.Struct({
  kind: Schema.Literal("percent"),
  percent: int(TOKEN_PRESSURE_BOUNDS.percent.min, TOKEN_PRESSURE_BOUNDS.percent.max),
});

export const TokenPressureTokens = Schema.Struct({
  kind: Schema.Literal("tokens"),
  tokens: int(TOKEN_PRESSURE_BOUNDS.tokens.min, TOKEN_PRESSURE_BOUNDS.tokens.max),
});

export const TokenPressureThreshold = Schema.Union([TokenPressurePercent, TokenPressureTokens]);
export type TokenPressureThreshold = typeof TokenPressureThreshold.Type;

/** A seat's own choice: a threshold of its own, or never nudge this seat. */
export const SeatTokenPressure = Schema.Union([
  TokenPressurePercent,
  TokenPressureTokens,
  Schema.Struct({ kind: Schema.Literal("off") }),
]);
export type SeatTokenPressure = typeof SeatTokenPressure.Type;

/** Settings default. Absent on older rows; read through `tokenPressureSettings`. */
export const TokenPressureSettings = Schema.Struct({
  enabled: Schema.Boolean,
  threshold: TokenPressureThreshold,
  /** How long an agent has to offboard after the nudge before Junto rotates it. */
  graceMinutes: int(TOKEN_PRESSURE_BOUNDS.graceMinutes.min, TOKEN_PRESSURE_BOUNDS.graceMinutes.max),
});
export type TokenPressureSettings = typeof TokenPressureSettings.Type;

export const TokenPressurePatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  threshold: Schema.optionalKey(TokenPressureThreshold),
  graceMinutes: Schema.optionalKey(
    int(TOKEN_PRESSURE_BOUNDS.graceMinutes.min, TOKEN_PRESSURE_BOUNDS.graceMinutes.max),
  ),
});
export type TokenPressurePatch = typeof TokenPressurePatch.Type;

/**
 * 75% sits below every supported harness's own auto-compact point (Claude
 * Code compacts near 83% of its window, Codex near 90%), so the agent gets
 * the nudge while it still has room to write its handoff.
 */
export const defaultTokenPressure = (): TokenPressureSettings => ({
  enabled: true,
  threshold: { kind: "percent", percent: 75 },
  graceMinutes: 10,
});

export const tokenPressureSettings = (
  settings: { readonly tokenPressure?: TokenPressureSettings } | undefined,
): TokenPressureSettings => settings?.tokenPressure ?? defaultTokenPressure();

export const isSeatTokenPressure = Schema.is(SeatTokenPressure);

// ── Context windows ─────────────────────────────────────────────────────────

/** Where a window came from: the session file, harness config, or our table. */
export type ContextWindowSource = "session" | "config" | "table";

/**
 * Claude Code writes exact usage and the model id to its transcript, but not
 * the context window. This table is ours, not Anthropic's: every Claude model
 * runs with 200k unless it was started as a `[1m]` variant, which the seat's
 * launch model carries (the transcript drops the suffix).
 */
export const CLAUDE_DEFAULT_WINDOW = 200_000;
export const CLAUDE_1M_WINDOW = 1_000_000;

export const claudeContextWindow = (launchModel: string | undefined): number =>
  launchModel !== undefined && /\[1m\]\s*$/i.test(launchModel) ? CLAUDE_1M_WINDOW : CLAUDE_DEFAULT_WINDOW;

// ── Harness support ─────────────────────────────────────────────────────────

/**
 * What Junto can read for each harness, from files the harness itself writes.
 * A harness absent here has no reader: its seats say pressure is not
 * available, and neither threshold kind applies to them.
 */
export type HarnessContextSupport = {
  /** Where the context window comes from; absent means unknown. */
  readonly window?: ContextWindowSource;
};

export const HARNESS_CONTEXT_SUPPORT: Readonly<Partial<Record<HarnessId, HarnessContextSupport>>> = {
  claude: { window: "table" },
  codex: { window: "session" },
};

export const harnessReadsContext = (harness: string | undefined): boolean =>
  harness !== undefined && Object.hasOwn(HARNESS_CONTEXT_SUPPORT, harness);

// ── Readings and limits ─────────────────────────────────────────────────────

/** One reading of a session's live context, from its harness's own file. */
export type ContextReading = {
  /** Tokens the harness sent as context on its latest request. */
  readonly usedTokens: number;
  readonly window?: number;
  readonly windowSource?: ContextWindowSource;
  readonly model?: string;
  /** Record time (ms) when the file has one, else when it was read. */
  readonly at: number;
};

export type ResolvedLimit =
  | { readonly ok: true; readonly limitTokens: number }
  | { readonly ok: false; readonly reason: "no-window" };

/** Threshold → a token count, or why it cannot be one for this reading. */
export const resolveLimit = (
  threshold: TokenPressureThreshold,
  window: number | undefined,
): ResolvedLimit => {
  if (threshold.kind === "tokens") return { ok: true, limitTokens: threshold.tokens };
  if (window === undefined || !(window > 0)) return { ok: false, reason: "no-window" };
  return { ok: true, limitTokens: Math.floor((window * threshold.percent) / 100) };
};

/** The seat's own choice wins; otherwise the default, when it is on. */
export const effectiveThreshold = (
  seat: SeatTokenPressure | undefined,
  defaults: TokenPressureSettings,
): { readonly threshold: TokenPressureThreshold; readonly from: "seat" | "default" } | undefined => {
  if (seat !== undefined) return seat.kind === "off" ? undefined : { threshold: seat, from: "seat" };
  return defaults.enabled ? { threshold: defaults.threshold, from: "default" } : undefined;
};

// ── Crossing ────────────────────────────────────────────────────────────────

/**
 * A crossing re-arms only once the context falls clearly back under the
 * limit, so a reading that wobbles around it is still one crossing.
 */
export const REARM_FRACTION = 0.9;

export type PressurePhase =
  /** Under the limit (or never over it). */
  | { readonly phase: "below" }
  /** Over the limit, waiting for the seat to finish its turn. */
  | { readonly phase: "over"; readonly since: number }
  /** Told to offboard; the grace clock runs from `at`. */
  | { readonly phase: "nudged"; readonly at: number }
  /** Grace ran out and rotation was asked for. */
  | { readonly phase: "rotating"; readonly at: number };

export type PressureAction = "nudge" | "rotate";

export type PressureStep = {
  readonly next: PressurePhase;
  readonly action?: PressureAction;
};

/**
 * One tick for one session. Nudges once per crossing and only between turns;
 * rotates once, also between turns, when the grace period has passed without
 * the pressure going away. (An agent that runs `junto offboard` is rotated at
 * its next idle by the monitor, whatever its pressure.) A new session is a fresh `below` (the caller keys
 * state by session), so an agent that offboarded is never chased.
 */
export const stepPressure = (
  current: PressurePhase,
  input: {
    readonly usedTokens: number;
    readonly limitTokens: number;
    readonly idle: boolean;
    readonly now: number;
    readonly graceMs: number;
  },
): PressureStep => {
  const { usedTokens, limitTokens, idle, now, graceMs } = input;
  if (usedTokens < limitTokens * REARM_FRACTION) return { next: { phase: "below" } };
  switch (current.phase) {
    case "below": {
      if (usedTokens < limitTokens) return { next: current };
      return idle ? { next: { phase: "nudged", at: now }, action: "nudge" } : { next: { phase: "over", since: now } };
    }
    case "over":
      return idle ? { next: { phase: "nudged", at: now }, action: "nudge" } : { next: current };
    case "nudged":
      return idle && now - current.at >= graceMs
        ? { next: { phase: "rotating", at: now }, action: "rotate" }
        : { next: current };
    case "rotating":
      return { next: current };
  }
};

// ── Snapshot (main → renderer) ──────────────────────────────────────────────

export type SeatPressureSnapshot = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly harness?: string;
  /**
   * reading: numbers below are live. unsupported: this harness writes no
   * usage Junto can read. no-session: the seat has not started a session
   * Junto can find yet.
   */
  readonly status: "reading" | "unsupported" | "no-session";
  readonly usedTokens?: number;
  readonly window?: number;
  readonly windowSource?: ContextWindowSource;
  /** Absent when no threshold applies (off, or percent without a window). */
  readonly limitTokens?: number;
  readonly thresholdFrom?: "seat" | "default";
  /** Set when the threshold is percent and the window is unknown. */
  readonly limitBlocked?: "no-window";
  readonly phase: PressurePhase["phase"];
  /** Rotation was due but could not happen: not on this build, or it failed. */
  readonly rotation?: "unavailable" | "failed";
  readonly at: number;
};

/** Main → renderer: snapshots that changed, and seats no longer watched. */
export type TokenPressureChange = {
  readonly upserts: ReadonlyArray<SeatPressureSnapshot>;
  /** `canvasName::nodeId` keys whose snapshot is gone (seat stopped or left). */
  readonly removed: ReadonlyArray<string>;
};

export const pressureKey = (canvasName: string, nodeId: string): string => `${canvasName}::${nodeId}`;

// ── Copy ────────────────────────────────────────────────────────────────────

/** 142000 → "142k", 1000000 → "1M", 950 → "950". */
export const formatTokens = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
};

/** "142k of 200k": used against the limit, or the window when no limit applies. */
export const pressureGaugeLabel = (snapshot: SeatPressureSnapshot): string | undefined => {
  if (snapshot.status !== "reading" || snapshot.usedTokens === undefined) return undefined;
  const of = snapshot.limitTokens ?? snapshot.window;
  return of === undefined ? `${formatTokens(snapshot.usedTokens)} in context` : `${formatTokens(snapshot.usedTokens)} of ${formatTokens(of)}`;
};

export const describeThreshold = (threshold: TokenPressureThreshold): string =>
  threshold.kind === "percent"
    ? `${threshold.percent}% of the context window`
    : `${formatTokens(threshold.tokens)} tokens`;

/**
 * The mail an agent reads when it crosses. Plain and short: what happened,
 * what to do, and that Junto will do it for them if they do not.
 */
export const composeOffboardNudge = (input: {
  readonly usedTokens: number;
  readonly limitTokens: number;
  readonly graceMinutes: number;
}): string =>
  [
    `Your context is at ${formatTokens(input.usedTokens)} tokens, past this seat's limit of ${formatTokens(input.limitTokens)}.`,
    "Finish the step you are on, write down where you are and what is left, then offboard so a fresh session can pick it up.",
    `If you have not offboarded in ${input.graceMinutes} minute${input.graceMinutes === 1 ? "" : "s"}, Junto will rotate this seat for you.`,
  ].join("\n");
