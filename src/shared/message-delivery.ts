// Pure helpers for the one-way message nudge channel.
// Actor delivery is kind-discriminated (actor-surface sum) — never ACP.
// The runtime projection carries delivery state from normalized message rows:
// delivered = metadata.deliveredAt stamped.

import type { CanvasDoc, CanvasNode, Message } from "./canvas";
import {
  actorDeliverySurfaceOf,
  deliveryTargetFromSurface,
  type SurfaceDeliveryTarget,
} from "./actor-surface";
import { isGroup } from "./graph";
import { resolveSpec, roleOf } from "./physics";

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
  const raw = message.metadata?.fromSeat;
  if (typeof raw !== "string") return undefined;
  const trimmed = sanitizeDeliveryLine(raw);
  return trimmed.length > 0 ? trimmed.slice(0, 32) : undefined;
};

/** Strip the `[factory mail from …]` envelope so the preview is useful. */
const briefWithoutFactoryEnvelope = (message: Message): string =>
  messageBriefText(message)
    .replace(/^\[factory mail from [^\]]*\]\s*/i, "")
    .trim();

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
 * One PTY notify line for one or more pending messages on the same seat.
 * N > 1 always batches (never serial full-body dumps on wake).
 * N === 1 uses the single-message payload rules.
 */
export const composeMessageDeliverySummary = (
  messages: ReadonlyArray<Message>,
): string => {
  if (messages.length === 0) {
    return sanitizeDeliveryLine("[message] (empty)");
  }
  if (messages.length === 1) {
    const message = messages[0]!;
    if (!shouldSummarizeMessageForPty(message)) {
      return composeMessageDeliveryPayload(message);
    }
    const sender = messageSenderLabel(message);
    const id = shortMessageId(message.messageId);
    const from = factoryMailFromSeat(message);
    const kind = isFactoryMailMessage(message) ? "factory mail" : "mail";
    const fromBit = from ? ` from ${from}` : "";
    const previewRaw = briefWithoutFactoryEnvelope(message);
    const preview =
      previewRaw.length > MESSAGE_PTY_SUMMARY_PREVIEW_MAX
        ? `${previewRaw.slice(0, MESSAGE_PTY_SUMMARY_PREVIEW_MAX)}…`
        : previewRaw;
    const previewBit = preview.length > 0 ? ` — ${preview}` : "";
    return sanitizeDeliveryLine(
      `[message - ${sender}] ${kind}${fromBit} — ${id}${previewBit} — vellum-command msg list`,
    );
  }
  const factoryCount = messages.filter((m) => isFactoryMailMessage(m)).length;
  const factoryBit =
    factoryCount > 0 ? ` (${String(factoryCount)} factory mail)` : "";
  const ids = messages
    .slice(0, 3)
    .map((m) => shortMessageId(m.messageId))
    .join(",");
  const more =
    messages.length > 3 ? ` +${String(messages.length - 3)}` : "";
  return sanitizeDeliveryLine(
    `[message - user] ${String(messages.length)} pending${factoryBit} — ${ids}${more} — vellum-command msg list`,
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

/**
 * Screen residual only. Prefer {@link operatorTypedThisGeneration} for the
 * real draft gate — harness chrome fills extractPromptBoxText on every real
 * startup-idle capture (claude/codex/grok/devin), so non-empty ≠ operator draft.
 *
 * Returns true only for a stuck product paste chip still occupying the box.
 */
export const composerBlocksMailInject = (promptBoxText: string): boolean => {
  const text = promptBoxText.trim();
  if (text.length === 0) return false;
  if (/^\[message\b/i.test(text)) return false;
  // Stuck product paste chip — do not pile another inject on top.
  return text.includes("[Pasted");
};

/**
 * Operator typed into this generation if a keystroke was noted at/after spawn.
 * Load-bearing draft gate for mail inject.
 */
export const operatorTypedThisGeneration = (input: {
  readonly lastUserInputAtMs: number | undefined;
  readonly generationStartedAtMs: number;
}): boolean => {
  if (input.lastUserInputAtMs === undefined) return false;
  return input.lastUserInputAtMs >= input.generationStartedAtMs;
};

/** True when metadata.deliveredAt is a finite number (already delivered). */
export const isMessageDelivered = (message: Message): boolean => {
  const at = message.metadata?.deliveredAt;
  return typeof at === "number" && Number.isFinite(at);
};

/**
 * Own-echo guard: role "agent" is from the live process behind the node —
 * never send those back. Role "user" (and any other non-agent role) is foreign.
 */
export const isForeignMessage = (message: Message): boolean => message.role !== "agent";

/** Pending = foreign + not yet stamped. */
export const isPendingDelivery = (message: Message): boolean =>
  isForeignMessage(message) && !isMessageDelivered(message);

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
    for (const message of node.ether?.messages?.items ?? []) {
      if (!isPendingDelivery(message)) continue;
      out.push({ nodeId: node.id, message, target });
    }
  }
  return out;
};
