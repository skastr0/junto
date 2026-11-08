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
 * The seat itself says whether its next turn is fresh (`seatNextTurn`), and
 * how it stands against its cache window (`seatCacheWindow`). Pure: main
 * gathers the facts.
 */
import type { CacheMode } from "./seat-offboard";
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
 * The seat against its cache window: the soft warning's fact. Main tells it
 * and the card draws it. Told while the seat is still and its next turn picks
 * up where it was (`SeatNextTurn` not fresh): past its window, that turn pays
 * for the seat's whole history again. Times are on the clock of the machine
 * showing the card, whichever machine runs the seat.
 */
export type SeatCacheWindow = {
  /** The cache window for the seat's harness on the seat's machine, whole minutes. */
  readonly windowMinutes: number;
  /** When the seat came to rest, its last status change (epoch ms). */
  readonly stillSince: number;
  /** When its window ends, or ended: `stillSince` plus the window. */
  readonly windowEndsAt: number;
  /** Past its window when main answered. */
  readonly pastWindow: boolean;
  /** How far past its window when main answered (ms); 0 while within it. */
  readonly pastByMs: number;
  /**
   * The seat's machine's cache mode: what that machine does with the seat
   * past its window (seat-offboard.ts). Absent when that machine has not said.
   */
  readonly cacheMode?: CacheMode;
  /**
   * The tokens the seat re-reads if it picks up where it was, as its harness
   * recorded them, read on the seat's machine. Absent when the harness has
   * not recorded them.
   */
  readonly tokens?: number;
};

/**
 * The seat's cache window at `now`, from its machine's offboard clock and
 * rules (`stillSince` is absent while the seat is not at rest).
 */
export const seatCacheWindow = (
  nextTurn: SeatNextTurn | undefined,
  rest: {
    readonly stillSince?: number;
    readonly windowMinutes: number;
    readonly cacheMode?: CacheMode;
    readonly tokens?: number;
  },
  now: number,
): SeatCacheWindow | undefined => {
  if (nextTurn?.fresh !== false || rest.stillSince === undefined) return undefined;
  const windowEndsAt = rest.stillSince + rest.windowMinutes * 60_000;
  return {
    windowMinutes: rest.windowMinutes,
    stillSince: rest.stillSince,
    windowEndsAt,
    pastWindow: now >= windowEndsAt,
    pastByMs: Math.max(0, now - windowEndsAt),
    ...(rest.cacheMode === undefined ? {} : { cacheMode: rest.cacheMode }),
    ...(rest.tokens === undefined ? {} : { tokens: rest.tokens }),
  };
};

/**
 * The seat line when its next turn starts fresh. A turn that continues says
 * nothing here: that is the common case. A seat past its cache window has its
 * own warning (`SeatCacheWindow`).
 */
export const SEAT_FRESH_NEXT_LINE = "fresh next";
