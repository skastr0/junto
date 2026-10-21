/**
 * Since your last session, as onboard shows it: threads owed and awaited by
 * their last message alone, with no time boundary; open signals; silent
 * signal answers bounded by the previous session's start; and an unread count
 * that agrees with `msg list --unread`.
 */
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { AgentSignal } from "../src/shared/agent-signals";
import { mailExtensionMetadata } from "../src/shared/crew";
import { mailListMatches } from "../src/shared/mail-list-filter";
import type { HeldMailbox } from "../src/shared/mail-threads";
import { asNodeId, type NodeId } from "../src/shared/model/base";
import {
  SINCE_COMMANDS,
  SINCE_PER_SECTION,
  SINCE_QUOTE_MAX,
  SINCE_SECTIONS,
  seatSince,
  sinceQuote,
  type Since,
  type SinceInput,
  type SinceSection,
  type SinceSectionKey,
} from "../src/shared/seat-since";
import { makeAgentMessage, makeUserMessage } from "../src/shared/task";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import type { Message } from "../src/shared/work-model";

const ME = asNodeId("seat-me");
const LEAD = "seat-lead";
const PEER = "seat-peer";
const T0 = Date.UTC(2026, 9, 21, 9);
const minute = (n: number) => T0 + n * 60_000;
const NAMES: Record<string, string> = { [ME]: "me", [LEAD]: "lead", [PEER]: "peer" };

/** A seat's actor id, one per node id. */
const seatIdOf = (nodeId: string): ActorSeatId =>
  Schema.decodeUnknownSync(ActorSeatId)(`seat_${Buffer.from(nodeId).toString("hex").padEnd(64, "0").slice(0, 64)}`);

type Receipts = { readonly deliveredAt?: number; readonly readAt?: number };

/** Seat mail from `from`, a row in the recipient's mailbox. */
const seatMail = (at: number, from: string, text: string, extra: Record<string, unknown> & Receipts = {}): Message =>
  makeUserMessage({
    messageId: ulid(at),
    text,
    contextId: "factory",
    metadata: {
      factoryMail: true,
      ...mailExtensionMetadata({
        mailKind: "prompt",
        fromSeat: seatIdOf(from),
        senderNodeId: from,
        senderName: NAMES[from] ?? from,
        senderGeneration: "g1",
        senderHarness: "claude",
      }),
      ...extra,
    },
  });

/** Operator mail into a seat's mailbox. */
const operatorMail = (at: number, text: string, extra: Record<string, unknown> & Receipts = {}): Message =>
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
      ...extra,
    },
  });

/** A seat's reply to the operator: an agent-role row in its own mailbox. */
const replyToOperator = (at: number, from: string, text: string, threadId: string): Message =>
  makeAgentMessage({
    messageId: ulid(at),
    text,
    contextId: "factory",
    metadata: {
      factoryMail: true,
      toNodeId: "operator",
      threadId,
      ...mailExtensionMetadata({
        mailKind: "prompt",
        fromSeat: seatIdOf(from),
        senderNodeId: from,
        senderName: NAMES[from] ?? from,
        senderGeneration: "g1",
        senderHarness: "claude",
      }),
    },
  });

let signalCount = 0;
const signal = (over: Partial<AgentSignal> & Pick<AgentSignal, "state">): AgentSignal => {
  signalCount += 1;
  return {
    signalId: `sig-${signalCount}`,
    canvasName: "factory",
    nodeId: ME,
    kind: "escalate",
    text: `signal ${signalCount}`,
    createdAt: minute(signalCount),
    ...over,
  };
};

const inputOf = (
  mailboxes: Record<string, ReadonlyArray<Message>>,
  over: Partial<SinceInput> = {},
): SinceInput => ({
  seat: ME,
  mailboxes: Object.entries(mailboxes).map(([nodeId, messages]): HeldMailbox => ({ nodeId, messages })),
  nameOf: (nodeId) => NAMES[nodeId],
  signals: [],
  previousStartedAt: 0,
  now: minute(1000),
  ...over,
});

const since = (input: SinceInput, perSection = SINCE_PER_SECTION): Since => seatSince(input, { perSection });

