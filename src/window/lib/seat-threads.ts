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
import type { AgentSignalState } from "@shared/wire/agent-signals";
import type { MailParty, MailThreadMessage, ThreadHeadSignal, ThreadSignal, ThreadSignalRef } from "@shared/wire/mail-threads";
import { agentSignals$ } from "./agent-signals-state";
import { getJuntoApi } from "./junto-api";
import type { AttachmentHold } from "./operator-attachments";
import { perfStage } from "@shared/perf-stages";

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
  /** The earliest signal raised in it that is still open; absent when none is. */
  readonly openSignal?: ThreadSignalRef;
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
  /** The operator's own mail that has not reached its seat yet; absent once it has, and on a seat's mail. */
  readonly waiting?: true;
  /** The seat's mail that is a signal, as the signal stands now; absent on plain mail. */
  readonly signal?: ThreadSignal;
  /** The operator's mail that answered a signal: the signal it answered. */
  readonly answers?: ThreadSignalRef;
  /** The operator's answer its seat never received: the signal was withdrawn first. Only with `answers`. */
  readonly held?: true;
};

/** Threads in a page: the first on open, and each older page as the list nears its end. */
export const THREADS_PAGE = 50;
/** Messages in a page: the newest on open, and each older page as the chat scrolls up. */
export const MESSAGES_PAGE = 50;

/** One page of one of a seat's two lists, newest first; `next` asks for the page after it. */
export type SeatThreadsPage = { readonly threads: ReadonlyArray<SeatThreadSummary>; readonly next?: string };

/**
 * One page of a thread's messages, oldest first; `older` asks for the page
 * above it. `headSignal` is the signal whose answer started the thread, on
 * every page: it is drawn before the thread's first message.
 */
export type SeatThreadMessagesPage = {
  readonly messages: ReadonlyArray<SeatThreadMessage>;
  readonly older?: string;
  readonly headSignal?: ThreadHeadSignal;
};

/**
 * A signal changed where it stands on this canvas. `closed` is every signal
 * the window knows closed there, as it stands: the store lays it over the
 * messages it holds, so a page read before the change takes the new state in
 * place instead of waiting for a read it will not get.
 */
export type SignalsChange = {
  readonly canvasName: string;
  readonly closed?: ReadonlyArray<{ readonly signalId: string; readonly state: AgentSignalState; readonly crossed?: true }>;
};

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
  /**
   * A signal on this canvas changed where it stands. A dismissal or a
   * withdrawal writes no mail, so no mail change says it: the threads read
   * differently, and no unread count moves.
   */
  readonly onSignalsChanged?: (listener: (change: SignalsChange) => void) => () => void;
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
  ...(message.waiting === true ? { waiting: true as const } : {}),
  ...(message.signal === undefined ? {} : { signal: message.signal }),
  ...(message.answers === undefined ? {} : { answers: message.answers }),
  ...(message.held === true ? { held: true as const } : {}),
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
          ...(thread.openSignal === undefined ? {} : { openSignal: thread.openSignal }),
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
        ...(page.headSignal === undefined ? {} : { headSignal: page.headSignal }),
      };
    },
    // Any mailbox can change a seat's threads: the canvas alone decides.
    onChanged: (listener) => onMail((event) => {
      perfStage("renderer", "change-push-arrived", { op: "WorkMailChanged" });
      listener({ canvasName: event.canvasName });
    }),
    // The window's own signals are the open canvas's, kept current by main:
    // any of them changing is that canvas's threads reading differently.
    onSignalsChanged: (listener) =>
      agentSignals$.onChange(({ value }) => {
        const signals = Object.values(value ?? {});
        const canvasName = signals[0]?.canvasName;
        if (canvasName === undefined) return;
        listener({
          canvasName,
          closed: signals.flatMap((signal) =>
            signal.state === "open"
              ? []
              : [{ signalId: signal.signalId, state: signal.state, ...(signal.crossed === true ? { crossed: true as const } : {}) }],
          ),
        });
      }),
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
  offSignals?.();
  offSignals = undefined;
  installed = next;
  if (listed.size > 0 || counted.size > 0) listenForChanges();
  for (const key of listed.keys()) void refreshSeat(key);
  for (const key of counted.keys()) void refreshUnread(key);
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
  /** The signal whose answer started the thread, as the newest read had it. */
  readonly headSignal?: ThreadHeadSignal;
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
    if (!read || !listed.has(key)) return;
    try {
      const seat = seatOfKey(key);
      const pages = await Promise.all(GROUPS.map((group) => read.list({ ...seat, group })));
      if (activeSource() !== read || !listed.has(key)) return;
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
    if (!read || !counted.has(key)) return;
    try {
      const total = await read.unreadTotal(seatOfKey(key));
      if (activeSource() !== read || !counted.has(key)) return;
      // A count that cannot be read keeps the last one: zero would claim nothing is waiting.
      if (total !== undefined) seatThreads$.unread[key].set(total);
    } catch {
      // A count that cannot be read leaves the last one; the list's own error line carries the failure.
    }
  });

