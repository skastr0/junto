/**
 * The operator's read state on a seat's thread page (0.11.3): the desktop list
 * joins the read points in by thread id, so a row says when the operator last
 * read it and how much came after, and a thread with no point reads as never
 * read. The join never touches the order or the page's cursor.
 */
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { mailExtensionMetadata } from "../src/shared/crew";
import {
  seatMailThreadsPage,
  type HeldMailbox,
  type MailReadPoint,
  type MailThreadsInput,
} from "../src/shared/mail-threads";
import { makeAgentMessage, makeUserMessage } from "../src/shared/task";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import { ActorSeatId } from "../src/shared/wire/resource-actor";
import type { Message } from "../src/shared/work-model";
import { withReadPoints } from "../src/main/junto/work/operator-threads";

const SEAT = "seat-1";
const T0 = Date.UTC(2026, 9, 19, 12);
const minute = (n: number) => T0 + n * 60_000;

/** Mail from another seat into SEAT: a thread the operator has not written in. */
const peerMail = (at: number, text: string, threadId?: string): Message => {
  const message = makeUserMessage({
    messageId: ulid(at),
    text,
    contextId: "factory",
    metadata: {
      factoryMail: true,
      ...mailExtensionMetadata({
        mailKind: "prompt",
        fromSeat: ActorSeatId.make(`seat_${"a".repeat(64)}`),
        senderNodeId: "seat-2",
        senderName: "peer",
        senderGeneration: "peer",
        senderHarness: "unknown",
      }),
      ...(threadId === undefined ? {} : { threadId }),
    },
  });
  return message;
};

/** SEAT's reply to the operator: the mail the unread count counts (0.11.5). */
const replyMail = (at: number, threadId: string): Message =>
  makeAgentMessage({
    messageId: ulid(at),
    text: "done",
    contextId: "factory",
    metadata: {
      factoryMail: true,
      ...mailExtensionMetadata({
        mailKind: "prompt",
        fromSeat: ActorSeatId.make(`seat_${"b".repeat(64)}`),
        senderNodeId: SEAT,
        senderName: "agent",
        senderGeneration: "agent",
        senderHarness: "unknown",
      }),
      toNodeId: "operator",
      threadId,
      inReplyTo: threadId,
    },
  });

/** Mail the operator wrote into SEAT: one the unread count leaves out. */
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

describe("the operator's read state on a seat's thread page", () => {
  // The operator asks twice; the seat answers each, and the operator writes back in the first.
  const first = operatorMail(minute(0), "look at this");
  const second = operatorMail(minute(1), "and this");
  const early = replyMail(minute(2), first.messageId);
  const answered = operatorMail(minute(3), "thanks", first.messageId);
  const late = replyMail(minute(4), first.messageId);
  const secondReply = replyMail(minute(5), second.messageId);
  const between = peerMail(minute(6), "between seats");
  const input = inputOf([first, second, early, answered, late, secondReply, between]);
  const page = (points?: ReadonlyMap<string, MailReadPoint>) =>
    seatMailThreadsPage(points === undefined ? input : withReadPoints(input, points), SEAT, { limit: 30 });

  it("reads every thread as never read when no point is held, counting only replies to the operator past their own last mail", () => {
    const threads = page().threads;
    const one = threads.find((thread) => thread.threadId === first.messageId)!;
    expect(one.readAt).toBeUndefined();
    // The operator wrote after the early reply: only the late one is unread.
    expect(one.unread).toBe(1);
    expect(threads.find((thread) => thread.threadId === second.messageId)?.unread).toBe(1);
    expect(threads.find((thread) => thread.threadId === between.messageId)).toMatchObject({ canReply: false, unread: 0 });
  });

  it("says when a read thread was read, and what came after it", () => {
    const points = new Map<string, MailReadPoint>([
      [first.messageId, { through: late.messageId, at: minute(7) }],
    ]);
    const threads = page(points).threads;
    expect(threads.find((thread) => thread.threadId === first.messageId)).toMatchObject({
      readAt: minute(7),
      unread: 0,
    });
    // A thread the operator has not read carries no read time.
    expect(threads.find((thread) => thread.threadId === second.messageId)?.readAt).toBeUndefined();
    expect(threads.find((thread) => thread.threadId === second.messageId)?.unread).toBe(1);
  });

  it("leaves the order and the page exactly as they were", () => {
    const bare = page();
    const points = new Map<string, MailReadPoint>([[first.messageId, { through: answered.messageId, at: minute(3) }]]);
    const joined = page(points);
    expect(joined.threads.map((thread) => thread.threadId)).toEqual(bare.threads.map((thread) => thread.threadId));
    expect(joined.next).toEqual(bare.next);
  });
});
