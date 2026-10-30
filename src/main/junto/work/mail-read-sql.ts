/**
 * The two mail reads onboard, `junto since` and `msg list` make, over a plain
 * read-only connection: a seat's own mailbox, and the mail it sent into the
 * others (`work_messages_sender`). The mail read worker runs them, so neither
 * their SQL nor their IO wait holds main.
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
    const ids = chunk.flatMap((row) => [
      mailboxMessageDeliveryId(canvasName, row.node_id, row.message_id),
      mailboxMessageReadId(canvasName, row.node_id, row.message_id),
      mailboxMessageReactId(canvasName, row.node_id, row.message_id, "ack"),
    ]);
    const receipts = ids.length === 0 ? [] : database.prepare(`
      SELECT delivery_id, accepted_at FROM work_delivery_receipts
      WHERE delivered_canvas_name=? AND delivered_item_kind='message'
        AND delivery_id IN (${ids.map(() => "?").join(",")})`).all(canvasName, ...ids) as unknown as ReceiptRow[];
    // As the repository's `mailRowsWithReceipts`: every stamp, parsed or not.
    const stamps = new Map(receipts.map((row) => [row.delivery_id, Date.parse(row.accepted_at)]));
    for (const row of chunk) {
      sent.push({ nodeId: row.node_id, message: messageOfRow(row, canvasName, row.node_id, stamps) });
    }
  }
  return sent;
};
