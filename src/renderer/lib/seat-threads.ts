/**
 * A seat's threads, for the Threads button and popup in its open view.
 *
 * A thread is the mail that hangs off one root message. The operator is in
 * it (canReply) or reads it between seats. Main owns the threads; this
 * module reads them through one typed source, keeps each retained seat's
 * list and each opened thread's messages, and reads again when the source
 * says something changed. Never writes the canvas.
 *
 * The source is main's threads IPC on `window.junto` (types in
 * src/shared/wire/mail-threads.ts, imported as types only: no Effect runtime
 * here). Main pushes nothing for threads: any mailbox can change a seat's
 * threads, so a mail change anywhere on the canvas reads its seats again.
 * The operator's read state rides each row (`unread`) and the seat's total
 * (`unreadTotal`); main decides both, so only replies to the operator count.
 */
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect, useState } from "react";
import type { MentionableSeat, OperatorThreadSend, OperatorThreadSent, ThreadGroup } from "@shared/mail-threads";
import type { ResourceSubject } from "@shared/thread-subject";
import type { ContentRef } from "@shared/wire/content-ref";
import type { MailParty, MailThreadMessage } from "@shared/wire/mail-threads";
import { getJuntoApi } from "./junto-api";

export type SeatAddress = { readonly canvasName: string; readonly seatId: string };

/** One thread in the seat's list. */
export type SeatThreadSummary = {
  readonly threadId: string;
  /** The root mail's first line. */
  readonly title: string;
  /** Who is in it, by name; "you" is the operator. */
  readonly participants: ReadonlyArray<string>;
  /** When it started: the root mail's time (epoch ms). */
  readonly startedAt: number;
  /** Its latest message's time (epoch ms). */
  readonly lastAt: number;
  /** Its latest message: who wrote it and what it says, as the list row shows them. */
  readonly last: SeatThreadMessage;
  readonly messageCount: number;
  /** The operator is in it and may write in it. */
  readonly canReply: boolean;
  /** When the operator last read it, on this Mac's clock; absent when never read. */
  readonly readAt?: number;
  /** Mail the operator did not write, past the read point, or all of it when never read. */
  readonly unread: number;
  /** A comment thread's task, artifact or page; absent for a mailbox thread. */
  readonly subject?: ResourceSubject;
};

/** One message in a thread. */
export type SeatThreadMessage = {
  readonly messageId: string;
  /** Who wrote it, by name; "you" for the operator. */
  readonly author: string;
  /** The operator wrote it. */
  readonly mine: boolean;
  readonly text: string;
  /** Epoch ms. */
  readonly at: number;
  /** Files the mail carries, by reference into the content store. */
  readonly attachments?: ReadonlyArray<ContentRef>;
};

/** Threads in a page: the first on open, and each older page as the list nears its end. */
export const THREADS_PAGE = 50;
/** Messages in a page: the newest on open, and each older page as the chat scrolls up. */
export const MESSAGES_PAGE = 50;

/** One page of one of a seat's two lists, newest first; `next` asks for the page after it. */
export type SeatThreadsPage = { readonly threads: ReadonlyArray<SeatThreadSummary>; readonly next?: string };

/** One page of a thread's messages, oldest first; `older` asks for the page above it. */
export type SeatThreadMessagesPage = { readonly messages: ReadonlyArray<SeatThreadMessage>; readonly older?: string };

/** What reads a seat's threads, a page at a time. */
export type SeatThreadsSource = {
  /** One list, the threads the operator is in or those between seats: from the newest, or after the cursor its page gave. */
  readonly list: (seat: SeatAddress & { readonly group: ThreadGroup; readonly after?: string }) => Promise<SeatThreadsPage>;
  /** The newest, or those before the cursor a page gave. */
  readonly messages: (
    seat: SeatAddress & { readonly threadId: string; readonly before?: string },
  ) => Promise<SeatThreadMessagesPage>;
  /** Something changed in this canvas's threads; no seat means any. */
  readonly onChanged: (listener: (change: { readonly canvasName: string; readonly seatId?: string }) => void) => () => void;
  /** What the operator has not read in the seat, over every thread of it, never a page of them; undefined when it cannot be read. */
  readonly unreadTotal: (seat: SeatAddress) => Promise<number | undefined>;
  /** The operator read a thread: their shared point moves, on every device. It never rejects. */
  readonly markRead: (seat: SeatAddress & { readonly threadId: string }) => Promise<void>;
  /** The operator's read state moved, here or on the phone; the seats whose counts changed. */
  readonly onReadChanged: (
    listener: (change: { readonly canvasName: string; readonly seatIds: ReadonlyArray<string> }) => void,
  ) => () => void;
};

