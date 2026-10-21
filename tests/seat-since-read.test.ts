/**
 * The since read takes the seat's own mailbox and the mail it sent into other
 * seats' mailboxes, never every mailbox on the canvas. `seatSince` only uses
 * mail the seat wrote or was written, so the projection over those two reads
 * is the projection over every seat's mailbox: proven here on a canvas with
 * mail between other seats, a reply to the operator, receipts, a signal
 * answered by mail and a comment held at a task node.
 */
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { seatMailboxes } from "../src/main/junto/work/seat-since-read";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { AgentSignal } from "../src/shared/agent-signals";
import { mailExtensionMetadata } from "../src/shared/crew";
import type { HeldMailbox } from "../src/shared/mail-threads";
import { asNodeId } from "../src/shared/model/base";
import { SINCE_PER_SECTION, seatSince, type Since } from "../src/shared/seat-since";
import { makeAgentMessage, makeUserMessage } from "../src/shared/task";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import type { Message } from "../src/shared/work-model";

const ME = "seat-me";
const LEAD = "seat-lead";
const PEER = "seat-peer";
const TASK = "task-node";
const SEATS: ReadonlySet<string> = new Set([ME, LEAD, PEER]);
const T0 = Date.UTC(2026, 9, 21, 9);
const minute = (n: number) => T0 + n * 60_000;

const seatIdOf = (nodeId: string): ActorSeatId =>
  Schema.decodeUnknownSync(ActorSeatId)(`seat_${Buffer.from(nodeId).toString("hex").padEnd(64, "0").slice(0, 64)}`);

const stamp = (from: string) =>
  from === "operator"
    ? mailExtensionMetadata({
        mailKind: "prompt",
        fromSeat: OPERATOR_SEAT_ID,
        senderNodeId: "operator",
        senderName: "operator",
        senderGeneration: "operator",
        senderHarness: "unknown",
      })
    : mailExtensionMetadata({
        mailKind: "prompt",
        fromSeat: seatIdOf(from),
        senderNodeId: from,
        senderName: from,
        senderGeneration: "g1",
        senderHarness: "claude",
      });

/** Mail from `from`, a row in its recipient's mailbox. */
const mail = (at: number, from: string, text: string, extra: Record<string, unknown> = {}): Message =>
  makeUserMessage({ messageId: ulid(at), text, contextId: "factory", metadata: { factoryMail: true, ...stamp(from), ...extra } });

/** A seat's reply to the operator: an agent-role row in its own mailbox. */
const toOperator = (at: number, from: string, text: string, threadId: string): Message =>
  makeAgentMessage({
    messageId: ulid(at),
    text,
    contextId: "factory",
    metadata: { factoryMail: true, toNodeId: "operator", threadId, ...stamp(from) },
  });

const toLead = mail(minute(1), ME, "Landed abc123", { deliveredAt: minute(2), readAt: minute(3) });
const leadReply = mail(minute(4), LEAD, "Thanks, next one", { threadId: toLead.messageId, inReplyTo: toLead.messageId });
const leadToPeer = mail(minute(5), LEAD, "Peer, look at this too", { threadId: toLead.messageId });
const toPeer = mail(minute(6), ME, "Can you check P5?", { deliveredAt: minute(7) });
const peerToLead = mail(minute(8), PEER, "Not my thread");
const operatorAsk = mail(minute(9), "operator", "Status?");
const myAnswer = toOperator(minute(10), ME, "On it", operatorAsk.messageId);
const answeredByMail = mail(minute(11), "operator", "Yes, go", { agentSignalId: "sig-mailed" });
const taskComment = mail(minute(12), ME, "Comment on the task", { subject: { kind: "task", nodeId: TASK } });

/** Every mailbox on the canvas, as the store holds it. */
const CANVAS: Readonly<Record<string, ReadonlyArray<Message>>> = {
  [ME]: [leadReply, operatorAsk, myAnswer, answeredByMail],
  [LEAD]: [toLead, peerToLead],
  [PEER]: [leadToPeer, toPeer],
  [TASK]: [taskComment],
};

