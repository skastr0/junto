import type { AgentSignal, AgentSignalKind } from "./agent-signals";
import { compareSignalListOrder } from "./agent-signals";
import { mailListMatches } from "./mail-list-filter";
import { seatMailThreads, type HeldMailbox } from "./mail-threads";
import type { NodeId } from "./model/base";
import type { Message } from "./work-model";
import type { MailParty, MailThreadSummary } from "./wire/mail-threads";

/**
 * Since your last session: what a fresh session owes, waits on and missed,
 * computed at onboard from rows Junto already holds and never stored
 * (docs/plans/0.10/08-continuity.md, Contract).
 *
 * - Owed and awaited replies are thread state, with no time boundary: the
 *   last message of each of the seat's threads in the `mail-threads.ts`
 *   derivation, its direction, and its `deliveredAt` and `readAt`. A replaced
 *   session ends when the next starts, so a window would always be empty.
 * - A signal answer the operator mailed is mail and shows as a thread. A
 *   silent answer has no receipt, so the previous session's `started_at`
 *   bounds it.
 * - Unread is a count of the seat's own mailbox rows that `msg list --unread`
 *   would list, through the same filter, so the two never disagree.
 *
 * `junto since --all` is this projection uncapped.
 */

export type SinceInput = {
  readonly seat: NodeId;
  /** Every mailbox on the canvas: sent mail lives in each recipient's. */
  readonly mailboxes: ReadonlyArray<HeldMailbox>;
  /** A seat's display name; the node id stands in when it has none. */
  readonly nameOf: (nodeId: string) => string | undefined;
  /** The canvas's signals; only this seat's are read. */
  readonly signals: ReadonlyArray<AgentSignal>;
  /** Bounds silent signal answers only. 0 when there was no previous session. */
  readonly previousStartedAt: number;
  /** Epoch ms the projection is as of. */
  readonly now: number;
};

export type SinceLine = { readonly text: string; readonly ref: string };
export type SinceSection = {
  readonly lines: ReadonlyArray<SinceLine>;
  /** Lines past the cap, listed by `command`. */
  readonly more: number;
  readonly command: string;
};

export const SINCE_SECTIONS = ["owedReplies", "awaitingReplies", "openSignals", "answersSince"] as const;
export type SinceSectionKey = (typeof SINCE_SECTIONS)[number];

export type Since = { readonly asOf: number; readonly unread: number } & {
  readonly [K in SinceSectionKey]: SinceSection;
};

/** Lines per section in onboard. */
export const SINCE_PER_SECTION = 8;
/** A line's quoted text, in characters, before it is cut. */
export const SINCE_QUOTE_MAX = 100;

/** The command that lists a section in full. */
export const SINCE_COMMANDS: Readonly<Record<SinceSectionKey, string>> = {
  owedReplies: "junto since --all",
  awaitingReplies: "junto since --all",
  openSignals: "junto signal list",
  answersSince: "junto signal list",
};

const KIND_WORDS: Readonly<Record<AgentSignalKind, string>> = {
  blocked: "blocked",
  escalate: "escalate",
  feedback: "feedback",
};

/** One line of text, cut to {@link SINCE_QUOTE_MAX} characters. */
export const sinceQuote = (text: string): string => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= SINCE_QUOTE_MAX ? line : `${line.slice(0, SINCE_QUOTE_MAX - 1).trimEnd()}…`;
};

const partyName = (party: MailParty): string => (party.kind === "operator" ? "the operator" : party.name);

const isSeat = (party: MailParty, seat: string): boolean => party.kind === "seat" && party.nodeId === seat;

const stamp = (row: Message | undefined, key: "deliveredAt" | "readAt"): boolean => {
  const value = row?.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value);
};

/** What became of the last mail: the recipient's read and delivery receipts. */
const receiptWords = (row: Message | undefined): string =>
  stamp(row, "readAt") ? "read" : stamp(row, "deliveredAt") ? "delivered, unread" : "not delivered yet";

const section = (key: SinceSectionKey, lines: ReadonlyArray<SinceLine>, cap: number): SinceSection => ({
  lines: lines.slice(0, cap),
  more: Math.max(0, lines.length - cap),
  command: SINCE_COMMANDS[key],
});

/** Newest answer first; the signal id breaks a tie. */
const byAnswer = (a: AgentSignal, b: AgentSignal): number =>
  (b.response?.at ?? 0) - (a.response?.at ?? 0) || (a.signalId < b.signalId ? 1 : a.signalId > b.signalId ? -1 : 0);

export const seatSince = (input: SinceInput, caps: { readonly perSection: number }): Since => {
  const cap = Math.max(0, Math.trunc(caps.perSection));
  const seat: string = input.seat;

  // The row each thread mail is in, to read its receipts: a seat's mail sits
  // in the recipient's mailbox, a reply to the operator in the seat's own.
  const rows = new Map<string, Message>();
  for (const mailbox of input.mailboxes) for (const row of mailbox.messages) rows.set(row.messageId, row);

  const threads: ReadonlyArray<MailThreadSummary> = seatMailThreads(input, seat);
  const owed: SinceLine[] = [];
  const awaiting: SinceLine[] = [];
  for (const thread of threads) {
    const last = thread.last;
    const quote = sinceQuote(last.text);
    if (isSeat(last.from, seat)) {
      const to = last.to.map(partyName).join(", ");
      awaiting.push({ text: `You wrote last to ${to}, ${receiptWords(rows.get(last.messageId))}: "${quote}"`, ref: last.messageId });
    } else if (last.to.some((party) => isSeat(party, seat))) {
      owed.push({ text: `${partyName(last.from)} wrote last, you have not replied: "${quote}"`, ref: last.messageId });
    }
  }

  const mine = input.signals.filter((signal) => signal.nodeId === seat);
  const open = mine
    .filter((signal) => signal.state === "open")
    .sort(compareSignalListOrder)
    .map((signal) => ({ text: `Open ${KIND_WORDS[signal.kind]}: "${sinceQuote(signal.text)}"`, ref: signal.signalId }));

  const mailed = new Set<string>();
  for (const row of rows.values()) {
    const id = row.metadata?.agentSignalId;
    if (typeof id === "string") mailed.add(id);
  }
  const answers = mine
    .filter(
      (signal): signal is AgentSignal & { readonly response: NonNullable<AgentSignal["response"]> } =>
        signal.state === "answered" &&
        signal.response !== undefined &&
        signal.response.at >= input.previousStartedAt &&
        !mailed.has(signal.signalId),
    )
    .sort(byAnswer)
    .map((signal) => ({
      text: `The operator answered your ${KIND_WORDS[signal.kind]} "${sinceQuote(signal.text)}" without mail: "${sinceQuote(signal.response.text)}"`,
      ref: signal.signalId,
    }));

  const unreadOnly = mailListMatches({ unread: true });
  const own = input.mailboxes.find((mailbox) => mailbox.nodeId === seat)?.messages ?? [];

  return {
    asOf: input.now,
    owedReplies: section("owedReplies", owed, cap),
    awaitingReplies: section("awaitingReplies", awaiting, cap),
    openSignals: section("openSignals", open, cap),
    answersSince: section("answersSince", answers, cap),
    unread: own.filter(unreadOnly).length,
  };
};
