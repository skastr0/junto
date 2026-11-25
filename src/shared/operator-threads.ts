/**
 * Global threads: the operator's threads across every seat of a canvas, as
 * the window reads them. Only threads the operator is in (they wrote in it,
 * or a seat wrote to them), one row per thread, newest activity first, a page
 * at a time. A row carries its seat, the seat's region, the thread's line, its
 * last mail and the operator's unread in it.
 *
 * The threads are derived in the core, from the per-canvas index of
 * `src/core/work/operator-threads.ts`; the read is `src/core/work/thread-rows.ts`.
 * Nothing here is stored: no table, no column.
 *
 * Narrowing: a region (a picked path, as the Needs you feed picks one: a parent
 * takes in its children, the empty path is the open field) and a search (every
 * word, in any case, in the thread's line, its seat's name or any of its mail),
 * a set of seats, and unread only. `regions` counts the filter with its region
 * left out, and `seatCounts` the filter with its seats left out, so a region
 * strip and a seat strip name every region and seat that has threads.
 *
 * Order: newest activity first, always. The read keeps no urgency: each row
 * carries its seat, and the window ranks rows with the one ladder
 * (`src/shared/wire/urgency.ts`, `seatUrgencyOrder`), reading its urgent seats
 * first through the `seats` filter when it orders by urgency.
 *
 * Change: a watch names a filter, and the core pushes the rows that changed
 * under it (`OperatorThreadsChanged`): rows that came or moved, and the ids of
 * those that left. The window lays them into what it holds; it does not read
 * the list again.
 */
import { Schema } from "effect";
import { CanvasName, NodeId } from "./model/base";
import { MailParty, ThreadSignalRef } from "./wire/mail-threads";
import { FeedRegion } from "./wire/operator-feed";
import { ResourceSubject } from "./wire/thread-subject";

/** Rows in a page when the caller names no limit. */
export const OPERATOR_THREADS_PAGE_DEFAULT = 50;
/** The most a page may hold. */
export const OPERATOR_THREADS_PAGE_MAX = 200;
/** How much of the last mail a row carries: a row shows a line of it, never the mail. */
export const OPERATOR_THREAD_PREVIEW_MAX = 280;
/** The longest search the read takes. */
export const OPERATOR_THREADS_SEARCH_MAX = 200;

const RegionLabel = Schema.String.pipe(Schema.check(Schema.isMaxLength(200)));

/**
 * What narrows the list: the canvas, and optionally a region and a search. A
 * watch is made of one, and a page is read under one.
 */
export const OperatorThreadsFilter = Schema.Struct({
  canvasName: CanvasName,
  /** A region's path, outer to inner, itself last; its children are in it. The empty path is the open field alone. */
  region: Schema.optionalKey(Schema.Array(RegionLabel).pipe(Schema.check(Schema.isMaxLength(32)))),
  /** Words, each of which must appear, in any case. Blank is no search. */
  search: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(OPERATOR_THREADS_SEARCH_MAX)))),
  /** Only the threads of these seats (a row's `seat` or `alsoSeats`). Absent is every seat; empty is none. */
  seats: Schema.optionalKey(Schema.Array(NodeId).pipe(Schema.check(Schema.isMaxLength(5000)))),
  /** Only threads with mail the operator has not read. */
  unread: Schema.optionalKey(Schema.Literal(true)),
});
export type OperatorThreadsFilter = typeof OperatorThreadsFilter.Encoded;
export type OperatorThreadsFilterDecoded = typeof OperatorThreadsFilter.Type;

const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: OPERATOR_THREADS_PAGE_MAX }));
const PageCursor = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));

/** One page: from the newest, or after the cursor the page before gave. */
export const OperatorThreadsPageQuery = Schema.Struct({
  ...OperatorThreadsFilter.fields,
  limit: Schema.optionalKey(PageLimit),
  after: Schema.optionalKey(PageCursor),
});
export type OperatorThreadsPageQuery = typeof OperatorThreadsPageQuery.Encoded;
export type OperatorThreadsPageQueryDecoded = typeof OperatorThreadsPageQuery.Type;

/** A seat as a row shows it: its name and the seed of its portrait (as the feed's `FeedSeat`). */
export const OperatorThreadSeat = Schema.Struct({
  nodeId: Schema.String,
  name: Schema.String,
  portraitIdentity: Schema.String,
});
export type OperatorThreadSeat = typeof OperatorThreadSeat.Type;

/**
 * One thread in the list. `seat` is the seat the operator talks with in it:
 * the first seat they wrote to there, or the first that wrote to them. The
 * seat view of `seat` holds this thread, so `{canvasName, seat.nodeId,
 * threadId}` opens it in the one thread chat.
 */
