/**
 * The mail reads onboard, `junto since` and `msg list` make, over a plain
 * read-only connection: a seat's own mailbox, and the mail it sent into the
 * others (`work_messages_sender`), whole or one page of each. The mail read
 * worker runs them, so neither their SQL nor their IO wait holds main.
 *
 * They are the repository's `loadInbox` and `readMailSentBy`, statement for
 * statement, and build each message as `messageFromRow` and
 * `messageWithReceipts` do: constructed from rows the write path already
 * decoded, never decoded again. tests/mail-read-sql.test.ts holds the two
 * paths equal on one database.
 *
 * Nothing here imports the repository, so the worker loads only this.
 */
import type { DatabaseSync } from "node:sqlite";
import { type MailListFilter, mailListMatches } from "@shared/mail-list-filter";
import { compareMessageIdsNewestFirst, pageNewestFirst, sortMessagesNewestFirst } from "@shared/message-delivery";
import type { Message } from "@shared/work-model";
import {
  mailboxMessageDeliveryId,
  mailboxMessageReactId,
  mailboxMessageReadId,
} from "./mailbox-receipts";

type MailRow = {
  readonly message_id: string;
  readonly role: string;
  readonly parts_json: string;
  readonly task_id: string | null;
  readonly context_id: string | null;
  readonly reference_task_ids_json: string | null;
  readonly metadata_json: string | null;
};

type ReceiptRow = { readonly delivery_id: string; readonly accepted_at: string };

/** One mail a seat sent, in the mailbox it sits in. */
export type SentMail = { readonly nodeId: string; readonly message: Message };

const MAIL_COLUMNS = `message_id, role, parts_json, task_id, context_id,
  reference_task_ids_json, metadata_json`;

/** Receipts are looked up this many rows at a time, as the repository does. */
const RECEIPT_LOOKUP_ROWS = 1_000;

const messageOfRow = (
  row: MailRow,
  canvasName: string,
  nodeId: string,
  stamps: ReadonlyMap<string, number>,
): Message => {
  const message: Message = {
    messageId: row.message_id,
    role: row.role as Message["role"],
    parts: JSON.parse(row.parts_json) as Message["parts"],
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.context_id === null ? {} : { contextId: row.context_id }),
    ...(row.reference_task_ids_json === null
      ? {}
      : { referenceTaskIds: JSON.parse(row.reference_task_ids_json) as Message["referenceTaskIds"] }),
    ...(row.metadata_json === null
      ? {}
      : { metadata: JSON.parse(row.metadata_json) as Message["metadata"] }),
  };
  const deliveredAt = stamps.get(mailboxMessageDeliveryId(canvasName, nodeId, row.message_id));
  const readAt = stamps.get(mailboxMessageReadId(canvasName, nodeId, row.message_id));
  const ackAt = stamps.get(mailboxMessageReactId(canvasName, nodeId, row.message_id, "ack"));
  if (deliveredAt === undefined && readAt === undefined && ackAt === undefined) return message;
  return { ...message, metadata: { ...message.metadata,
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    ...(readAt === undefined ? {} : { readAt }),
    ...(ackAt === undefined ? {} : { reactions: [{ kind: "ack", at: ackAt }] }),
  } };
};

const stampsOf = (rows: ReadonlyArray<ReceiptRow>): Map<string, number> => {
  const stamps = new Map<string, number>();
  for (const row of rows) {
    const ms = Date.parse(row.accepted_at);
    if (Number.isFinite(ms)) stamps.set(row.delivery_id, ms);
  }
  return stamps;
};

/** A seat's whole mailbox, oldest first, each mail with its receipts. */
export const readInbox = (database: DatabaseSync, canvasName: string, nodeId: string): Message[] => {
  const receipts = database.prepare(`
    SELECT delivery_id, accepted_at
    FROM work_delivery_receipts
    WHERE delivered_canvas_name = ?
      AND delivered_node_id = ?
      AND delivered_item_kind = 'message'`).all(canvasName, nodeId) as unknown as ReceiptRow[];
  const rows = database.prepare(`
    SELECT ${MAIL_COLUMNS}
    FROM work_messages
    WHERE canvas_name = ? AND node_id = ?
    ORDER BY position`).all(canvasName, nodeId) as unknown as MailRow[];
  const stamps = stampsOf(receipts);
  return rows.map((row) => messageOfRow(row, canvasName, nodeId, stamps));
};

