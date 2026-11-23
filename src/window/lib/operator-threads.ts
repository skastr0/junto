/**
 * Global threads: the operator's threads across every seat of a canvas, for
 * the Threads modal. Only threads the operator is in, one row per thread, each
 * carrying its seat, its region, its line, its last mail and the operator's
 * unread in it (src/shared/operator-threads.ts holds the shapes).
 *
 * Main owns the threads, derived in the core. This module reads them a page at
 * a time, and watches the filter it reads under: the core pushes the rows that
 * changed, and they are laid into what is held. A change never reads the list
 * again. Never writes the canvas.
 *
 * Order: newest first. `urgentFirst` puts the seats a caller ranked with the
 * one ladder (`seatUrgencyOrder`, src/window/lib/urgency-order.ts) ahead, in
 * that order, each seat's threads newest first; the rest follow, newest first.
 * The seats put first are read whole, so their order never has a gap.
 *
 * The source is main's operator threads IPC on `window.junto`, imported as
 * types only: no Effect runtime here. A test installs its own.
 */
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type {
  OperatorThreadRow,
  OperatorThreadsChanged,
  OperatorThreadsFilter,
  OperatorThreadsPage,
  OperatorThreadsPageQuery,
  OperatorThreadsRegionCount,
  OperatorThreadsSeatCount,
} from "@shared/operator-threads";
import { getJuntoApi } from "./junto-api";

export type { OperatorThreadRow, OperatorThreadsRegionCount, OperatorThreadsSeatCount };

/** What the modal shows: a canvas, narrowed by region and search, and the seats it puts first. */
export type OperatorThreadsView = {
  readonly canvasName: string;
  /** A picked region's path, as the Needs you feed picks one; absent is every region. */
  readonly region?: ReadonlyArray<string>;
  /** Words, each of which must appear; blank is no search. */
  readonly search?: string;
  /** Only threads with mail the operator has not read. */
  readonly unread?: boolean;
  /** Only the threads of this seat: the Seats toggle's one kept seat. */
  readonly seat?: string;
  /** Seats whose threads come first, in this order: `seatUrgencyOrder` with the calm left out. Absent or empty is newest first. */
  readonly urgentFirst?: ReadonlyArray<string>;
};

export type OperatorThreadsState = {
  /** The rows held, in the view's order. */
  readonly rows: ReadonlyArray<OperatorThreadRow>;
  readonly loaded: boolean;
  /** Why the last read failed; empty when it did not. */
  readonly error: string;
  /** Every row the filter holds, never the page. */
  readonly total: number;
  /** The operator's unread over every row the filter holds. */
  readonly unread: number;
  /** Each region with threads under the view with its region left out, and its counts: the region strip. */
  readonly regions: ReadonlyArray<OperatorThreadsRegionCount>;
  /** Each seat with threads under the view with its seat left out, and its counts: the seat strip. */
  readonly seatCounts: ReadonlyArray<OperatorThreadsSeatCount>;
  /** Older rows wait to be read (`loadMoreOperatorThreads`). */
  readonly hasMore: boolean;
  readonly loadingMore?: true;
};

/** What reads the operator's threads. */
export type OperatorThreadsSource = {
  readonly list: (query: OperatorThreadsPageQuery) => Promise<OperatorThreadsPage>;
  readonly watch: (filter: OperatorThreadsFilter) => Promise<{ readonly watchId: string }>;
  readonly unwatch: (watchId: string) => Promise<void>;
  readonly onChanged: (listener: (change: OperatorThreadsChanged) => void) => () => void;
};

/** Rows in a page: the first on open, and each older page as the list nears its end. */
export const OPERATOR_THREADS_PAGE = 50;
/** The most pages the seats put first are read in, so a canvas where every seat is urgent still opens. */
const URGENT_PAGES_MAX = 20;

/** The source over main's IPC, or undefined while the bridge lacks it. */
export const juntoOperatorThreadsSource = (): OperatorThreadsSource | undefined => {
  const api = getJuntoApi();
  const list = api?.operatorThreadsList;
  const watch = api?.operatorThreadsWatch;
  const unwatch = api?.operatorThreadsUnwatch;
  const onChanged = api?.onOperatorThreadsChanged;
  if (typeof list !== "function" || typeof watch !== "function" || typeof unwatch !== "function" || typeof onChanged !== "function") {
    return undefined;
  }
  return { list, watch, unwatch: (watchId) => unwatch({ watchId }), onChanged };
};

