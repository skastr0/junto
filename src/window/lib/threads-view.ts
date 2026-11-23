/**
 * Threads, the operator modal: what its list shows and in what order. The
 * operator's threads across every seat, one row each, flat (the row carries
 * its region; sections would break recency). The same region pick, seat
 * pick and search as the needs-you feed, plus one Unread chip where the
 * feed has its kinds.
 *
 * Pure but for the view state, which is session-lived and module-scoped like
 * the feed's (feedView$): it survives the modal's open and close without
 * pretending to be a preference.
 */
import { observable } from "@legendapp/state";
import type { FeedRegion, FeedSeatChip } from "@shared/operator-feed";
import { seatChipsOf } from "@shared/operator-feed";
import { compareView, SeatUrgency } from "@shared/wire/urgency";
import { regionChipsOf, regionMatches, regionPickName, type FeedRegionChip, type FeedRegionPick } from "./operator-feed";
import type { SeatGroup } from "./seat-line";
import type { SeatThreadSummary } from "./seat-threads";

/** One row: a thread between the operator and one seat, with where that seat sits. */
export type ThreadRow = {
  readonly canvasName: string;
  readonly seatId: string;
  readonly seatName: string;
  readonly region: FeedRegion;
  readonly thread: SeatThreadSummary;
};

/** A row's one key across every seat: a thread id is a mail id, and a seat may share it with another. */
export const threadRowKey = (row: Pick<ThreadRow, "seatId" | "thread">): string => `${row.seatId}\n${row.thread.threadId}`;

/** The list's two orders, in the needs-you feed's own words. */
export type ThreadsOrder = "newest" | "urgency";

export const THREADS_ORDER_OPTIONS: ReadonlyArray<{ readonly value: ThreadsOrder; readonly label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "urgency", label: "Most urgent first" },
];

export const threadsView$ = observable<{
  region: FeedRegionPick | undefined;
  order: ThreadsOrder;
  /** Words the core read finds in a thread's seat, region, title or messages; empty finds everything. */
  query: string;
  /** Only threads with mail the operator has not read. */
  unread: boolean;
  /** The one seat kept, by node id; undefined keeps every seat. */
  seat: string | undefined;
  /** Whether the seat chips are unfolded; folded by default, as in the feed. */
  seatsOpen: boolean;
}>({ region: undefined, order: "newest", query: "", unread: false, seat: undefined, seatsOpen: false });

export type ThreadsFilter = {
  readonly query: string;
  readonly unread: boolean;
  readonly seat: string | undefined;
};

/** Whether the operator narrowed anything besides a region: the surface offers to clear it. */
export const threadsFilterOn = (filter: ThreadsFilter): boolean =>
  filter.query.trim() !== "" || filter.unread || filter.seat !== undefined;

/**
 * Whether a row passes the axes the window holds: Unread and the seat. The
 * words are not matched here: a search reads every message of every thread,
 * which only the core read holds, so the query goes to it and the rows that
 * come back already match.
 */
export const threadRowMatches = (row: ThreadRow, filter: ThreadsFilter): boolean => {
  if (filter.unread && row.thread.unread === 0) return false;
  return filter.seat === undefined || row.seatId === filter.seat;
};

/** Newest activity first; ties by seat then thread, so the order never flickers. */
const byRecency = (a: ThreadRow, b: ThreadRow): number =>
  b.thread.lastAt - a.thread.lastAt || a.seatName.localeCompare(b.seatName) || a.thread.threadId.localeCompare(b.thread.threadId);

/**
 * The rows in an order. Newest first is recency alone. Most urgent first is
 * the seat's urgency in the rail's view, the order the rail and the step keys
 * read (seatUrgencyOrder), then recency. `urgencyOf` is read once per seat by
 * the caller, so the order holds still while the operator moves through it;
 * a seat it does not know is offline.
 */
export const orderThreadRows = (
  rows: ReadonlyArray<ThreadRow>,
  order: ThreadsOrder,
  urgencyOf: (seatId: string) => SeatGroup | undefined,
): ReadonlyArray<ThreadRow> => {
  if (order === "newest") return [...rows].sort(byRecency);
  const compare = compareView(SeatUrgency);
  const groups = new Map<string, SeatGroup>();
  const groupOf = (seatId: string): SeatGroup => {
    let group = groups.get(seatId);
    if (group === undefined) {
      group = urgencyOf(seatId) ?? SeatUrgency.group.offline;
      groups.set(seatId, group);
    }
    return group;
  };
  return [...rows].sort((a, b) => compare(groupOf(a.seatId), groupOf(b.seatId)) || byRecency(a, b));
};

