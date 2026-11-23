/**
 * Threads across every seat of a canvas: one row per thread, newest activity
 * first, a page at a time, read from the canvas's thread index
 * (`canvasThreads`, work/operator-threads.ts). One read serves the window's
 * Global threads (the operator's threads) and the CLI's overseer list (every
 * thread, between seats included).
 *
 * `who` says which threads: `operator`, those the operator is in; `all`,
 * every one. The filter narrows by seats, region, search and unread.
 * `regions` counts the filter with its region left out, `seatCounts` with its
 * seats left out, so a strip names every region and seat that has threads.
 *
 * The operator's read points ride only a read that asks for them: a seat's or
 * an overseer's read shows no unread and moves no point.
 *
 * Watches: a window names a filter, and each change to the canvas's mail, its
 * read points or the canvas itself (a rename, a seat moved region) pushes the
 * rows that came, moved or left under it, never the list. A burst of changes
 * is one pass. Every page and change is stamped with the canvas's generation,
 * so a reader lays a change only over what is older than it.
 *
 * Nothing is stored: no table, no column. Mail text never leaves in a log.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ulid } from "ulid";
import { asNodeId, type Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { feedRegionForCanvas } from "@shared/operator-feed";
import { operatorIn, summaryOf, unreadPast, type MailReadPoint, type MailThreadsInput } from "@shared/mail-threads";
import {
  OPERATOR_THREAD_PREVIEW_MAX,
  OPERATOR_THREADS_PAGE_DEFAULT,
  OPERATOR_THREADS_PAGE_MAX,
  type OperatorThreadRow,
  type OperatorThreadSeat,
  type OperatorThreadsChanged,
  type OperatorThreadsFilterDecoded,
  type OperatorThreadsPage,
  type OperatorThreadsRegionCount,
  type OperatorThreadsSeatCount,
} from "@shared/operator-threads";
import type { FeedRegion } from "@shared/wire/operator-feed";
import type { MailThreadMessage } from "@shared/wire/mail-threads";
import { canvasPoints } from "./mail-reads";
import { canvasThreads } from "./operator-threads";

/** Which threads a read holds: those the operator is in, or every one. */
export type ThreadRowsWho = "operator" | "all";

/** What narrows a read, the canvas apart. */
export type ThreadRowsFilter = Omit<OperatorThreadsFilterDecoded, "canvasName">;

export type ThreadRowsQuery = ThreadRowsFilter & {
  readonly who: ThreadRowsWho;
  readonly limit?: number;
  readonly after?: string;
};

// ---- Generations ----

const generations = new Map<string, number>();

/** The canvas's next stamp: every page and change takes one, so later is always larger. */
const nextGeneration = (canvasName: string): number => {
  const next = (generations.get(canvasName) ?? 0) + 1;
  generations.set(canvasName, next);
  return next;
};

// ---- One thread, as a read sees it ----

type Thread = {
  readonly threadId: string;
  readonly entries: ReadonlyArray<MailThreadMessage>;
  readonly lastAt: number;
  readonly seat: OperatorThreadSeat;
  readonly region: FeedRegion;
  readonly alsoSeats: ReadonlyArray<OperatorThreadSeat>;
  readonly point: MailReadPoint | undefined;
  readonly unread: number;
};

const seatOf = (canvas: Canvas, nodeId: string): OperatorThreadSeat | undefined => {
  const node = canvas.nodes.get(asNodeId(nodeId));
  return node === undefined ? undefined : { nodeId, name: titleOf(node), portraitIdentity: nodeId };
};

/**
 * The seat a thread is with: the first seat the operator wrote to in it, or
 * the first that wrote to them; between seats, its first mail's recipient.
 * That seat's own view holds the thread.
 */
