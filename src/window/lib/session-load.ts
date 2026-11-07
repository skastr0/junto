/**
 * Presentation for actor session load — spinner tone + short label.
 * Product-facing only; does not own process lifecycle.
 */

import { HUE } from "./theme";

/** Distinct load phases an operator can read while a seat comes up. */
export type SessionLoadPhase =
  | "finding"
  | "starting"
  | "attaching"
  | "stuck";

export type SessionLoadTone = "cyan" | "amber" | "crimson" | "steel";

export type SessionLoadPresentation = {
  readonly phase: SessionLoadPhase;
  readonly tone: SessionLoadTone;
  readonly label: string;
  readonly hex: string;
};

export const SESSION_LOAD_TONE_HEX: Record<SessionLoadTone, string> = {
  cyan: HUE.cyan,
  amber: HUE.amber,
  crimson: HUE.crimson,
  steel: HUE.steel,
};

/** After this many ms in a non-terminal load phase, surface as stuck. */
export const SESSION_LOAD_STUCK_MS = 12_000;

/** Resolve the operator-facing load state without exposing harness ids. */
export const sessionLoadPresentation = (input: {
  readonly phase: SessionLoadPhase;
}): SessionLoadPresentation => {
  switch (input.phase) {
    case "finding":
      return {
        phase: "finding",
        tone: "cyan",
        label: "finding session",
        hex: SESSION_LOAD_TONE_HEX.cyan,
      };
    case "starting":
      return {
        phase: "starting",
        tone: "amber",
        label: "starting session",
        hex: SESSION_LOAD_TONE_HEX.amber,
      };
    case "attaching":
      return {
        phase: "attaching",
        tone: "cyan",
        label: "attaching",
        hex: SESSION_LOAD_TONE_HEX.cyan,
      };
    case "stuck":
      return {
        phase: "stuck",
        tone: "crimson",
        label: "stuck — still loading",
        hex: SESSION_LOAD_TONE_HEX.crimson,
      };
  }
};

/** The machine finds the seat before reporting its start. */
export const initialSessionLoadPhase = (input: {
  readonly agentSeat: boolean;
}): SessionLoadPhase => input.agentSeat ? "finding" : "attaching";

/** True while the stage should show the load spinner (not live, not dead). */
export const isSessionLoadActive = (
  phase: SessionLoadPhase | null | undefined,
): phase is SessionLoadPhase => phase != null;
