/**
 * Threads, the operator modal: what its list asks for and how it draws what
 * comes back. The operator's threads across every seat, one row each, flat
 * (the row carries its region; sections would break recency). The same
 * region pick, seat pick and search as the needs-you feed, plus one Unread
 * chip where the feed has its kinds.
 *
 * The store (operator-threads.ts, over the core's read) answers the rows: it
 * narrows by region, words, unread and seat, puts the seats asked for first,
 * pages, and counts the total, the unread, each region and each seat over
 * everything the filter holds, never a page. This module says what to ask it.
 *
 * Pure but for the view state, which is session-lived and module-scoped like
 * the feed's (feedView$): it survives the modal's open and close without
 * pretending to be a preference.
 */
import { observable } from "@legendapp/state";
import type { Seat } from "@shared/model";
import type { FeedSeatChip } from "@shared/operator-feed";
import { SeatUrgency } from "@shared/wire/urgency";
import { regionChipsOf, regionPickName, type FeedRegionChip, type FeedRegionPick } from "./operator-feed";
import type { OperatorThreadRow, OperatorThreadsRegionCount, OperatorThreadsSeatCount, OperatorThreadsView } from "./operator-threads";
import type { SeatGroup } from "./seat-line";
import type { SeatThreadSummary } from "./seat-threads";
import { seatUrgencyOrder } from "./urgency-order";

/** One row: a thread between the operator and a seat; one per thread id. */
export type ThreadRow = OperatorThreadRow;

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
  participants: ["you", row.seat.name, ...(row.alsoSeats ?? []).map((seat) => seat.name)],
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

/** A seat kept, by node id, on its canvas: a pick never follows the operator to another canvas. */
export type ThreadsSeatPick = { readonly canvasName: string; readonly seatId: string };

/** The kept seat's id on this canvas, or undefined when none is kept here. */
export const threadsSeatOn = (pick: ThreadsSeatPick | undefined, canvasName: string): string | undefined =>
  pick?.canvasName === canvasName ? pick.seatId : undefined;

export const threadsView$ = observable<{
  region: FeedRegionPick | undefined;
  order: ThreadsOrder;
  /** Words the core read finds in a thread's line, its seat's name or any of its mail; empty finds everything. */
  query: string;
  /** Only threads with mail the operator has not read. */
  unread: boolean;
  /** The one seat kept, on the canvas it was picked on; undefined keeps every seat. */
  seat: ThreadsSeatPick | undefined;
  /** Whether the seat chips are unfolded; folded by default, as in the feed. */
  seatsOpen: boolean;
}>({ region: undefined, order: "newest", query: "", unread: false, seat: undefined, seatsOpen: false });

/** The rail's groups that ask for the operator; the calm ones (working, resting, offline) keep recency. */
const URGENT_GROUPS: ReadonlySet<SeatGroup> = new Set([
  SeatUrgency.group.blocked,
  SeatUrgency.group.waiting,
  SeatUrgency.group.review,
  SeatUrgency.group.done,
]);

/**
 * The seats Most urgent first puts first: the canvas's seats in the order
 * the rail and the step keys read them (seatUrgencyOrder), the calm left
 * out. `urgencyOf` is read once by the caller, so the order holds still
 * while the operator moves through it.
 */
export const urgentSeatsFirst = <S extends Seat>(
  seats: ReadonlyArray<S>,
  urgencyOf: (seat: S) => SeatGroup,
): ReadonlyArray<string> => {
  const groups = new Map(seats.map((seat) => [seat.id, urgencyOf(seat)] as const));
  return seatUrgencyOrder(seats, (seat) => groups.get(seat.id)!)
    .filter((seat) => URGENT_GROUPS.has(groups.get(seat.id)!))
    .map((seat) => seat.id);
};

/** What the store is asked for: the canvas, the picked region, the words, Unread, the seat and the seats put first. */
export const threadsStoreView = (
  view: {
    readonly region: FeedRegionPick | undefined;
    readonly query: string;
    readonly unread: boolean;
    readonly seat: string | undefined;
    readonly order: ThreadsOrder;
  },
  canvasName: string,
  urgentFirst: ReadonlyArray<string>,
): OperatorThreadsView => {
  const search = view.query.trim();
  return {
    canvasName,
    ...(view.region?.canvasName === canvasName ? { region: view.region.path } : {}),
    ...(search === "" ? {} : { search }),
    ...(view.unread ? { unread: true } : {}),
    ...(view.seat === undefined ? {} : { seat: view.seat }),
    ...(view.order === "urgency" && urgentFirst.length > 0 ? { urgentFirst } : {}),
  };
};

/** Whether the operator narrowed anything besides a region: the surface offers to clear it. */
export const threadsFilterOn = (view: { readonly query: string; readonly unread: boolean; readonly seat: string | undefined }): boolean =>
  view.query.trim() !== "" || view.unread || view.seat !== undefined;

/**
 * The region strip's chips from the store's counts, each the innermost
 * region a seat sits in: a parent counts its children, and a chip counts
 * the operator's unread there.
 */
export const threadRegionChips = (
  regions: ReadonlyArray<OperatorThreadsRegionCount>,
  pick?: ReadonlyArray<string>,
): ReadonlyArray<FeedRegionChip> =>
  regionChipsOf(
    regions.map((entry) => ({ region: entry.region, count: entry.unread })),
    pick,
  );

/**
 * The seat chips from the store's counts, over the filter with its seat left
 * out: one per seat, the most threads first, counting threads.
 */
export const threadSeatChips = (counts: ReadonlyArray<OperatorThreadsSeatCount>): ReadonlyArray<FeedSeatChip> =>
  [...counts]
    .map(
      (count): FeedSeatChip => ({
        seatId: count.seat.nodeId,
        name: count.seat.name,
        count: count.total,
        regionLabel: count.region.label,
        regionPath: count.region.path,
        open: count.region.path.length === 0,
        color: count.region.color,
      }),
    )
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

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
export const toggleThreadsSeat = (canvasName: string, seatId: string): void => {
  threadsView$.seat.set(threadsSeatOn(threadsView$.seat.peek(), canvasName) === seatId ? undefined : { canvasName, seatId });
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
