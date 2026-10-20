/**
 * The pages of a seat's threads and of one thread's messages. A cursor names
 * a place in the order, not a count: mail arriving at the newest end, even a
 * reply that lifts an old thread to the top, never repeats or skips what a
 * reader has yet to see.
 */
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { mailExtensionMetadata } from "../src/shared/crew";
import {
  seatMailThreadMessages,
  seatMailThreadMessagesPage,
  seatMailThreads,
  seatMailThreadsPage,
  type HeldMailbox,
  type MailThreadsInput,
} from "../src/shared/mail-threads";
import { makeUserMessage } from "../src/shared/task";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import type { Message } from "../src/shared/work-model";

const SEAT = "seat-1";
const T0 = Date.UTC(2026, 9, 19, 12);
const minute = (n: number) => T0 + n * 60_000;

/** Operator mail into SEAT: a new thread, or a reply in `threadId`. */
const operatorMail = (at: number, text: string, threadId?: string): Message =>
  makeUserMessage({
    messageId: ulid(at),
    text,
    contextId: "factory",
    metadata: {
      factoryMail: true,
      ...mailExtensionMetadata({
        mailKind: "prompt",
        fromSeat: OPERATOR_SEAT_ID,
        senderNodeId: "operator",
        senderName: "operator",
        senderGeneration: "operator",
        senderHarness: "unknown",
      }),
      ...(threadId === undefined ? {} : { threadId }),
    },
  });

const inputOf = (messages: ReadonlyArray<Message>): MailThreadsInput => {
  const mailboxes: HeldMailbox[] = [{ nodeId: SEAT, messages }];
  return { mailboxes, nameOf: () => undefined };
};

/** `count` threads, one minute apart, the first the oldest. */
const roots = (count: number): Message[] => Array.from({ length: count }, (_, n) => operatorMail(minute(n), `thread ${n}`));
const ids = (page: { threads: ReadonlyArray<{ threadId: string }> }) => page.threads.map((thread) => thread.threadId);

const walk = (input: MailThreadsInput, limit: number): string[] => {
  const seen: string[] = [];
  let after: string | undefined;
  do {
    const page = seatMailThreadsPage(input, SEAT, { limit, ...(after === undefined ? {} : { after }) });
    seen.push(...ids(page));
    after = page.next;
  } while (after !== undefined);
  return seen;
};

describe("a seat's threads, a page at a time", () => {
  it("pages the whole list newest first, once each, and ends without a cursor", () => {
    const input = inputOf(roots(23));
    const full = seatMailThreads(input, SEAT).map((thread) => thread.threadId);
    const first = seatMailThreadsPage(input, SEAT, { limit: 10 });
    expect(first.threads).toHaveLength(10);
    expect(first.next).toBeDefined();
    expect(walk(input, 10)).toEqual(full);
    expect(seatMailThreadsPage(input, SEAT, { limit: 23 }).next).toBeUndefined();
    expect(seatMailThreadsPage(input, SEAT, { limit: 100 }).threads).toHaveLength(23);
  });

  it("opens on a page of fifty and never more than the cap", () => {
    const input = inputOf(roots(300));
    expect(seatMailThreadsPage(input, SEAT).threads).toHaveLength(50);
    expect(seatMailThreadsPage(input, SEAT, { limit: 5_000 }).threads).toHaveLength(200);
  });

  it("is stable when new mail arrives at the top between pages", () => {
    const held = roots(30);
    const before = inputOf(held);
    const page1 = seatMailThreadsPage(before, SEAT, { limit: 10 });
    const rest = walk(before, 10).slice(10);

    // A new thread, a reply that lifts an unread old thread to the top, and a
    // reply that lifts one the reader already has.
    const unread = ids(seatMailThreadsPage(before, SEAT, { limit: 30 }))[20]!;
    const seen = ids(page1)[3]!;
    const arrived = [
      ...held,
      operatorMail(minute(100), "brand new"),
      operatorMail(minute(101), "lifts an old one", unread),
      operatorMail(minute(102), "lifts a seen one", seen),
    ];
    const after = inputOf(arrived);
    const page2 = seatMailThreadsPage(after, SEAT, { limit: 10, after: page1.next });

    // Nothing the reader has is repeated, and what follows is what followed,
    // less the thread that moved up out of it.
    expect(ids(page2).filter((id) => ids(page1).includes(id))).toEqual([]);
    const wanted = rest.filter((id) => id !== unread);
    expect(ids(page2)).toEqual(wanted.slice(0, 10));
    const tail: string[] = [];
    let cursor: string | undefined = page1.next;
    do {
      const page = seatMailThreadsPage(after, SEAT, { limit: 10, ...(cursor === undefined ? {} : { after: cursor }) });
      tail.push(...ids(page));
      cursor = page.next;
    } while (cursor !== undefined);
    expect(tail).toEqual(wanted);
  });

  it("starts at the newest end for a cursor it cannot read, and ends past the oldest", () => {
    const input = inputOf(roots(5));
    const newest = ids(seatMailThreadsPage(input, SEAT, { limit: 3 }));
    expect(ids(seatMailThreadsPage(input, SEAT, { limit: 3, after: "not a cursor" }))).toEqual(newest);
    expect(seatMailThreadsPage(input, SEAT, { limit: 3, after: "0.0" })).toEqual({ threads: [] });
  });

  it("summarises only a page's threads, each as the full list does", () => {
    const input = inputOf(roots(12));
    const full = seatMailThreads(input, SEAT);
    expect(seatMailThreadsPage(input, SEAT, { limit: 4 }).threads).toEqual(full.slice(0, 4));
  });
});

