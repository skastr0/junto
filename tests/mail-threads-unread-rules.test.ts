/**
 * The operator's unread, as the operator ruled it for 0.11.5. One derivation
 * counts for the desktop's rows and header and for the phone:
 *
 *   1. Only threads the operator is in count. Mail between seats never does,
 *      and those threads stay readable with no count.
 *   2. What the operator wrote is read, a Needs you answer too, and writing in
 *      a thread reads it through that mail.
 *   3. Only replies to the operator count, never seat mail inside the
 *      operator's own thread.
 *   4. The operator's threads page apart from those between seats, each list
 *      on its own cursor, so seat mail never pushes them off a page.
 */
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { mailExtensionMetadata } from "../src/shared/crew";
import {
  seatMailThreadEntries,
  seatMailThreads,
  seatMailThreadsPage,
  unreadPast,
  type MailReadPoint,
  type MailThreadsInput,
  type ThreadGroup,
} from "../src/shared/mail-threads";
import { makeAgentMessage, makeUserMessage } from "../src/shared/task";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import { ActorSeatId } from "../src/shared/wire/resource-actor";
import type { Message } from "../src/shared/work-model";

const SEAT = "seat-1";
const PEER = "seat-2";
const T0 = Date.UTC(2026, 9, 30, 12);
const minute = (n: number) => T0 + n * 60_000;

const operatorMeta = mailExtensionMetadata({
  mailKind: "prompt",
  fromSeat: OPERATOR_SEAT_ID,
  senderNodeId: "operator",
  senderName: "operator",
  senderGeneration: "operator",
  senderHarness: "unknown",
});
const peerMeta = mailExtensionMetadata({
  mailKind: "prompt",
  fromSeat: ActorSeatId.make(`seat_${"a".repeat(64)}`),
  senderNodeId: PEER,
  senderName: "peer",
  senderGeneration: "peer",
  senderHarness: "unknown",
});
const seatMeta = mailExtensionMetadata({
  mailKind: "prompt",
  fromSeat: ActorSeatId.make(`seat_${"b".repeat(64)}`),
  senderNodeId: SEAT,
  senderName: "agent",
  senderGeneration: "agent",
  senderHarness: "unknown",
});

const thread = (threadId: string | undefined, inReplyTo?: string) => ({
  ...(threadId === undefined ? {} : { threadId }),
  ...(inReplyTo === undefined ? {} : { inReplyTo }),
});

/** Operator mail into SEAT, as the thread view and the phone write it. */
const operatorMail = (at: number, threadId?: string, extra: Record<string, unknown> = {}): Message =>
  makeUserMessage({ messageId: ulid(at), text: "from the operator", contextId: "factory", metadata: { factoryMail: true, ...operatorMeta, ...thread(threadId), ...extra } });

/** A Needs you answer: operator mail naming the signal it answers, a thread of its own. */
const needsYouAnswer = (at: number): Message => operatorMail(at, undefined, { agentSignalId: "sig-1" });

/** SEAT's reply to the operator: an agent-role row in its own mailbox. */
const replyToOperator = (at: number, threadId: string, inReplyTo: string): Message =>
  makeAgentMessage({ messageId: ulid(at), text: "to the operator", contextId: "factory", metadata: { factoryMail: true, ...seatMeta, toNodeId: "operator", ...thread(threadId, inReplyTo) } });

/** Seat mail from PEER into SEAT: a new thread between seats, or a row inside one. */
const peerMail = (at: number, threadId?: string, inReplyTo?: string): Message =>
  makeUserMessage({ messageId: ulid(at), text: "between seats", contextId: "factory", metadata: { factoryMail: true, ...peerMeta, ...thread(threadId, inReplyTo) } });

/** SEAT's mail to PEER, held in PEER's mailbox. */
const seatToPeer = (at: number, threadId?: string, inReplyTo?: string): Message =>
  makeUserMessage({ messageId: ulid(at), text: "seat to peer", contextId: "factory", metadata: { factoryMail: true, ...seatMeta, ...thread(threadId, inReplyTo) } });

