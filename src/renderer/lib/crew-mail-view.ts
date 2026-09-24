/**
 * Operator mail projection: sender, kind, subject, refs, and one plain
 * delivery state. Mail is delivered once its text is written into the
 * recipient's input; until then it waits for the seat to start. Nothing here
 * invents a status the document did not record.
 */
import type { CanvasDoc } from "@shared/canvas";
import type { Message } from "@shared/work-model";
import {
  isMessageDelivered,
  isMessageRead,
  stripFactoryEnvelope,
} from "@shared/message-delivery";
import {
  readMailEvidenceRef,
  readMailExtension,
  type MailEvidenceRef,
  type MailKind,
} from "@shared/crew";

export type { MailEvidenceRef, MailKind };

/** Written into the recipient's input, or waiting for its seat to start. */
export type MailDelivery = "delivered" | "waiting";

const nonempty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const isMailKind = (value: unknown): value is MailKind =>
  value === "notice" || value === "prompt" || value === "receipt";

export const parseMailEvidenceRef = (
  value: unknown,
): MailEvidenceRef | undefined => readMailEvidenceRef(value);

export const parseMailEvidenceRefs = (
  value: unknown,
): ReadonlyArray<MailEvidenceRef> => {
  if (!Array.isArray(value)) return [];
  const refs: MailEvidenceRef[] = [];
  for (const entry of value) {
    const parsed = parseMailEvidenceRef(entry);
    if (parsed !== undefined) refs.push(parsed);
  }
  return refs;
};

export const mailDeliveryOf = (message: Message): MailDelivery =>
  isMessageDelivered(message) ? "delivered" : "waiting";

export const mailDeliveryLabel = (delivery: MailDelivery): string =>
  delivery === "delivered" ? "delivered" : "waiting for seat";

export const mailKindLabel = (kind: MailKind): string => {
  switch (kind) {
    case "notice":
      return "notice";
    case "prompt":
      return "prompt";
    case "receipt":
      return "receipt";
  }
};

export const mailEvidenceLabel = (ref: MailEvidenceRef): string => {
  switch (ref.kind) {
    case "commit":
      return ref.sha.length > 12 ? ref.sha.slice(0, 12) : ref.sha;
    case "file":
      return ref.line === undefined ? ref.path : `${ref.path}:${ref.line}`;
    case "task":
      return ref.taskId;
    case "seat":
      return ref.actorRef;
    case "session-read":
      return ref.sessionId;
    case "url":
      return ref.url;
  }
};

/** Compact notices name the sender. Always pass the actual message. */
export const stripMailEnvelope = (body: string, message: Message): string =>
  stripFactoryEnvelope(body, message);

export const mailKindOf = (message: Message): MailKind | undefined => {
  const extension = readMailExtension(message.metadata);
  if (extension !== undefined) return extension.mailKind;
  const explicit = message.metadata?.mailKind;
  if (isMailKind(explicit)) return explicit;
  return undefined;
};

export const mailSubjectOf = (message: Message): string | undefined => {
  const extension = readMailExtension(message.metadata);
  if (extension !== undefined) return nonempty(extension.subject);
  return nonempty(message.metadata?.subject);
};

export const mailRefsOf = (message: Message): ReadonlyArray<MailEvidenceRef> => {
  const extension = readMailExtension(message.metadata);
  if (extension !== undefined) return extension.refs ?? [];
  return parseMailEvidenceRefs(message.metadata?.refs);
};

const metadataRecord = (
  metadata: unknown,
): Record<string, unknown> | undefined =>
  metadata !== null && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : undefined;

/** Stamped sender handle: canvas node when present, else `fromSeat`. */
export const resolveMailSenderStamp = (
  metadata: unknown,
): string | undefined => {
  const extension = readMailExtension(metadata);
  if (extension !== undefined) {
    return nonempty(extension.senderNodeId) ?? extension.fromSeat;
  }
  const record = metadataRecord(metadata);
  if (record === undefined) return undefined;
  return nonempty(record.senderNodeId) ?? nonempty(record.fromSeat);
};

/**
 * Peer maps key by canvas node. Prefer `senderNodeId`; `fromSeat` only when
 * that value is still a node id.
 */
export const resolveMailSenderNodeId = (
  doc: CanvasDoc,
  metadata: unknown,
): string | undefined => {
  const stamp = resolveMailSenderStamp(metadata);
  if (stamp !== undefined && doc.nodes.some((node) => node.id === stamp)) {
    return stamp;
  }
  const extension = readMailExtension(metadata);
  const fromSeat = nonempty(extension?.fromSeat) ?? nonempty(metadataRecord(metadata)?.fromSeat);
  if (fromSeat !== undefined && doc.nodes.some((node) => node.id === fromSeat)) {
    return fromSeat;
  }
  return undefined;
};

export const resolveMailSenderLabel = (
  metadata: unknown,
  fallbackStamp: string | undefined,
  titleOf: (nodeId: string) => string | undefined,
): string => {
  const extension = readMailExtension(metadata);
  const named =
    nonempty(extension?.senderName) ??
    nonempty(metadataRecord(metadata)?.senderName);
  const stamp = fallbackStamp ?? resolveMailSenderStamp(metadata);
  if (stamp === undefined) return named ?? "system";
  return titleOf(stamp) ?? named ?? stamp;
};

export type CrewMailView = {
  readonly messageId: string;
  readonly kind: MailKind | undefined;
  readonly subject: string | undefined;
  readonly delivery: MailDelivery;
  readonly read: boolean;
  readonly refs: ReadonlyArray<MailEvidenceRef>;
};

export const crewMailViewOf = (message: Message): CrewMailView => ({
  messageId: message.messageId,
  kind: mailKindOf(message),
  subject: mailSubjectOf(message),
  delivery: mailDeliveryOf(message),
  read: isMessageRead(message),
  refs: mailRefsOf(message),
});

export type MailCounts = {
  readonly total: number;
  readonly unread: number;
};

export const countMailViews = (
  views: ReadonlyArray<{
    readonly direction: "in" | "note";
    readonly read: boolean;
  }>,
): MailCounts => {
  let unread = 0;
  for (const view of views) {
    if (view.direction === "in" && !view.read) unread += 1;
  }
  return { total: views.length, unread };
};

export const resolveSenderLabel = (
  doc: CanvasDoc,
  fromNodeId: string | undefined,
  titleOf: (nodeId: string) => string | undefined,
): string => {
  if (fromNodeId === undefined) return "system";
  return titleOf(fromNodeId) ?? fromNodeId;
};