const counterpartOf = (entries: ReadonlyArray<MailThreadMessage>): string | undefined => {
  for (const entry of entries) {
    if (entry.mine) {
      const to = entry.to.find((party) => party.kind === "seat");
      if (to?.kind === "seat") return to.nodeId;
    } else if (entry.from.kind === "seat" && entry.to.some((party) => party.kind === "operator")) {
      return entry.from.nodeId;
    }
  }
  const first = entries[0];
  if (first === undefined) return undefined;
  const to = first.to.find((party) => party.kind === "seat");
  if (to?.kind === "seat") return to.nodeId;
  return first.from.kind === "seat" ? first.from.nodeId : undefined;
};

const seatsOf = (entries: ReadonlyArray<MailThreadMessage>): ReadonlyArray<string> => {
  const seats = new Set<string>();
  for (const entry of entries) {
    if (entry.from.kind === "seat") seats.add(entry.from.nodeId);
    for (const party of entry.to) if (party.kind === "seat") seats.add(party.nodeId);
  }
  return [...seats];
};

/** What a search looks in, per thread mail as held: its mail's words, in lower case. Kept as long as the mail is. */
const haystacks = new WeakMap<ReadonlyArray<MailThreadMessage>, string>();

const haystackOf = (entries: ReadonlyArray<MailThreadMessage>): string => {
  let held = haystacks.get(entries);
  if (held === undefined) {
    held = entries.map((entry) => entry.text).join("\n").toLowerCase();
    haystacks.set(entries, held);
  }
  return held;
};

/** The search's words, in lower case; none for a blank search. */
const wordsOf = (search: string | undefined): ReadonlyArray<string> =>
  (search ?? "").toLowerCase().split(/\s+/u).filter((word) => word.length > 0);

/** A region is under a picked path: itself or a child. The empty path is the open field alone (as the feed's `regionMatches`). */
const regionUnder = (path: ReadonlyArray<string>, region: FeedRegion): boolean =>
  path.length === 0
    ? region.path.length === 0
    : path.length <= region.path.length && path.every((label, index) => region.path[index] === label);

const regionKey = (region: FeedRegion): string => `${region.regionId ?? ""}\u0000${region.path.join("\u0001")}`;

/** Newest activity first; the thread id breaks a tie (as `seatMailThreadsPage`). */
const byActivity = (a: Pick<Thread, "lastAt" | "threadId">, b: Pick<Thread, "lastAt" | "threadId">): number =>
  b.lastAt - a.lastAt || (a.threadId < b.threadId ? 1 : a.threadId > b.threadId ? -1 : 0);

/** A cursor is the sort key of a page's last row, `<time>.<thread id>`, as a seat's own list writes it. */
const cursorOf = (thread: Pick<Thread, "lastAt" | "threadId">): string => `${thread.lastAt}.${thread.threadId}`;

const readCursor = (cursor: string | undefined): { readonly lastAt: number; readonly threadId: string } | undefined => {
  if (cursor === undefined) return undefined;
  const dot = cursor.indexOf(".");
  const lastAt = Number(cursor.slice(0, dot));
  return dot > 0 && Number.isFinite(lastAt) ? { lastAt, threadId: cursor.slice(dot + 1) } : undefined;
};

type View = {
  readonly canvas: Canvas;
  readonly input: MailThreadsInput;
  readonly threads: () => Iterable<readonly [string, ReadonlyArray<MailThreadMessage>]>;
};

/** Every thread `who` holds on the canvas, with its seat, region and read state; a thread whose seat left the canvas is not. */
const threadsOf = (view: View, who: ThreadRowsWho, points: ReadonlyMap<string, MailReadPoint> | undefined): Thread[] => {
  const out: Thread[] = [];
  for (const [threadId, entries] of view.threads()) {
    const last = entries[entries.length - 1];
    if (last === undefined) continue;
    if (who === "operator" && !operatorIn(entries)) continue;
    const counterpart = counterpartOf(entries);
    const seat = counterpart === undefined ? undefined : seatOf(view.canvas, counterpart);
    if (seat === undefined) continue;
    const alsoSeats = seatsOf(entries).flatMap((nodeId) => {
      if (nodeId === seat.nodeId) return [];
      const also = seatOf(view.canvas, nodeId);
      return also === undefined ? [] : [also];
    });
    const point = points?.get(threadId);
    out.push({
      threadId,
      entries,
      lastAt: last.at,
      seat,
      region: feedRegionForCanvas(view.canvas, seat.nodeId),
      alsoSeats,
      point,
      unread: points === undefined ? 0 : unreadPast(entries, point),
    });
  }
  return out;
};

