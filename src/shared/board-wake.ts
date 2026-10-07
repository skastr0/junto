// Pure bulletin wake-set + inject envelope.
// Operator megaphone only — agent posts never mint wakes.

import type { SurfaceDeliveryTarget } from "./actor-surface";
import { nodeOf, wiresAt, type Canvas } from "./model/canvas";
import type { NodeId } from "./model/base";
import { wireGrant, wireKinds } from "./model/wire";
import { sanitizeDeliveryLine } from "./message-delivery";

export type BoardWakeKind =
  | "operator.topic.notify"
  | "operator.notify.all"
  | "scheduler.pulse"
  /** Soft actor-to-actor tag; only tagged seats, async no-reply copy. */
  | "actor.tag";

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

/**
 * Seat is eligible for board megaphone wakes.
 *
 * The verb decides: a seat that `participates` in a board is reachable by the
 * operator megaphone; one that only `messages` it reads and posts without ever
 * being called into the room.
 */
export const edgeNotifyOn = (
  canvas: Canvas,
  a: string,
  b: string,
): boolean => {
  const kinds = wireKinds(canvas.nodes.values());
  for (const wire of wiresAt(canvas, a as NodeId)) {
    if (wire.from !== b && wire.to !== b) continue;
    if (wireGrant(wire, kinds)?.wake === true) return true;
  }
  return false;
};

/**
 * Seats a board wake reaches: every seat joined to the board by a wire that
 * wakes, once each, in the order the canvas holds its wires.
 */
export const resolveBoardWakeSet = (
  canvas: Canvas,
  boardNodeId: string,
): ReadonlyArray<BoardWakeSeat> => {
  const board = boardNodeId as NodeId;
  if (!canvas.nodes.has(board)) return [];
  const kinds = wireKinds(canvas.nodes.values());
  const out = new Map<string, BoardWakeSeat>();
  for (const wire of wiresAt(canvas, board)) {
    if (wireGrant(wire, kinds)?.wake !== true) continue;
    const seat = nodeOf(canvas, wire.from === board ? wire.to : wire.from, "agent");
    if (seat === undefined || out.has(seat.id)) continue;
    out.set(seat.id, { nodeId: seat.id, target: { bindingId: seat.bindingId } });
  }
  return [...out.values()];
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
  if (wake.kind === "actor.tag") {
    return sanitizeDeliveryLine(
      `[board-tag - ${topic}] ${body} (async — no reply required)`,
    );
  }
  const prefix =
    wake.kind === "operator.notify.all"
      ? `[board - notify-all - ${topic}]`
      : wake.kind === "scheduler.pulse"
        ? `[board - pulse - ${topic}]`
        : `[board - ${topic}]`;
  return sanitizeDeliveryLine(
    `${prefix} ${body} - mark_read or post optional`,
  );
};

export const boardWakeInjectId = (
  canvas: string,
  seatNodeId: string,
  wakeEventId: string,
): string => {
  // Stable opaque id for delivery.accepted — mirror mailbox digest style.
  const material = `junto/board-wake-inject/v1\0${canvas}\0${seatNodeId}\0${wakeEventId}`;
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
