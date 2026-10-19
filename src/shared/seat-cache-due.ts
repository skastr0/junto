/**
 * The auto cache mode's question (seat-offboard.ts CacheMode). A seat this
 * machine runs has sat still past its cache window while the operator has it
 * open, so Junto asks before it starts the seat fresh, and never does without
 * an answer: Start fresh, or Keep this session. Keep is not asked again until
 * the seat leaves the screen. Main sends the whole list each time it changes
 * (`seatCacheDue`); a window that opens asks for it (`seatCacheDueList`).
 *
 * Imported by the preload's reach: keep this module free of Effect.
 */

/** A seat due the question. */
export type SeatCacheDue = {
  readonly canvasName: string;
  readonly seatId: string;
  /** When its cache window ended (epoch ms, the seat's machine's clock). */
  readonly windowEndsAt: number;
};

/** Start fresh: the seat's session ends now and its next turn begins anew. Keep: it carries on. */
export const SEAT_CACHE_DUE_ANSWERS = ["fresh", "keep"] as const;
export type SeatCacheDueAnswer = (typeof SEAT_CACHE_DUE_ANSWERS)[number];

export type SeatCacheDueAnswerInput = {
  readonly canvasName: string;
  readonly seatId: string;
  readonly answer: SeatCacheDueAnswer;
};

export type SeatCacheDueAnswerResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