describe("owed and awaited replies", () => {
  it("owes a reply when the last mail in a thread is to the seat, read or not", () => {
    const root = seatMail(minute(1), LEAD, "Please land the contract", { readAt: minute(2) });
    const out = since(inputOf({ [ME]: [root] }));
    expect(out.owedReplies.lines).toEqual([
      { text: 'lead wrote last, you have not replied: "Please land the contract"', ref: root.messageId },
    ]);
    expect(out.awaitingReplies.lines).toEqual([]);
  });

  it("awaits a reply once the seat wrote last, with the recipient's receipts", () => {
    const root = seatMail(minute(1), LEAD, "Please land the contract");
    const reply = seatMail(minute(2), ME, "Landed", { threadId: root.messageId, deliveredAt: minute(3) });
    const out = since(inputOf({ [ME]: [root], [LEAD]: [reply] }));
    expect(out.owedReplies.lines).toEqual([]);
    expect(out.awaitingReplies.lines).toEqual([
      { text: 'You wrote last to lead, delivered, unread: "Landed"', ref: reply.messageId },
    ]);
  });

  it("says read, delivered or not delivered from the last mail's receipts", () => {
    const read = seatMail(minute(1), ME, "one", { deliveredAt: minute(2), readAt: minute(3) });
    const queued = seatMail(minute(4), ME, "two");
    const lines = since(inputOf({ [LEAD]: [read], [PEER]: [queued] })).awaitingReplies.lines.map((line) => line.text);
    expect(lines).toEqual([
      'You wrote last to peer, not delivered yet: "two"',
      'You wrote last to lead, read: "one"',
    ]);
  });

  it("has no time boundary: a thread from long before the previous session still counts", () => {
    const old = seatMail(minute(1), LEAD, "old ask");
    const out = since(inputOf({ [ME]: [old] }, { previousStartedAt: minute(900) }));
    expect(out.owedReplies.lines.map((line) => line.ref)).toEqual([old.messageId]);
  });

  it("owes the operator a reply, and awaits the operator after replying", () => {
    const ask = operatorMail(minute(1), "Status?");
    expect(since(inputOf({ [ME]: [ask] })).owedReplies.lines[0]?.text).toBe(
      'the operator wrote last, you have not replied: "Status?"',
    );
    const answer = replyToOperator(minute(2), ME, "On it", ask.messageId);
    const out = since(inputOf({ [ME]: [ask, answer] }));
    expect(out.owedReplies.lines).toEqual([]);
    expect(out.awaitingReplies.lines[0]?.text).toBe('You wrote last to the operator, not delivered yet: "On it"');
  });

  it("ignores threads between other seats and mail that is not conversation", () => {
    const others = seatMail(minute(1), LEAD, "not yours");
    const receipt = seatMail(minute(2), LEAD, "receipt", { mailKind: "receipt" });
    const taskComment = makeUserMessage({
      messageId: ulid(minute(3)),
      text: "task note",
      contextId: "factory",
      taskId: "task-1",
      metadata: { factoryMail: true, fromSeat: "seatid-lead", senderNodeId: LEAD },
    });
    const out = since(inputOf({ [PEER]: [others], [ME]: [receipt, taskComment] }));
    expect(out.owedReplies.lines).toEqual([]);
    expect(out.awaitingReplies.lines).toEqual([]);
  });

  it("lists newest activity first and quotes the last mail on one line, cut", () => {
    const long = `first line\n\n${"x".repeat(200)}`;
    const a = seatMail(minute(1), LEAD, "older");
    const b = seatMail(minute(2), PEER, long);
    const lines = since(inputOf({ [ME]: [a, b] })).owedReplies.lines;
    expect(lines.map((line) => line.ref)).toEqual([b.messageId, a.messageId]);
    expect(lines[0]?.text).toContain(sinceQuote(long));
    expect(sinceQuote(long)).toHaveLength(SINCE_QUOTE_MAX);
    expect(sinceQuote(long).endsWith("…")).toBe(true);
    expect(sinceQuote(long)).not.toContain("\n");
  });
});

