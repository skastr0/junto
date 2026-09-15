// Pure helpers for the one-way message nudge channel.
// Actor delivery is kind-discriminated (actor-surface sum) — never ACP.
// The runtime projection carries delivery state from normalized message rows:
// delivered = metadata.deliveredAt stamped.

import { decodeTime } from "ulid";
import type { CanvasDoc, CanvasNode, Message } from "./canvas";
import {
  actorDeliverySurfaceOf,
  deliveryTargetFromSurface,
  type SurfaceDeliveryTarget,
} from "./actor-surface";
import { isGroup } from "./graph";
import { resolveSpec, roleOf } from "./physics";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Birth time from a ULID message id. Non-ULID ids have no time. */
export const messageIdTimeMs = (id: string): number | undefined => {
  if (!ULID_PATTERN.test(id)) return undefined;
  try {
    return decodeTime(id);
  } catch {
    return undefined;
  }
};

/** Newest first. ULID ids order by birth; non-ULID ids sink. */
export const compareMessageIdsNewestFirst = (a: string, b: string): number => {
  const aMs = messageIdTimeMs(a);
  const bMs = messageIdTimeMs(b);
  if (aMs !== undefined && bMs !== undefined) return b.localeCompare(a);
  if (aMs !== undefined) return -1;
  if (bMs !== undefined) return 1;
  return b.localeCompare(a);
};

export const sortMessagesNewestFirst = (
  messages: ReadonlyArray<Message>,
): Message[] =>
  [...messages].sort((a, b) =>
    compareMessageIdsNewestFirst(a.messageId, b.messageId),
  );

/**
 * Strip C0/C1 controls (and DEL) so a delivered line never carries CSI/ESC
 * inject material into a PTY. Whitespace is collapsed to a single line.
 */
export const sanitizeDeliveryLine = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Max brief length that may ride the PTY as the full one-liner.
 * Longer bodies (and every factoryMail) become a summary pointer instead —
 * the PTY is a notify surface, not a dump truck for peer essays.
 */
export const MESSAGE_PTY_FULL_BODY_MAX = 160;

/** Preview length inside a summary line (before the CLI pointer). */
export const MESSAGE_PTY_SUMMARY_PREVIEW_MAX = 48;

/** True when metadata.factoryMail is the boolean true (peer factory mail). */
export const isFactoryMailMessage = (message: Message): boolean =>
  message.metadata?.factoryMail === true;

/**
 * Full body may paste only when short AND not factory mail.
 * Factory mail and long bodies always summarize.
 */
export const shouldSummarizeMessageForPty = (message: Message): boolean => {
  if (isFactoryMailMessage(message)) return true;
  return messageBriefText(message).length > MESSAGE_PTY_FULL_BODY_MAX;
};

const shortMessageId = (messageId: string): string =>
  messageId.length > 12 ? messageId.slice(0, 12) : messageId;

const factoryMailFromSeat = (message: Message): string | undefined => {
  const raw = message.metadata?.senderName ?? message.metadata?.senderNodeId ?? message.metadata?.fromSeat;
  if (typeof raw !== "string") return undefined;
  const trimmed = sanitizeDeliveryLine(raw);
  return trimmed.length > 0 ? trimmed.slice(0, 32) : undefined;
};

/** Installed messages may still carry the old envelope in their body. */
const briefWithoutFactoryEnvelope = (message: Message): string =>
  messageBriefText(message)
    .replace(/^\[factory mail from [^\]]*\]\s*/i, "")
    .trim();

/** Full-body prompt policy has its own composer; notices never choose it. */
export const composeImmediatePromptPayload = (message: Message): string => {
  const from = factoryMailFromSeat(message) ?? "seat";
  const body = message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .replace(/^\[factory mail from [^\]]*\]\s*/i, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();
  return `mail from ${from}\n${body}`;
};

/**
 * Pulse-style one-liner for a single message.
 * Short ordinary mail: full brief. Factory mail / long body: summary + CLI pointer.
 */
export const composeMessageDeliveryPayload = (message: Message): string => {
  if (!shouldSummarizeMessageForPty(message)) {
    const sender = messageSenderLabel(message);
    const brief = messageBriefText(message);
    const task =
      typeof message.taskId === "string" && message.taskId.trim().length > 0
        ? ` - task ${sanitizeDeliveryLine(message.taskId)}`
        : "";
    return sanitizeDeliveryLine(`[message - ${sender}] ${brief}${task}`);
  }
  return composeMessageDeliverySummary([message]);
};

/**
 * One PTY notify line for unread mail on the same seat.
 * Cadence: N === 1 is the latest unread; N > 1 is one newest-first list.
 * Never serial dumps. Bodies stay in the mailbox.
 */
