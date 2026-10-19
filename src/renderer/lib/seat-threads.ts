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
 * Mail has no operator read state, so nothing here says what is new.
 */
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type { MailParty } from "@shared/wire/mail-threads";
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
  readonly messageCount: number;
  /** The operator is in it and may write in it. */
  readonly canReply: boolean;
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
};

/** What reads a seat's threads. */
export type SeatThreadsSource = {
  readonly list: (seat: SeatAddress) => Promise<ReadonlyArray<SeatThreadSummary>>;
  /** Oldest first. */
  readonly messages: (seat: SeatAddress & { readonly threadId: string }) => Promise<ReadonlyArray<SeatThreadMessage>>;
  /** Something changed in this canvas's threads; no seat means any. */
  readonly onChanged: (listener: (change: { readonly canvasName: string; readonly seatId?: string }) => void) => () => void;
};

/** A party by name, as the popup says it: the operator is "you". */
const partyName = (party: MailParty): string => (party.kind === "operator" ? "you" : party.name);

/** The source over main's threads IPC, or undefined while the bridge lacks it. */
export const juntoSeatThreadsSource = (): SeatThreadsSource | undefined => {
  const api = getJuntoApi();
  const list = api?.seatThreadsList;
  const messages = api?.seatThreadMessages;
  const onMail = api?.onWorkMailChanged;
  if (typeof list !== "function" || typeof messages !== "function" || typeof onMail !== "function") return undefined;
  return {
    list: async ({ canvasName, seatId }) =>
      (await list({ canvasName, nodeId: seatId })).map((thread) => ({
        threadId: thread.threadId,
        title: thread.title,
        participants: thread.participants.map(partyName),
        startedAt: thread.startedAt,
        lastAt: thread.lastAt,
        messageCount: thread.messageCount,
        canReply: thread.canReply,
      })),
    messages: async ({ canvasName, seatId, threadId }) =>
      (await messages({ canvasName, nodeId: seatId, threadId })).map((message) => ({
        messageId: message.messageId,
        author: partyName(message.from),
        mine: message.mine,
        text: message.text,
        at: message.at,
      })),
    // Any mailbox can change a seat's threads: the canvas alone decides.
    onChanged: (listener) => onMail((event) => listener({ canvasName: event.canvasName })),
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
  installed = next;
  if (retained.size > 0) listenForChanges();
  for (const key of retained.keys()) void refreshSeat(key);
  for (const key of Object.keys(seatThreads$.messages.peek())) void refreshThread(key);
};

type SeatState = {
  readonly threads: ReadonlyArray<SeatThreadSummary>;
  readonly loaded: boolean;
  readonly error: string;
};

type ThreadState = {
  readonly messages: ReadonlyArray<SeatThreadMessage>;
  readonly loaded: boolean;
  readonly error: string;
};

export const seatThreads$ = observable<{
  readonly seats: Record<string, SeatState | undefined>;
  readonly messages: Record<string, ThreadState | undefined>;
}>({ seats: {}, messages: {} });

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

const refreshSeat = (key: string): Promise<void> =>
  coalesce(key, async () => {
    const read = activeSource();
    if (!read || !retained.has(key)) return;
    try {
      const threads = await read.list(seatOfKey(key));
      if (activeSource() !== read || !retained.has(key)) return;
      seatThreads$.seats[key].set({ threads: [...threads], loaded: true, error: "" });
    } catch (error) {
      const prior = seatThreads$.seats[key].peek();
      seatThreads$.seats[key].set({ threads: prior?.threads ?? [], loaded: true, error: errorText(error) });
    }
  });

const refreshThread = (key: string): Promise<void> =>
  coalesce(key, async () => {
    const read = activeSource();
    const [canvasName = "", seatId = "", threadId = ""] = key.split("\u0000");
    if (!read || !openThreads.has(key)) return;
    try {
      const messages = await read.messages({ canvasName, seatId, threadId });
      if (activeSource() !== read || !openThreads.has(key)) return;
      seatThreads$.messages[key].set({ messages: [...messages], loaded: true, error: "" });
    } catch (error) {
      const prior = seatThreads$.messages[key].peek();
      seatThreads$.messages[key].set({ messages: prior?.messages ?? [], loaded: true, error: errorText(error) });
    }
  });

/** Seats retained, and by how many users. */
const retained = new Map<string, number>();
/** Threads open, and by how many users. */
const openThreads = new Map<string, number>();
let offChanged: (() => void) | undefined;

const listenForChanges = (): void => {
  const read = activeSource();
  if (offChanged || !read) return;
  offChanged = read.onChanged((change) => {
    for (const key of retained.keys()) {
      const seat = seatOfKey(key);
      if (seat.canvasName !== change.canvasName) continue;
      if (change.seatId !== undefined && change.seatId !== seat.seatId) continue;
      void refreshSeat(key);
    }
    for (const key of openThreads.keys()) {
      const [canvasName, seatId] = key.split("\u0000");
      if (canvasName !== change.canvasName) continue;
      if (change.seatId !== undefined && change.seatId !== seatId) continue;
      void refreshThread(key);
    }
  });
};

const stopListeningIfIdle = (): void => {
  if (retained.size > 0 || openThreads.size > 0) return;
  offChanged?.();
  offChanged = undefined;
};

/** Keep a seat's thread list read and current; the returned function lets go. */
export const retainSeatThreads = (seat: SeatAddress): (() => void) => {
  const key = seatKey(seat);
  retained.set(key, (retained.get(key) ?? 0) + 1);
  listenForChanges();
  void refreshSeat(key);
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

/** Test helper: forget every seat, thread and source. */
export const resetSeatThreads = (): void => {
  offChanged?.();
  offChanged = undefined;
  installed = undefined;
  bridged = undefined;
  retained.clear();
  openThreads.clear();
  flights.clear();
  seatThreads$.set({ seats: {}, messages: {} });
};