/** A party by name, as the popup says it: the operator is "you". */
const partyName = (party: MailParty): string => (party.kind === "operator" ? "you" : party.name);

/** One mail, as this module holds it: main's parties read by name. */
const messageOf = (message: MailThreadMessage): SeatThreadMessage => ({
  messageId: message.messageId,
  author: partyName(message.from),
  mine: message.mine,
  text: message.text,
  at: message.at,
  ...(message.attachments === undefined || message.attachments.length === 0 ? {} : { attachments: message.attachments }),
});

/** The source over main's threads IPC, or undefined while the bridge lacks it. */
export const juntoSeatThreadsSource = (): SeatThreadsSource | undefined => {
  const api = getJuntoApi();
  const list = api?.seatThreadsList;
  const messages = api?.seatThreadMessages;
  const onMail = api?.onWorkMailChanged;
  const markRead = api?.seatThreadMarkRead;
  const unreadTotal = api?.seatThreadUnread;
  const onRead = api?.onSeatThreadReadChanged;
  if (
    typeof list !== "function" ||
    typeof messages !== "function" ||
    typeof onMail !== "function" ||
    typeof markRead !== "function" ||
    typeof unreadTotal !== "function" ||
    typeof onRead !== "function"
  ) {
    return undefined;
  }
  return {
    list: async ({ canvasName, seatId, group, after }) => {
      const page = await list({
        canvasName,
        nodeId: seatId,
        limit: THREADS_PAGE,
        group,
        ...(after === undefined ? {} : { after }),
      });
      return {
        threads: page.threads.map((thread) => ({
          threadId: thread.threadId,
          title: thread.title,
          participants: thread.participants.map(partyName),
          startedAt: thread.startedAt,
          lastAt: thread.lastAt,
          last: messageOf(thread.last),
          messageCount: thread.messageCount,
          canReply: thread.canReply,
          ...(thread.readAt === undefined ? {} : { readAt: thread.readAt }),
          unread: thread.unread,
          ...(thread.subject === undefined ? {} : { subject: thread.subject }),
        })),
        ...(page.next === undefined ? {} : { next: page.next }),
      };
    },
    messages: async ({ canvasName, seatId, threadId, before }) => {
      const page = await messages({
        canvasName,
        nodeId: seatId,
        threadId,
        limit: MESSAGES_PAGE,
        ...(before === undefined ? {} : { before }),
      });
      return {
        messages: page.messages.map(messageOf),
        ...(page.older === undefined ? {} : { older: page.older }),
      };
    },
    // Any mailbox can change a seat's threads: the canvas alone decides.
    onChanged: (listener) => onMail((event) => listener({ canvasName: event.canvasName })),
    unreadTotal: ({ canvasName, seatId }) => unreadTotal({ canvasName, nodeId: seatId }),
    markRead: async ({ canvasName, seatId, threadId }) => {
      // Main answers the point or undefined, and never rejects; the list is read again either way.
      await markRead({ canvasName, nodeId: seatId, threadId });
    },
    onReadChanged: (listener) =>
      onRead((change) => listener({ canvasName: change.canvasName, seatIds: change.seats })),
  };
};

let installed: SeatThreadsSource | undefined;
let bridged: SeatThreadsSource | undefined;

/** The installed source, else main's over the bridge. */
const activeSource = (): SeatThreadsSource | undefined => installed ?? (bridged ??= juntoSeatThreadsSource());

