import { Schema } from "effect";
import { mailThreadOf } from "../crew";
import { messageIdTimeMs } from "../message-delivery";
import type { Message } from "../work-model";
import { OPERATOR_SEAT_ID } from "../work-reference";

/**
 * Mail threads: the mail that hangs off one root message, read from the
 * mailboxes the store already holds. One derivation, shared by the desktop's
 * Threads popup and the phone's `threads.list`.
 *
 * A mail's thread is its `threadId`, or its own id when it starts one. Mail
 * reaches a thread three ways: seat mail and replies (each a row in the
 * recipient's mailbox), operator mail (a row in each addressed seat's
 * mailbox, one per seat, sharing a `sendId`), and a seat's reply to the
 * operator (an agent-role row in the seat's own mailbox naming
 * `toNodeId: "operator"`). Nothing here reads or writes anything else.
 *
 * There is no operator read state for mail, so a summary says nothing about
 * what the operator has seen.
 */

export const MailParty = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("operator") }),
  Schema.Struct({ kind: Schema.Literal("seat"), nodeId: Schema.String, name: Schema.String }),
]);
export type MailParty = typeof MailParty.Type;

export const MailThreadMessage = Schema.Struct({
  messageId: Schema.String,
  threadId: Schema.String,
  inReplyTo: Schema.optionalKey(Schema.String),
  from: MailParty,
  /** Every recipient; operator mail with mentions has several. */
  to: Schema.Array(MailParty),
  /** The operator wrote it. */
  mine: Schema.Boolean,
  text: Schema.String,
  /** Epoch ms, from the ULID. */
  at: Schema.Number,
});
export type MailThreadMessage = typeof MailThreadMessage.Type;

export const MailThreadSummary = Schema.Struct({
  threadId: Schema.String,
  /** The root mail's first line, or the oldest mail's when the root is not held. */
  title: Schema.String,
  /** Everyone who wrote or was written to, in order of first appearance. */
  participants: Schema.Array(MailParty),
  startedAt: Schema.Number,
  lastAt: Schema.Number,
  last: MailThreadMessage,
  messageCount: Schema.Number,
  /** The operator sent mail in it, or mail in it is addressed to the operator. */
  canReply: Schema.Boolean,
});
export type MailThreadSummary = typeof MailThreadSummary.Type;

/** One seat's mailbox as the store holds it. */
export type HeldMailbox = { readonly nodeId: string; readonly messages: ReadonlyArray<Message> };

export type MailThreadsInput = {
  readonly mailboxes: ReadonlyArray<HeldMailbox>;
  /** A seat's display name; the node id stands in when it has none. */
  readonly nameOf: (nodeId: string) => string | undefined;
};

const OPERATOR: MailParty = { kind: "operator" };

const text = (message: Message): string =>
  message.parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n")
    .trim();

