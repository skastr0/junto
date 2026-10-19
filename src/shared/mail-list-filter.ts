/**
 * The filters `msg list` takes: thread, sender, unread, since and text. They
 * combine with AND, and each one is checked here before anything is listed.
 * A refusal names the field and the shape it wants, never what the caller
 * sent.
 */
import { Result } from "effect";
import { MAIL_MESSAGE_ID_SHAPE, isMailMessageId, mailThreadOf } from "./crew";
import { messageIdTimeMs } from "./message-delivery";
import type { Message } from "./work-model";

/** The filter fields of a `msg list` input, as the CLI sends them. */
export type MailListFilterArgs = {
  readonly threadId?: string;
  readonly from?: string;
  readonly unread?: boolean;
  readonly since?: string;
  readonly text?: string;
};

export type MailListFilter = {
  readonly threadId?: string;
  readonly from?: string;
  readonly unread?: true;
  /** After this message (strictly), or born at or after this time. */
  readonly since?: { readonly afterId: string } | { readonly fromMs: number };
  /** Lower case: a match ignores case. */
  readonly text?: string;
};

export type MailListFilterRefusal = {
  readonly path: string;
  readonly expected: string;
  readonly message: string;
};

export const MAIL_LIST_TEXT_MAX = 1000;
const SINCE_SHAPE = "an ISO 8601 time (2026-10-19 or 2026-10-19T12:00:00Z) or a message id (a ULID)";
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/u;

const refuse = (path: string, expected: string, message: string): Result.Result<never, MailListFilterRefusal> =>
  Result.fail({ path, expected, message });

/** Check and normalize the filters; an empty filter lists everything. */
export const mailListFilterOf = (
  args: MailListFilterArgs,
): Result.Result<MailListFilter, MailListFilterRefusal> => {
  const filter: {
    threadId?: string;
    from?: string;
    unread?: true;
    since?: MailListFilter["since"];
    text?: string;
  } = {};
  if (args.threadId !== undefined) {
    const id = args.threadId.trim();
    if (!isMailMessageId(id)) return refuse("threadId", "ULID", `threadId must be ${MAIL_MESSAGE_ID_SHAPE}`);
    filter.threadId = id;
  }
  if (args.from !== undefined) {
    const from = args.from.trim();
    if (from === "" || from.length > 200) {
      return refuse("from", "seat", "from must be a seat's name, node id or seat id, 1 to 200 characters");
    }
    filter.from = from;
  }
  if (args.unread === true) filter.unread = true;
  if (args.since !== undefined) {
    const since = args.since.trim();
    if (isMailMessageId(since)) {
      filter.since = { afterId: since };
    } else {
      const ms = ISO_TIME.test(since) ? Date.parse(since) : Number.NaN;
      if (!Number.isFinite(ms)) return refuse("since", "ISO 8601 time or ULID", `since must be ${SINCE_SHAPE}`);
      filter.since = { fromMs: ms };
    }
  }
  if (args.text !== undefined) {
    const text = args.text.trim();
    if (text === "" || text.length > MAIL_LIST_TEXT_MAX) {
      return refuse("text", "text", `text must be 1 to ${MAIL_LIST_TEXT_MAX} characters`);
    }
    filter.text = text.toLowerCase();
  }
  return Result.succeed(filter);
};

const stringMeta = (message: Message, key: string): string | undefined => {
  const value = message.metadata?.[key];
  return typeof value === "string" ? value : undefined;
};

const isUnread = (message: Message): boolean => {
  if (message.role !== "user") return false;
  const readAt = message.metadata?.readAt;
  return !(typeof readAt === "number" && Number.isFinite(readAt));
};

const bodyOf = (message: Message): string =>
  [
    stringMeta(message, "subject") ?? "",
    ...message.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
  ].join("\n").toLowerCase();

/** True when the message passes every filter that is set. */
export const mailListMatches =
  (filter: MailListFilter) =>
  (message: Message): boolean => {
    if (filter.threadId !== undefined && mailThreadOf(message) !== filter.threadId) return false;
    if (
      filter.from !== undefined &&
      stringMeta(message, "fromSeat") !== filter.from &&
      stringMeta(message, "senderNodeId") !== filter.from &&
      stringMeta(message, "senderName") !== filter.from
    ) return false;
    if (filter.unread === true && !isUnread(message)) return false;
    if (filter.since !== undefined) {
      const bornMs = messageIdTimeMs(message.messageId);
      if (bornMs === undefined) return false;
      if ("afterId" in filter.since ? message.messageId <= filter.since.afterId : bornMs < filter.since.fromMs) {
        return false;
      }
    }
    if (filter.text !== undefined && !bodyOf(message).includes(filter.text)) return false;
    return true;
  };