const inputOf = (seat: ReadonlyArray<Message>, peer: ReadonlyArray<Message> = [], points: ReadonlyMap<string, MailReadPoint> = new Map()): MailThreadsInput => ({
  mailboxes: [
    { nodeId: SEAT, messages: seat },
    { nodeId: PEER, messages: peer },
  ],
  nameOf: (nodeId) => (nodeId === SEAT ? "agent" : nodeId === PEER ? "peer" : undefined),
  readPointOf: (threadId) => points.get(threadId),
});

/** The seat's total as main counts it (work/mail-reads.ts unreadTotals). */
const total = (input: MailThreadsInput, nodeId = SEAT) =>
  [...seatMailThreadEntries(input, nodeId)].reduce((sum, [threadId, entries]) => sum + unreadPast(entries, input.readPointOf?.(threadId)), 0);

const summary = (input: MailThreadsInput, threadId: string, nodeId = SEAT) =>
  seatMailThreads(input, nodeId).find((item) => item.threadId === threadId)!;

describe("rule 1: only threads the operator is in count", () => {
  it("never counts or badges a thread between seats, never read, and it stays readable", () => {
    const opened = peerMail(minute(0));
    const answered = seatToPeer(minute(1), opened.messageId, opened.messageId);
    const more = peerMail(minute(2), opened.messageId, answered.messageId);
    const input = inputOf([opened, more], [answered]);

    for (const nodeId of [SEAT, PEER]) {
      const between = summary(input, opened.messageId, nodeId);
      expect(between).toMatchObject({ canReply: false, unread: 0, messageCount: 3 });
      expect(total(input, nodeId)).toBe(0);
    }
  });

  it("counts a thousand seat mails as nothing, beside one reply to the operator", () => {
    const seatMail = Array.from({ length: 1_000 }, (_, n) => peerMail(minute(n)));
    const asked = operatorMail(minute(2_000));
    const input = inputOf([...seatMail, asked, replyToOperator(minute(2_001), asked.messageId, asked.messageId)]);
    expect(total(input)).toBe(1);
  });
});

describe("rule 2: what the operator wrote is read, and writing reads the thread", () => {
  it("never counts the operator's own mail, a Needs you answer included", () => {
    const answer = needsYouAnswer(minute(0));
    const sent = operatorMail(minute(1));
    const input = inputOf([answer, sent, operatorMail(minute(2), sent.messageId)]);
    expect(summary(input, answer.messageId)).toMatchObject({ canReply: true, unread: 0 });
    expect(summary(input, sent.messageId)).toMatchObject({ canReply: true, unread: 0 });
    expect(total(input)).toBe(0);
  });

  it("reads a seat's reply when the operator writes after it, with no read point stored", () => {
    const asked = operatorMail(minute(0));
    const r1 = replyToOperator(minute(1), asked.messageId, asked.messageId);
    const r2 = replyToOperator(minute(2), asked.messageId, asked.messageId);
    expect(total(inputOf([asked, r1, r2]))).toBe(2);

    // The operator answers: the read point is that mail, so both replies are read.
    const answered = operatorMail(minute(3), asked.messageId);
    expect(total(inputOf([asked, r1, r2, answered]))).toBe(0);

    // A reply after it counts again, and only it.
    const r3 = replyToOperator(minute(4), asked.messageId, answered.messageId);
    expect(summary(inputOf([asked, r1, r2, answered, r3]), asked.messageId).unread).toBe(1);
  });

  it("reads through a Needs you answer the same way", () => {
    const answer = needsYouAnswer(minute(0));
    const reply = replyToOperator(minute(1), answer.messageId, answer.messageId);
    expect(total(inputOf([answer, reply]))).toBe(1);
    const again = operatorMail(minute(2), answer.messageId);
    expect(total(inputOf([answer, reply, again]))).toBe(0);
  });

  it("keeps a stored read point that is later than the operator's last mail", () => {
    const asked = operatorMail(minute(0));
    const r1 = replyToOperator(minute(1), asked.messageId, asked.messageId);
    const r2 = replyToOperator(minute(2), asked.messageId, asked.messageId);
    const points = new Map([[asked.messageId, { through: r1.messageId, at: minute(5) }]]);
    expect(total(inputOf([asked, r1, r2], [], points))).toBe(1);
  });
});