export const composeMessageDeliverySummary = (
  messages: ReadonlyArray<Message>,
): string => {
  const ordered = sortMessagesNewestFirst(messages);
  if (ordered.length === 0) {
    return sanitizeDeliveryLine("[message] (empty)");
  }
  if (ordered.length === 1) {
    const message = ordered[0]!;
    if (!shouldSummarizeMessageForPty(message)) {
      return composeMessageDeliveryPayload(message);
    }
    const id = sanitizeDeliveryLine(message.messageId);
    const from = factoryMailFromSeat(message);
    const fromBit = from ? ` from ${from}` : "";
    const previewRaw = briefWithoutFactoryEnvelope(message);
    const preview =
      previewRaw.length > MESSAGE_PTY_SUMMARY_PREVIEW_MAX
        ? `${previewRaw.slice(0, MESSAGE_PTY_SUMMARY_PREVIEW_MAX)}…`
        : previewRaw;
    const previewBit = preview.length > 0 ? ` — ${preview}` : "";
    return sanitizeDeliveryLine(
      `mail${fromBit}${previewBit} — vellum-command msg read ${id}`,
    );
  }
  const senders = [...new Set(ordered.map(factoryMailFromSeat).filter((from) => from !== undefined))];
  const fromBit = senders.length > 0 ? ` from ${senders.slice(0, 3).join(", ")}` : "";
  const ids = ordered
    .slice(0, 3)
    .map((m) => shortMessageId(m.messageId))
    .join(",");
  const more =
    ordered.length > 3 ? ` +${String(ordered.length - 3)}` : "";
  return sanitizeDeliveryLine(
    `mail${fromBit} — ${String(ordered.length)} unread — ${ids}${more} — vellum-command msg list`,
  );
};

/**
 * Sender label for the nudge line. Prefer role only — free metadata.sender
 * is spoofable on authorial writes and must not mint an "operator" trust label.
 */
export const messageSenderLabel = (message: Message): string => message.role;

export const messageBriefText = (message: Message): string => {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.kind !== "text") continue;
    const line = sanitizeDeliveryLine(part.text);
    if (line) chunks.push(line);
  }
  return chunks.join(" ") || "(empty)";
};

/** True when metadata.deliveredAt is a finite number (already nudged the PTY). */
export const isMessageDelivered = (message: Message): boolean => {
  const at = message.metadata?.deliveredAt;
  return typeof at === "number" && Number.isFinite(at);
};

/** True when metadata.readAt is a finite number (mailbox listed or marked read). */
export const isMessageRead = (message: Message): boolean => {
  const at = message.metadata?.readAt;
  return typeof at === "number" && Number.isFinite(at);
};

/**
 * Own-echo guard: role "agent" is from the live process behind the node —
 * never send those back. Role "user" (and any other non-agent role) is foreign.
 */
export const isForeignMessage = (message: Message): boolean => message.role !== "agent";

/**
 * Needs a PTY notify: foreign, still unread, and not yet nudged.
 * Listed mail is read — do not inject it. deliveredAt is only the
 * at-most-once notify receipt, not a product status.
 */
export const isPendingDelivery = (message: Message): boolean =>
  isForeignMessage(message) && !isMessageRead(message) && !isMessageDelivered(message);

/**
 * PTY is a notify surface. Read is listing the mailbox.
 * A paste never marks mail read — short or long, one or many.
 */
export const ptyInjectMarksRead = (_message: Message): boolean => false;

/**
 * Resolve transport target from kind-discriminated actor surface.
 * No optional-field OR. No ACP. Illegal agent shapes → undefined.
 *
 * The wire target sum itself is {@link SurfaceDeliveryTarget}, declared once
 * beside the surfaces it is derived from.
 */
export const deliveryTargetOf = (
  node: CanvasNode,
): SurfaceDeliveryTarget | undefined => {
  const surface = actorDeliverySurfaceOf(node);
  if (!surface) return undefined;
  return deliveryTargetFromSurface(surface);
};

/** Stamp metadata.deliveredAt on one message in an actor inbox. */
export const stampMessageDelivered = (
  doc: CanvasDoc,
  nodeId: string,
  messageId: string,
  deliveredAt: number,
): CanvasDoc | null => {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const items = node.ether?.messages?.items;
  if (!items) return null;
  const idx = items.findIndex((m) => m.messageId === messageId);
  if (idx < 0) return null;
  const current = items[idx]!;
  if (isMessageDelivered(current)) return null; // already stamped — no-op
  const nextItems = items.map((m, i) => {
    if (i !== idx) return m;
    return {
      ...m,
      metadata: {
        ...(m.metadata ?? {}),
        deliveredAt,
      },
    };
  });
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      return {
        ...n,
        ether: {
          ...(n.ether ?? {}),
          messages: { items: nextItems },
        },
      } as CanvasNode;
    }),
  };
};

/**
 * Collect pending (foreign, unstamped) messages on reachable work surfaces.
 * Participation is the actor role, asked of physics — not a kind list.
 */
export const listPendingDeliveries = (
  doc: CanvasDoc,
): ReadonlyArray<{
  readonly nodeId: string;
  readonly message: Message;
  readonly target: SurfaceDeliveryTarget;
}> => {
  const out: Array<{
    nodeId: string;
    message: Message;
    target: SurfaceDeliveryTarget;
  }> = [];
  for (const node of doc.nodes) {
    const spec = resolveSpec({
      isGroup: isGroup(node),
      kind: node.ether?.entity?.kind,
    });
    if (roleOf(spec) !== "actor") continue;
    const target = deliveryTargetOf(node);
    if (!target) continue;
    const pending = sortMessagesNewestFirst(
      (node.ether?.messages?.items ?? []).filter((message) =>
        isPendingDelivery(message),
      ),
    );
    for (const message of pending) {
      out.push({ nodeId: node.id, message, target });
    }
  }
  return out;
};