/** One page of mail, newest first, as `pageNewestFirst` answers it. */
export type MailPage<M> = { readonly items: ReadonlyArray<M>; readonly more: boolean; readonly remaining: number };

/** The page `msg list` asks for: its size, its cursor, and its filters. */
export type MailPageQuery = {
  readonly limit: number;
  readonly before?: string;
  readonly filter: MailListFilter;
};

const filtered = (filter: MailListFilter): boolean => Object.keys(filter).length > 0;

/** A page of mail already read whole: filter, newest first, then the page. */
export const pageOfInbox = (messages: ReadonlyArray<Message>, query: MailPageQuery): MailPage<Message> =>
  pageNewestFirst(sortMessagesNewestFirst(messages.filter(mailListMatches(query.filter))), query);

/** The same over sent mail, each row kept with the mailbox it sits in. */
export const pageOfSent = (rows: ReadonlyArray<SentMail>, query: MailPageQuery): MailPage<SentMail> => {
  const matches = mailListMatches(query.filter);
  const newest = rows
    .filter((row) => matches(row.message))
    .map((row) => ({ messageId: row.message.messageId, row }))
    .sort((a, b) => compareMessageIdsNewestFirst(a.messageId, b.messageId));
  const page = pageNewestFirst(newest, query);
  return { items: page.items.map((item) => item.row), more: page.more, remaining: page.remaining };
};

/**
 * Receipts for these mails only, each in the mailbox it sits in: delivered,
 * read and ack, as `messageWithReceipts` stamps them. Each key carries its
 * mailbox: by delivery id alone the lookup reads every receipt on the canvas
 * (65,632 here, 26 ms for a 50-mail page) instead of seeking the primary
 * key's (canvas, mailbox, delivery id).
 */
const receiptStamps = (
  database: DatabaseSync,
  canvasName: string,
  rows: ReadonlyArray<{ readonly node_id: string; readonly message_id: string }>,
): Map<string, number> => {
  const keys = rows.flatMap((row) => [
    [row.node_id, mailboxMessageDeliveryId(canvasName, row.node_id, row.message_id)],
    [row.node_id, mailboxMessageReadId(canvasName, row.node_id, row.message_id)],
    [row.node_id, mailboxMessageReactId(canvasName, row.node_id, row.message_id, "ack")],
  ]);
  if (keys.length === 0) return new Map();
  return stampsOf(database.prepare(`
    SELECT delivery_id, accepted_at FROM work_delivery_receipts
    WHERE delivered_canvas_name=? AND delivered_item_kind='message'
      AND (delivered_node_id, delivery_id) IN (VALUES ${keys.map(() => "(?,?)").join(",")})`)
    .all(canvasName, ...keys.flat()) as unknown as ReceiptRow[]);
};

/**
 * The page's ids, newest first, from ids alone, with how many older ones
 * remain: `pageNewestFirst` over `compareMessageIdsNewestFirst`, the order
 * `msg list` lists in.
 */
const pageOfKeys = <K extends { readonly message_id: string }>(
  keys: ReadonlyArray<K>,
  query: MailPageQuery,
): { readonly page: K[]; readonly more: boolean; readonly remaining: number } => {
  const newest = [...keys].sort((a, b) => compareMessageIdsNewestFirst(a.message_id, b.message_id));
  const { items, more, remaining } = pageNewestFirst(
    newest.map((key) => ({ messageId: key.message_id, key })),
    { limit: query.limit, ...(query.before === undefined ? {} : { before: query.before }) },
  );
  return { page: items.map((item) => item.key), more, remaining };
};

