/**
 * Operator mail projection — typed view of one attempt's preserved facts.
 *
 * Transport timestamps and read / reply / reaction timestamps never erase
 * one another. The chip the ledger paints is derived from those facts.
 * Nothing here invents a status the document did not record.
 */
import { Schema } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import type { Message } from "@shared/work-model";
import {
  MailAttemptFacts as MailAttemptFactsSchema,
  MailEvidenceRef as MailEvidenceRefSchema,
  deriveMailDisplayState,
  normalizeDisplayTimestamp,
  readMailExtension,
  type MailAttemptFacts as CanonicalMailAttemptFacts,
  type MailAttemptReason,
  type MailDisplayState,
  type MailEvidenceRef,
  type MailKind,
} from "@shared/crew";

export type { MailEvidenceRef, MailKind };
export type MailDeliveryDisplay = MailDisplayState;

export type MailAttemptFacts = {
  readonly queuedAt: number | string | undefined;
  readonly notifiedAt: number | string | undefined;
  readonly unresolvedAt: number | string | undefined;
  readonly refusedAt: number | string | undefined;
  readonly refusedReason: MailAttemptReason | undefined;
  readonly readAt: number | string | undefined;
  readonly repliedAt: number | string | undefined;
  readonly reactedAt: number | string | undefined;
  readonly generation: string | undefined;
};

const nonempty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const isMailKind = (value: unknown): value is MailKind =>
  value === "notice" || value === "prompt" || value === "receipt";

const decodeEvidenceRef = Schema.decodeUnknownOption(MailEvidenceRefSchema);
const decodeAttemptFacts = Schema.decodeUnknownOption(MailAttemptFactsSchema);

export const parseMailEvidenceRef = (
  value: unknown,
): MailEvidenceRef | undefined => {
  const decoded = decodeEvidenceRef(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

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

/**
 * Receipt facts outrank transport. Unresolved outranks a later refusal so a
 * physical write cannot be hidden by a no-write retry.
 */
export const deriveMailDisplay = (
  facts: MailAttemptFacts,
): MailDeliveryDisplay =>
  deriveMailDisplayState({
    queuedAt: normalizeDisplayTimestamp(facts.queuedAt),
    notifiedAt: normalizeDisplayTimestamp(facts.notifiedAt),
    unresolvedAt: normalizeDisplayTimestamp(facts.unresolvedAt),
    refusedAt: normalizeDisplayTimestamp(facts.refusedAt),
    readAt: normalizeDisplayTimestamp(facts.readAt),
    repliedAt: normalizeDisplayTimestamp(facts.repliedAt),
    reactedAt: normalizeDisplayTimestamp(facts.reactedAt),
  });

export const mailDisplayLabel = (display: MailDeliveryDisplay): string => {
  switch (display) {
    case "queued":
      return "queued";
    case "notified":
      return "notified";
    case "unresolved":
      return "unresolved";
    case "refused":
      return "refused";
    case "read":
      return "read";
    case "replied":
      return "replied";
    case "reacted":
      return "reacted";
  }
};

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

/** Compact notices name the sender. Legacy bracket envelope still strips. */
export const stripMailEnvelope = (body: string): string => {
  const legacy = /^\[factory mail from [^\]]+\]\s*/.exec(body);
  if (legacy) return body.slice(legacy[0].length);
  const current = /^mail from [^\n]+?\s+/i.exec(body);
  if (current) return body.slice(current[0].length);
  return body;
};

export const mailKindOf = (message: Message): MailKind | undefined => {
  const extension = readMailExtension(message.metadata);
  if (extension !== undefined) return extension.mailKind;
  const explicit = message.metadata?.mailKind;
  if (isMailKind(explicit)) return explicit;
  return undefined;
};

const stampOf = (value: unknown): number | string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return nonempty(value);
};

const isAttemptReason = (value: unknown): value is MailAttemptReason =>
  value === "seat-busy" ||
  value === "composer-draft" ||
  value === "composer-unreadable" ||
  value === "operator-interlock" ||
  value === "not-idle" ||
  value === "not-settled" ||
  value === "paused" ||
  value === "no-lease" ||
  value === "seat-gone" ||
  value === "oversize" ||
  value === "written-no-evidence";