/** Install a source over main's (or drop it with undefined). Every retained seat reads again. */
export const setSeatThreadsSource = (next: SeatThreadsSource | undefined): void => {
  offChanged?.();
  offChanged = undefined;
  offRead?.();
  offRead = undefined;
  installed = next;
  if (retained.size > 0) listenForChanges();
  for (const key of retained.keys()) {
    void refreshSeat(key);
    void refreshUnread(key);
  }
  for (const key of Object.keys(seatThreads$.messages.peek())) void refreshThread(key);
};

/** Each list's cursor for its page after the last one read; a list that has ended has none. */
type ListCursors = { readonly [G in ThreadGroup]?: string };

type SeatState = {
  /** The pages read so far of both lists, newest first. */
  readonly threads: ReadonlyArray<SeatThreadSummary>;
  readonly loaded: boolean;
  readonly error: string;
  /** Where each list goes on; absent when both have ended. */
  readonly next?: ListCursors;
  /** An older page is being read. */
  readonly loadingMore?: true;
};

type ThreadState = {
  /** The pages read so far, oldest first. */
  readonly messages: ReadonlyArray<SeatThreadMessage>;
  readonly loaded: boolean;
  readonly error: string;
  /** Cursor for the page above the first one read; absent at the thread's start. */
  readonly older?: string;
  /** An older page is being read. */
  readonly loadingMore?: true;
};

export const seatThreads$ = observable<{
  readonly seats: Record<string, SeatState | undefined>;
  readonly messages: Record<string, ThreadState | undefined>;
  /** What the operator has not read in a seat, over every thread of it; absent until read. */
  readonly unread: Record<string, number | undefined>;
}>({ seats: {}, messages: {}, unread: {} });

const seatKey = (seat: SeatAddress): string => `${seat.canvasName}\u0000${seat.seatId}`;
const threadKey = (seat: SeatAddress, threadId: string): string => `${seatKey(seat)}\u0000${threadId}`;
const seatOfKey = (key: string): SeatAddress => {
  const [canvasName = "", seatId = ""] = key.split("\u0000");
  return { canvasName, seatId };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads in flight per key, and whether another was asked for meanwhile. */
const flights = new Map<string, { again: boolean }>();

const coalesce = async (key: string, read: () => Promise<void>): Promise<void> => {
  const flight = flights.get(key);
  if (flight) {
    flight.again = true;
    return;
  }
  const mine = { again: true };
  flights.set(key, mine);
  try {
    while (mine.again) {
      mine.again = false;
      await read();
    }
  } finally {
    flights.delete(key);
  }
};

/** Newest activity first, as the main side orders them. */
const byActivity = (a: SeatThreadSummary, b: SeatThreadSummary): number =>
  b.lastAt - a.lastAt || (a.threadId < b.threadId ? 1 : a.threadId > b.threadId ? -1 : 0);

/** Oldest first, as the main side orders them. */
const byAge = (a: SeatThreadMessage, b: SeatThreadMessage): number =>
  a.at - b.at || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);

/**
 * Pages read again or further on, laid into what is held: the incoming rows
 * win by id, the rest stay, and the order is the main side's. Reading the head
 * again is enough to see change, because mail moves a thread to the head.
 */
const laid = <T>(held: ReadonlyArray<T>, incoming: ReadonlyArray<T>, id: (row: T) => string, order: (a: T, b: T) => number): T[] => {
  const fresh = new Set(incoming.map(id));
  return [...held.filter((row) => !fresh.has(id(row))), ...incoming].sort(order);
};

/**
 * A head page read again over what is held. Held rows beyond the head's far
 * end stay, with the cursor held; with none, the head is all there is and its
 * own cursor stands.
 */
const refreshed = <T>(
  held: ReadonlyArray<T>,
  head: ReadonlyArray<T>,
  headCursor: string | undefined,
  heldCursor: string | undefined,
  id: (row: T) => string,
  order: (a: T, b: T) => number,
  beyondHead: (row: T, far: T) => boolean,
): { readonly rows: T[]; readonly cursor: string | undefined } => {
  const fresh = new Set(head.map(id));
  const far = head.reduce<T | undefined>((acc, row) => (acc === undefined || beyondHead(row, acc) ? row : acc), undefined);
  // Held rows inside the head's range that the head no longer has are gone.
  const tail = far === undefined || headCursor === undefined ? [] : held.filter((row) => !fresh.has(id(row)) && beyondHead(row, far));
  return tail.length === 0
    ? { rows: [...head], cursor: headCursor }
    : { rows: laid(tail, head, id, order), cursor: heldCursor };
};

