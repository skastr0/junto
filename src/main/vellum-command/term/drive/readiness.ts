/**
 * Positive UI readiness for managed typing — never a quiet-gap timer.
 * Hermes "Installing TUI dependencies…" swallows Ctrl+C; gate on signals.
 */

import type { AgentSeatState } from "../../../../shared/agent-seat-state";
import type { ObserverGridSnapshot } from "../observer/types";

export type ReadinessInput = {
  readonly harness?: string;
  readonly seatState?: AgentSeatState;
  readonly snapshot?: ObserverGridSnapshot;
};

/**
 * Amp: positive composer readiness (see `isAmpReady`).
 * Other non-Hermes: ready once the seat is bound (any published state except pure unknown
 * with zero screen signal is fine — idle gate still blocks typing).
 * Hermes: require a positive signal — bracketed-paste mode, non-empty title,
 * idle/working/attention state, or non-empty grid text.
 */
/** Amp composer states that are painted but cannot accept a turn yet. */
const AMP_NOT_READY = ["connecting", "catching up"];

/**
 * Amp readiness is positive, and it is not the absence of output.
 *
 * A fresh `amp threads continue` paints its whole composer box immediately
 * while the footer still reads `~ Connecting` and the OSC title is empty. Text
 * written into that window lands in the composer and the CR never submits it —
 * observed in the first PTY capture of this harness, where the prompt sat
 * unsent for the rest of the session. Amp titles the window only once the
 * thread is live, so a non-empty title plus a footer that has stopped saying
 * connecting/catching up is the evidence that a turn can be accepted.
 */
const isAmpReady = (input: ReadinessInput): boolean => {
  const snap = input.snapshot;
  if (!snap) return false;
  if (snap.signals.title.trim().length === 0) return false;
  const text = snap.text.toLowerCase();
  return !AMP_NOT_READY.some((phrase) => text.includes(phrase));
};

export const isManagedTerminalReady = (input: ReadinessInput): boolean => {
  const harness = input.harness?.trim().toLowerCase() ?? "";
  if (harness === "amp") return isAmpReady(input);
  if (harness !== "hermes") {
    // Claude/Codex/Grok: allow as soon as we are not totally unbound.
    // Idle gate still prevents typing into dialogs.
    return true;
  }

  const snap = input.snapshot;
  if (snap?.signals.modes.bracketedPaste) return true;
  if ((snap?.signals.title.trim().length ?? 0) > 0) return true;
  if (snap?.text.trim().length) return true;

  const state = input.seatState;
  if (state === "idle" || state === "working" || state === "attention") {
    return true;
  }
  return false;
};
