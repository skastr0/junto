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

const shortId = (id: string): string => {
  const trimmed = id.trim();
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 8)}…`;
};

/**
 * Resolve spinner presentation for the current load phase.
 * `sessionId` is only used for the resuming label (truncated).
 */
export const sessionLoadPresentation = (input: {
  readonly phase: SessionLoadPhase;
  readonly sessionId?: string | null;
}): SessionLoadPresentation => {
  const sid = input.sessionId?.trim();
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
        label: sid ? `resuming ${shortId(sid)}` : "resuming session",
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

/**
 * First active load phase for an actor seat open, before the host answers.
 * A pinned session id only names the session a seat would use; it never
 * proves one exists, so a pinned seat is "finding" until the host says
 * whether it resumed. No pin starts fresh. Non-agent shells skip to attach.
 */
export const initialSessionLoadPhase = (input: {
  readonly agentSeat: boolean;
  readonly sessionId?: string | null;
}): SessionLoadPhase => {
  if (!input.agentSeat) return "attaching";
  if (input.sessionId === undefined || input.sessionId === null) {
    return "starting";
  }
  return "finding";
};

/** Load phase once the host started a generation: resume only when it proved one. */
export const startedSessionLoadPhase = (input: {
  readonly resuming: boolean;
}): SessionLoadPhase => (input.resuming ? "resuming" : "starting");

/** True while the stage should show the load spinner (not live, not dead). */
export const isSessionLoadActive = (
  phase: SessionLoadPhase | null | undefined,
): phase is SessionLoadPhase => phase != null;
