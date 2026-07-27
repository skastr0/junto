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
