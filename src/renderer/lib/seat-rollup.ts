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
import { FEED_KIND_LABEL } from "@shared/operator-feed";
import { MemberSeverity } from "@shared/region-rollup";
import { compareUrgency, Level, levelOfSignal, type UrgencyLevel } from "@shared/wire/urgency";
import type { ThreadHealthTone } from "@shared/thread-health";
import { resolveActivityGlyph, type ActivitySpec } from "./activity";

export type SeatRollupSource = "signal" | "control" | "health";

/** Theme tone names; each resolves to a `--color-*` token. */
export type SeatRollupTone = "crimson" | "amber" | "cyan" | "green" | "violet" | "steel";

export type SeatRollup = {
  readonly source: SeatRollupSource;
  readonly tone: SeatRollupTone;
  /** Where the reading sits on the one urgency ladder: what worseRollup orders by. */
  readonly level: UrgencyLevel;
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
  work: "amber",
  notice: "steel",
};

/** Health hues: trouble and waiting amber (never crimson), good green, steady none. */
export const HEALTH_ROLLUP_TONE: Readonly<Record<ThreadHealthTone, SeatRollupTone | undefined>> = {
  trouble: "amber",
  waiting: "amber",
  steady: undefined,
  good: "green",
};

/**
 * What a control state reads as when nothing louder speaks: its hue and its
 * level on the ladder (a tier is a group of levels, so the control's own
 * level is named here: ready is a settled turn, working is work in flight).
 * Idle reads nothing; the card paints identity instead.
 */
const controlReading = (
  control: MemberSeverity,
): { readonly tone: SeatRollupTone; readonly level: UrgencyLevel } | undefined => {
  switch (control) {
    case MemberSeverity.group.blocked:
      return { tone: "crimson", level: Level.blocked };
    case MemberSeverity.group.attention:
      return { tone: "amber", level: Level.waiting };
    case MemberSeverity.group.escalated:
      return { tone: "amber", level: Level.escalated };
    case MemberSeverity.group.working:
      return { tone: "cyan", level: Level.working };
    case MemberSeverity.group.ready:
      return { tone: "green", level: Level.done };
    case MemberSeverity.group.idle:
      return undefined;
  }
};

/** The ladder level a health reading stands for: trouble degrades, waiting is a request, good is calm. */
const healthLevel = (tone: ThreadHealthTone): UrgencyLevel => {
  switch (tone) {
    case "trouble":
      return Level.degraded;
    case "waiting":
      return Level.escalated;
    case "steady":
    case "good":
      return Level.resting;
  }
};

/** A control state proves itself, by the ring's own glyph: a stop or a dialog the seat is held at. */
const isProven = (control: MemberSeverity): boolean =>
  control === MemberSeverity.group.blocked || control === MemberSeverity.group.attention;

export const seatRollup = (input: SeatRollupInput): SeatRollup | undefined => {
  if (input.signal !== undefined) {
    return {
      source: "signal",
      tone: SIGNAL_ROLLUP_TONE[input.signal],
      level: levelOfSignal(input.signal),
      stale: false,
      reason: FEED_KIND_LABEL[input.signal],
    };
  }
  const control = input.control;
  if (control !== undefined && isProven(control)) {
    const reading = controlReading(control)!;
    return {
      source: "control",
      tone: reading.tone,
      level: reading.level,
      stale: false,
      reason: FEED_KIND_LABEL[control as "blocked" | "attention"],
    };
  }
  const health = input.health;
  const healthTone = health?.health === undefined ? undefined : HEALTH_ROLLUP_TONE[health.health];
  if (health !== undefined && healthTone !== undefined) {
    return {
      source: "health",
      tone: healthTone,
      level: healthLevel(health.health!),
      stale: health.healthStale,
      reason: `AI reads ${health.line ?? health.health}`,
    };
  }
  const reading = control === undefined ? undefined : controlReading(control);
  if (control !== undefined && reading !== undefined) {
    return { source: "control", tone: reading.tone, level: reading.level, stale: false, reason: control };
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
  if (glyph === "halt") return MemberSeverity.group.blocked;
  if (glyph === "call") return MemberSeverity.group.attention;
  if (glyph === "work") return MemberSeverity.group.working;
  if (glyph === "done") return MemberSeverity.group.ready;
  return MemberSeverity.group.idle;
};

/**
 * The worse of two readings, for tinting a region by its worst member: the
 * more urgent level on the one ladder wins, and at the same level a current
 * reading outranks a faded one.
 */
export const worseRollup = (
  a: SeatRollup | undefined,
  b: SeatRollup | undefined,
): SeatRollup | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const byLevel = compareUrgency(a.level, b.level);
  if (byLevel !== 0) return byLevel < 0 ? a : b;
  // Same level: a current reading outranks a faded one.
  return a.stale && !b.stale ? b : a;
};