/** Each part of a filter on its own, so the strips can leave one out. */
const matcher = (filter: ThreadRowsFilter) => {
  const words = wordsOf(filter.search);
  const seats = filter.seats === undefined ? undefined : new Set<string>(filter.seats);
  const region = filter.region;
  return {
    rest: (thread: Thread): boolean => {
      if (filter.unread === true && thread.unread === 0) return false;
      if (words.length === 0) return true;
      const names = [thread.seat.name, ...thread.alsoSeats.map((seat) => seat.name)].join("\n").toLowerCase();
      const title = summaryTitle(thread).toLowerCase();
      const hay = haystackOf(thread.entries);
      return words.every((word) => hay.includes(word) || names.includes(word) || title.includes(word));
    },
    seats: (thread: Thread): boolean =>
      seats === undefined || seats.has(thread.seat.nodeId) || thread.alsoSeats.some((seat) => seats.has(seat.nodeId)),
    region: (thread: Thread): boolean => region === undefined || regionUnder(region, thread.region),
  };
};

/** The line a thread is listed under, as its row says it. Set while a read runs: a subject's name needs the canvas's input. */
let titleInput: MailThreadsInput | undefined;
const titles = new WeakMap<ReadonlyArray<MailThreadMessage>, string>();
const summaryTitle = (thread: Thread): string => {
  let held = titles.get(thread.entries);
  if (held === undefined && titleInput !== undefined) {
    held = summaryOf(titleInput, thread.threadId, thread.entries).title;
    titles.set(thread.entries, held);
  }
  return held ?? "";
};

type Counted = {
  readonly matched: Thread[];
  readonly total: number;
  readonly unread: number;
  readonly regions: ReadonlyArray<OperatorThreadsRegionCount>;
  readonly seatCounts: ReadonlyArray<OperatorThreadsSeatCount>;
};

/** The threads under the filter, newest first, with its counts and both strips. */
const countUnder = (view: View, threads: ReadonlyArray<Thread>, filter: ThreadRowsFilter): Counted => {
  titleInput = view.input;
  try {
    const match = matcher(filter);
    const matched: Thread[] = [];
    let unread = 0;
    const regions = new Map<string, { region: FeedRegion; total: number; unread: number }>();
    const seats = new Map<string, { seat: OperatorThreadSeat; region: FeedRegion; total: number; unread: number }>();
    for (const thread of threads) {
      if (!match.rest(thread)) continue;
      const inSeats = match.seats(thread);
      const inRegion = match.region(thread);
      if (inSeats) {
        const key = regionKey(thread.region);
        const held = regions.get(key) ?? { region: thread.region, total: 0, unread: 0 };
        held.total += 1;
        held.unread += thread.unread;
        regions.set(key, held);
      }
      if (inRegion) {
        for (const seat of [thread.seat, ...thread.alsoSeats]) {
          const held = seats.get(seat.nodeId) ?? { seat, region: feedRegionForCanvas(view.canvas, seat.nodeId), total: 0, unread: 0 };
          held.total += 1;
          held.unread += thread.unread;
          seats.set(seat.nodeId, held);
        }
      }
      if (inSeats && inRegion) {
        matched.push(thread);
        unread += thread.unread;
      }
    }
    matched.sort(byActivity);
    return {
      matched,
      total: matched.length,
      unread,
      regions: [...regions.values()],
      seatCounts: [...seats.values()],
    };
  } finally {
    titleInput = undefined;
  }
};

