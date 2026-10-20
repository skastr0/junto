/**
 * Mail threads for the phone: the desktop's own derivation
 * (`mail-threads.ts`) cut to the wire's bounds and fitted to one frame.
 *
 * Bodies, titles and seat names are the operator's content and pass through
 * unscrubbed; they are only cut to length, at a character boundary, with
 * `textCut` saying so. What cannot fit a bound (an id too long for the wire)
 * is left out rather than failing the whole answer. Refusals the phone sees
 * are fixed sentences: a send's refusal never carries a seat's name or the
 * mail's text.
 */
import type { MailParty, MailThreadMessage, MailThreadSummary } from "./wire/mail-threads";
import {
  COMPANION_MAX_OUTBOUND_BYTES,
  COMPANION_MENTIONS_MAX,
  COMPANION_THREAD_MESSAGES_MAX,
  COMPANION_THREAD_PREVIEW_MAX,
  COMPANION_THREAD_TEXT_MAX,
  COMPANION_THREADS_MAX,
  type CompanionResultByOp,
  type CompanionThreadMessage,
  type CompanionThreadParty,
  type CompanionThreadSummary,
} from "./wire/companion-protocol";

/** Room the answer may take in a frame: the rest is the envelope. */
export const COMPANION_THREADS_BUDGET_BYTES = COMPANION_MAX_OUTBOUND_BYTES - 32 * 1024;

const ID_MAX = 128;
const NAME_MAX = 256;
const PARTICIPANTS_MAX = 64;
const RECIPIENTS_MAX = 32;

const encoder = new TextEncoder();
const bytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
export const clipText = (text: string, max: number): { readonly text: string; readonly cut: boolean } => {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
};

const idOk = (id: string | undefined): id is string => id !== undefined && id.length > 0 && id.length <= ID_MAX;

const seatOf = (party: Extract<MailParty, { kind: "seat" }>) =>
  party.nodeId.length > 0 && party.nodeId.length <= 256
    ? { kind: "seat" as const, nodeId: party.nodeId, name: clipText(party.name, NAME_MAX).text }
    : undefined;

const partyOf = (party: MailParty): CompanionThreadParty | undefined =>
  party.kind === "operator" ? { kind: "operator" } : seatOf(party);

/** One thread mail within the wire's bounds, or undefined when its ids are not. */
export const companionThreadMessage = (
  message: MailThreadMessage,
  textMax: number = COMPANION_THREAD_TEXT_MAX,
): CompanionThreadMessage | undefined => {
  if (!idOk(message.messageId) || !idOk(message.threadId)) return undefined;
  const from = partyOf(message.from);
  if (from === undefined) return undefined;
  const text = clipText(message.text, textMax);
  const mentions = (message.mentions ?? []).flatMap((seat) => seatOf(seat) ?? []).slice(0, COMPANION_MENTIONS_MAX);
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    ...(idOk(message.inReplyTo) ? { inReplyTo: message.inReplyTo } : {}),
    from,
    to: message.to.flatMap((party) => partyOf(party) ?? []).slice(0, RECIPIENTS_MAX),
    mine: message.mine,
    text: text.text,
    ...(text.cut ? { textCut: true as const } : {}),
    at: Number.isFinite(message.at) ? message.at : 0,
    ...(message.attachments === undefined || message.attachments.length === 0 ? {} : { attachments: message.attachments }),
    ...(mentions.length === 0 ? {} : { mentions }),
  };
};

const companionThreadSummary = (summary: MailThreadSummary): CompanionThreadSummary | undefined => {
  const last = companionThreadMessage(summary.last, COMPANION_THREAD_PREVIEW_MAX);
  if (!idOk(summary.threadId) || last === undefined) return undefined;
  return {
    threadId: summary.threadId,
    title: clipText(summary.title, COMPANION_THREAD_PREVIEW_MAX).text,
    participants: summary.participants.flatMap((party) => partyOf(party) ?? []).slice(0, PARTICIPANTS_MAX),
    startedAt: summary.startedAt,
    lastAt: summary.lastAt,
    last,
    messageCount: summary.messageCount,
    canReply: summary.canReply,
  };
};

/** A seat's threads, newest activity first, as many as fit; `cut` when older ones were left out. */
export const companionThreads = (summaries: ReadonlyArray<MailThreadSummary>): CompanionResultByOp["threads.list"] => {
  const threads: CompanionThreadSummary[] = [];
  let bytes = 0;
  let cut = false;
  for (const summary of summaries) {
    const thread = companionThreadSummary(summary);
    if (thread === undefined) continue;
    const size = bytesOf(thread) + 1;
    if (threads.length >= COMPANION_THREADS_MAX || bytes + size > COMPANION_THREADS_BUDGET_BYTES) {
      cut = true;
      break;
    }
    threads.push(thread);
    bytes += size;
  }
  return { threads, cut };
};

/** One thread oldest first, the newest kept that fit; `cut` when older ones were left out. */
export const companionThreadMessages = (
  messages: ReadonlyArray<MailThreadMessage>,
): CompanionResultByOp["thread.get"] => {
  const kept: CompanionThreadMessage[] = [];
  let bytes = 0;
  let cut = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = companionThreadMessage(messages[i]!);
    if (message === undefined) continue;
    const size = bytesOf(message) + 1;
    if (kept.length >= COMPANION_THREAD_MESSAGES_MAX || bytes + size > COMPANION_THREADS_BUDGET_BYTES) {
      cut = true;
      break;
    }
    kept.push(message);
    bytes += size;
  }
  return { messages: kept.reverse(), cut };
};

/** The seats a mail may mention, within `seat.get`'s bounds. */
export const companionConnected = (
  seats: ReadonlyArray<{ readonly nodeId: string; readonly name: string }>,
): ReadonlyArray<{ readonly nodeId: string; readonly name: string }> =>
  seats
    .filter((seat) => seat.nodeId.length > 0 && seat.nodeId.length <= 256)
    .slice(0, 64)
    .map((seat) => ({ nodeId: seat.nodeId, name: clipText(seat.name, NAME_MAX).text }));

/** The refusals a thread send may answer, as the phone reads them. */
const SEND_REFUSALS = new Set([
  "No such canvas.",
  "No such seat.",
  "Mail needs some text.",
  "That mail is not in this seat's threads.",
  "That mail is in another thread.",
  "That thread is not one of this seat's.",
]);

/**
 * A send's refusal in fixed words. The only other refusal the send makes
 * names a mentioned seat that is not wired here, so it becomes a sentence
 * without the name; a failure never carries the store's words.
 */
export const companionSendRefusal = (reason: "not-found" | "invalid" | "failed", message: string): string => {
  if (reason === "failed") return "The mail could not be sent.";
  if (SEND_REFUSALS.has(message)) return message;
  return reason === "invalid" ? "A mentioned seat is not connected to this one." : "No such seat.";
};