/** The operator's threads page apart from those between seats, first (0.11.5). */
const GROUPS: ReadonlyArray<ThreadGroup> = ["with-you", "between"];
const inGroup = (group: ThreadGroup) => (thread: SeatThreadSummary): boolean => thread.canReply === (group === "with-you");

/** Both lists' cursors, or none when both have ended. */
const cursorsOf = (cursors: ListCursors): ListCursors | undefined =>
  GROUPS.some((group) => cursors[group] !== undefined) ? cursors : undefined;

/** Both lists as one, newest first; a thread that moved between them is kept once, with the operator. */
const merged = (withYou: ReadonlyArray<SeatThreadSummary>, between: ReadonlyArray<SeatThreadSummary>): SeatThreadSummary[] => {
  const mine = new Set(withYou.map((thread) => thread.threadId));
  return [...withYou, ...between.filter((thread) => !mine.has(thread.threadId))].sort(byActivity);
};

const refreshSeat = (key: string): Promise<void> =>
  coalesce(key, async () => {
    const read = activeSource();
    if (!read || !retained.has(key)) return;
    try {
      const seat = seatOfKey(key);
      const pages = await Promise.all(GROUPS.map((group) => read.list({ ...seat, group })));
      if (activeSource() !== read || !retained.has(key)) return;
      const prior = seatThreads$.seats[key].peek();
      // Each list's head over what it holds, on its own cursor.
      const heads = GROUPS.map((group, n) => {
        const page = pages[n]!;
        return refreshed(
          (prior?.threads ?? []).filter(inGroup(group)),
          page.threads.filter(inGroup(group)),
          page.next,
          prior?.next?.[group],
          (t) => t.threadId,
          byActivity,
          (row, far) => byActivity(row, far) > 0,
        );
      });
      const next = cursorsOf(Object.fromEntries(GROUPS.flatMap((group, n) => (heads[n]!.cursor === undefined ? [] : [[group, heads[n]!.cursor]]))));
      seatThreads$.seats[key].set({
        threads: merged(heads[0]!.rows, heads[1]!.rows),
        loaded: true,
        error: "",
        ...(next === undefined ? {} : { next }),
        ...(prior?.loadingMore ? { loadingMore: true as const } : {}),
      });
    } catch (error) {
      const prior = seatThreads$.seats[key].peek();
      seatThreads$.seats[key].set({ ...prior, threads: prior?.threads ?? [], loaded: true, error: errorText(error) });
    }
  });

/**
 * The seat's unread total read again, as the button shows it: every thread of
 * the seat, so paging the list never moves the number (0.11.3).
 */
const refreshUnread = (key: string): Promise<void> =>
  coalesce(`${key}\u0001unread`, async () => {
    const read = activeSource();
    if (!read || !retained.has(key)) return;
    try {
      const total = await read.unreadTotal(seatOfKey(key));
      if (activeSource() !== read || !retained.has(key)) return;
      // A count that cannot be read keeps the last one: zero would claim nothing is waiting.
      if (total !== undefined) seatThreads$.unread[key].set(total);
    } catch {
      // A count that cannot be read leaves the last one; the list's own error line carries the failure.
    }
  });

const refreshThread = (key: string): Promise<void> =>
  coalesce(key, async () => {
    const read = activeSource();
    const [canvasName = "", seatId = "", threadId = ""] = key.split("\u0000");
    if (!read || !openThreads.has(key)) return;
    try {
      const page = await read.messages({ canvasName, seatId, threadId });
      if (activeSource() !== read || !openThreads.has(key)) return;
      const prior = seatThreads$.messages[key].peek();
      const head = refreshed(prior?.messages ?? [], page.messages, page.older, prior?.older, (m) => m.messageId, byAge, (row, far) => byAge(row, far) < 0);
      seatThreads$.messages[key].set({
        messages: head.rows,
        loaded: true,
        error: "",
        ...(head.cursor === undefined ? {} : { older: head.cursor }),
        ...(prior?.loadingMore ? { loadingMore: true as const } : {}),
      });
    } catch (error) {
      const prior = seatThreads$.messages[key].peek();
      seatThreads$.messages[key].set({ ...prior, messages: prior?.messages ?? [], loaded: true, error: errorText(error) });
    }
  });

