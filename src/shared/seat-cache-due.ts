/**
 * The auto cache mode's question (seat-offboard.ts CacheMode). A seat has sat
 * still past its cache window while the operator has it open, so Junto asks
 * before it starts the seat fresh, and never does without an answer: Start
 * fresh, or Keep this session. Keep is not asked again until the seat leaves
 * every screen. Main sends the whole list each time it changes
 * (`seatCacheDue`); a window that opens asks for it (`seatCacheDueList`).
 *
 * Each time a seat falls due, its machine mints a new question id. An answer
 * names that id: the first answer settles it, and an answer to an earlier
 * question never touches a later one. A seat run on a linked machine is asked
 * by that machine, over the view of it shown here.
 *
 * Imported by the preload's reach: keep this module free of Effect.
 */

/** A question id: 16 random bytes, base64url, as an attach handle is. */
export const CACHE_QUESTION_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** A seat due the question. */
export type SeatCacheDue = {
  readonly canvasName: string;
  readonly seatId: string;
  /** This time the seat fell due; the answer names it. */
  readonly question: string;
  /** When its cache window ended (epoch ms, this machine's clock). */
  readonly windowEndsAt: number;
  /**
   * The estimated tokens the seat re-reads if it continues, from the same
   * estimate as the offboard status. Absent when there is no estimate.
   */
  readonly tokens?: number;
};

/** Start fresh: the seat's session ends now and its next turn begins anew. Keep: it carries on. */
export const SEAT_CACHE_DUE_ANSWERS = ["fresh", "keep"] as const;
export type SeatCacheDueAnswer = (typeof SEAT_CACHE_DUE_ANSWERS)[number];

export type SeatCacheDueAnswerInput = {
  readonly canvasName: string;
  readonly seatId: string;
  readonly question: string;
  readonly answer: SeatCacheDueAnswer;
};

/**
 * The answer was taken: Start fresh ends the session unless the seat is busy
 * or typed into again since. Refused: the question was already answered or
 * has gone, or the seat cannot be reached.
 */
export type SeatCacheDueAnswerResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
