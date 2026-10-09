/**
 * Presentation for actor session load — spinner tone + short label.
 * Product-facing only; does not own process lifecycle.
 */

import { HUE } from "./theme";

/** Distinct load phases an operator can read while a seat comes up. */
export type SessionLoadPhase =
  | "finding"
  | "starting"
  | "resuming"
  | "attaching"
  | "stuck";

export type SessionLoadTone = "cyan" | "amber" | "violet" | "crimson" | "steel";

export type SessionLoadPresentation = {
  readonly phase: SessionLoadPhase;
  readonly tone: SessionLoadTone;
  readonly label: string;
  readonly hex: string;
};

export const SESSION_LOAD_TONE_HEX: Record<SessionLoadTone, string> = {
  cyan: HUE.cyan,
  amber: HUE.amber,
  violet: HUE.violet,
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
        label: "starting new session",
        hex: SESSION_LOAD_TONE_HEX.amber,
      };
    case "resuming":
      return {
        phase: "resuming",
        tone: "violet",
        label: "resuming session",
        hex: SESSION_LOAD_TONE_HEX.violet,
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

/** The machine resolves its pin before reporting start or resume. */
export const initialSessionLoadPhase = (input: {
  readonly agentSeat: boolean;
}): SessionLoadPhase => input.agentSeat ? "finding" : "attaching";

/** Load phase once the host started a generation: resume only when it proved one. */
export const startedSessionLoadPhase = (input: {
  readonly resuming: boolean;
}): SessionLoadPhase => (input.resuming ? "resuming" : "starting");

/** True while the stage should show the load spinner (not live, not dead). */
export const isSessionLoadActive = (
  phase: SessionLoadPhase | null | undefined,
): phase is SessionLoadPhase => phase != null;