/**
 * The next older page of a retained seat's threads, when there is one and none
 * is being read: the operator's list until it ends, then the list between seats.
 */
export const loadMoreSeatThreads = async (seat: SeatAddress): Promise<void> => {
  const key = seatKey(seat);
  const read = activeSource();
  const state = seatThreads$.seats[key].peek();
  const group = GROUPS.find((candidate) => state?.next?.[candidate] !== undefined);
  const after = group === undefined ? undefined : state?.next?.[group];
  if (!read || !state || !retained.has(key) || group === undefined || after === undefined || state.loadingMore) return;
  seatThreads$.seats[key].set({ ...state, loadingMore: true });
  try {
    const page = await read.list({ ...seat, group, after });
    if (activeSource() !== read || !retained.has(key)) return;
    const now = seatThreads$.seats[key].peek();
    if (!now) return;
    // A head read meanwhile may have moved the cursor on; only its own page ends here.
    const { loadingMore: _done, next: _next, ...rest } = now;
    const { [group]: held, ...others } = now.next ?? {};
    const moved = held === after ? page.next : held;
    const next = cursorsOf({ ...others, ...(moved === undefined ? {} : { [group]: moved }) });
    const lists = GROUPS.map((each) => {
      const held = now.threads.filter(inGroup(each));
      return each === group ? laid(held, page.threads.filter(inGroup(each)), (t) => t.threadId, byActivity) : held;
    });
    seatThreads$.seats[key].set({
      ...rest,
      threads: merged(lists[0]!, lists[1]!),
      error: "",
      ...(next === undefined ? {} : { next }),
    });
  } catch (error) {
    const now = seatThreads$.seats[key].peek();
    if (now) {
      const { loadingMore: _done, ...rest } = now;
      seatThreads$.seats[key].set({ ...rest, error: errorText(error) });
    }
  }
};

/** The next older page of an open thread's messages, when there is one and none is being read. */
export const loadOlderMessages = async (seat: SeatAddress, threadId: string): Promise<void> => {
  const key = threadKey(seat, threadId);
  const read = activeSource();
  const state = seatThreads$.messages[key].peek();
  const before = state?.older;
  if (!read || !state || !openThreads.has(key) || before === undefined || state.loadingMore) return;
  seatThreads$.messages[key].set({ ...state, loadingMore: true });
  try {
    const page = await read.messages({ ...seat, threadId, before });
    if (activeSource() !== read || !openThreads.has(key)) return;
    const now = seatThreads$.messages[key].peek();
    if (!now) return;
    const { loadingMore: _done, older: _older, ...rest } = now;
    const older = now.older === before ? page.older : now.older;
    seatThreads$.messages[key].set({
      ...rest,
      messages: laid(now.messages, page.messages, (m) => m.messageId, byAge),
      error: "",
      ...(older === undefined ? {} : { older }),
    });
  } catch (error) {
    const now = seatThreads$.messages[key].peek();
    if (now) {
      const { loadingMore: _done, ...rest } = now;
      seatThreads$.messages[key].set({ ...rest, error: errorText(error) });
    }
  }
};

/** Seats retained, and by how many users. */
const retained = new Map<string, number>();
/** Threads open, and by how many users. */
const openThreads = new Map<string, number>();
let offChanged: (() => void) | undefined;
let offRead: (() => void) | undefined;

