/**
 * May a seat raise a signal in this thread (docs/security-doctrine.md)? One
 * rule, run by the seat's machine before the raise and by the machine that
 * edits the canvas when it takes the signal from a peer. A thread need not
 * start with the operator: the operator writes into any of the seat's
 * threads, those between seats included. The rule is that the seat's own
 * mailbox holds a row the operator wrote in that thread, and that the thread
 * is in no task or resource thread.
 *
 * Pure, no Node imports.
 */
import { mailThreadOf } from "./crew";
import { THREAD_SUBJECT_KEY } from "./thread-subject";
import { OPERATOR_SEAT_ID } from "./work-reference";

/** The one refusal, in fixed words: a row's own words never reach a log or a peer. */
export const SIGNAL_THREAD_REFUSAL = "a signal names a thread in which the operator wrote nothing to that seat";

/**
 * One row of the seat's own mailbox. `actorSeatId` is the row's stored author
 * (the `actor_seat_id` column, which the repository also stamps as
 * `metadata.fromSeat` on every mailbox row), never what its sender wrote.
 */
export type SignalThreadRow = {
  readonly messageId: string;
  readonly actorSeatId: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/** Why a thread is refused, for the tests; a seat and a peer are told only SIGNAL_THREAD_REFUSAL. */
export type SignalThreadFault = "no_operator_row" | "subject_thread";

/**
 * The fault in raising a signal in `threadId`, or undefined when it may be.
 * `mailbox` is the seat's own mailbox, or any part of it that holds the
 * thread's rows: rows of other threads are passed over.
 */
export const signalThreadFault = (threadId: string, mailbox: ReadonlyArray<SignalThreadRow>): SignalThreadFault | undefined => {
  const thread = mailbox.filter((row) => mailThreadOf(row) === threadId);
  if (thread.some((row) => row.metadata?.[THREAD_SUBJECT_KEY] !== undefined)) return "subject_thread";
  return thread.some((row) => row.actorSeatId === OPERATOR_SEAT_ID) ? undefined : "no_operator_row";
};
