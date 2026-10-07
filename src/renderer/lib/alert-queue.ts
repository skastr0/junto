/**
 * Rising edges for the attention sounds.
 *
 * Pure model only: no React, no IPC, no audio. The wire layer feeds live
 * signals and sounds each rise. Stepping to the next agent is not here: that
 * is the shared urgency order (lib/urgency-order.ts, lib/urgency-step.ts).
 *
 * Laws:
 * - The first observe is the baseline: nothing has risen, nothing is heard.
 * - A subject rises when it appears after the baseline, or becomes more
 *   urgent than it was. Urgency is the one table every surface reads
 *   (SEAT_URGENCY: lower is more urgent).
 * - A subject that calms down, or is re-sent unchanged, does not rise.
 * - A held subject (its state is unknown for now: a restart, a reconnect)
 *   keeps the urgency it had; coming back where it was is not a rise.
 */

import type { SeatUrgency } from "./seat-line";

/** What a signal is about; each kind has its own cue (sound/director.ts). */
export const ALERT_KINDS = ["blocked", "attention", "ready", "working"] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

/** A subject present right now, with how urgent it is. Not yet an edge. */
export interface AlertSignal {
  readonly id: string;
  readonly kind: AlertKind;
  readonly subjectKey: string;
  /** From SEAT_URGENCY: lower is more urgent. */
  readonly urgency: SeatUrgency;
}

export interface AlertQueue {
  /** The urgency last observed for each subject after the baseline. */
  readonly known: Readonly<Record<string, SeatUrgency>>;
  readonly baselined: boolean;
}

export const emptyAlertQueue = (): AlertQueue => ({ known: {}, baselined: false });

/**
 * Observe the current signals. The first call is the baseline. Later calls
 * return the subjects that rose: new since the last observe, or more urgent
 * than they were. A subject that disappears is forgotten, unless `held`.
 */
export const observeSignals = (
  queue: AlertQueue,
  signals: ReadonlyArray<AlertSignal>,
  held: ReadonlySet<string> = new Set(),
): { readonly queue: AlertQueue; readonly risen: ReadonlyArray<AlertSignal> } => {
  const known: Record<string, SeatUrgency> = {};
  for (const id of held) {
    const before = queue.known[id];
    if (before !== undefined) known[id] = before;
  }
  for (const signal of signals) known[signal.id] = signal.urgency;

  if (!queue.baselined) return { queue: { known, baselined: true }, risen: [] };

  const risen = signals.filter((signal) => {
    const before = queue.known[signal.id];
    return before === undefined || signal.urgency < before;
  });
  return { queue: { known, baselined: true }, risen };
};

/** Stable id helpers for the wire layer. */
export const alertId = {
  node: (nodeId: string) => `node:${nodeId}`,
} as const;
