// Deterministic durable receipt identities for mailbox PTY delivery and agent read-ack.
// Same plane as work_delivery_receipts / delivery.accepted (task claims already use this).

import { createHash } from "node:crypto";

const digest = (parts: ReadonlyArray<unknown>): string =>
  createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");

/** Stable restart-safe id for one mailbox message PTY inject. */
export const mailboxMessageDeliveryId = (
  canvasName: string,
  nodeId: string,
  messageId: string,
): string =>
  `delivery_${digest([
    "vellum/mailbox-message-delivery/v1",
    canvasName,
    nodeId,
    messageId,
  ])}`;

/** Stable id for one mailbox message read-ack by the seat that owns the inbox. */
export const mailboxMessageReadId = (
  canvasName: string,
  nodeId: string,
  messageId: string,
): string =>
  `delivery_${digest([
    "vellum/mailbox-message-read/v1",
    canvasName,
    nodeId,
    messageId,
  ])}`;

/** Closed reaction vocabulary. `ack` = got it, will reply later. */
export const MAILBOX_REACTION_KINDS = ["ack"] as const;
export type MailboxReactionKind = (typeof MAILBOX_REACTION_KINDS)[number];

export const isMailboxReactionKind = (
  value: string,
): value is MailboxReactionKind =>
  (MAILBOX_REACTION_KINDS as ReadonlyArray<string>).includes(value);

/** Stable id for one mailbox reaction by the seat that owns the inbox. */
export const mailboxMessageReactId = (
  canvasName: string,
  nodeId: string,
  messageId: string,
  reaction: MailboxReactionKind,
): string =>
  `delivery_${digest([
    "vellum/mailbox-message-react/v1",
    canvasName,
    nodeId,
    messageId,
    reaction,
  ])}`;
