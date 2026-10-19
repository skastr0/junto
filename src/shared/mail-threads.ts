import { Schema } from "effect";
import { MailMessageId, mailThreadOf } from "./crew";
import { CanvasName, NodeId } from "./model/base";
import { COMPANION_MAX_TEXT } from "./wire/companion-protocol";
import { messageIdTimeMs } from "./message-delivery";
import type { Message } from "./work-model";
import { OPERATOR_SEAT_ID } from "./work-reference";
import type { MailParty, MailThreadMessage, MailThreadSummary } from "./wire/mail-threads";

/**
 * Mail threads: the mail that hangs off one root message, read from the
 * mailboxes the store already holds. One derivation, shared by the desktop's
 * Threads popup and the phone's `threads.list`.
 *
 * A mail's thread is its `threadId`, or its own id when it starts one. Mail
 * reaches a thread three ways: seat mail and replies (each a row in the
 * recipient's mailbox), operator mail (a row in the one seat it is written
 * to), and a seat's reply to the operator (an agent-role row in the seat's
 * own mailbox naming `toNodeId: "operator"`). A mention is a reference the
 * mail carries, never a recipient. Nothing here reads or writes anything else.
 *
 * There is no operator read state for mail, so a summary says nothing about
 * what the operator has seen.
 */

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

const partyKey = (party: MailParty): string => (party.kind === "operator" ? "operator" : `seat:${party.nodeId}`);

type Entry = MailThreadMessage;
type SeatParty = Extract<MailParty, { kind: "seat" }>;

const mentionsOf = (row: Message, seat: (nodeId: string) => SeatParty): ReadonlyArray<SeatParty> => {
  const held = row.metadata?.mentions;
  return Array.isArray(held) ? held.filter((id): id is string => typeof id === "string").map(seat) : [];
};

/**
 * One mailbox row as thread mail, or undefined when it is not conversation:
 * task comments, receipts, Junto's own prompts, and a seat's private notes.
 */
const entryOf = (row: Message, mailbox: string, seat: (nodeId: string) => SeatParty): Entry | undefined => {
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
  const mentions = mentionsOf(row, seat);
  return {
    messageId: row.messageId,
    threadId: mailThreadOf(row),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    from,
    to: [to],
    mine: from.kind === "operator",
    text: text(row),
    at: messageIdTimeMs(row.messageId) ?? 0,
    ...(mentions.length === 0 ? {} : { mentions }),
  };
};

/** Every thread mail held, oldest first. */
const entriesOf = (input: MailThreadsInput): ReadonlyArray<Entry> => {
  const seat = (nodeId: string): SeatParty => ({ kind: "seat", nodeId, name: input.nameOf(nodeId) ?? nodeId });
  return input.mailboxes
    .flatMap((mailbox) => mailbox.messages.flatMap((row) => entryOf(row, mailbox.nodeId, seat) ?? []))
    .sort((a, b) => a.at - b.at || a.messageId.localeCompare(b.messageId));
};

const involves = (entry: Entry, nodeId: string): boolean =>
  [entry.from, ...entry.to].some((party) => party.kind === "seat" && party.nodeId === nodeId);

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
    last,
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
): ReadonlyArray<MailThreadMessage> => threadsTouching(input, nodeId).get(threadId) ?? [];

// ---- Operator send ----

/** The most seats one mail may mention. */
export const MAIL_MENTIONS_MAX = 32;
/** Operator mail text, the same bound as the phone's and a signal answer. */
export const OPERATOR_MAIL_MAX_TEXT = COMPANION_MAX_TEXT;

/**
 * The operator writes in a seat's threads, always to that seat alone: with
 * neither id, a new thread; with `inReplyTo`, a reply in that mail's thread;
 * with `threadId` alone, a mail into that thread. `mentions` are references
 * only, seats wired to this seat, kept on the mail; they receive nothing.
 */
export const OperatorThreadSend = Schema.Struct({
  canvasName: CanvasName,
  nodeId: NodeId,
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(OPERATOR_MAIL_MAX_TEXT))),
  threadId: Schema.optionalKey(MailMessageId),
  inReplyTo: Schema.optionalKey(MailMessageId),
  mentions: Schema.optionalKey(Schema.Array(NodeId).pipe(Schema.check(Schema.isMaxLength(MAIL_MENTIONS_MAX)))),
});
/** As a caller sends it; main decodes it to `OperatorThreadSendDecoded`. */
export type OperatorThreadSend = typeof OperatorThreadSend.Encoded;
export type OperatorThreadSendDecoded = typeof OperatorThreadSend.Type;

export type OperatorThreadSent =
  | {
      readonly ok: true;
      readonly messageId: string;
      readonly threadId: string;
      readonly delivery: "delivered" | "waiting_for_seat" | "failed";
    }
  | { readonly ok: false; readonly reason: "not-found" | "invalid" | "failed"; readonly message: string };

/** A seat a mention may name: wired to the seat by an edge. */
export type MentionableSeat = { readonly nodeId: string; readonly name: string };

export const SeatThreadsQuery = Schema.Struct({
  canvasName: CanvasName,
  nodeId: NodeId,
});
/** As a caller sends it; main decodes it to `SeatThreadsQueryDecoded`. */
export type SeatThreadsQuery = typeof SeatThreadsQuery.Encoded;
export type SeatThreadsQueryDecoded = typeof SeatThreadsQuery.Type;

export const SeatThreadQuery = Schema.Struct({
  canvasName: CanvasName,
  nodeId: NodeId,
  threadId: MailMessageId,
});
/** As a caller sends it; main decodes it to `SeatThreadQueryDecoded`. */
export type SeatThreadQuery = typeof SeatThreadQuery.Encoded;
export type SeatThreadQueryDecoded = typeof SeatThreadQuery.Type;