/** One thread as a row, its last mail cut to a line's worth. */
const rowOf = (input: MailThreadsInput, thread: Thread): OperatorThreadRow => {
  const summary = summaryOf(input, thread.threadId, thread.entries);
  const last = summary.last;
  return {
    threadId: thread.threadId,
    seat: thread.seat,
    region: thread.region,
    title: summary.title,
    startedAt: summary.startedAt,
    lastAt: summary.lastAt,
    last: {
      messageId: last.messageId,
      from: last.from,
      text: last.text.length > OPERATOR_THREAD_PREVIEW_MAX ? last.text.slice(0, OPERATOR_THREAD_PREVIEW_MAX) : last.text,
      at: last.at,
      ...(last.waiting === true ? { waiting: true as const } : {}),
    },
    messageCount: summary.messageCount,
    unread: thread.unread,
    ...(thread.point === undefined ? {} : { readAt: thread.point.at }),
    ...(thread.alsoSeats.length === 0 ? {} : { alsoSeats: thread.alsoSeats }),
    ...(summary.subject === undefined ? {} : { subject: summary.subject }),
  };
};

/** The canvas's threads, and the operator's read points when asked. */
const readView = (canvasName: string, readPoints: boolean) =>
  Effect.gen(function* () {
    const view = yield* canvasThreads(canvasName);
    const points = readPoints ? yield* canvasPoints(yield* SqlClient.SqlClient, canvasName) : undefined;
    return { view, points };
  });

const pageOf = (counted: Counted, input: MailThreadsInput, page: { readonly limit?: number; readonly after?: string }) => {
  const limit = Math.min(OPERATOR_THREADS_PAGE_MAX, Math.max(1, Math.trunc(page.limit ?? OPERATOR_THREADS_PAGE_DEFAULT)));
  const after = readCursor(page.after);
  const start = after === undefined ? 0 : counted.matched.findIndex((thread) => byActivity(thread, after) > 0);
  const rest = start < 0 ? [] : counted.matched.slice(start);
  const held = rest.slice(0, limit);
  const last = held[held.length - 1];
  return {
    rows: held.map((thread) => rowOf(input, thread)),
    ...(rest.length > limit && last !== undefined ? { next: cursorOf(last) } : {}),
  };
};

/**
 * One page of the canvas's threads across every seat, newest activity first:
 * the `limit` after `after`, `next` for the page that follows, and the
 * filter's counts over every thread it holds. `readPoints` joins the
 * operator's read state in; without it every row reads 0 unread.
 */
export const threadRowsPage = (canvasName: string, query: ThreadRowsQuery, options: { readonly readPoints?: boolean } = {}) =>
  Effect.gen(function* () {
    const generation = nextGeneration(canvasName);
    const { view, points } = yield* readView(canvasName, options.readPoints === true);
    const counted = countUnder(view, threadsOf(view, query.who, points), query);
    return {
      ...pageOf(counted, view.input, query),
      total: counted.total,
      unread: counted.unread,
      regions: counted.regions,
      seatCounts: counted.seatCounts,
      generation,
    } satisfies OperatorThreadsPage;
  });

/** The window's page: the operator's threads, with their read state. */
export const operatorThreadsPage = (query: OperatorThreadsFilterDecoded & { readonly limit?: number; readonly after?: string }) => {
  const { canvasName, ...rest } = query;
  return threadRowsPage(canvasName, { ...rest, who: "operator" }, { readPoints: true });
};

// ---- Watches ----

/**
 * What a watch last pushed of a thread, as a row shows it. Its mail is named
 * by count and newest id, never by the array: a mail anywhere in a mailbox
 * derives every thread of that mailbox again, and those threads did not move.
 */
type Seen = string;

type Watch = {
  readonly watchId: string;
  readonly subscriber: number;
  readonly filter: OperatorThreadsFilterDecoded;
  seen: Map<string, Seen>;
};

const signOf = (thread: Thread): string =>
  [
    thread.entries.length,
    thread.entries[thread.entries.length - 1]?.messageId ?? "",
    thread.entries[thread.entries.length - 1]?.waiting === true ? "w" : "",
    thread.point?.through ?? "",
    thread.unread,
    thread.seat.name,
    regionKey(thread.region),
    thread.alsoSeats.map((seat) => `${seat.nodeId}\u0001${seat.name}`).join("\u0002"),
  ].join("\u0000");

