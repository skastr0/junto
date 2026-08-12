/**
 * Actor ledger — pure projections of one actor's standing with the work
 * kernel, read entirely from the canvas doc (the repository projects work
 * state into `ether`; no IPC reads here).
 *
 * Mailbox facts come from `ether.messages` on the actor node itself:
 *   - sender: `metadata.fromSeat` (stamped by msg.send)
 *   - delivery: `metadata.deliveredAt` / `metadata.readAt` (stamped by the
 *     doc projection from durable receipts)
 *   - age: the messageId is a ULID — its timestamp is birth time
 */
import { decodeTime } from "ulid";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { Message, Part } from "@shared/work-model";
import type { WorkSeatRecentOp } from "@shared/work-recent-ops";
import { nodeTitle } from "./presentation";

export type MailRow = {
  readonly messageId: string;
  /** "in" = foreign mail into this seat; "note" = agent-role self history. */
  readonly direction: "in" | "note";
  readonly fromNodeId: string | undefined;
  readonly fromLabel: string;
  readonly sentAtMs: number | undefined;
  readonly preview: string;
  readonly body: string;
  readonly delivered: boolean;
  readonly read: boolean;
  readonly taskId: string | undefined;
};

export type MailCounts = {
  readonly total: number;
  /** Inbound mail without a PTY delivery receipt yet. */
  readonly queued: number;
  /** Inbound mail without a read-ack from the seat. */
  readonly unread: number;
};

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ulidTimeMs = (id: string): number | undefined => {
  if (!ULID_PATTERN.test(id)) return undefined;
  try {
    return decodeTime(id);
  } catch {
    return undefined;
  }
};

const textOfParts = (parts: ReadonlyArray<Part>): string =>
  parts
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

/** msg.send wraps the text as "[factory mail from <seat>] …" — strip for display. */
const stripFactoryMailPrefix = (body: string): string => {
  const match = /^\[factory mail from [^\]]+\]\s*/.exec(body);
  return match ? body.slice(match[0].length) : body;
};

const metadataString = (message: Message, key: string): string | undefined => {
  const value = message.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const metadataNumber = (message: Message, key: string): number | undefined => {
  const value = message.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const senderLabel = (
  doc: CanvasDoc,
  fromNodeId: string | undefined,
): string => {
  if (fromNodeId === undefined) return "system";
  const peer = doc.nodes.find((node) => node.id === fromNodeId);
  return peer ? nodeTitle(peer) : fromNodeId;
};

const toMailRow = (doc: CanvasDoc, message: Message): MailRow => {
  const fromNodeId = metadataString(message, "fromSeat");
  const rawBody = textOfParts(message.parts);
  const body = stripFactoryMailPrefix(rawBody);
  const firstLine = body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return {
    messageId: message.messageId,
    direction: message.role === "user" ? "in" : "note",
    fromNodeId,
    fromLabel: senderLabel(doc, fromNodeId),
    sentAtMs: ulidTimeMs(message.messageId),
    preview: firstLine,
    body,
    delivered: metadataNumber(message, "deliveredAt") !== undefined,
    read: metadataNumber(message, "readAt") !== undefined,
    taskId: message.taskId,
  };
};

/** Newest first (ULID ids order by birth; non-ULID ids sink to the end). */
const compareMailNewestFirst = (a: MailRow, b: MailRow): number => {
  if (a.sentAtMs !== undefined && b.sentAtMs !== undefined) {
    return b.messageId.localeCompare(a.messageId);
  }
  if (a.sentAtMs !== undefined) return -1;
  if (b.sentAtMs !== undefined) return 1;
  return b.messageId.localeCompare(a.messageId);
};

export const mailboxRows = (
  doc: CanvasDoc,
  node: CanvasNode,
): ReadonlyArray<MailRow> =>
  (node.ether?.messages?.items ?? [])
    .map((message) => toMailRow(doc, message))
    .sort(compareMailNewestFirst);

export const mailboxCounts = (rows: ReadonlyArray<MailRow>): MailCounts => {
  let queued = 0;
  let unread = 0;
  for (const row of rows) {
    if (row.direction !== "in") continue;
    if (!row.delivered) queued += 1;
    if (!row.read) unread += 1;
  }
  return { total: rows.length, queued, unread };
};

/**
 * Per-peer unread counts over this actor's inbound mail — for the
 * connections rail: "which wired peer is waiting on this seat". Keys are
 * sender node ids (metadata.fromSeat, process-bound since admission strips
 * spoofed values); read state is the seat's durable read-ack projection.
 */
export const unreadMailByPeer = (
  rows: ReadonlyArray<MailRow>,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.direction !== "in" || row.read || row.fromNodeId === undefined) {
      continue;
    }
    counts.set(row.fromNodeId, (counts.get(row.fromNodeId) ?? 0) + 1);
  }
  return counts;
};

/** Applied time of a recent-op entry, defensively parsed. */
export const recentOpAtMs = (op: WorkSeatRecentOp): number | undefined => {
  const ms = Date.parse(op.appliedAt);
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * One plain line per receipt. The feed is identity-backed CLI activity only
 * (its coverage names what it cannot see); labels stay in product words.
 */
export const recentOpLabel = (op: WorkSeatRecentOp): string => {
  const summary = op.summary;
  switch (op.operation) {
    case "message.append":
      return "sent mail";
    case "artifact.publish":
      return summary.kind === "artifact" && summary.name
        ? `published ${summary.name}`
        : "published an artifact";
    case "task.claim":
      return "claimed a task";
    case "proposal.create":
      return "proposed a task";
    case "request.create":
      return "raised a request";
    case "delivery.accepted":
      return summary.kind === "delivery"
        ? `delivery accepted - ${summary.delivered.kind}`
        : "delivery accepted";
    case "board.topic.create":
      return summary.kind === "topic"
        ? `opened topic ${summary.title}`
        : "opened a topic";
    case "board.post.append":
      return "posted to the board";
  }
};

/** Compact age for list rows: now, 45s, 12m, 3h, 5d. */
export const mailAgeLabel = (
  nowMs: number,
  sentAtMs: number | undefined,
): string | undefined => {
  if (sentAtMs === undefined) return undefined;
  const delta = Math.max(0, nowMs - sentAtMs);
  if (delta < 10_000) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
};