const stringField = (message: Message, key: string): string | undefined => {
  const value = message.metadata?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

const sameParty = (a: MailParty, b: MailParty): boolean =>
  a.kind === b.kind && (a.kind === "operator" || (b.kind === "seat" && a.nodeId === b.nodeId));

const partyKey = (party: MailParty): string => (party.kind === "operator" ? "operator" : `seat:${party.nodeId}`);

type Entry = MailThreadMessage & { readonly sendKey: string };

/**
 * One mailbox row as thread mail, or undefined when it is not conversation:
 * task comments, receipts, Junto's own prompts, and a seat's private notes.
 */
const entryOf = (row: Message, mailbox: string, seat: (nodeId: string) => MailParty): Entry | undefined => {
  if (row.metadata?.factoryMail !== true || row.taskId !== undefined) return undefined;
  if (stringField(row, "mailKind") === "receipt") return undefined;
  const fromSeat = stringField(row, "fromSeat");
  const senderName = stringField(row, "senderName");
  let from: MailParty;
  if (fromSeat === OPERATOR_SEAT_ID) {
    if (senderName !== "operator") return undefined;
    from = OPERATOR;
  } else {
    const sender = stringField(row, "senderNodeId") ?? fromSeat;
    if (sender === undefined) return undefined;
    from = seat(sender);
  }
  let to: MailParty;
  if (row.role === "agent") {
    if (stringField(row, "toNodeId") !== "operator") return undefined;
    to = OPERATOR;
  } else {
    to = seat(mailbox);
  }
  const inReplyTo = stringField(row, "inReplyTo");
  return {
    messageId: row.messageId,
    threadId: mailThreadOf(row),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    from,
    to: [to],
    mine: from.kind === "operator",
    text: text(row),
    at: messageIdTimeMs(row.messageId) ?? 0,
    sendKey: stringField(row, "sendId") ?? row.messageId,
  };
};

/** Every thread mail held, one entry per send, recipients merged. */
const entriesOf = (input: MailThreadsInput): ReadonlyArray<Entry> => {
  const seat = (nodeId: string): MailParty => ({ kind: "seat", nodeId, name: input.nameOf(nodeId) ?? nodeId });
  const bySend = new Map<string, Entry>();
  for (const mailbox of input.mailboxes) {
    for (const row of mailbox.messages) {
      const entry = entryOf(row, mailbox.nodeId, seat);
      if (entry === undefined) continue;
      const held = bySend.get(entry.sendKey);
      if (held === undefined) {
        bySend.set(entry.sendKey, entry);
        continue;
      }
      // The copy whose id is the send's own id speaks for it.
      const lead = entry.messageId === entry.sendKey ? entry : held;
      const to = [...held.to, ...entry.to.filter((party) => !held.to.some((known) => sameParty(known, party)))];
      bySend.set(entry.sendKey, { ...lead, to });
    }
  }
  return [...bySend.values()].sort((a, b) => a.at - b.at || a.messageId.localeCompare(b.messageId));
};

const involves = (entry: Entry, nodeId: string): boolean =>
  [entry.from, ...entry.to].some((party) => party.kind === "seat" && party.nodeId === nodeId);

const strip = ({ sendKey: _sendKey, ...message }: Entry): MailThreadMessage => message;

const summaryOf = (threadId: string, entries: ReadonlyArray<Entry>): MailThreadSummary => {
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const root = entries.find((entry) => entry.messageId === threadId) ?? first;
  const participants = new Map<string, MailParty>();
  for (const entry of entries) {
    for (const party of [entry.from, ...entry.to]) {
      if (!participants.has(partyKey(party))) participants.set(partyKey(party), party);
    }
  }
  return {
    threadId,
    title: root.text.split(/\r?\n/, 1)[0]?.trim() ?? "",
    participants: [...participants.values()],
    startedAt: first.at,
    lastAt: last.at,
    last: strip(last),
    messageCount: entries.length,
    canReply: entries.some((entry) => entry.mine || entry.to.some((party) => party.kind === "operator")),
  };
};

const threadsTouching = (input: MailThreadsInput, nodeId: string): ReadonlyMap<string, ReadonlyArray<Entry>> => {
  const entries = entriesOf(input);
  const mine = new Set(entries.filter((entry) => involves(entry, nodeId)).map((entry) => entry.threadId));
  const threads = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!mine.has(entry.threadId)) continue;
    const held = threads.get(entry.threadId);
    if (held === undefined) threads.set(entry.threadId, [entry]);
    else held.push(entry);
  }
  return threads;
};

/** The threads a seat wrote or was written to in, newest activity first. */
export const seatMailThreads = (input: MailThreadsInput, nodeId: string): ReadonlyArray<MailThreadSummary> =>
  [...threadsTouching(input, nodeId)]
    .map(([threadId, entries]) => summaryOf(threadId, entries))
    .sort((a, b) => b.lastAt - a.lastAt || b.threadId.localeCompare(a.threadId));

/** One of a seat's threads, oldest first; empty when the seat is not in it. */
export const seatMailThreadMessages = (
  input: MailThreadsInput,
  nodeId: string,
  threadId: string,
): ReadonlyArray<MailThreadMessage> => (threadsTouching(input, nodeId).get(threadId) ?? []).map(strip);

// ---- Operator send ----

/**
 * The operator writes in a seat's threads: with neither id, a new thread to
 * the seat; with `inReplyTo`, a reply in that mail's thread; with `threadId`
 * alone, a mail into that thread. `mentions` are seats wired to this seat;
 * each gets the same mail in the same thread.
 */
export const OperatorThreadSend = Schema.Struct({
  canvasName: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  threadId: Schema.optionalKey(Schema.NonEmptyString),
  inReplyTo: Schema.optionalKey(Schema.NonEmptyString),
  mentions: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});
export type OperatorThreadSend = typeof OperatorThreadSend.Type;

export type OperatorThreadSent =
  | {
      readonly ok: true;
      /** The mail to the seat; each mentioned seat holds its own copy. */
      readonly messageId: string;
      readonly threadId: string;
      readonly delivery: ReadonlyArray<{
        readonly nodeId: string;
        readonly messageId: string;
        readonly state: "delivered" | "waiting_for_seat" | "failed";
      }>;
    }
  | { readonly ok: false; readonly reason: "not-found" | "invalid" | "failed"; readonly message: string };

/** A seat a mention may name: wired to the seat by an edge. */
export type MentionableSeat = { readonly nodeId: string; readonly name: string };

export const SeatThreadsQuery = Schema.Struct({
  canvasName: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
});
export type SeatThreadsQuery = typeof SeatThreadsQuery.Type;

export const SeatThreadQuery = Schema.Struct({
  canvasName: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
});
export type SeatThreadQuery = typeof SeatThreadQuery.Type;