/**
 * Transport facts use the exported MailAttemptFacts names. Receipt stamps
 * stay on the root envelope (`readAt`, and the historical `deliveredAt`
 * notify receipt). No parallel metadata keys.
 */
export const mailAttemptFactsOf = (
  message: Message,
  queuedAt: number | undefined,
): MailAttemptFacts => {
  const meta = message.metadata;
  const decoded = decodeAttemptFacts(meta);
  const transport: CanonicalMailAttemptFacts | undefined =
    decoded._tag === "Some" ? decoded.value : undefined;
  return {
    queuedAt: transport?.queuedAt ?? queuedAt,
    notifiedAt: transport?.notifiedAt ?? stampOf(meta?.notifiedAt) ?? stampOf(meta?.deliveredAt),
    unresolvedAt: transport?.unresolvedAt ?? stampOf(meta?.unresolvedAt),
    refusedAt: transport?.refusedAt ?? stampOf(meta?.refusedAt),
    refusedReason:
      transport?.refusedReason ??
      (isAttemptReason(meta?.refusedReason) ? meta.refusedReason : undefined),
    readAt: stampOf(meta?.readAt),
    repliedAt: stampOf(meta?.repliedAt),
    reactedAt: stampOf(meta?.reactedAt),
    generation: transport?.generation ?? nonempty(meta?.generation),
  };
};

export const mailSubjectOf = (message: Message): string | undefined => {
  const extension = readMailExtension(message.metadata);
  return nonempty(extension?.subject) ?? nonempty(message.metadata?.subject);
};

export const mailRefsOf = (message: Message): ReadonlyArray<MailEvidenceRef> => {
  const extension = readMailExtension(message.metadata);
  if (extension?.refs !== undefined) return extension.refs;
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
  readonly facts: MailAttemptFacts;
  readonly display: MailDeliveryDisplay;
  readonly displayReason: string | undefined;
  readonly refs: ReadonlyArray<MailEvidenceRef>;
};

export const crewMailViewOf = (
  message: Message,
  queuedAt: number | undefined,
): CrewMailView => {
  const facts = mailAttemptFactsOf(message, queuedAt);
  const display = deriveMailDisplay(facts);
  return {
    messageId: message.messageId,
    kind: mailKindOf(message),
    subject: mailSubjectOf(message),
    facts,
    display,
    displayReason: display === "refused" ? facts.refusedReason : undefined,
    refs: mailRefsOf(message),
  };
};

export type MailCounts = {
  readonly total: number;
  readonly unread: number;
  readonly unresolved: number;
};

export const countMailViews = (
  views: ReadonlyArray<{
    readonly direction: "in" | "note";
    readonly display: MailDeliveryDisplay;
    readonly read: boolean;
  }>,
): MailCounts => {
  let unread = 0;
  let unresolved = 0;
  for (const view of views) {
    if (view.direction !== "in") continue;
    if (!view.read) unread += 1;
    if (view.display === "unresolved") unresolved += 1;
  }
  return { total: views.length, unread, unresolved };
};

/** Sender node ids whose inbound attempts are still unresolved. */
export const unresolvedMailByPeer = (
  rows: ReadonlyArray<{
    readonly direction: "in" | "note";
    readonly display: MailDeliveryDisplay;
    readonly fromNodeId: string | undefined;
  }>,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (
      row.direction !== "in" ||
      row.display !== "unresolved" ||
      row.fromNodeId === undefined
    ) {
      continue;
    }
    counts.set(row.fromNodeId, (counts.get(row.fromNodeId) ?? 0) + 1);
  }
  return counts;
};

export const resolveSenderLabel = (
  doc: CanvasDoc,
  fromNodeId: string | undefined,
  titleOf: (nodeId: string) => string | undefined,
): string => {
  if (fromNodeId === undefined) return "system";
  return titleOf(fromNodeId) ?? fromNodeId;
};
