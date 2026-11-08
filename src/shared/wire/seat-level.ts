/**
 * A seat's level on the one urgency ladder (urgency.ts), and when the seat
 * took it. The desktop's seat rail, palette and alerts read it, and main sends
 * it on every companion seat, so the phone sorts by the same rule.
 *
 * A wire module: imports nothing but sibling wire modules, so the phone syncs it.
 */

import type { AgentSignalKind } from "./agent-signals";
import type { ActivitySpec } from "./seat-activity";
import { Level, Palette, type UrgencyLevel } from "./urgency";

/**
 * A seat's level, from the facts its seat line reads: a declared blocker or a
 * halted ring is blocked, a spawn failure is stopped, a dialog waiting for
 * input is waiting, a declared escalation is escalated, a feedback signal is
 * review (the model asked), a settled turn nobody has read is done, work in
 * flight is working, a seat that draws the off ring is offline, and the rest
 * rest.
 */
export const seatLevel = (input: {
  readonly activity: Pick<ActivitySpec, "mode" | "tone" | "glyph">;
  readonly signal?: AgentSignalKind;
  readonly failure?: string;
}): UrgencyLevel => {
  const { activity, signal, failure } = input;
  const { mode, tone } = activity;
  if (signal === "blocked" || (mode === "wave" && tone === "crimson")) return Level.blocked;
  if (failure) return Level.stopped;
  if (mode === "wave" && tone === "amber") return Level.waiting;
  if (signal === "escalate") return Level.escalated;
  if (signal === "feedback") return Level.review;
  if (mode === "pulse" && tone === "green") return Level.done;
  if (mode === "wave") return Level.working;
  // Offline, stopped and gone seats draw the "off" ring.
  return activity.glyph === "off" ? Level.offline : Level.resting;
};

/**
 * When a seat took its level: the time of the fact that put it there. The open
 * signal for a level that signal set, the finished turn for done, the last time
 * it left rest for work in flight, else the status change in the seat's own
 * snapshot, else the seat event itself.
 */
export const seatLevelSince = (input: {
  readonly level: UrgencyLevel;
  readonly signal?: { readonly kind: AgentSignalKind; readonly createdAt: number };
  readonly snapshot?: {
    readonly since: number;
    readonly activitySince?: number;
    readonly turnUnseen?: { readonly since: number };
  };
  /** When the desktop saw the turn finish, where it keeps that. */
  readonly doneAt?: number;
  /** The seat event's own time. */
  readonly at?: number;
}): number => {
  const { level, signal, snapshot } = input;
  const fallback = input.at ?? 0;
  const fromSignal =
    (level === Level.blocked && signal?.kind === "blocked") ||
    (level === Level.escalated && signal?.kind === "escalate") ||
    (level === Level.review && signal?.kind === "feedback");
  if (fromSignal && signal) return signal.createdAt;
  if (level === Level.done) return input.doneAt ?? snapshot?.turnUnseen?.since ?? fallback;
  if (Palette.groupOf(level) === Palette.group.working) return snapshot?.activitySince ?? snapshot?.since ?? fallback;
  return snapshot?.since ?? fallback;
};
