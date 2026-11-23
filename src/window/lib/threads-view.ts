/**
 * Threads, the operator modal: what its list shows and in what order. The
 * operator's threads across every seat, one row each, flat (the row carries
 * its region; sections would break recency). The same region pick, seat
 * pick and search as the needs-you feed, plus one Unread chip where the
 * feed has its kinds.
 *
 * The core read answers the rows: it narrows by region, words and seat, and
 * counts the total and the unread over everything the filter holds, never a
 * page. This module says what to ask it and how to draw what comes back.
 *
 * Pure but for the view state, which is session-lived and module-scoped like
 * the feed's (feedView$): it survives the modal's open and close without
 * pretending to be a preference.
 */
import { observable } from "@legendapp/state";
import type { FeedRegion, FeedSeatChip } from "@shared/operator-feed";
import { seatChipsOf } from "@shared/operator-feed";
import type { MailParty } from "@shared/wire/mail-threads";
import type { ResourceSubject } from "@shared/wire/thread-subject";
import { compareView, SeatUrgency } from "@shared/wire/urgency";
import { regionChipsOf, regionPickName, type FeedRegionChip, type FeedRegionPick } from "./operator-feed";
import type { SeatGroup } from "./seat-line";
import type { SeatThreadSummary } from "./seat-threads";

/**
 * One row: a thread between the operator and one seat, as the core's
 * operator threads read answers it (OperatorThreadRow,
 * src/shared/operator-threads.ts), held here by what the list draws.
 */
export type ThreadRow = {
  readonly threadId: string;
  /** The seat the operator talks with in it; its seat view holds the thread. */
  readonly seat: { readonly nodeId: string; readonly name: string; readonly portraitIdentity: string };
  readonly region: FeedRegion;
  /** The thread's line: a subject's name, else its root mail's first line. */
  readonly title: string;
  readonly startedAt: number;
  readonly lastAt: number;
  readonly last: { readonly messageId: string; readonly from: MailParty; readonly text: string; readonly at: number };
  readonly messageCount: number;
  readonly unread: number;
  readonly readAt?: number;
  readonly subject?: ResourceSubject;
};

/** A row's one key across every seat: a thread id is a mail id, and two seats' views may hold it. */
export const threadRowKey = (row: Pick<ThreadRow, "seat" | "threadId">): string => `${row.seat.nodeId}\n${row.threadId}`;

/** The operator wrote the row's last mail. */
export const lastIsMine = (row: Pick<ThreadRow, "last">): boolean => row.last.from.kind === "operator";

/**
 * The row as the one thread chat takes it (ThreadChat, the seat view's
 * SeatThreadSummary). Every row is a thread the operator is in, so it can
 * be answered.
 */
export const seatSummaryOf = (row: ThreadRow): SeatThreadSummary => ({
  threadId: row.threadId,
  title: row.title,
  participants: ["you", row.seat.name],
  startedAt: row.startedAt,
  lastAt: row.lastAt,
  last: {
    messageId: row.last.messageId,
    author: row.last.from.kind === "operator" ? "you" : row.last.from.name,
    mine: lastIsMine(row),
    text: row.last.text,
    at: row.last.at,
  },
  messageCount: row.messageCount,
  canReply: true,
  unread: row.unread,
  ...(row.readAt === undefined ? {} : { readAt: row.readAt }),
  ...(row.subject === undefined ? {} : { subject: row.subject }),
});

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

/**
 * What the core read is asked for (OperatorThreadsFilter): the canvas, the
 * picked region, the words and the kept seat. The words are matched there,
 * over every mail of every thread, never over the rows the window holds.
 */
export const threadsReadFilter = (
  view: {
    readonly region: FeedRegionPick | undefined;
    readonly query: string;
    readonly seat: string | undefined;
  },
  canvasName: string,
): {
  readonly canvasName: string;
  readonly region?: ReadonlyArray<string>;
  readonly search?: string;
  readonly seats?: ReadonlyArray<string>;
} => {
  const search = view.query.trim();
  return {
    canvasName,
    ...(view.region?.canvasName === canvasName ? { region: view.region.path } : {}),
    ...(search === "" ? {} : { search }),
    ...(view.seat === undefined ? {} : { seats: [view.seat] }),
  };
};

/** Whether the operator narrowed anything besides a region: the surface offers to clear it. */
export const threadsFilterOn = (view: { readonly query: string; readonly unread: boolean; readonly seat: string | undefined }): boolean =>
  view.query.trim() !== "" || view.unread || view.seat !== undefined;

/** Unread keeps the threads with mail the operator has not read. */
export const keepUnread = (rows: ReadonlyArray<ThreadRow>, unread: boolean): ReadonlyArray<ThreadRow> =>
  unread ? rows.filter((row) => row.unread > 0) : rows;

/** Newest activity first; ties by seat then thread, so the order never flickers. */
const byRecency = (a: ThreadRow, b: ThreadRow): number =>
  b.lastAt - a.lastAt || a.seat.name.localeCompare(b.seat.name) || a.threadId.localeCompare(b.threadId);

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
  return [...rows].sort((a, b) => compare(groupOf(a.seat.nodeId), groupOf(b.seat.nodeId)) || byRecency(a, b));
};

/**
 * The seats in the order Most urgent first reads them: one list per group of
 * the rail's view, most urgent first, empty groups left out. The core keeps
 * no urgency, so the window reads each group's threads in turn through the
 * read's `seats` filter, newest first within each.
 */
export const seatsByUrgency = (
  seatIds: ReadonlyArray<string>,
  urgencyOf: (seatId: string) => SeatGroup | undefined,
): ReadonlyArray<ReadonlyArray<string>> => {
  const byGroup = new Map<SeatGroup, string[]>();
  for (const seatId of seatIds) {
    const group = urgencyOf(seatId) ?? SeatUrgency.group.offline;
    const held = byGroup.get(group);
    if (held) held.push(seatId);
    else byGroup.set(group, [seatId]);
  }
  const compare = compareView(SeatUrgency);
  return [...byGroup.entries()].sort(([a], [b]) => compare(a, b)).map(([, seats]) => seats);
};

/**
 * The region strip's chips over the rows: each region a row's seat sits in,
 * most recent first, counting its unread threads.
 */
export const threadRegionChips = (
  rows: ReadonlyArray<ThreadRow>,
  pick?: ReadonlyArray<string>,
): ReadonlyArray<FeedRegionChip> =>
  regionChipsOf(
    [...rows].sort(byRecency).map((row) => ({ region: row.region, count: row.unread > 0 ? 1 : 0 })),
    pick,
  );

/** The seat chips over the rows: one per seat, the most threads first, counting threads. */
export const threadSeatChips = (rows: ReadonlyArray<ThreadRow>): ReadonlyArray<FeedSeatChip> =>
  seatChipsOf(rows.map((row) => ({ seatId: row.seat.nodeId, name: row.seat.name, region: row.region })));

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
