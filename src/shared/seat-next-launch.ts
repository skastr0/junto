/**
 * What the next start of a seat that is not running will do: resume the
 * session it had, or begin a fresh one. A ping, a mail wake and the
 * operator's start all take the same path (seat-session-before-start.ts,
 * managed-spawn-plan.ts), so one answer holds for all of them.
 *
 * - resume: the seat's open session belongs to its harness and the harness's
 *   own store proves it exists (or the harness keeps its thread by id).
 * - offboarded: the seat's last session ended at an offboard; what is open
 *   now, if anything, has nothing behind it, so the start is fresh.
 * - fresh: no session to go back to.
 *
 * The seat itself only ever says whether its next turn is fresh
 * (`seatNextTurn`). Pure: main gathers the facts.
 */
import type { SeatSessionEndReason } from "./seat-sessions";

export const SEAT_NEXT_LAUNCHES = ["resume", "offboarded", "fresh"] as const;
export type SeatNextLaunch = (typeof SEAT_NEXT_LAUNCHES)[number];

export const seatNextLaunch = (input: {
  readonly harness: string;
  /** The seat's open session for its current binding, if any. */
  readonly open?: { readonly harness: string; readonly sessionId: string };
  /** The harness keeps its thread by id (Amp): the id alone resumes it. */
  readonly provisioned: boolean;
  /** The harness's own store holds the open session's id. */
  readonly provenOnDisk: boolean;
  /** Why the seat's most recent ended session ended. */
  readonly lastEnded?: SeatSessionEndReason;
}): SeatNextLaunch => {
  const open = input.open?.harness === input.harness && input.open.sessionId.trim() !== "" ? input.open : undefined;
  if (open && (input.provisioned || input.provenOnDisk)) return "resume";
  return input.lastEnded === "offboard" ? "offboarded" : "fresh";
};

/**
 * What the seat's next turn does, whoever gives it (mail, a prompt, a wake):
 * continue its session, or begin a fresh one. `freshAt`, while it continues:
 * when its session goes cold if nothing moves first.
 */
export type SeatNextTurn = { readonly fresh: boolean; readonly freshAt?: number };

/**
 * A seat that is not running starts fresh when it has no session to resume.
 * Otherwise the turn is fresh only when its session has gone cold, by the
 * same test that cuts it (operator-offboard.ts `coldness`).
 */
export const seatNextTurn = (input: {
  readonly running: boolean;
  /** What a start does; read for a seat that is not running. */
  readonly launch: SeatNextLaunch;
  readonly cold: { readonly cold: boolean; readonly at?: number };
}): SeatNextTurn =>
  !input.running && input.launch !== "resume"
    ? { fresh: true }
    : { fresh: input.cold.cold, ...(!input.cold.cold && input.cold.at !== undefined ? { freshAt: input.cold.at } : {}) };

/**
 * The seat line when its next turn starts fresh. A turn that continues says
 * nothing: that is the common case, and the seat never talks about caches.
 */
export const SEAT_FRESH_NEXT_LINE = "fresh next";