describe("a thread's messages, a page at a time", () => {
  const rootId = (held: Message[]) => held[0]!.messageId;
  const thread = (replies: number): Message[] => {
    const root = operatorMail(minute(0), "root");
    return [root, ...Array.from({ length: replies }, (_, n) => operatorMail(minute(n + 1), `reply ${n}`, root.messageId))];
  };

  it("opens on the newest page, oldest first, and pages up to the root", () => {
    const held = thread(44);
    const input = inputOf(held);
    const all = seatMailThreadMessages(input, SEAT, rootId(held)).map((message) => message.messageId);
    const newest = seatMailThreadMessagesPage(input, SEAT, rootId(held), { limit: 20 });
    expect(newest.messages.map((message) => message.messageId)).toEqual(all.slice(-20));
    expect(newest.older).toBeDefined();
    const pages = [newest];
    while (pages[0]!.older !== undefined) {
      pages.unshift(seatMailThreadMessagesPage(input, SEAT, rootId(held), { limit: 20, before: pages[0]!.older }));
    }
    expect(pages.flatMap((page) => page.messages.map((message) => message.messageId))).toEqual(all);
    expect(pages[0]!.messages[0]!.messageId).toBe(rootId(held));
    expect(pages[0]!.older).toBeUndefined();
  });

  it("keeps the older pages put when mail arrives at the newest end", () => {
    const held = thread(44);
    const root = rootId(held);
    const input = inputOf(held);
    const newest = seatMailThreadMessagesPage(input, SEAT, root, { limit: 20 });
    const olderBefore = seatMailThreadMessagesPage(input, SEAT, root, { limit: 20, before: newest.older });
    const arrived = inputOf([...held, operatorMail(minute(200), "late", root), operatorMail(minute(201), "later", root)]);
    expect(seatMailThreadMessagesPage(arrived, SEAT, root, { limit: 20, before: newest.older })).toEqual(olderBefore);
  });

  it("reads a short thread whole, and nothing for a thread that is not the seat's", () => {
    const held = thread(2);
    const input = inputOf(held);
    expect(seatMailThreadMessagesPage(input, SEAT, rootId(held))).toMatchObject({ messages: { length: 3 } });
    expect(seatMailThreadMessagesPage(input, SEAT, rootId(held)).older).toBeUndefined();
    expect(seatMailThreadMessagesPage(input, SEAT, ulid(minute(900)))).toEqual({ messages: [] });
  });
});
