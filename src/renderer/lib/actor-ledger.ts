/**
 * Actor ledger — pure projections of one actor's standing with the work
 * kernel, read entirely from the canvas doc (the repository projects work
 * state into `ether`; no IPC reads here).
 *
 * Mailbox facts come from `ether.messages` on the actor node itself:
 *   - sender: `metadata.senderNodeId`, else `fromSeat` when that is a node id
 *   - read: `metadata.readAt` (listed or marked read)
 *   - delivery display is derived from preserved attempt timestamps
 *   - age: the messageId is a ULID — its timestamp is birth time
 */
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { Message, Part } from "@shared/work-model";
import type { WorkSeatRecentOp } from "@shared/work-recent-ops";
import {
  compareMessageIdsNewestFirst,
  messageIdTimeMs,
} from "@shared/message-delivery";
import {
  countMailViews,
  crewMailViewOf,
  resolveMailSenderLabel,
  resolveMailSenderNodeId,
  resolveMailSenderStamp,
  stripMailEnvelope,
  type MailCounts,
  type MailDeliveryDisplay,
  type MailEvidenceRef,
  type MailKind,
} from "./crew-mail-view";
import { nodeTitle } from "./presentation";

export type { MailCounts };

export type MailRow = {
  readonly messageId: string;
  /** "in" = foreign mail into this seat; "note" = agent-role self history. */
  readonly direction: "in" | "note";
  readonly fromNodeId: string | undefined;
  readonly fromLabel: string;
  readonly sentAtMs: number | undefined;
  readonly preview: string;
  readonly body: string;
  readonly subject: string | undefined;
  readonly kind: MailKind | undefined;
  readonly display: MailDeliveryDisplay;
  readonly delivery: MailDeliveryDisplay;
  readonly deliveryReason: string | undefined;
  readonly generation: string | undefined;
  readonly refs: ReadonlyArray<MailEvidenceRef>;
  readonly delivered: boolean;
  readonly read: boolean;
  readonly unresolved: boolean;
  readonly taskId: string | undefined;
};

const textOfParts = (parts: ReadonlyArray<Part>): string =>
  parts
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

/** msg.send wraps the text as "mail from <seat> …" — strip for display. */
const stripFactoryMailPrefix = stripMailEnvelope;

const toMailRow = (doc: CanvasDoc, message: Message): MailRow => {
  const fromNodeId =
    resolveMailSenderNodeId(doc, message.metadata) ??
    resolveMailSenderStamp(message.metadata);
  const rawBody = textOfParts(message.parts);
  const body = stripFactoryMailPrefix(rawBody, message);
  const sentAtMs = messageIdTimeMs(message.messageId);
  const view = crewMailViewOf(message, sentAtMs);
  const firstLine =
    (view.subject ?? body.split(/\r?\n/, 1)[0]?.trim()) || "";
  return {
    messageId: message.messageId,
    direction: message.role === "user" ? "in" : "note",
    fromNodeId,
    fromLabel: resolveMailSenderLabel(message.metadata, fromNodeId, (id) => {
      const peer = doc.nodes.find((node) => node.id === id);
      return peer ? nodeTitle(peer) : undefined;
    }),
    sentAtMs,
    preview: firstLine,
    body,
    subject: view.subject,
    kind: view.kind,
    display: view.display,
    delivery: view.display,
    deliveryReason: view.displayReason,
    generation: view.facts.generation,
    refs: view.refs,
    delivered: view.facts.notifiedAt !== undefined,
    read: view.facts.readAt !== undefined,
    unresolved: view.display === "unresolved",
    taskId: message.taskId,
  };
};

export const mailboxRows = (
  doc: CanvasDoc,
  node: CanvasNode,
): ReadonlyArray<MailRow> =>
  (node.ether?.messages?.items ?? [])
    .map((message) => toMailRow(doc, message))
    .sort((a, b) => compareMessageIdsNewestFirst(a.messageId, b.messageId));

export const mailboxCounts = (rows: ReadonlyArray<MailRow>): MailCounts =>
  countMailViews(rows);

/** Settled mail decays out of the pane after this long. Unread never does. */
export const MAIL_SETTLED_WINDOW_MS = 30 * 60_000;

export type VisibleMail = {
  readonly rows: ReadonlyArray<MailRow>;
  /** Settled rows past the window, folded into a count rather than dropped. */
  readonly hidden: number;
};

/**
 * The pane shows the seat's backlog plus a short tail of what just happened.
 * Unread inbound mail IS the backlog, so it survives at any age — a seat
 * sitting on eleven-day-old unread mail is precisely what this section exists
 * to surface, and an age cut alone would hide it. Everything settled (read
 * mail, and the agent's own note history) falls out of the list once it is
 * older than the window and is reported as a count, never silently dropped.
 */
export const visibleMailRows = (
  rows: ReadonlyArray<MailRow>,
  nowMs: number,
  windowMs: number = MAIL_SETTLED_WINDOW_MS,
): VisibleMail => {
  const visible: MailRow[] = [];
  let hidden = 0;
  for (const row of rows) {
    if (row.direction === "in" && !row.read) {
      visible.push(row);
      continue;
    }
    const age = row.sentAtMs === undefined ? undefined : nowMs - row.sentAtMs;
    if (age !== undefined && age <= windowMs) {
      visible.push(row);
      continue;
    }
    hidden += 1;
  }
  return { rows: visible, hidden };
};

/**
 * Per-peer unread counts over this actor's inbound mail — for the
 * connections rail: "which wired peer is waiting on this seat". Keys are
 * sender node ids (`senderNodeId`, or `fromSeat` when that is still a node
 * id); read state is the seat's durable read-ack projection.
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
    default:
      return "worked";
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
