/**
 * Motion on wires, as pure functions of the wall clock: where a flow track's
 * marks sit and how a derives track breathes (flow-track.css, FlowTrack.tsx),
 * and where a pulse's dash is (wire-pulse.css, wire-pulse.ts).
 *
 * The motion law: nothing here slows, steps or throttles. Every value is a
 * continuous function of `now`, the wall clock in epoch milliseconds (the
 * frame's timestamp plus `performance.timeOrigin`), the same clock the DOM
 * phases from (`Date.now()`, FlowTrack.tsx:139-144). Tempo and easing are the
 * theme's (`DURATION`, `EASING`) through flow-track.ts and wire-pulse.ts;
 * this file holds no number of its own beyond the keyframes it mirrors.
 *
 * Pure. No DOM.
 */

import type { TaskPathVerb } from "@shared/physics";
import { DURATION, EASING } from "@shared/theme";
import { TRACK_BREATH_MS, TRACK_PERIOD, TRACK_PERIOD_MS, TRACK_SCALE } from "@window/lib/flow-track";
import { WIRE_PULSE_DASH, WIRE_PULSE_MS, WIRE_PULSE_WIDTH } from "@window/lib/wire-pulse";
import type { CanvasTier } from "../../contract";
import { cubicBezier } from "./ease";

const mod = (value: number, period: number): number => ((value % period) + period) % period;

// ---------------------------------------------------------------------------
// Flow tracks
// ---------------------------------------------------------------------------

/** Board units from one mark to the next at a tier (FlowTrack.tsx:53). */
export const trackPeriod = (tier: CanvasTier): number => TRACK_PERIOD * TRACK_SCALE[tier];

/** `derives` breathes `0%, 100% { opacity: 1 } 50% { opacity: 0.4 }`, ease-in-out per half (flow-track.css:60-63). */
export const DERIVE_LOW = 0.4;
const easeInOut = cubicBezier(EASING["in-out"]);
const easeLinear = cubicBezier(EASING.linear);

export type TrackPhase = {
  /** Board units between mark centres. */
  readonly period: number;
  /**
   * Mark centres sit where `along` is `offset` plus a whole number of
   * periods, `along` being the distance from the wire's source end.
   */
  readonly offset: number;
  /** The track's opacity now: 1 for flows, the breath for derives. */
  readonly opacity: number;
};

/** The breath of a derives track at a fraction of its 1600 ms cycle. */
export const deriveBreath = (fraction: number): number =>
  fraction < 0.5
    ? 1 + (DERIVE_LOW - 1) * easeInOut(fraction / 0.5)
    : DERIVE_LOW + (1 - DERIVE_LOW) * easeInOut((fraction - 0.5) / 0.5);

/**
 * Where a track's marks are at `now`. Today each run's mover starts at
 * `-(run.at % period) - period` and its tile centres a mark half a period in
 * (FlowTrack.tsx:90-96, flow-track.ts trackTile), so along the wire every mark
 * centre is half a period plus a whole number of periods. Flows slides one
 * period every `TRACK_PERIOD_MS` (450 ms, linear) from the wall-clock phase
 * `now % 450` (FlowTrack.tsx:139-144); derives holds still and breathes on
 * `now % 1600`. Reduced motion stops both where they start (flow-track.css:75-78).
 */
export const trackPhase = (
  verb: TaskPathVerb,
  tier: CanvasTier,
  now: number,
  reducedMotion = false,
): TrackPhase => {
  const period = trackPeriod(tier);
  if (reducedMotion) return { period, offset: period / 2, opacity: 1 };
  if (verb === "derives") {
    return { period, offset: period / 2, opacity: deriveBreath(mod(now, TRACK_BREATH_MS) / TRACK_BREATH_MS) };
  }
  const slide = easeLinear(mod(now, TRACK_PERIOD_MS) / TRACK_PERIOD_MS);
  return { period, offset: mod(period * (0.5 + slide), period), opacity: 1 };
};

/** The mark centres a phase puts between `from` and `to` along the wire. */
export const markCentres = (phase: TrackPhase, from: number, to: number): number[] => {
  const out: number[] = [];
  const first = phase.offset + Math.ceil((from - phase.offset) / phase.period) * phase.period;
  for (let at = first; at <= to + 1e-9; at += phase.period) out.push(at);
  return out;
};

// ---------------------------------------------------------------------------
// Pulses
// ---------------------------------------------------------------------------

const easePulse = cubicBezier(EASING.pulse);

/** A pulse's dash weight and its round caps, half this past each end of the span. */
export const PULSE_HALF_WIDTH = WIRE_PULSE_WIDTH / 2;

/** How far a pulse has travelled at `now`, eased; undefined before it starts or once it has ended. */
export const pulseProgress = (startedAt: number, now: number): number | undefined => {
  const elapsed = now - startedAt;
  if (elapsed < 0 || elapsed >= WIRE_PULSE_MS) return undefined;
  return easePulse(elapsed / WIRE_PULSE_MS);
};

export type PulseSpan = {
  /** The dash's core along the wire, source end to target end; the caps reach `PULSE_HALF_WIDTH` past it. */
  readonly from: number;
  readonly to: number;
};

/**
 * Where the pulse's dash is at `now`. Today the dash is `0.16` of the wire
 * long and its mover travels the wire's length plus the dash, `translateX` 0
 * to 100% (or -100% in reverse) in 900 ms on `cubic-bezier(.45, 0, .55, 1)`,
 * filling forwards (wire-pulse.css:26-47; wire-pulse.ts pulseMover): forward
 * it enters with its head at the source end and leaves with its tail at the
 * target end, reverse the other way round.
 */
export const pulseSpan = (
  length: number,
  reverse: boolean,
  startedAt: number,
  now: number,
): PulseSpan | undefined => {
  const progress = pulseProgress(startedAt, now);
  if (progress === undefined) return undefined;
  const dash = WIRE_PULSE_DASH * length;
  const travel = (length + dash) * progress;
  const from = reverse ? length - travel : -dash + travel;
  return { from, to: from + dash };
};

/** Under reduced motion a pulse holds the whole wire in its colour: 0.85 for 700 ms, then gone in one step (wire-pulse.css:63-77). */
export const PULSE_HOLD_OPACITY = 0.85;
/** The hold's stroke weight (wire-pulse.css:68). */
export const PULSE_HOLD_WIDTH = 2.4;

export const pulseHold = (startedAt: number, now: number, holdMs: number = DURATION["pulse-hold"]): number | undefined => {
  const elapsed = now - startedAt;
  return elapsed >= 0 && elapsed < holdMs ? PULSE_HOLD_OPACITY : undefined;
};