let installed: OperatorThreadsSource | undefined;
let bridged: OperatorThreadsSource | undefined;
const activeSource = (): OperatorThreadsSource | undefined => installed ?? (bridged ??= juntoOperatorThreadsSource());

// ---- Order ----

const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Newest activity first; the thread id breaks a tie, as the core orders them. */
export const byActivity = (a: Pick<OperatorThreadRow, "lastAt" | "threadId">, b: Pick<OperatorThreadRow, "lastAt" | "threadId">): number =>
  b.lastAt - a.lastAt || compareId(b.threadId, a.threadId);

/** Where a row's seats stand among those put first; undefined when none of them is. */
const urgentPlace = (row: OperatorThreadRow, place: ReadonlyMap<string, number>): number | undefined => {
  let best = place.get(row.seat.nodeId);
  for (const seat of row.alsoSeats ?? []) {
    const at = place.get(seat.nodeId);
    if (at !== undefined && (best === undefined || at < best)) best = at;
  }
  return best;
};

/** The view's order: the seats put first, in their order, then the rest; newest first within each. */
const viewOrder = (place: ReadonlyMap<string, number>) => (a: OperatorThreadRow, b: OperatorThreadRow): number => {
  const pa = urgentPlace(a, place) ?? Number.POSITIVE_INFINITY;
  const pb = urgentPlace(b, place) ?? Number.POSITIVE_INFINITY;
  return pa !== pb ? (pa < pb ? -1 : 1) : byActivity(a, b);
};

// ---- What is held ----

const filterKey = (view: Pick<OperatorThreadsView, "canvasName" | "region" | "search" | "unread" | "seat">): string =>
  [
    view.canvasName,
    view.region === undefined ? "*" : `r:${view.region.join("\u0001")}`,
    (view.search ?? "").trim().toLowerCase(),
    view.unread === true ? "unread" : "",
    view.seat ?? "",
  ].join("\u0000");

const filterOf = (view: OperatorThreadsView): OperatorThreadsFilter => {
  const search = view.search?.trim() ?? "";
  return {
    canvasName: view.canvasName,
    ...(view.region === undefined ? {} : { region: [...view.region] }),
    ...(search === "" ? {} : { search }),
    ...(view.unread === true ? { unread: true as const } : {}),
    ...(view.seat === undefined ? {} : { seats: [view.seat] }),
  };
};

type Held = {
  readonly filter: OperatorThreadsFilter;
  users: number;
  /** The seats put first, in order. */
  urgent: ReadonlyArray<string>;
  /** The threads of the seats put first, read whole. */
  readonly first: Map<string, OperatorThreadRow>;
  /** Every thread of the filter read so far, newest first, up to `next`. */
  readonly all: Map<string, OperatorThreadRow>;
  /** Where the list of every thread goes on; undefined once it has ended. */
  next: string | undefined;
  /** The newest change laid in, or the page read; anything at or before it is held already. */
  generation: number;
  watchId?: string;
  /** Changes that came while the head was being read, laid after it lands. */
  pending?: OperatorThreadsChanged[];
  total: number;
  unread: number;
  regions: ReadonlyArray<OperatorThreadsRegionCount>;
  seatCounts: ReadonlyArray<OperatorThreadsSeatCount>;
  loaded: boolean;
  error: string;
  loadingMore: boolean;
  /** Bumped by each head read, so a page read before it is not laid over it. */
  epoch: number;
};

const held = new Map<string, Held>();
const NO_ROWS: OperatorThreadsState = { rows: [], loaded: false, error: "", total: 0, unread: 0, regions: [], seatCounts: [], hasMore: false };

export const operatorThreads$ = observable<{ readonly lists: Record<string, OperatorThreadsState | undefined> }>({ lists: {} });

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the modal reads: the two lists as one, in the view's order. */
const publish = (key: string, list: Held): void => {
  const place = new Map(list.urgent.map((seat, index) => [seat, index] as const));
  const rows = new Map(list.all);
  for (const [id, row] of list.first) rows.set(id, row);
  operatorThreads$.lists[key].set({
    rows: [...rows.values()].sort(viewOrder(place)),
    loaded: list.loaded,
    error: list.error,
    total: list.total,
    unread: list.unread,
    regions: list.regions,
    seatCounts: list.seatCounts,
    hasMore: list.next !== undefined,
    ...(list.loadingMore ? { loadingMore: true as const } : {}),
  });
};