const listenForChanges = (): void => {
  const read = activeSource();
  if ((offChanged && offRead) || !read) return;
  offChanged ??= read.onChanged((change) => {
    for (const key of retained.keys()) {
      const seat = seatOfKey(key);
      if (seat.canvasName !== change.canvasName) continue;
      if (change.seatId !== undefined && change.seatId !== seat.seatId) continue;
      void refreshSeat(key);
      void refreshUnread(key);
    }
    for (const key of openThreads.keys()) {
      const [canvasName, seatId] = key.split("\u0000");
      if (canvasName !== change.canvasName) continue;
      if (change.seatId !== undefined && change.seatId !== seatId) continue;
      void refreshThread(key);
    }
  });
  // The operator read on the other device: the counts here follow (0.11.3).
  offRead ??= read.onReadChanged((change) => {
    for (const key of retained.keys()) {
      const seat = seatOfKey(key);
      if (seat.canvasName !== change.canvasName || !change.seatIds.includes(seat.seatId)) continue;
      void refreshSeat(key);
      void refreshUnread(key);
    }
  });
};

const stopListeningIfIdle = (): void => {
  if (retained.size > 0 || openThreads.size > 0) return;
  offChanged?.();
  offChanged = undefined;
  offRead?.();
  offRead = undefined;
};

/**
 * The operator read a thread here: their shared point moves, and the seat's
 * list is read again so the row stops saying what it has not read. Main never
 * rejects a mark, so this cannot fail the surface.
 */
export const markSeatThreadRead = async (seat: SeatAddress, threadId: string): Promise<void> => {
  const read = activeSource();
  if (!read) return;
  await read.markRead({ ...seat, threadId });
  await Promise.all([refreshSeat(seatKey(seat)), refreshUnread(seatKey(seat))]);
};

/** Read a retained seat's threads again now, as after the operator sent in them. */
export const refreshSeatThreads = (seat: SeatAddress): void => {
  const key = seatKey(seat);
  if (retained.has(key)) void refreshSeat(key);
  for (const thread of openThreads.keys()) if (thread.startsWith(`${key}\u0000`)) void refreshThread(thread);
};

/** Keep a seat's thread list read and current; the returned function lets go. */
export const retainSeatThreads = (seat: SeatAddress): (() => void) => {
  const key = seatKey(seat);
  retained.set(key, (retained.get(key) ?? 0) + 1);
  listenForChanges();
  void refreshSeat(key);
  void refreshUnread(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const users = (retained.get(key) ?? 1) - 1;
    if (users > 0) retained.set(key, users);
    else retained.delete(key);
    stopListeningIfIdle();
  };
};

/** Keep one thread's messages read and current; the returned function lets go. */
export const openSeatThread = (seat: SeatAddress, threadId: string): (() => void) => {
  const key = threadKey(seat, threadId);
  openThreads.set(key, (openThreads.get(key) ?? 0) + 1);
  listenForChanges();
  void refreshThread(key);
  return () => {
    const users = (openThreads.get(key) ?? 1) - 1;
    if (users > 0) openThreads.set(key, users);
    else openThreads.delete(key);
    stopListeningIfIdle();
  };
};

/** The seat's threads, retained while mounted. */
export const useSeatThreads = (seat: SeatAddress, enabled = true): SeatState => {
  const { canvasName, seatId } = seat;
  useEffect(() => {
    if (!enabled || !canvasName) return;
    return retainSeatThreads({ canvasName, seatId });
  }, [canvasName, seatId, enabled]);
  return use$(() => seatThreads$.seats[seatKey(seat)].get()) ?? NO_THREADS;
};

/**
 * What the operator has not read in the seat, over every thread of it: the
 * header's count, which paging never moves. Kept current with the seat's
 * threads while mounted, and 0 until the first read lands.
 */
export const useSeatUnread = (seat: SeatAddress, enabled = true): number => {
  const { canvasName, seatId } = seat;
  useEffect(() => {
    if (!enabled || !canvasName) return;
    return retainSeatThreads({ canvasName, seatId });
  }, [canvasName, seatId, enabled]);
  return use$(() => seatThreads$.unread[seatKey(seat)].get()) ?? 0;
};

/** One thread's messages, read while mounted. */
export const useSeatThreadMessages = (seat: SeatAddress, threadId: string | undefined): ThreadState => {
  const { canvasName, seatId } = seat;
  useEffect(() => {
    if (threadId === undefined || !canvasName) return;
    return openSeatThread({ canvasName, seatId }, threadId);
  }, [canvasName, seatId, threadId]);
  return (
    use$(() => (threadId === undefined ? undefined : seatThreads$.messages[threadKey(seat, threadId)].get())) ??
    NO_MESSAGES
  );
};