/** Where the window knows a signal closed, and whether its answer and withdrawal crossed. */
type Closing = { readonly state: AgentSignalState; readonly crossed?: true };

/**
 * Where the window knows each signal closed, by canvas. A signal never
 * reopens (main refuses anything on a signal that is not open), so a closed
 * state is final: it is laid over a held state that is still open, never open
 * over closed, and never one closing over another, which keeps what main
 * reported. A crossing is the one later word on a closed signal: the answer
 * and the withdrawal met, so the pair the window holds replaces a held
 * closing that does not say so.
 */
const closedOn = new Map<string, Map<string, Closing>>();

const layClosed = <S extends ThreadSignal>(known: ReadonlyMap<string, Closing>, signal: S): S => {
  const now = known.get(signal.signalId);
  if (now === undefined || now.state === "open") return signal;
  if (signal.state === "open") return { ...signal, state: now.state, ...(now.crossed === true ? { crossed: true as const } : {}) };
  if (now.crossed === true && signal.crossed !== true) return { ...signal, state: now.state, crossed: true as const };
  return signal;
};

/** These messages with every open signal in them that is known closed, closed; the same array when none is. */
const closedOver = (canvasName: string, messages: ReadonlyArray<SeatThreadMessage>): ReadonlyArray<SeatThreadMessage> => {
  const known = closedOn.get(canvasName);
  if (known === undefined) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (message.signal === undefined) return message;
    const signal = layClosed(known, message.signal);
    if (signal === message.signal) return message;
    changed = true;
    return { ...message, signal };
  });
  return changed ? next : messages;
};

/** Record what the window says is closed on this canvas, and lay it over every thread held from it. */
const lay = (change: SignalsChange): void => {
  if (change.closed === undefined || change.closed.length === 0) return;
  let known = closedOn.get(change.canvasName);
  if (known === undefined) {
    known = new Map();
    closedOn.set(change.canvasName, known);
  }
  for (const { signalId, state, crossed } of change.closed) known.set(signalId, { state, ...(crossed === true ? { crossed } : {}) });
  for (const [key, held] of Object.entries(seatThreads$.messages.peek())) {
    if (held === undefined || !key.startsWith(`${change.canvasName}\u0000`)) continue;
    const messages = closedOver(change.canvasName, held.messages);
    const headSignal = held.headSignal === undefined ? undefined : layClosed(known, held.headSignal);
    if (messages !== held.messages) seatThreads$.messages[key].messages.set(messages);
    if (headSignal !== held.headSignal && headSignal !== undefined) seatThreads$.messages[key].headSignal.set(headSignal);
  }
};

