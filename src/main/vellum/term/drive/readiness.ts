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
 * Non-Hermes: ready once the seat is bound (any published state except pure unknown
 * with zero screen signal is fine — idle gate still blocks typing).
 * Hermes: require a positive signal — bracketed-paste mode, non-empty title,
 * idle/working/attention state, or non-empty grid text.
 */
export const isManagedTerminalReady = (input: ReadinessInput): boolean => {
  const harness = input.harness?.trim().toLowerCase() ?? "";
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