/** Changes to one canvas this close together are one pass. */
const WATCH_PASS_MS = 40;

/**
 * The watches of one core: `watch` starts one for a window, and each change
 * the core hears (`changed`) pushes, per watch on that canvas, the rows that
 * came, moved or left. `send` is how a change reaches its window.
 */
export const makeThreadRowsWatches = (options: {
  readonly run: (effect: Effect.Effect<void>) => void;
  readonly send: (subscriber: number, change: OperatorThreadsChanged) => void;
  readonly read: (canvasName: string) => Effect.Effect<{ readonly view: View; readonly points: ReadonlyMap<string, MailReadPoint> | undefined }, unknown>;
}) => {
  const watches = new Map<string, Watch>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const again = new Set<string>();

  const pass = (canvasName: string) =>
    Effect.gen(function* () {
      const mine = [...watches.values()].filter((watch) => watch.filter.canvasName === canvasName);
      if (mine.length === 0) return;
      const generation = nextGeneration(canvasName);
      const { view, points } = yield* options.read(canvasName);
      const threads = threadsOf(view, "operator", points);
      for (const watch of mine) {
        if (!watches.has(watch.watchId)) continue;
        const counted = countUnder(view, threads, watch.filter);
        const seen = new Map<string, Seen>();
        const rows: OperatorThreadRow[] = [];
        for (const thread of counted.matched) {
          const now = signOf(thread);
          seen.set(thread.threadId, now);
          if (watch.seen.get(thread.threadId) !== now) rows.push(rowOf(view.input, thread));
        }
        const gone = [...watch.seen.keys()].filter((threadId) => !seen.has(threadId));
        watch.seen = seen;
        if (rows.length === 0 && gone.length === 0) continue;
        options.send(watch.subscriber, {
          watchId: watch.watchId,
          canvasName,
          rows,
          gone,
          total: counted.total,
          unread: counted.unread,
          regions: counted.regions,
          seatCounts: counted.seatCounts,
          generation,
        });
      }
    }).pipe(
      Effect.catch((error) => Effect.logWarning("operator threads: a change was not pushed", { canvasName, error: String(error) })),
    );

  const drain = (canvasName: string): void => {
    if (running.has(canvasName)) {
      again.add(canvasName);
      return;
    }
    running.add(canvasName);
    options.run(
      pass(canvasName).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running.delete(canvasName);
            if (again.delete(canvasName)) changed(canvasName);
          }),
        ),
      ),
    );
  };

  /** Something on the canvas changed: one pass for the burst. */
  const changed = (canvasName: string): void => {
    if (timers.has(canvasName)) return;
    if (![...watches.values()].some((watch) => watch.filter.canvasName === canvasName)) return;
    timers.set(
      canvasName,
      setTimeout(() => {
        timers.delete(canvasName);
        drain(canvasName);
      }, WATCH_PASS_MS),
    );
  };

  /** Start a watch: what the filter holds now is what its first change is laid against. */
  const watch = (subscriber: number, filter: OperatorThreadsFilterDecoded) =>
    Effect.gen(function* () {
      const watchId = ulid();
      const { view, points } = yield* options.read(filter.canvasName);
      const counted = countUnder(view, threadsOf(view, "operator", points), filter);
      watches.set(watchId, {
        watchId,
        subscriber,
        filter,
        seen: new Map(counted.matched.map((thread) => [thread.threadId, signOf(thread)])),
      });
      return { watchId };
    });

  const unwatch = (watchId: string): void => {
    watches.delete(watchId);
  };

  /** A window closed: its watches end with it. */
  const windowGone = (subscriber: number): void => {
    for (const [watchId, held] of watches) if (held.subscriber === subscriber) watches.delete(watchId);
  };

  return { watch, unwatch, windowGone, changed, size: () => watches.size };
};

/** The read a watch takes: the operator's threads with their read points. */
export const operatorThreadsView = (canvasName: string) => readView(canvasName, true);