const NO_THREADS: SeatState = { threads: [], loaded: false, error: "" };
const NO_MESSAGES: ThreadState = { messages: [], loaded: false, error: "" };

/** The list's two groups, newest first in each. */
export const groupSeatThreads = (
  threads: ReadonlyArray<SeatThreadSummary>,
): { readonly withYou: ReadonlyArray<SeatThreadSummary>; readonly betweenSeats: ReadonlyArray<SeatThreadSummary> } => {
  const newest = [...threads].sort((a, b) => b.lastAt - a.lastAt);
  return {
    withYou: newest.filter((thread) => thread.canReply),
    betweenSeats: newest.filter((thread) => !thread.canReply),
  };
};

/** "you, pty-lead, +1": the first two names and how many more. */
export const participantsLine = (participants: ReadonlyArray<string>): string => {
  const shown = participants.slice(0, 2).join(", ");
  const more = participants.length - 2;
  return more > 0 ? `${shown}, +${more}` : shown;
};

/**
 * A thread's title as a line of words: the markers markdown would draw (bold,
 * strike, inline code) are dropped, since a list row and a header do not
 * render markdown. Underscores stay: names like snake_case and __init__ carry them.
 */
export const previewText = (title: string): string => title.replace(/\*\*|~~|`/g, "");

/** "Between cli-lead and pty-lead.", for a read-only thread. */
export const betweenLine = (participants: ReadonlyArray<string>): string => {
  if (participants.length === 0) return "Between seats.";
  if (participants.length === 1) return `From ${participants[0]}.`;
  const head = participants.slice(0, -1).join(", ");
  return `Between ${head} and ${participants.at(-1)}.`;
};

/** "01:12": a message's or a thread's time, on this machine's clock, 24 hour. */
export const threadTime = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

// ---- Writing ----

/**
 * Main's bound on operator mail text (OPERATOR_MAIL_MAX_TEXT in
 * src/shared/mail-threads.ts), said here because that module carries the
 * Effect runtime; tests/seat-threads.test.tsx holds them equal.
 */
export const THREAD_TEXT_MAX = 8_000;

export type { MentionableSeat };

/** The seats an @ may name: agent seats wired to this one, as main checks them. Empty while unread or unreachable. */
export const useSeatThreadMentionables = (seat: SeatAddress): ReadonlyArray<MentionableSeat> => {
  const { canvasName, seatId } = seat;
  const [seats, setSeats] = useState<ReadonlyArray<MentionableSeat>>([]);
  useEffect(() => {
    const read = getJuntoApi()?.seatThreadMentionables;
    if (typeof read !== "function" || !canvasName) return;
    let alive = true;
    void read({ canvasName, nodeId: seatId }).then(
      (found) => {
        if (alive && Array.isArray(found)) setSeats(found);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [canvasName, seatId]);
  return seats;
};

/**
 * Send the operator's mail in a seat's threads: a reply with `inReplyTo` or
 * `threadId`, a new thread with neither. A bridge that is down or throws
 * reads as a refusal with a message. Sent, the seat's threads read again.
 */
export const sendSeatThread = async (
  input: SeatAddress & Omit<OperatorThreadSend, "canvasName" | "nodeId">,
): Promise<OperatorThreadSent> => {
  const { canvasName, seatId, ...mail } = input;
  const send = getJuntoApi()?.seatThreadSend;
  if (typeof send !== "function") return { ok: false, reason: "failed", message: "Junto could not reach this seat." };
  try {
    const result = await send({ canvasName, nodeId: seatId, ...mail });
    if (result.ok) refreshSeatThreads({ canvasName, seatId });
    return result;
  } catch (error) {
    return { ok: false, reason: "failed", message: errorText(error) };
  }
};

/** Test helper: forget every seat, thread and source. */
export const resetSeatThreads = (): void => {
  offChanged?.();
  offChanged = undefined;
  installed = undefined;
  bridged = undefined;
  retained.clear();
  openThreads.clear();
  flights.clear();
  seatThreads$.set({ seats: {}, messages: {}, unread: {} });
};