/** A row's seats meet the seats put first. */
const isUrgent = (row: OperatorThreadRow, urgent: ReadonlySet<string>): boolean =>
  urgent.has(row.seat.nodeId) || (row.alsoSeats ?? []).some((seat) => urgent.has(seat.nodeId));

/** The far end of what the list of every thread holds: a row past it waits for its page. */
const farEnd = (list: Held): OperatorThreadRow | undefined => {
  let far: OperatorThreadRow | undefined;
  for (const row of list.all.values()) if (far === undefined || byActivity(row, far) > 0) far = row;
  return far;
};

/** One change laid in: what came or moved takes its place, what left goes. */
const lay = (list: Held, change: OperatorThreadsChanged): void => {
  if (change.generation <= list.generation) return;
  list.generation = change.generation;
  const urgent = new Set(list.urgent);
  const far = list.next === undefined ? undefined : farEnd(list);
  for (const id of change.gone) {
    list.first.delete(id);
    list.all.delete(id);
  }
  for (const row of change.rows) {
    if (isUrgent(row, urgent)) list.first.set(row.threadId, row);
    else list.first.delete(row.threadId);
    // Past the far end of a list that goes on, a row waits for its page; inside it, it takes its place.
    if (far === undefined || byActivity(row, far) <= 0) list.all.set(row.threadId, row);
    else list.all.delete(row.threadId);
  }
  list.total = change.total;
  list.unread = change.unread;
  list.regions = change.regions;
  list.seatCounts = change.seatCounts;
};

