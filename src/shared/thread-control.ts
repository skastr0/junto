/**
 * `thread.list` and `thread.show`: a seat's threads, those with the operator
 * and those between seats, read from a seat. With no `seat` the caller reads its own, seat-local as
 * `msg.list` with no target is; with `seat` it reads a connected seat's,
 * admitted by port `threads.read`.
 *
 * The threads are the core's one read (`src/core/work/operator-threads.ts`),
 * as the desktop pages them. A seat's view leaves the operator's read state
 * out: a summary carries no `readAt` and no `unread`, and reading moves no
 * read point.
 *
 * Pure module, no Node imports.
 */
import { Schema } from "effect";
import { MailMessageId } from "./crew";
import { PAGE_MAX, THREAD_GROUPS } from "./mail-threads";
import { MailThreadMessage, MailThreadSummary } from "./wire/mail-threads";

const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PAGE_MAX }));
const PageCursor = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));
/** A seat as `seat read` takes it: its name, node id or ref. */
const SeatTarget = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));

export const ThreadListArgs = Schema.Struct({
  /** Whose threads: a connected seat's name, node id or ref. Absent, the caller's own. */
  seat: Schema.optionalKey(SeatTarget),
  /** Threads in the page, newest activity first (default 50, max 200). */
  limit: Schema.optionalKey(PageLimit),
  /** The `next` a previous page answered. */
  after: Schema.optionalKey(PageCursor),
  /** One list alone, with its own cursor: the threads the operator is in, or those between seats. Absent, both as one. */
  group: Schema.optionalKey(Schema.Literals(THREAD_GROUPS)),
});
export type ThreadListArgs = typeof ThreadListArgs.Type;

export const ThreadShowArgs = Schema.Struct({
  threadId: MailMessageId,
  /** Whose thread: a connected seat's name, node id or ref. Absent, the caller's own. */
  seat: Schema.optionalKey(SeatTarget),
  /** Messages in the page, the newest unless `before` says otherwise (default 50, max 200). */
  limit: Schema.optionalKey(PageLimit),
  /** The `older` a previous page answered. */
  before: Schema.optionalKey(PageCursor),
});
export type ThreadShowArgs = typeof ThreadShowArgs.Type;

// The operator's read state is theirs: a seat's view of a thread leaves it out.
const { readAt: _readAt, unread: _unread, ...seatSummaryFields } = MailThreadSummary.fields;

/** A thread as a seat reads it: the desktop's summary without the operator's read state. */
export const SeatThreadSummary = Schema.Struct(seatSummaryFields);
export type SeatThreadSummary = typeof SeatThreadSummary.Type;

/** One page of a seat's threads, newest activity first. `next` asks for the page after it; absent at the end. */
export const ThreadListAnswer = Schema.Struct({
  /** The seat whose threads these are, by node id. */
  seat: Schema.String,
  threads: Schema.Array(SeatThreadSummary),
  next: Schema.optionalKey(Schema.String),
});
export type ThreadListAnswer = typeof ThreadListAnswer.Type;

/** One page of a thread's messages, oldest first. `older` asks for the page above it; absent at the thread's start. */
export const ThreadShowAnswer = Schema.Struct({
  seat: Schema.String,
  threadId: Schema.String,
  messages: Schema.Array(MailThreadMessage),
  older: Schema.optionalKey(Schema.String),
});
export type ThreadShowAnswer = typeof ThreadShowAnswer.Type;

/** A summary as a seat reads it: the operator's read state taken off. */
export const seatThreadSummaryOf = (summary: MailThreadSummary): SeatThreadSummary => {
  const { readAt: _at, unread: _count, ...rest } = summary;
  return rest;
};
