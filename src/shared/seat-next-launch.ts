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
 * Pure: main gathers the facts.
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

/** The seat line for a seat that is not running, by what its next start does. */
export const SEAT_NEXT_LAUNCH_LINE: Readonly<Record<SeatNextLaunch, string>> = {
  resume: "not running, will resume",
  offboarded: "offboarded, starts fresh",
  fresh: "not running, starts fresh",
};
