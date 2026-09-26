/**
 * One seat, one status tone: the order every seat surface reads in.
 *
 *   1. the seat's own declared signal (blocked, escalate, feedback);
 *   2. proven control attention (a dialog or a stoppage the engine proved);
 *   3. Jev's thread-health reading, both ends of the spectrum;
 *   4. plain control state (working, ready, parked), or nothing when idle.
 *
 * It is the seat line's order (`AgentSeatView`) and the ring's: the ring lets
 * call and halt outrank a reading and a declared signal outrank the waiting
 * glow. Anything that paints a seat with ONE colour (the minimap, a region
 * tint) reads this function, so it can never disagree with the seat.
 *
 * Pure: callers supply the three inputs from their stores. The health input is
 * the ring's own mark (`threadHealthMark`), which has already hidden a waiting
 * reading and muted a good one while a declared blocked or escalate is open.
 */

import type { AgentSignalKind } from "@shared/agent-signals";
import type { MemberSeverity } from "@shared/region-rollup";
import type { ThreadHealthTone } from "@shared/thread-health";
import { resolveActivityGlyph, type ActivitySpec } from "./activity";

export type SeatRollupSource = "signal" | "control" | "health";

/** Theme tone names; each resolves to a `--color-*` token. */
export type SeatRollupTone = "crimson" | "amber" | "cyan" | "green" | "violet" | "steel";

export type SeatRollup = {
  readonly source: SeatRollupSource;
  readonly tone: SeatRollupTone;
  /** A faded reading: only health ages, a declared signal is current until closed. */
  readonly stale: boolean;
  /** Short words for a tooltip or aria text. */
  readonly reason: string;
};

export type SeatRollupInput = {
  readonly signal?: AgentSignalKind | undefined;
  readonly control?: MemberSeverity | undefined;
  readonly health?:
    | {
        readonly health: ThreadHealthTone | undefined;
        readonly healthStale: boolean;
        readonly line: string | undefined;
      }
    | undefined;
};

/** Declared signal hues, the same as the ring's flag and the sidebar chips. */
export const SIGNAL_ROLLUP_TONE: Readonly<Record<AgentSignalKind, SeatRollupTone>> = {
  blocked: "crimson",
  escalate: "amber",
  feedback: "cyan",
};

/** Health hues: trouble and waiting amber (never crimson), good green, steady none. */
export const HEALTH_ROLLUP_TONE: Readonly<Record<ThreadHealthTone, SeatRollupTone | undefined>> = {
  trouble: "amber",
  waiting: "amber",
  steady: undefined,
  good: "green",
};

/** Control state hues when nothing louder speaks; idle paints identity instead. */
export const CONTROL_ROLLUP_TONE: Readonly<Record<MemberSeverity, SeatRollupTone | undefined>> = {
  blocked: "crimson",
  attention: "amber",
  working: "cyan",
  ready: "green",
  idle: undefined,
};

const SIGNAL_REASON: Readonly<Record<AgentSignalKind, string>> = {
  blocked: "blocked",
  escalate: "wants you",
  feedback: "ready for review",
};

const PROVEN: ReadonlySet<MemberSeverity> = new Set(["blocked", "attention"]);

export const seatRollup = (input: SeatRollupInput): SeatRollup | undefined => {
  if (input.signal !== undefined) {
    return {
      source: "signal",
      tone: SIGNAL_ROLLUP_TONE[input.signal],
      stale: false,
      reason: SIGNAL_REASON[input.signal],
    };
  }
  const control = input.control;
  if (control !== undefined && PROVEN.has(control)) {
    return { source: "control", tone: CONTROL_ROLLUP_TONE[control]!, stale: false, reason: control };
  }
  const health = input.health;
  const healthTone = health?.health === undefined ? undefined : HEALTH_ROLLUP_TONE[health.health];
  if (health !== undefined && healthTone !== undefined) {
    return {
      source: "health",
      tone: healthTone,
      stale: health.healthStale,
      reason: `AI reads ${health.line ?? health.health}`,
    };
  }
  const controlTone = control === undefined ? undefined : CONTROL_ROLLUP_TONE[control];
  if (control !== undefined && controlTone !== undefined) {
    return { source: "control", tone: controlTone, stale: false, reason: control };
  }
  return undefined;
};

/**
 * The seat card's control state in the rollup's vocabulary. The card derives
 * an ActivitySpec; the region rollup derives a MemberSeverity; this is the one
 * bridge, through the same glyph the ring draws (call and halt are proven), so
 * the seat line can read `seatRollup` too.
 */
export const controlFromActivity = (activity: ActivitySpec): MemberSeverity => {
  const glyph = resolveActivityGlyph(activity.mode, activity.tone, activity.glyph);
  if (glyph === "halt") return "blocked";
  if (glyph === "call") return "attention";
  if (glyph === "work") return "working";
  if (glyph === "done") return "ready";
  return "idle";
};

/**
 * Worst first, for tinting a region by its worst member: a declared blocker,
 * then anything amber, then work, then good news, then parked.
 */
const TONE_RANK: Readonly<Record<SeatRollupTone, number>> = {
  crimson: 0,
  amber: 1,
  cyan: 2,
  green: 3,
  violet: 4,
  steel: 5,
};

export const worseRollup = (
  a: SeatRollup | undefined,
  b: SeatRollup | undefined,
): SeatRollup | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (TONE_RANK[a.tone] !== TONE_RANK[b.tone]) return TONE_RANK[a.tone] < TONE_RANK[b.tone] ? a : b;
  // Same hue: a current reading outranks a faded one.
  return a.stale && !b.stale ? b : a;
};
