// Pure bulletin wake-set + inject envelope.
// Operator megaphone only — agent posts never mint wakes.

import type { CanvasDoc, CanvasNode } from "./canvas";
import { isGroup } from "./graph";
import {
  actorDeliverySurfaceOf,
  deliveryTargetFromSurface,
  type SurfaceDeliveryTarget,
} from "./actor-surface";
import { resolveSpec, roleOf } from "./physics";
import { sanitizeDeliveryLine } from "./message-delivery";

export type BoardWakeKind =
  | "operator.topic.notify"
  | "operator.notify.all"
  | "scheduler.pulse";

export type BoardWakeEvent = {
  readonly wakeEventId: string;
  readonly canvasName: string;
  readonly boardNodeId: string;
  readonly kind: BoardWakeKind;
  readonly topicId?: string;
  readonly postId?: string;
  readonly topicTitle?: string;
  readonly excerptSource: string;
  readonly createdAt: number;
};

export type BoardWakeSeat = {
  readonly nodeId: string;
  readonly target: SurfaceDeliveryTarget;
};

/** Edge has operator-authored Notify ON. */
export const edgeNotifyOn = (
  doc: CanvasDoc,
  a: string,
  b: string,
): boolean => {
  for (const edge of doc.edges) {
    const pair =
      (edge.fromNode === a && edge.toNode === b) ||
      (edge.fromNode === b && edge.toNode === a);
    if (!pair) continue;
    if (edge.ether?.notify === true) return true;
  }
  return false;
};

/**
 * Resolve live actor seats eligible for a board wake.
 * Notify-all still requires Notify ON (operator wires the war-room).
 */
export const resolveBoardWakeSet = (
  doc: CanvasDoc,
  boardNodeId: string,
): ReadonlyArray<BoardWakeSeat> => {
  const board = doc.nodes.find((n) => n.id === boardNodeId);
  if (!board) return [];

  const neighborIds = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.fromNode === boardNodeId) neighborIds.add(edge.toNode);
    if (edge.toNode === boardNodeId) neighborIds.add(edge.fromNode);
  }

  const out: BoardWakeSeat[] = [];
  for (const nodeId of neighborIds) {
    if (!edgeNotifyOn(doc, boardNodeId, nodeId)) continue;
    const node = doc.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const spec = resolveSpec({
      isGroup: isGroup(node),
      kind: node.ether?.entity?.kind,
    });
    if (roleOf(spec) !== "actor") continue;
    const surface = actorDeliverySurfaceOf(node);
    if (!surface) continue;
    const target = deliveryTargetFromSurface(surface);
    if (!target) continue;
    out.push({ nodeId, target });
  }
  return out;
};

const EXCERPT_MAX = 200;

export const composeBoardInjectEnvelope = (wake: BoardWakeEvent): string => {
  const topic =
    typeof wake.topicTitle === "string" && wake.topicTitle.trim().length > 0
      ? sanitizeDeliveryLine(wake.topicTitle).slice(0, 48)
      : wake.topicId
        ? sanitizeDeliveryLine(wake.topicId).slice(0, 24)
        : "board";
  const excerpt = sanitizeDeliveryLine(wake.excerptSource).slice(0, EXCERPT_MAX);
  const body = excerpt.length > 0 ? excerpt : "(empty)";
  const prefix =
    wake.kind === "operator.notify.all"
      ? `[board · notify-all · ${topic}]`
      : wake.kind === "scheduler.pulse"
        ? `[board · pulse · ${topic}]`
        : `[board · ${topic}]`;
  return sanitizeDeliveryLine(
    `${prefix} ${body} · mark_read or post optional`,
  );
};

export const boardWakeInjectId = (
  canvas: string,
  seatNodeId: string,
  wakeEventId: string,
): string => {
  // Stable opaque id for delivery.accepted — mirror mailbox digest style.
  const material = `vellum/board-wake-inject/v1\0${canvas}\0${seatNodeId}\0${wakeEventId}`;
  // Lightweight non-crypto hash (browser/main safe, no Node crypto import).
  let h = 2166136261;
  for (let i = 0; i < material.length; i += 1) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  // Expand to 64 hex-ish chars for CHECK compatibility with delivery ids.
  let out = "";
  while (out.length < 64) out += hex;
  return out.slice(0, 64);
};

export const authorLabel = (node: CanvasNode | undefined): string => {
  const name = node?.ether?.entity?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  return node?.id ?? "agent";
};
