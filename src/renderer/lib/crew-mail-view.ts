/**
 * Operator mail projection — typed view of one attempt's preserved facts.
 *
 * Transport timestamps and read / reply / reaction timestamps never erase
 * one another. The chip the ledger paints is derived from those facts.
 * Nothing here invents a status the document did not record.
 */
import type { CanvasDoc } from "@shared/canvas";
import type { Message } from "@shared/work-model";
import {
  deriveMailDisplayState,
  type MailDisplayState,
  type MailEvidenceRef,
  type MailKind,
} from "@shared/crew";

export type { MailEvidenceRef, MailKind };
export type MailDeliveryDisplay = MailDisplayState;

export type MailAttemptFacts = {
  readonly queuedAt: number | undefined;
  readonly notifiedAt: number | undefined;
  readonly unresolvedAt: number | undefined;
  readonly refusedAt: number | undefined;
  readonly refusedReason: string | undefined;
  readonly readAt: number | undefined;
  readonly repliedAt: number | undefined;
  readonly reactedAt: number | undefined;
  readonly generation: string | undefined;
};

const finiteMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
};

const nonempty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const isMailKind = (value: unknown): value is MailKind =>
  value === "notice" || value === "prompt" || value === "receipt";

const isEvidenceKind = (
  value: unknown,
): value is MailEvidenceRef["kind"] =>
  value === "commit" ||
  value === "file" ||
  value === "task" ||
  value === "seat" ||
  value === "session-read" ||
  value === "url";

export const parseMailEvidenceRef = (
  value: unknown,
): MailEvidenceRef | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!isEvidenceKind(record.kind)) return undefined;
  switch (record.kind) {
    case "commit": {
      const sha = nonempty(record.sha);
      return sha === undefined ? undefined : { kind: "commit", sha };
    }
    case "file": {
      const path = nonempty(record.path);
      if (path === undefined) return undefined;
      const line = finiteMs(record.line);
      return line === undefined
        ? { kind: "file", path }
        : { kind: "file", path, line };
    }
    case "task": {
      const taskId = nonempty(record.taskId);
      return taskId === undefined ? undefined : { kind: "task", taskId };
    }
    case "seat": {
      const actorRef = nonempty(record.actorRef);
      return actorRef === undefined ? undefined : { kind: "seat", actorRef };
    }
    case "session-read": {
      const sessionId = nonempty(record.sessionId);
      return sessionId === undefined
        ? undefined
        : { kind: "session-read", sessionId };
    }
    case "url": {
      const url = nonempty(record.url);
      return url === undefined ? undefined : { kind: "url", url };
    }
  }
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

const present = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

/**
 * Receipt facts outrank transport. Unresolved outranks a later refusal so a
 * physical write cannot be hidden by a no-write retry.
 */
export const deriveMailDisplay = (
  facts: MailAttemptFacts,
): MailDeliveryDisplay =>
  deriveMailDisplayState({
    queuedAt: present(facts.queuedAt),
    notifiedAt: present(facts.notifiedAt),
    unresolvedAt: present(facts.unresolvedAt),
    refusedAt: present(facts.refusedAt),
    readAt: present(facts.readAt),
    repliedAt: present(facts.repliedAt),
    reactedAt: present(facts.reactedAt),
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
  const explicit = message.metadata?.mailKind;
  if (isMailKind(explicit)) return explicit;
  return undefined;
};

export const mailAttemptFactsOf = (
  message: Message,
  queuedAt: number | undefined,
): MailAttemptFacts => {
  const meta = message.metadata;
  return {
    queuedAt,
    notifiedAt: finiteMs(meta?.notifiedAt) ?? finiteMs(meta?.deliveredAt),
    unresolvedAt: finiteMs(meta?.unresolvedAt),
    refusedAt: finiteMs(meta?.refusedAt),
    refusedReason: nonempty(meta?.refuseReason) ?? nonempty(meta?.refusedReason),
    readAt: finiteMs(meta?.readAt),
    repliedAt: finiteMs(meta?.repliedAt),
    reactedAt: finiteMs(meta?.reactedAt),
    generation: nonempty(meta?.generation),
  };
};

export const mailSubjectOf = (message: Message): string | undefined =>
  nonempty(message.metadata?.subject);

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
    refs: parseMailEvidenceRefs(message.metadata?.refs),
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