/** What `mailSentBy` returns: every row stamped with the sender, outside its own mailbox. */
const sentBy = (sender: string) =>
  Object.entries(CANVAS).flatMap(([nodeId, messages]) =>
    nodeId === sender ? [] : messages.filter((row) => row.metadata?.senderNodeId === sender).map((message) => ({ nodeId, message })),
  );

const signals: ReadonlyArray<AgentSignal> = [
  {
    signalId: "sig-mailed",
    canvasName: "factory",
    nodeId: ME,
    kind: "escalate",
    text: "May I land?",
    createdAt: minute(1),
    state: "answered",
    response: { text: "Yes, go", at: minute(11) },
  } as AgentSignal,
];

const sinceOver = (mailboxes: ReadonlyArray<HeldMailbox>, seat: string): Since =>
  seatSince(
    { seat: asNodeId(seat), mailboxes, nameOf: (id) => id, signals: signals.filter((s) => s.nodeId === seat), now: minute(100) },
    { perSection: SINCE_PER_SECTION },
  );

/** Every seat's mailbox, as the read took them before. */
const everySeatMailbox: ReadonlyArray<HeldMailbox> = [...SEATS].map((nodeId) => ({ nodeId, messages: CANVAS[nodeId] ?? [] }));

describe("the since read takes only the seat's own mail", () => {
  it("is the seat's own mailbox and what it sent, each row in the mailbox it sits in", () => {
    expect(seatMailboxes(ME, SEATS, CANVAS[ME]!, sentBy(ME))).toEqual([
      { nodeId: ME, messages: CANVAS[ME] },
      { nodeId: LEAD, messages: [toLead] },
      { nodeId: PEER, messages: [toPeer] },
    ]);
  });

  it("leaves out mail held at a node that is not a seat, and its own mailbox's rows from the sent read", () => {
    const held = seatMailboxes(ME, SEATS, CANVAS[ME]!, [...sentBy(ME), { nodeId: ME, message: myAnswer }]);
    expect(held.map((mailbox) => mailbox.nodeId)).toEqual([ME, LEAD, PEER]);
    expect(held.flatMap((mailbox) => mailbox.messages)).not.toContain(taskComment);
    expect(held.filter((mailbox) => mailbox.nodeId === ME)).toHaveLength(1);
  });

  it.each([ME, LEAD, PEER])("gives %s the same since as reading every seat's mailbox", (seat) => {
    const projected = sinceOver(seatMailboxes(seat, SEATS, CANVAS[seat] ?? [], sentBy(seat)), seat);
    expect(projected).toEqual(sinceOver(everySeatMailbox, seat));
  });

  it("keeps what the seat owes, awaits and has unread, with receipts and the mailed answer", () => {
    const projected = sinceOver(seatMailboxes(ME, SEATS, CANVAS[ME]!, sentBy(ME)), ME);
    // The operator's mailed answer starts a thread of its own, newest first.
    expect(projected.owedReplies.lines.map((line) => line.ref)).toEqual([
      { kind: "mail", messageId: answeredByMail.messageId },
      { kind: "mail", messageId: leadReply.messageId },
    ]);
    expect(projected.awaitingReplies.lines.map((line) => line.text)).toEqual([
      'You wrote last to the operator, not delivered yet: "On it"',
      'You wrote last to seat-peer, delivered, unread: "Can you check P5?"',
    ]);
    expect(projected.answersSince.lines).toEqual([]);
    expect(projected.unread).toBe(sinceOver(everySeatMailbox, ME).unread);
  });

  it("reads nothing but its own mailbox when it sent nothing, and nothing at all when it is not a seat", () => {
    expect(seatMailboxes(PEER, SEATS, [], [])).toEqual([{ nodeId: PEER, messages: [] }]);
    expect(seatMailboxes(TASK, SEATS, CANVAS[TASK]!, sentBy(TASK))).toEqual([]);
  });
});
