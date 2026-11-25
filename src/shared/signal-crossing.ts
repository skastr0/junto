import type { AgentSignal } from "./wire/agent-signals";

/**
 * An answer and a withdrawal that crossed, as either machine keeps them: the
 * editing machine an answered signal with `withdrawnAt` beside it, the seat's
 * machine a withdrawn one holding the answer that came after. The one rule
 * the core's thread reads and the feed's pane share.
 */
export const crossedClosing = (signal: AgentSignal): boolean =>
  signal.crossed === true ||
  (signal.state === "answered" && signal.withdrawnAt !== undefined) ||
  (signal.state === "withdrawn" && signal.response !== undefined);

/**
 * The sentence for an answer and a withdrawal that crossed, everywhere it is
 * said: the thread's signal frame, the feed's pane and its exchange row. It is
 * the seat's own statement, not a fact the operator's machine can check.
 */
export const crossedWords = (seat: string): string => `${seat} says it withdrew this before your answer reached it.`;

/** The same said alone, where the card is out of sight: it names the signal, its headline last after a colon. */
export const crossedLiveWords = (seat: string, headline: string): string =>
  `${seat} says it withdrew a signal before your answer reached it: ${headline}`;

/** The seat withdrew a signal and no answer was on its way: said where the operator's half-typed reply was kept under it. */
export const withdrawnWords = (seat: string): string => `${seat} withdrew this signal.`;

/** The same said alone, where the card is out of sight. */
export const withdrawnLiveWords = (seat: string, headline: string): string => `${seat} withdrew a signal: ${headline}`;

/** Closed by its own seat with no answer held: only a reply being written under it asks the pane to keep it. */
export const withdrawnPlain = (signal: AgentSignal): boolean => signal.state === "withdrawn" && !crossedClosing(signal);

/**
 * The live line's tail for a reply that was being written: a sentence after a headline. A headline that
 * ends its own sentence (a question, an exclamation, a full stop) takes no added period.
 */
export const draftNotSent = (said: string): string => `${said}${/[.?!]$/u.test(said.trimEnd()) ? "" : "."} Your draft was not sent.`;
