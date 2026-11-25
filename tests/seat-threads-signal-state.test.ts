/**
 * A signal that closes takes its new state in place, wherever its message is
 * held: on a page of older messages already laid in, and on one that lands
 * after the change. Only the newest page is read again, so without this an
 * older page keeps the state it was read with.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadHeadSignal, ThreadSignal } from "../src/shared/wire/mail-threads";
import {
  loadOlderMessages,
  openSeatThread,
  resetSeatThreads,
  seatThreads$,
  setSeatThreadsSource,
  type SeatThreadMessage,
  type SeatThreadsSource,
  type SignalsChange,
} from "../src/window/lib/seat-threads";

const SEAT = { canvasName: "factory", seatId: "seat-1" };
const KEY = `factory\u0000seat-1\u0000notes`;

const signal = (signalId: string, over: Partial<ThreadSignal> = {}): ThreadSignal => ({
  signalId,
  kind: "escalate",
  state: "open",
  text: `Question ${signalId}?`,
  ...over,
});
const raised = (messageId: string, at: number, sig: ThreadSignal): SeatThreadMessage => ({
  messageId,
  author: "pty-lead",
  mine: false,
  text: sig.text,
  at,
  signal: sig,
});
const plain = (messageId: string, at: number): SeatThreadMessage => ({ messageId, author: "you", mine: true, text: "ok", at });

let signalListeners: Set<(change: SignalsChange) => void>;
let pages: Record<string, { messages: SeatThreadMessage[]; older?: string }>;
let head: ThreadHeadSignal | undefined;

const source = (): SeatThreadsSource => ({
  list: async () => ({ threads: [] }),
  messages: async ({ before }) => ({
    ...(pages[before ?? "newest"] ?? { messages: [] }),
    ...(head === undefined || before !== undefined ? {} : { headSignal: head }),
  }),
  onChanged: () => () => undefined,
  onSignalsChanged: (listener) => {
    signalListeners.add(listener);
    return () => signalListeners.delete(listener);
  },
  unreadTotal: async () => 0,
  markRead: async () => undefined,
  onReadChanged: () => () => undefined,
});

const closed = (...rows: Array<[string, ThreadSignal["state"]] | [string, ThreadSignal["state"], true]>): void =>
  signalListeners.forEach((listener) =>
    listener({
      canvasName: "factory",
      closed: rows.map(([signalId, state, crossed]) => ({ signalId, state, ...(crossed === true ? { crossed } : {}) })),
    }),
  );
const held = () => seatThreads$.messages[KEY].peek()!;
const stateOf = (messageId: string): ThreadSignal["state"] | undefined => held().messages.find((m) => m.messageId === messageId)?.signal?.state;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

let off: (() => void) | undefined;
beforeEach(async () => {
  signalListeners = new Set();
  head = undefined;
  pages = {
    newest: { messages: [plain("m9", 90)], older: "c1" },
    c1: { messages: [raised("m5", 50, signal("s5")), plain("m6", 60)], older: "c2" },
    c2: { messages: [raised("m1", 10, signal("s1")), plain("m2", 20)] },
  };
  setSeatThreadsSource(source());
  off = openSeatThread(SEAT, "notes");
  await settle();
});
afterEach(() => {
  off?.();
  resetSeatThreads();
});

describe("a signal that closes, on a page of older messages", () => {
  it("takes its new state in place on a page already laid in", async () => {
    await loadOlderMessages(SEAT, "notes");
    expect(stateOf("m5")).toBe("open");
    closed(["s5", "dismissed"]);
    expect(stateOf("m5")).toBe("dismissed");
  });

  it("takes it on a page that lands after the change", async () => {
    closed(["s1", "withdrawn"]);
    await loadOlderMessages(SEAT, "notes");
    await loadOlderMessages(SEAT, "notes");
    expect(stateOf("m5")).toBe("open");
    expect(stateOf("m1")).toBe("withdrawn");
  });

  it("takes it on the signal at the head of the thread", async () => {
    head = { ...signal("h1"), at: 5 };
    pages.newest = { messages: [plain("m9", 90)] };
    off?.();
    resetSeatThreads();
    setSeatThreadsSource(source());
    off = openSeatThread(SEAT, "notes");
    await settle();
    expect(held().headSignal?.state).toBe("open");
    closed(["h1", "answered"]);
    expect(held().headSignal?.state).toBe("answered");
  });

  it("never lays open over closed, and leaves a closing that main reported as it is", async () => {
    pages.c1 = { messages: [raised("m5", 50, signal("s5", { state: "answered", crossed: true }))] };
    await loadOlderMessages(SEAT, "notes");
    closed(["s5", "withdrawn"]);
    expect(held().messages.find((m) => m.messageId === "m5")?.signal).toMatchObject({ state: "answered", crossed: true });
  });

  it("lays a crossing with the closing: an open signal that crossed reads withdrawn and crossed, on a held page and on one that lands", async () => {
    await loadOlderMessages(SEAT, "notes");
    closed(["s5", "withdrawn", true], ["s1", "withdrawn", true]);
    expect(held().messages.find((m) => m.messageId === "m5")?.signal).toMatchObject({ state: "withdrawn", crossed: true });
    await loadOlderMessages(SEAT, "notes");
    expect(held().messages.find((m) => m.messageId === "m1")?.signal).toMatchObject({ state: "withdrawn", crossed: true });
  });

  it("adds the crossing to a closing already held, since the window's pair is the later word", async () => {
    pages.c1 = { messages: [raised("m5", 50, signal("s5", { state: "answered" }))] };
    await loadOlderMessages(SEAT, "notes");
    closed(["s5", "withdrawn", true]);
    expect(held().messages.find((m) => m.messageId === "m5")?.signal).toMatchObject({ state: "withdrawn", crossed: true });
  });

  it("changes nothing for a signal it does not hold, and nothing for an empty change", async () => {
    await loadOlderMessages(SEAT, "notes");
    const before = held();
    closed(["elsewhere", "dismissed"]);
    signalListeners.forEach((listener) => listener({ canvasName: "factory" }));
    expect(held()).toBe(before);
  });
});
