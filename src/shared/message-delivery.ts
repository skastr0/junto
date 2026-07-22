// Pure helpers for the one-way message nudge channel.
// Agent nodes → ACP chatPrompt; herdr nodes → stock terminal.input text.
// Document stays the source of truth: delivered = metadata.deliveredAt stamped.

import type { CanvasDoc, CanvasNode, Message } from "./canvas";

/**
 * Strip C0/C1 controls (and DEL) so herdr terminal.input never carries
 * CSI/ESC inject material. Whitespace is collapsed to a single line.
 */
export const sanitizeDeliveryLine = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Pulse-style one-liner: `[message · <sender>] <brief>[ · task <id>]` */
export const composeMessageDeliveryPayload = (message: Message): string => {
  const sender = messageSenderLabel(message);
  const brief = messageBriefText(message);
  const task =
    typeof message.taskId === "string" && message.taskId.trim().length > 0
      ? ` · task ${sanitizeDeliveryLine(message.taskId)}`
      : "";
  return sanitizeDeliveryLine(`[message · ${sender}] ${brief}${task}`);
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

export type DeliveryTarget =
  | { readonly kind: "agent"; readonly agentKey: string }
  | { readonly kind: "herdr"; readonly terminalId: string }
  | { readonly kind: "terminal"; readonly bindingId: string };

/** Resolve transport target from an agent/herdr node. Undefined = unreachable. */
export const deliveryTargetOf = (node: CanvasNode): DeliveryTarget | undefined => {
  const kind = node.ether?.entity?.kind;
  if (kind === "agent") {
    const agentKey = node.ether?.entity?.name?.trim();
    if (!agentKey) return undefined;
    return { kind: "agent", agentKey };
  }
  if (kind === "herdr") {
    const terminalId = node.ether?.herdr?.terminalId?.trim();
    if (!terminalId) return undefined;
    return { kind: "herdr", terminalId };
  }
  if (kind === "terminal") {
    const bindingId = node.ether?.terminal?.bindingId?.trim();
    if (!bindingId) return undefined;
    return { kind: "terminal", bindingId };
  }
  return undefined;
};

/** Stamp metadata.deliveredAt on one message in an agent/herdr messages list. */
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

/** Collect pending (foreign, unstamped) messages on reachable work surfaces. */
export const listPendingDeliveries = (
  doc: CanvasDoc,
): ReadonlyArray<{
  readonly nodeId: string;
  readonly message: Message;
  readonly target: DeliveryTarget;
}> => {
  const out: Array<{
    nodeId: string;
    message: Message;
    target: DeliveryTarget;
  }> = [];
  for (const node of doc.nodes) {
    const kind = node.ether?.entity?.kind;
    if (kind !== "agent" && kind !== "herdr" && kind !== "terminal") continue;
    const target = deliveryTargetOf(node);
    if (!target) continue;
    for (const message of node.ether?.messages?.items ?? []) {
      if (!isPendingDelivery(message)) continue;
      out.push({ nodeId: node.id, message, target });
    }
  }
  return out;
};