describe("signals", () => {
  it("lists this seat's open signals in signal list order, most urgent first", () => {
    const feedback = signal({ state: "open", kind: "feedback" });
    const blocked = signal({ state: "open", kind: "blocked" });
    const closed = signal({ state: "dismissed", closedAt: minute(50) });
    const elsewhere = signal({ state: "open", nodeId: PEER });
    const out = since(inputOf({}, { signals: [feedback, blocked, closed, elsewhere] }));
    expect(out.openSignals.lines).toEqual([
      { text: `Open blocked: "${blocked.text}"`, ref: blocked.signalId },
      { text: `Open feedback: "${feedback.text}"`, ref: feedback.signalId },
    ]);
    expect(out.openSignals.command).toBe("junto signal list");
  });

  it("shows silent answers since the previous session started, newest first", () => {
    const before = signal({ state: "answered", response: { text: "old", at: minute(99) }, closedAt: minute(99) });
    const atStart = signal({ state: "answered", response: { text: "go ahead", at: minute(100) }, closedAt: minute(100) });
    const later = signal({ state: "answered", kind: "blocked", response: { text: "unblocked", at: minute(120) }, closedAt: minute(120) });
    const out = since(inputOf({}, { signals: [before, atStart, later], previousStartedAt: minute(100) }));
    expect(out.answersSince.lines).toEqual([
      { text: `The operator answered your blocked "${later.text}" without mail: "unblocked"`, ref: later.signalId },
      { text: `The operator answered your escalate "${atStart.text}" without mail: "go ahead"`, ref: atStart.signalId },
    ]);
  });

  it("leaves a mailed answer to the mail sections", () => {
    const answered = signal({ state: "answered", response: { text: "yes", at: minute(200) }, closedAt: minute(200) });
    const mail = operatorMail(minute(200), `The operator answered your escalate signal (${answered.signalId})`, {
      agentSignalId: answered.signalId,
    });
    const out = since(inputOf({ [ME]: [mail] }, { signals: [answered] }));
    expect(out.answersSince.lines).toEqual([]);
    expect(out.owedReplies.lines.map((line) => line.ref)).toEqual([mail.messageId]);
  });
});

describe("unread", () => {
  it("counts the seat's own unread rows exactly as msg list --unread does", () => {
    const unread = seatMail(minute(1), LEAD, "a");
    const read = seatMail(minute(2), LEAD, "b", { readAt: minute(3) });
    const notMail = makeUserMessage({ messageId: ulid(minute(4)), text: "task brief", contextId: "factory" });
    const own = replyToOperator(minute(5), ME, "mine", unread.messageId);
    const elsewhere = seatMail(minute(6), LEAD, "c");
    const mine = [unread, read, notMail, own];
    const out = since(inputOf({ [ME]: mine, [PEER]: [elsewhere] }));
    expect(out.unread).toBe(mine.filter(mailListMatches({ unread: true })).length);
    expect(out.unread).toBe(2);
  });
});

describe("caps", () => {
  it("caps each section, counts the rest, and names the command that lists it", () => {
    const mail = Array.from({ length: 11 }, (_, n) => seatMail(minute(n), LEAD, `ask ${n}`));
    const out = since(inputOf({ [ME]: mail }), 8);
    expect(out.owedReplies.lines).toHaveLength(8);
    expect(out.owedReplies.more).toBe(3);
    expect(out.owedReplies.command).toBe("junto since --all");
    const all = since(inputOf({ [ME]: mail }), Number.POSITIVE_INFINITY);
    expect(all.owedReplies.lines).toHaveLength(11);
    expect(all.owedReplies.more).toBe(0);
  });

  it("is as of the time it is given and empty for a quiet seat", () => {
    const out = since(inputOf({}, { now: 42 }));
    expect(out).toEqual({
      asOf: 42,
      owedReplies: { lines: [], more: 0, command: SINCE_COMMANDS.owedReplies },
      awaitingReplies: { lines: [], more: 0, command: SINCE_COMMANDS.awaitingReplies },
      openSignals: { lines: [], more: 0, command: SINCE_COMMANDS.openSignals },
      answersSince: { lines: [], more: 0, command: SINCE_COMMANDS.answersSince },
      unread: 0,
    });
  });
});

describe("types", () => {
  it("takes a branded seat id, never a bare string", () => {
    expectTypeOf<SinceInput["seat"]>().toEqualTypeOf<NodeId>();
    // @ts-expect-error a bare string is not a NodeId
    const bad: SinceInput["seat"] = "seat-me";
    void bad;
  });

  it("has one section per key and one command per section", () => {
    expectTypeOf<SinceSectionKey>().toEqualTypeOf<"owedReplies" | "awaitingReplies" | "openSignals" | "answersSince">();
    expectTypeOf<Since[SinceSectionKey]>().toEqualTypeOf<SinceSection>();
    expectTypeOf<keyof Since>().toEqualTypeOf<SinceSectionKey | "asOf" | "unread">();
    expect(Object.keys(SINCE_COMMANDS).sort()).toEqual([...SINCE_SECTIONS].sort());
  });
});
