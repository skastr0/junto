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
const AMP_BUSY_FOOTER = /^\s*╰\s*(?:[∼≈≋~]\s*)?(?:loading thread|connecting|reconnecting|catching up|sending|streaming|thinking|cancelling|retrying|waiting for approval)\b/iu;
const AMP_AUTH_PROMPT = /^\s*(?:[│╰]\s*)?(?:[∼≈≋~]\s*)?(?:Error:\s*)?(?:not logged in|login required|authentication required|sign in to continue)\b/iu;

/**
 * Amp readiness is positive, and it is not the absence of output.
 *
 * A fresh `amp threads continue` paints its whole composer box immediately
 * while the footer still reads `~ Connecting` and the OSC title is empty. Text
 * written into that window lands in the composer and the CR never submits it —
 * observed in the first PTY capture of this harness. Current Amp can also
 * finish loading a new empty thread WITHOUT setting a title until its first
 * turn. That startup requires its complete empty ruled composer, settled
 * footer, and enabled bracketed paste; a generic blank box is insufficient.
 */
const isAmpReady = (input: ReadinessInput): boolean => {
  const snap = input.snapshot;
  if (!snap) return false;
  if (input.seatState === "working" || input.seatState === "attention") return false;
  if (/[\u2800-\u28ff]/u.test(snap.signals.title)) return false;
  const lines = snap.lines.filter((line) => line.trim()).slice(-8);
  if (lines.some((line) => AMP_BUSY_FOOTER.test(line) || AMP_AUTH_PROMPT.test(line))) return false;
  if (snap.signals.title.includes(" - amp - ")) return true;
  if (!snap.signals.modes.bracketedPaste) return false;
  let top = -1;
  let bottom = -1;
  for (const [index, line] of lines.entries()) {
    if (/^\s*╭─/u.test(line)) top = index;
    if (/^\s*╰─/u.test(line)) bottom = index;
  }
  if (top < 0 || bottom <= top + 1) return false;
  return lines.slice(top + 1, bottom).every((line) => /^\s*│\s*│\s*$/u.test(line));
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