/** The threads of the seats put first, read whole (up to `URGENT_PAGES_MAX` pages). */
const readFirst = async (read: OperatorThreadsSource, list: Held): Promise<{ rows: OperatorThreadRow[]; generation: number }> => {
  const rows: OperatorThreadRow[] = [];
  // A view kept to some seats puts first only those of them that are urgent.
  const kept = list.filter.seats;
  const seats = kept === undefined ? [...list.urgent] : list.urgent.filter((seat) => kept.includes(seat));
  if (seats.length === 0) return { rows, generation: 0 };
  let after: string | undefined;
  let generation = 0;
  for (let pages = 0; pages < URGENT_PAGES_MAX; pages += 1) {
    const page = await read.list({ ...list.filter, seats, limit: 200, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows);
    generation = Math.max(generation, page.generation);
    if (page.next === undefined) break;
    after = page.next;
  }
  return { rows, generation };
};

/** The head read: the first page of every thread, and the seats put first whole. Changes that come meanwhile are laid after it. */
const readHead = async (key: string): Promise<void> => {
  const list = held.get(key);
  const read = activeSource();
  if (list === undefined || read === undefined) return;
  const epoch = (list.epoch += 1);
  list.pending ??= [];
  try {
    const [page, first] = await Promise.all([read.list({ ...list.filter, limit: OPERATOR_THREADS_PAGE }), readFirst(read, list)]);
    if (held.get(key) !== list || list.epoch !== epoch || activeSource() !== read) return;
    list.all.clear();
    for (const row of page.rows) list.all.set(row.threadId, row);
    list.first.clear();
    for (const row of first.rows) list.first.set(row.threadId, row);
    list.next = page.next;
    list.total = page.total;
    list.unread = page.unread;
    list.regions = page.regions;
    list.seatCounts = page.seatCounts;
    // The older of the two reads is where the held rows stand: a change after it is laid.
    list.generation = first.rows.length === 0 ? page.generation : Math.min(page.generation, first.generation);
    list.loaded = true;
    list.error = "";
    const pending = list.pending ?? [];
    list.pending = undefined;
    for (const change of pending) lay(list, change);
  } catch (error) {
    if (held.get(key) !== list || list.epoch !== epoch) return;
    list.pending = undefined;
    list.loaded = true;
    list.error = errorText(error);
  }
  publish(key, list);
};

let offChanged: (() => void) | undefined;

const listen = (read: OperatorThreadsSource): void => {
  offChanged ??= read.onChanged((change) => {
    for (const [key, list] of held) {
      if (list.watchId !== change.watchId) continue;
      if (list.pending !== undefined) list.pending.push(change);
      else {
        lay(list, change);
        publish(key, list);
      }
    }
  });
};

const startWatch = async (key: string, list: Held, read: OperatorThreadsSource): Promise<void> => {
  listen(read);
  try {
    const { watchId } = await read.watch(list.filter);
    if (held.get(key) !== list) {
      void read.unwatch(watchId).catch(() => undefined);
      return;
    }
    list.watchId = watchId;
  } catch {
    // Without a watch the list still reads; it follows changes again when it is next retained.
  }
};

/**
 * Keep the view's list read and current; the returned function lets go. A
 * view that differs only in the seats it puts first shares the list, and the
 * new order reads those seats again.
 */
export const retainOperatorThreads = (view: OperatorThreadsView): (() => void) => {
  const key = filterKey(view);
  const urgent = [...(view.urgentFirst ?? [])];
  let list = held.get(key);
  const read = activeSource();
  if (list === undefined) {
    list = {
      filter: filterOf(view),
      users: 0,
      urgent,
      first: new Map(),
      all: new Map(),
      next: undefined,
      generation: -1,
      total: 0,
      unread: 0,
      regions: [],
      seatCounts: [],
      loaded: false,
      error: "",
      loadingMore: false,
      epoch: 0,
    };
    held.set(key, list);
    // The watch first, so no change between the read and the watch is missed: one that lands during the read is laid after it.
    list.pending = [];
    if (read !== undefined) void startWatch(key, list, read).then(() => readHead(key));
  } else if (urgent.join("\u0000") !== list.urgent.join("\u0000")) {
    list.urgent = urgent;
    void readHead(key);
  }
  list.users += 1;
  let released = false;
  const mine = list;
  return () => {
    if (released) return;
    released = true;
    mine.users -= 1;
    if (mine.users > 0 || held.get(key) !== mine) return;
    held.delete(key);
    operatorThreads$.lists[key].delete();
    if (mine.watchId !== undefined) void activeSource()?.unwatch(mine.watchId).catch(() => undefined);
    if (held.size === 0) {
      offChanged?.();
      offChanged = undefined;
    }
  };
};

/** The next older page of the view's list, when there is one and none is being read. */
export const loadMoreOperatorThreads = async (view: OperatorThreadsView): Promise<void> => {
  const key = filterKey(view);
  const list = held.get(key);
  const read = activeSource();
  const after = list?.next;
  if (list === undefined || read === undefined || after === undefined || list.loadingMore || !list.loaded) return;
  list.loadingMore = true;
  publish(key, list);
  const epoch = list.epoch;
  try {
    const page = await read.list({ ...list.filter, limit: OPERATOR_THREADS_PAGE, after });
    if (held.get(key) !== list || list.epoch !== epoch) return;
    // A row a change already laid is newer than the page's: the page does not undo it.
    for (const row of page.rows) if (!list.all.has(row.threadId)) list.all.set(row.threadId, row);
    if (list.next === after) list.next = page.next;
    list.error = "";
  } catch (error) {
    if (held.get(key) === list) list.error = errorText(error);
  } finally {
    list.loadingMore = false;
    if (held.get(key) === list) publish(key, list);
  }
};

/** The view's list, retained while mounted. */
export const useOperatorThreads = (view: OperatorThreadsView, enabled = true): OperatorThreadsState => {
  const key = filterKey(view);
  const urgent = (view.urgentFirst ?? []).join("\u0000");
  useEffect(() => {
    if (!enabled || !view.canvasName) return;
    return retainOperatorThreads(view);
    // The view is named by its key and its order; a new object of the same view retains nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, urgent, enabled]);
  return use$(() => operatorThreads$.lists[key].get()) ?? NO_ROWS;
};

/** Install a source over main's (or drop it with undefined): every held list watches and reads again. */
export const setOperatorThreadsSource = (next: OperatorThreadsSource | undefined): void => {
  offChanged?.();
  offChanged = undefined;
  installed = next;
  const read = activeSource();
  for (const [key, list] of held) {
    list.watchId = undefined;
    list.generation = -1;
    list.pending = [];
    if (read !== undefined) void startWatch(key, list, read).then(() => readHead(key));
  }
};

/** Test helper: forget every list and source. */
export const resetOperatorThreads = (): void => {
  offChanged?.();
  offChanged = undefined;
  installed = undefined;
  bridged = undefined;
  held.clear();
  operatorThreads$.set({ lists: {} });
};