/**
 * One page of a seat's mailbox. With no filter the page is chosen from ids
 * alone (the primary key holds them), and only its rows and their receipts
 * are read. A filter reads text and receipts, so it walks the mailbox.
 */
export const readInboxPage = (
  database: DatabaseSync,
  canvasName: string,
  nodeId: string,
  query: MailPageQuery,
): MailPage<Message> => {
  if (filtered(query.filter)) return pageOfInbox(readInbox(database, canvasName, nodeId), query);
  const keys = database.prepare(`
    SELECT message_id FROM work_messages
    WHERE canvas_name = ? AND node_id = ?`).all(canvasName, nodeId) as unknown as Array<{ readonly message_id: string }>;
  const { page, more, remaining } = pageOfKeys(keys, query);
  if (page.length === 0) return { items: [], more, remaining };
  const ids = page.map((key) => key.message_id);
  const rows = database.prepare(`
    SELECT ${MAIL_COLUMNS}
    FROM work_messages
    WHERE canvas_name = ? AND node_id = ?
      AND message_id IN (${ids.map(() => "?").join(",")})`).all(canvasName, nodeId, ...ids) as unknown as MailRow[];
  const byId = new Map(rows.map((row) => [row.message_id, row]));
  const stamps = receiptStamps(database, canvasName, ids.map((id) => ({ node_id: nodeId, message_id: id })));
  return {
    items: ids.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [messageOfRow(row, canvasName, nodeId, stamps)];
    }),
    more,
    remaining,
  };
};

/**
 * One page of the mail `sender` wrote into the other mailboxes, chosen the
 * same way: from the sender index's ids when nothing is filtered.
 */
export const readSentByPage = (
  database: DatabaseSync,
  canvasName: string,
  sender: string,
  query: MailPageQuery,
): MailPage<SentMail> => {
  if (filtered(query.filter)) return pageOfSent(readSentBy(database, canvasName, sender), query);
  const keys = database.prepare(`
    SELECT node_id, message_id FROM work_messages
    WHERE canvas_name=? AND node_id<>? AND json_extract(metadata_json,'$.senderNodeId')=?`)
    .all(canvasName, sender, sender) as unknown as Array<{ readonly node_id: string; readonly message_id: string }>;
  const { page, more, remaining } = pageOfKeys(keys, query);
  const stamps = receiptStamps(database, canvasName, page);
  const one = database.prepare(`
    SELECT ${MAIL_COLUMNS}
    FROM work_messages
    WHERE canvas_name = ? AND node_id = ? AND message_id = ?`);
  const items = page.flatMap((key): SentMail[] => {
    const row = one.get(canvasName, key.node_id, key.message_id) as unknown as MailRow | undefined;
    return row === undefined ? [] : [{ nodeId: key.node_id, message: messageOfRow(row, canvasName, key.node_id, stamps) }];
  });
  return { items, more, remaining };
};

/** Every mail `sender` wrote into the other mailboxes on a canvas, in no order. */
export const readSentBy = (database: DatabaseSync, canvasName: string, sender: string): SentMail[] => {
  const rows = database.prepare(`
    SELECT node_id, ${MAIL_COLUMNS}
    FROM work_messages
    WHERE canvas_name=? AND node_id<>? AND json_extract(metadata_json,'$.senderNodeId')=?
    ORDER BY node_id,position`).all(canvasName, sender, sender) as unknown as Array<MailRow & { readonly node_id: string }>;
  const sent: SentMail[] = [];
  for (let at = 0; at < rows.length; at += RECEIPT_LOOKUP_ROWS) {
    const chunk = rows.slice(at, at + RECEIPT_LOOKUP_ROWS);
    // Each stamp's own mailbox with its id, as every read here looks them up.
    const stamps = receiptStamps(database, canvasName, chunk);
    for (const row of chunk) {
      sent.push({ nodeId: row.node_id, message: messageOfRow(row, canvasName, row.node_id, stamps) });
    }
  }
  return sent;
};