export const OperatorThreadRow = Schema.Struct({
  threadId: Schema.String,
  seat: OperatorThreadSeat,
  /** `seat`'s region on the canvas, as the Needs you feed names it. */
  region: FeedRegion,
  /** The thread's line: a subject thread's resource name, else its root mail's first line. */
  title: Schema.String,
  startedAt: Schema.Number,
  /** Its newest mail's time, epoch ms: the list's order. */
  lastAt: Schema.Number,
  /** Its newest mail, its text cut to `OPERATOR_THREAD_PREVIEW_MAX`. */
  last: Schema.Struct({
    messageId: Schema.String,
    from: MailParty,
    text: Schema.String,
    at: Schema.Number,
    /** The operator's own mail, not yet with its seat (a thread message's `waiting`). */
    waiting: Schema.optionalKey(Schema.Literal(true)),
  }),
  messageCount: Schema.Number,
  /** Replies to the operator past their read, as a seat's own list counts them. */
  unread: Schema.Number,
  /** The operator's last explicit mark, on the Mac's clock; absent when never marked. */
  readAt: Schema.optionalKey(Schema.Number),
  /** The other seats in it, when a review copied it to more than one. */
  alsoSeats: Schema.optionalKey(Schema.Array(OperatorThreadSeat)),
  /** The resource it is about; absent for a mailbox thread. */
  subject: Schema.optionalKey(ResourceSubject),
  /** The earliest signal raised in it that is still open (a thread message's `signal`, paired). */
  openSignal: Schema.optionalKey(ThreadSignalRef),
});
export type OperatorThreadRow = typeof OperatorThreadRow.Type;

/** A region with threads under the filter, its region left out: the strip's chip, and its counts. */
export const OperatorThreadsRegionCount = Schema.Struct({
  region: FeedRegion,
  total: Schema.Number,
  unread: Schema.Number,
});
export type OperatorThreadsRegionCount = typeof OperatorThreadsRegionCount.Type;

/** A seat with threads under the filter, its seats left out: the seat strip's chip, and its counts. A thread counts for each seat in it. */
export const OperatorThreadsSeatCount = Schema.Struct({
  seat: OperatorThreadSeat,
  region: FeedRegion,
  total: Schema.Number,
  unread: Schema.Number,
});
export type OperatorThreadsSeatCount = typeof OperatorThreadsSeatCount.Type;

/**
 * One page. `next` asks for the page after it, absent at the end; `total` and `unread` count every row the filter
 * holds, never the page: `unread` is the threads with something unread, as is each count in `regions` and `seatCounts`.
 */
export const OperatorThreadsPage = Schema.Struct({
  rows: Schema.Array(OperatorThreadRow),
  next: Schema.optionalKey(Schema.String),
  total: Schema.Number,
  unread: Schema.Number,
  /** Each region with threads under the filter with its region left out, the innermost a seat sits in; a parent's count is its children's sum, the reader's to add. */
  regions: Schema.Array(OperatorThreadsRegionCount),
  /** Each seat with threads under the filter with its seats left out. */
  seatCounts: Schema.Array(OperatorThreadsSeatCount),
  /** Where the canvas's threads stood when this page was read: a change at or before it is already in the page. */
  generation: Schema.Number,
});
export type OperatorThreadsPage = typeof OperatorThreadsPage.Type;

/** A watch, as main answers it: the id its pushes carry. */
export const OperatorThreadsWatched = Schema.Struct({ watchId: Schema.String });
export type OperatorThreadsWatched = typeof OperatorThreadsWatched.Type;

export const OperatorThreadsUnwatch = Schema.Struct({ watchId: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))) });
export type OperatorThreadsUnwatch = typeof OperatorThreadsUnwatch.Encoded;

/**
 * What changed under one watch: `rows` came into its filter or moved (new
 * mail, a read, a rename, a seat moved region), `gone` left it (a thread the
 * operator is no longer in, a seat removed, a filter it no longer matches).
 * `total`, `unread`, `regions` and `seatCounts` are the filter's again, so a header and a
 * region strip never read.
 */
export const OperatorThreadsChanged = Schema.Struct({
  watchId: Schema.String,
  canvasName: Schema.String,
  rows: Schema.Array(OperatorThreadRow),
  gone: Schema.Array(Schema.String),
  total: Schema.Number,
  unread: Schema.Number,
  regions: Schema.Array(OperatorThreadsRegionCount),
  seatCounts: Schema.Array(OperatorThreadsSeatCount),
  /** Where the canvas's threads stand after this change; a reader lays a change only over a page or change older than it. */
  generation: Schema.Number,
});
export type OperatorThreadsChanged = typeof OperatorThreadsChanged.Type;

/** The window's entry (`window.junto`), on the channels of `operator-threads-channels.ts`. */
export interface OperatorThreadsApi {
  /** One page of the operator's threads across every seat of a canvas. Rejects when the core could not read them. */
  readonly operatorThreadsList: (query: OperatorThreadsPageQuery) => Promise<OperatorThreadsPage>;
  /** Start pushes under a filter. A window's watches end when it closes. */
  readonly operatorThreadsWatch: (filter: OperatorThreadsFilter) => Promise<OperatorThreadsWatched>;
  readonly operatorThreadsUnwatch: (input: OperatorThreadsUnwatch) => Promise<void>;
  /** Main → renderer: what changed under one of this window's watches. */
  readonly onOperatorThreadsChanged: (listener: (change: OperatorThreadsChanged) => void) => () => void;
}

// ---- The renderer's input, decoded at main's edge ----

const closed = { onExcessProperty: "error" } as const;
export const decodeOperatorThreadsPageQuery = Schema.decodeUnknownResult(OperatorThreadsPageQuery, closed);
export const decodeOperatorThreadsFilter = Schema.decodeUnknownResult(OperatorThreadsFilter, closed);
export const decodeOperatorThreadsUnwatch = Schema.decodeUnknownResult(OperatorThreadsUnwatch, closed);