const refreshThread = (key: string): Promise<void> =>
  coalesce(key, async () => {
    const read = activeSource();
    const [canvasName = "", seatId = "", threadId = ""] = key.split("\u0000");
    if (!read || !openThreads.has(key)) return;
    try {
      perfStage("renderer", "reread-started", { op: "ThreadsMessages" });
      const page = await read.messages({ canvasName, seatId, threadId });
      perfStage("renderer", "reread-returned", { op: "ThreadsMessages" });
      if (activeSource() !== read || !openThreads.has(key)) return;
      const prior = seatThreads$.messages[key].peek();
      const head = refreshed(prior?.messages ?? [], page.messages, page.older, prior?.older, (m) => m.messageId, byAge, (row, far) => byAge(row, far) < 0);
      seatThreads$.messages[key].set({
        messages: head.rows,
        loaded: true,
        error: "",
        ...(head.cursor === undefined ? {} : { older: head.cursor }),
        ...(prior?.loadingMore ? { loadingMore: true as const } : {}),
        ...(page.headSignal === undefined ? {} : { headSignal: page.headSignal }),
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
  if (!read || !state || !listed.has(key) || group === undefined || after === undefined || state.loadingMore) return;
  seatThreads$.seats[key].set({ ...state, loadingMore: true });
  try {
    const page = await read.list({ ...seat, group, after });
    if (activeSource() !== read || !listed.has(key)) return;
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
      messages: laid(now.messages, closedOver(seat.canvasName, page.messages), (m) => m.messageId, byAge),
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

/** Seats whose list is retained, and by how many users. */
const listed = new Map<string, number>();
/** Seats whose unread count is retained, and by how many users: the button shows one with the popup shut. */
const counted = new Map<string, number>();
/** Threads open, and by how many users. */
const openThreads = new Map<string, number>();
let offChanged: (() => void) | undefined;
let offRead: (() => void) | undefined;
let offSignals: (() => void) | undefined;

/** The keys of `held` this change touches: its canvas, and the seat the change names when it names one. */
const touched = (
  keys: Iterable<string>,
  change: { readonly canvasName: string; readonly seatId?: string },
): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const key of keys) {
    const seat = seatOfKey(key);
    if (seat.canvasName !== change.canvasName) continue;
    if (change.seatId !== undefined && change.seatId !== seat.seatId) continue;
    out.push(key);
  }
  return out;
};

/**
 * The floor between change-driven reads of one canvas: mail arrives in bursts
 * (an append, its receipts, a read mark), and each change used to read the
 * canvas again. A read now takes everything a burst asked for, one runs at a
 * time, and the next starts no sooner than this after the last one began.
 */
const THREADS_READ_FLOOR_MS = 500;

/** What one canvas still owes a read: its lists, their counts, its open threads. */
type CanvasPace = {
  readonly lists: Set<string>;
  readonly counts: Set<string>;
  readonly threads: Set<string>;
  /** A read of this canvas is in flight. */
  running: boolean;
  /** When the last read began. */
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const paces = new Map<string, CanvasPace>();

const paceOf = (canvasName: string): CanvasPace => {
  let pace = paces.get(canvasName);
  if (pace === undefined) {
    pace = { lists: new Set(), counts: new Set(), threads: new Set(), running: false, startedAt: 0 };
    paces.set(canvasName, pace);
  }
  return pace;
};

/**
 * One read of this canvas now, or as soon as the floor allows: everything a
 * burst asked for goes in one pass, and a change during it is carried to the
 * pass that follows, never to a read of its own.
 */
const drainPace = (canvasName: string, pace: CanvasPace): void => {
  if (pace.running || pace.timer !== undefined) return;
  if (pace.lists.size === 0 && pace.counts.size === 0 && pace.threads.size === 0) return;
  const wait = THREADS_READ_FLOOR_MS - (Date.now() - pace.startedAt);
  if (wait > 0) {
    pace.timer = setTimeout(() => {
      pace.timer = undefined;
      drainPace(canvasName, pace);
    }, wait);
    return;
  }
  const lists = [...pace.lists];
  const counts = [...pace.counts];
  const threads = [...pace.threads];
  pace.lists.clear();
  pace.counts.clear();
  pace.threads.clear();
  pace.running = true;
  pace.startedAt = Date.now();
  void Promise.all([
    ...lists.map((key) => refreshSeat(key)),
    ...counts.map((key) => refreshUnread(key)),
    ...threads.map((key) => refreshThread(key)),
  ]).finally(() => {
    pace.running = false;
    drainPace(canvasName, pace);
  });
};

/** Ask for a read of this canvas, added to whatever its burst already owes. */
const paceCanvas = (canvasName: string, ask: (pace: CanvasPace) => void): void => {
  const pace = paceOf(canvasName);
  ask(pace);
  drainPace(canvasName, pace);
};

/**
 * A mail change names no thread, and any mailbox can change a seat's threads:
 * every list held is read again, and every count, while a seat whose popup is
 * shut is asked only for the count its button shows. All of it is paced per
 * canvas: a burst of changes costs one read and one trailing.
 */
const listenForChanges = (): void => {
  const read = activeSource();
  if ((offChanged && offRead) || !read) return;
  offChanged ??= read.onChanged((change) => {
    paceCanvas(change.canvasName, (pace) => {
      for (const key of touched(listed.keys(), change)) pace.lists.add(key);
      for (const key of touched(counted.keys(), change)) pace.counts.add(key);
      for (const key of touched(openThreads.keys(), change)) pace.threads.add(key);
    });
  });
  // The operator read on the other device: the counts here follow (0.11.3).
  offRead ??= read.onReadChanged((change) => {
    const seats = new Set(change.seatIds);
    paceCanvas(change.canvasName, (pace) => {
      for (const key of touched(listed.keys(), change)) if (seats.has(seatOfKey(key).seatId)) pace.lists.add(key);
      for (const key of touched(counted.keys(), change)) if (seats.has(seatOfKey(key).seatId)) pace.counts.add(key);
    });
  });
  // A signal changed where it stands: a row's open mark and an open thread's
  // signals read again. No mail moved, so no count is asked for.
  offSignals ??= read.onSignalsChanged?.((change) => {
    // In place now, so a page held from before the change does not wait for a read.
    lay(change);
    paceCanvas(change.canvasName, (pace) => {
      for (const key of touched(listed.keys(), change)) pace.lists.add(key);
      for (const key of touched(openThreads.keys(), change)) pace.threads.add(key);
    });
  });
};

const stopListeningIfIdle = (): void => {
  if (listed.size > 0 || counted.size > 0 || openThreads.size > 0) return;
  offChanged?.();
  offChanged = undefined;
  offRead?.();
  offRead = undefined;
  offSignals?.();
  offSignals = undefined;
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
  // The list's rows carry the read state; a thread's mail does not, so it is not read again.
  await Promise.all([refreshList(seat), refreshCount(seat)]);
};

/** Read a retained seat's list again, if its popup is showing one. */
const refreshList = (seat: SeatAddress): Promise<void> => {
  const key = seatKey(seat);
  return listed.has(key) ? refreshSeat(key) : Promise.resolve();
};

/** Read a retained seat's threads again now, as after the operator sent in them. */
export const refreshSeatThreads = (seat: SeatAddress): void => {
  const key = seatKey(seat);
  void refreshList(seat);
  for (const thread of openThreads.keys()) if (thread.startsWith(`${key}\u0000`)) void refreshThread(thread);
};

/** Read a retained seat's count again, if its button is showing one. */
const refreshCount = (seat: SeatAddress): Promise<void> => {
  const key = seatKey(seat);
  return counted.has(key) ? refreshUnread(key) : Promise.resolve();
};

/**
 * Keep a seat's thread list read and current; the returned function lets go.
 * A seat whose popup is shut keeps only its count (`retainSeatUnread`).
 */
export const retainSeatThreads = (seat: SeatAddress): (() => void) => {
  const key = seatKey(seat);
  listed.set(key, (listed.get(key) ?? 0) + 1);
  listenForChanges();
  void refreshSeat(key);
  void refreshCount(seat);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const users = (listed.get(key) ?? 1) - 1;
    if (users > 0) listed.set(key, users);
    else listed.delete(key);
    stopListeningIfIdle();
  };
};

/** Keep a seat's unread count read and current, for the button; the returned function lets go. */
export const retainSeatUnread = (seat: SeatAddress): (() => void) => {
  const key = seatKey(seat);
  counted.set(key, (counted.get(key) ?? 0) + 1);
  listenForChanges();
  void refreshUnread(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const users = (counted.get(key) ?? 1) - 1;
    if (users > 0) counted.set(key, users);
    else counted.delete(key);
    stopListeningIfIdle();
  };
};

const releaseSeatThread = (key: string): void => {
  const users = (openThreads.get(key) ?? 1) - 1;
  if (users > 0) openThreads.set(key, users);
  else openThreads.delete(key);
  stopListeningIfIdle();
};

/** Keep one thread's messages read and current; the returned function lets go. */
export const openSeatThread = (seat: SeatAddress, threadId: string): (() => void) => {
  const key = threadKey(seat, threadId);
  openThreads.set(key, (openThreads.get(key) ?? 0) + 1);
  listenForChanges();
  void refreshThread(key);
  return () => releaseSeatThread(key);
};

/**
 * The mail a send committed, drawn before the thread's next read returns. Its
 * id is the store's own id, so the read replaces it rather than doubling it.
 */
const laySentMessage = (
  seat: SeatAddress,
  sent: { readonly messageId: string; readonly threadId: string; readonly delivery: "delivered" | "waiting_for_seat" | "failed" },
  mail: Pick<OperatorThreadSend, "text" | "attachments">,
): void => {
  const key = threadKey(seat, sent.threadId);
  const prior = seatThreads$.messages[key].peek();
  if (prior?.messages.some((message) => message.messageId === sent.messageId)) return;
  const optimistic: SeatThreadMessage = {
    messageId: sent.messageId,
    author: "you",
    mine: true,
    text: mail.text,
    at: Date.now(),
    ...(mail.attachments === undefined ? {} : { attachments: mail.attachments }),
    ...(sent.delivery === "delivered" ? {} : { waiting: true as const }),
  };
  seatThreads$.messages[key].set({
    messages: [...(prior?.messages ?? []), optimistic],
    loaded: prior?.loaded ?? false,
    error: prior?.error ?? "",
    ...(prior?.older === undefined ? {} : { older: prior.older }),
    ...(prior?.loadingMore === undefined ? {} : { loadingMore: true as const }),
    ...(prior?.headSignal === undefined ? {} : { headSignal: prior.headSignal }),
  });
};

/**
 * Read a thread a send has just written before its chat can mount. The first
 * read holds the thread open only until it returns; a chat mounted meanwhile
 * holds its own count.
 */
const preloadSeatThread = (seat: SeatAddress, threadId: string): void => {
  const key = threadKey(seat, threadId);
  openThreads.set(key, (openThreads.get(key) ?? 0) + 1);
  listenForChanges();
  void refreshThread(key).finally(() => releaseSeatThread(key));
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
 * header's count, which paging never moves. Kept current while mounted, and 0
 * until the first read lands; the list is not read for it.
 */
export const useSeatUnread = (seat: SeatAddress, enabled = true): number => {
  const { canvasName, seatId } = seat;
  useEffect(() => {
    if (!enabled || !canvasName) return;
    return retainSeatUnread({ canvasName, seatId });
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
 * A line of words for a place that does not render markdown: a list row, a
 * header. The markers markdown would draw (bold, strike, inline code) are
 * dropped, and a link reads as its label, so a mention shows as "@Bravo" and
 * not as the address it is written as. Underscores stay: names like
 * snake_case and __init__ carry them.
 */
export const previewText = (title: string): string =>
  title
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\*\*|~~|`/g, "");

/** "Between cli-lead and pty-lead.", for a read-only thread. */
export const betweenLine = (participants: ReadonlyArray<string>): string => {
  if (participants.length === 0) return "Between seats.";
  if (participants.length === 1) return `From ${participants[0]}.`;
  const head = participants.slice(0, -1).join(", ");
  return `Between ${head} and ${participants.at(-1)}.`;
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
 * The seats an @ may name in mail that goes to each of these seats: wired to
 * every one of them, since main checks a mention against each recipient.
 * Empty with no seat, while unread, or when any one cannot be read.
 */
export const useSeatThreadMentionablesOfAll = (
  canvasName: string,
  seatIds: ReadonlyArray<string>,
): ReadonlyArray<MentionableSeat> => {
  const [seats, setSeats] = useState<ReadonlyArray<MentionableSeat>>([]);
  // The ids as one value, so a new array of the same seats reads nothing again.
  const key = seatIds.join("\u0000");
  useEffect(() => {
    const read = getJuntoApi()?.seatThreadMentionables;
    const ids = key === "" ? [] : key.split("\u0000");
    if (typeof read !== "function" || !canvasName || ids.length === 0) {
      setSeats((held) => (held.length === 0 ? held : []));
      return;
    }
    let alive = true;
    void Promise.all(ids.map((nodeId) => read({ canvasName, nodeId }))).then(
      (found) => {
        if (!alive || !found.every(Array.isArray)) return;
        const [first = [], ...rest] = found;
        const inAll = rest.map((list) => new Set(list.map((seat) => seat.nodeId)));
        setSeats(first.filter((seat) => inAll.every((ids) => ids.has(seat.nodeId))));
      },
      () => {
        if (alive) setSeats([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [canvasName, key]);
  return seats;
};

/**
 * A draft held outside the composer, so it outlives it: what was written and
 * the files on it are there when the composer comes back (Quick thread keeps
 * one until it is sent).
 */
export type HeldThreadDraft = {
  readonly text: () => string;
  readonly keepText: (text: string) => void;
  readonly files: AttachmentHold;
};

/**
 * What was typed in a thread's reply field and not sent, kept per canvas, seat
 * and thread for the app session: a close, a switch to another panel or
 * another thread, and the way back, find it as it was left. It goes when the
 * mail is sent or the operator clears the field.
 */
const replyDrafts = new Map<string, string>();

/** A thread's reply draft: read as it was left, written as the operator types. */
export const replyDraftOf = (seat: SeatAddress, threadId: string): { readonly text: () => string; readonly keepText: (text: string) => void } => {
  const key = threadKey(seat, threadId);
  return {
    text: () => replyDrafts.get(key) ?? "",
    keepText: (text) => {
      if (text.trim() === "") replyDrafts.delete(key);
      else replyDrafts.set(key, text);
    },
  };
};

/** A seat a new thread goes to, with the name the operator reads. */
export type ThreadRecipient = { readonly seatId: string; readonly name: string };

/**
 * A seat's new thread, and whether the seat has the mail. `waiting`: the
 * mail is in the thread and reaches the seat when the seat is back. It is
 * never sent again.
 */
export type NewThread = {
  readonly seatId: string;
  readonly threadId: string;
  readonly arrival: "arrived" | "waiting";
  /** The root mail the send wrote, for the thread's first optimistic row. */
  readonly messageId: string;
  readonly text: string;
  readonly at: number;
};

/**
 * How long a send may stay unarrived before anything about waiting is drawn
 * or said: a seat that takes the mail inside it has it, and the operator
 * never sees the mail wait. A running seat, or a stopped one the send wakes,
 * takes it inside a second.
 */
export const WAITING_AFTER_MS = 1000;

// The mail sent from here whose waiting mark is held back until its second is up, by message id.
// One store for every place that draws the mark (a message in a thread, a row in Global threads),
// so no place draws it from a read before the others do.
const markHeld$ = observable<Record<string, true>>({});
const heldSince = new Map<string, number>();
const holdTimers = new Set<ReturnType<typeof setTimeout>>();
// The sends in flight to a seat, by seat, and when the first began. The mail a send writes can reach a
// list (a pushed change) before the answer names it, so the seat's mail written since the send began is
// held too, until the answer's own hold by id takes over.
const sending$ = observable<Record<string, { count: number; since: number }>>({});

/** The longest a send holds its seat's marks: a send that never answers cannot hold them for ever. */
const SEND_HOLD_CAP_MS = 10 * WAITING_AFTER_MS;

/** A send to this seat begins; the one thing it returns ends its hold, once, at its answer or at the cap. */
const sendBegins = (seatId: string): (() => void) => {
  const now = sending$[seatId].peek();
  sending$[seatId].set({ count: (now?.count ?? 0) + 1, since: now?.since ?? Date.now() });
  let over = false;
  const end = (): void => {
    if (over) return;
    over = true;
    clearTimeout(cap);
    holdTimers.delete(cap);
    const held = sending$[seatId].peek();
    if (held === undefined || held.count <= 1) sending$[seatId].delete();
    else sending$[seatId].set({ count: held.count - 1, since: held.since });
  };
  const cap = setTimeout(end, SEND_HOLD_CAP_MS);
  holdTimers.add(cap);
  return end;
};

// The signals whose closing a thread on screen says aloud, by id, counted. A closing is one event:
// while a thread says it, no other place (a seat's preamble bubble, the feed) says it again.
const speaking = new Map<string, number>();

/** A thread on screen says the closing of these signals; returns the release, for when it leaves the screen. */
export const speakSignalsFor = (signalIds: ReadonlyArray<string>): (() => void) => {
  for (const id of signalIds) speaking.set(id, (speaking.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of signalIds) {
      const left = (speaking.get(id) ?? 1) - 1;
      if (left <= 0) speaking.delete(id);
      else speaking.set(id, left);
    }
  };
};

/** Whether a thread on screen says this signal's closing, so nothing else should. */
export const threadSpeaksFor = (signalId: string): boolean => speaking.has(signalId);

/** The operator's mail was sent from here: its waiting mark is held back for a second. */
export const holdWaitingMark = (messageId: string): void => {
  markHeld$[messageId].set(true);
  heldSince.set(messageId, Date.now());
  const timer = setTimeout(() => {
    holdTimers.delete(timer);
    heldSince.delete(messageId);
    markHeld$[messageId].delete();
  }, WAITING_AFTER_MS);
  holdTimers.add(timer);
};

/**
 * How much of its second this mail's hold has left, so what is said about it
 * can end when the mark can be drawn. Mail with no hold on record has none
 * left: every send from here is held when it is answered, so none means the
 * second is up, and the mark is already drawn.
 */
export const waitingHoldLeft = (messageId: string): number => {
  const since = heldSince.get(messageId);
  return since === undefined ? 0 : Math.max(0, WAITING_AFTER_MS - (Date.now() - since));
};

/** Whether this mail's waiting mark is still held back: held by its id, or written while a send to its seat is still in flight. */
export const useWaitingMarkHeld = (mail: { readonly messageId: string; readonly at: number }, seatId: string): boolean => {
  const byId = use$(markHeld$[mail.messageId]) === true;
  const sending = use$(sending$[seatId]);
  // A second of slack for the clocks of the write and of the send's start.
  return byId || (sending !== undefined && mail.at >= sending.since - 1000);
};

/**
 * Who the operator's mail has not reached yet, in one sentence about the
 * seat. The one wording for every place that says it: under a message in a
 * thread, and on Quick thread's receipt.
 */
export const waitingForSeats = (names: ReadonlyArray<string>): string =>
  names.length === 1
    ? `Waiting for ${names[0]}. It arrives when the seat is back.`
    : `Waiting for ${names.length} seats. Each gets it when it is back.`;

/** What came of one send to several seats: the thread each seat got, and each seat that got none, with main's words. */
export type NewThreadsOutcome = {
  readonly sent: ReadonlyArray<NewThread>;
  readonly failed: ReadonlyArray<{ readonly seatId: string; readonly message: string }>;
};

/**
 * One new thread per seat, the same text and files in each. Every seat is
 * tried: one that refuses does not stop the rest, and the outcome names it,
 * so the operator sends again to those alone. In the order the seats came.
 */
export const sendNewThreads = async (
  canvasName: string,
  seatIds: ReadonlyArray<string>,
  mail: Pick<OperatorThreadSend, "text" | "attachments">,
  displayText = mail.text,
): Promise<NewThreadsOutcome> => {
  const results = await Promise.all(seatIds.map((seatId) => sendSeatThread({ canvasName, seatId, ...mail })));
  const at = Date.now();
  const sent: NewThread[] = [];
  const failed: Array<{ seatId: string; message: string }> = [];
  results.forEach((result, index) => {
    const seatId = seatIds[index]!;
    // Written is sent, and is never sent again. Anything short of delivered reads as waiting for the seat.
    if (result.ok) {
      sent.push({
        seatId,
        threadId: result.threadId,
        arrival: result.delivery === "delivered" ? "arrived" : "waiting",
        messageId: result.messageId,
        text: displayText,
        at,
      });
    } else failed.push({ seatId, message: result.message });
  });
  return { sent, failed };
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
  const endSend = sendBegins(seatId);
  try {
    perfStage("renderer", "invoke-sent", { op: "seatThreadSend" });
    const result = await send({ canvasName, nodeId: seatId, ...mail });
    perfStage("renderer", "promise-resolved", { op: "seatThreadSend" });
    if (result.ok) {
      // Before the read the send asks for, so no read can draw the mark inside its second.
      holdWaitingMark(result.messageId);
      laySentMessage({ canvasName, seatId }, result, mail);
      preloadSeatThread({ canvasName, seatId }, result.threadId);
      refreshSeatThreads({ canvasName, seatId });
    }
    return result;
  } catch (error) {
    return { ok: false, reason: "failed", message: errorText(error) };
  } finally {
    endSend();
  }
};

/** Test helper: forget every seat, thread and source. */
export const resetSeatThreads = (): void => {
  offChanged?.();
  offChanged = undefined;
  offSignals?.();
  offSignals = undefined;
  installed = undefined;
  bridged = undefined;
  listed.clear();
  counted.clear();
  openThreads.clear();
  for (const pace of paces.values()) if (pace.timer !== undefined) clearTimeout(pace.timer);
  paces.clear();
  flights.clear();
  closedOn.clear();
  replyDrafts.clear();
  for (const timer of holdTimers) clearTimeout(timer);
  holdTimers.clear();
  heldSince.clear();
  speaking.clear();
  markHeld$.set({});
  sending$.set({});
  seatThreads$.set({ seats: {}, messages: {}, unread: {} });
};