describe("rule 3: only replies to the operator count", () => {
  it("leaves seat mail inside the operator's thread uncounted", () => {
    const asked = operatorMail(minute(0));
    // The seat brings a peer into the operator's thread; the peer answers the seat.
    const toPeer = seatToPeer(minute(1), asked.messageId, asked.messageId);
    const fromPeer = peerMail(minute(2), asked.messageId, toPeer.messageId);
    const input = inputOf([asked, fromPeer], [toPeer]);
    expect(summary(input, asked.messageId)).toMatchObject({ canReply: true, unread: 0 });
    expect(total(input)).toBe(0);

    // The seat's reply to the operator is the one that counts.
    const reply = replyToOperator(minute(3), asked.messageId, asked.messageId);
    expect(total(inputOf([asked, fromPeer, reply], [toPeer]))).toBe(1);
  });

  it("leaves a seat's answer to the operator's mail uncounted when it goes to another seat", () => {
    const asked = operatorMail(minute(0));
    const sideways = peerMail(minute(1), asked.messageId, asked.messageId);
    expect(total(inputOf([asked, sideways]))).toBe(0);
  });
});

describe("rule 4: the operator's threads page apart, each list on its own cursor", () => {
  /** Three operator threads, then sixty between seats, all newer. */
  const flooded = (): Message[] => {
    const mine = [0, 1, 2].map((n) => operatorMail(minute(n)));
    const opened = peerMail(minute(3));
    const toOperator = replyToOperator(minute(4), opened.messageId, opened.messageId);
    const seatMail = Array.from({ length: 60 }, (_, n) => peerMail(minute(10 + n)));
    return [...mine, opened, toOperator, ...seatMail];
  };
  const ids = (page: { threads: ReadonlyArray<{ threadId: string }> }) => page.threads.map((item) => item.threadId);
  const walk = (input: MailThreadsInput, group: ThreadGroup, limit: number): string[] => {
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = seatMailThreadsPage(input, SEAT, { limit, group, ...(after === undefined ? {} : { after }) });
      seen.push(...ids(page));
      after = page.next;
    } while (after !== undefined);
    return seen;
  };

  it("holds every thread the operator is in on the first page of its list, however much seat mail is newer", () => {
    const input = inputOf(flooded());
    // As one list, a page of fifty holds none of them: they went missing.
    expect(seatMailThreadsPage(input, SEAT, { limit: 50 }).threads.filter((item) => item.canReply)).toHaveLength(0);

    const withYou = seatMailThreadsPage(input, SEAT, { limit: 50, group: "with-you" });
    expect(withYou.threads).toHaveLength(4);
    expect(withYou.threads.every((item) => item.canReply)).toBe(true);
    expect(withYou.next).toBeUndefined();
  });

  it("pages each list on its own cursor, every thread once, none in both", () => {
    const input = inputOf(flooded());
    const withYou = walk(input, "with-you", 2);
    const between = walk(input, "between", 25);
    expect(withYou).toHaveLength(4);
    expect(between).toHaveLength(60);
    expect(withYou.filter((id) => between.includes(id))).toEqual([]);
    expect(new Set([...withYou, ...between])).toEqual(new Set(seatMailThreads(input, SEAT).map((item) => item.threadId)));
  });

  it("puts a thread a seat opened to the operator with the operator's threads in the phone's one list too", () => {
    const input = inputOf(flooded());
    const first = seatMailThreadsPage(input, SEAT, { limit: 4, ownedFirst: true });
    expect(first.threads.every((item) => item.canReply)).toBe(true);
    // The fourth is the seat's thread to the operator, which the operator never wrote in.
    expect(first.threads.some((item) => item.canReply && !item.owned)).toBe(true);
    const second = seatMailThreadsPage(input, SEAT, { limit: 4, ownedFirst: true, after: first.next! });
    expect(second.threads.every((item) => !item.canReply)).toBe(true);
  });
});