/** The rows in the picked region (its children too); a pick on another canvas is ignored. */
export const rowsInRegion = (
  rows: ReadonlyArray<ThreadRow>,
  pick: FeedRegionPick | undefined,
  canvasName: string,
): ReadonlyArray<ThreadRow> =>
  pick?.canvasName === canvasName ? rows.filter((row) => regionMatches(pick.path, row.region)) : rows;

/** What the list shows: the picked region's rows the filter keeps, in the picked order. */
export const viewThreadRows = (
  rows: ReadonlyArray<ThreadRow>,
  pick: FeedRegionPick | undefined,
  canvasName: string,
  order: ThreadsOrder,
  filter: ThreadsFilter,
  urgencyOf: (seatId: string) => SeatGroup | undefined,
): ReadonlyArray<ThreadRow> =>
  orderThreadRows(
    rowsInRegion(rows, pick, canvasName).filter((row) => threadRowMatches(row, filter)),
    order,
    urgencyOf,
  );

/**
 * The region strip's chips over the rows: each region a row's seat sits in,
 * most recent first, counting its unread threads.
 */
export const threadRegionChips = (
  rows: ReadonlyArray<ThreadRow>,
  pick?: ReadonlyArray<string>,
): ReadonlyArray<FeedRegionChip> =>
  regionChipsOf(
    [...rows].sort(byRecency).map((row) => ({ region: row.region, count: row.thread.unread > 0 ? 1 : 0 })),
    pick,
  );

/** The seat chips over the rows: one per seat, the most threads first, counting threads. */
export const threadSeatChips = (rows: ReadonlyArray<ThreadRow>): ReadonlyArray<FeedSeatChip> =>
  seatChipsOf(rows.map((row) => ({ seatId: row.seatId, name: row.seatName, region: row.region })));

/** Threads with mail the operator has not read. */
export const unreadThreads = (rows: ReadonlyArray<ThreadRow>): number =>
  rows.reduce((count, row) => (row.thread.unread > 0 ? count + 1 : count), 0);

/**
 * The status line, in the feed's form: "24 threads, 3 unread"; with a region
 * picked, "6 of 24 threads in Product"; with a filter on, "5 of 24 shown",
 * and "in Product" when a region is picked too.
 */
export const threadsStatusLine = (input: {
  readonly total: number;
  readonly unread: number;
  readonly shown: number;
  readonly region?: ReadonlyArray<string>;
  readonly filtering: boolean;
}): string => {
  const where = input.region === undefined ? "" : ` in ${regionPickName(input.region)}`;
  if (input.filtering) return `${input.shown} of ${input.total} shown${where}`;
  if (input.region !== undefined) return `${input.shown} of ${input.total} ${input.total === 1 ? "thread" : "threads"}${where}`;
  if (input.total === 0) return "no threads yet";
  const threads = `${input.total} ${input.total === 1 ? "thread" : "threads"}`;
  return input.unread > 0 ? `${threads}, ${input.unread} unread` : threads;
};

/** Clear everything the operator narrowed: the region pick, the words, Unread and the seat. */
export const clearThreadsFilters = (): void => {
  threadsView$.region.set(undefined);
  threadsView$.query.set("");
  threadsView$.unread.set(false);
  threadsView$.seat.set(undefined);
};

/** A seat chip's press: the seat becomes the one kept, or leaves when it already is. */
export const toggleThreadsSeat = (seatId: string): void => {
  threadsView$.seat.set(threadsView$.seat.peek() === seatId ? undefined : seatId);
};

/**
 * Keep a selection through a list change: a row that left hands it to its
 * nearest neighbour still there, next first; nothing picked takes the first.
 */
export const reconcileThreadSelection = (
  previous: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
  selected: string | null,
): string | null => {
  const live = new Set(current);
  if (selected !== null && live.has(selected)) return selected;
  const index = selected === null ? -1 : previous.indexOf(selected);
  if (index !== -1) {
    const after = previous.slice(index + 1).find((key) => live.has(key));
    if (after !== undefined) return after;
    const before = previous.slice(0, index).reverse().find((key) => live.has(key));
    if (before !== undefined) return before;
  }
  return current[0] ?? null;
};
