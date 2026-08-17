/**
 * Board collaboration: connected-actor registry + post tags.
 *
 * Connected actors are derived from the canvas (edges to the board node).
 * Tags on posts name actor node ids; tag notify is opt-in via edge wake
 * (same default as operator megaphone: ON unless wake:false) but is a soft
 * inject — no reply / ack required, less urgent copy than mailbox.
 */

import type { CanvasDoc, CanvasNode } from "./canvas";
import { isGroup } from "./graph";
import { resolveSpec, roleOf } from "./physics";
import { edgeNotifyOn, authorLabel } from "./board-wake";
import { sanitizeDeliveryLine } from "./message-delivery";

export type BoardConnectedActor = {
  readonly nodeId: string;
  /** entity.name when authored (host:profile / host:harness). */
  readonly agentKey?: string;
  readonly label: string;
  /** Edge wake eligible for board tag / megaphone inject. */
  readonly wake: boolean;
};

const actorFromNode = (
  doc: CanvasDoc,
  sinkNodeId: string,
  node: CanvasNode,
): BoardConnectedActor | undefined => {
  const spec = resolveSpec({
    isGroup: isGroup(node),
    kind: node.ether?.entity?.kind,
  });
  if (roleOf(spec) !== "actor") return undefined;
  const agentKey =
    typeof node.ether?.entity?.name === "string" &&
    node.ether.entity.name.trim().length > 0
      ? node.ether.entity.name.trim()
      : undefined;
  return {
    nodeId: node.id,
    ...(agentKey ? { agentKey } : {}),
    label: authorLabel(node),
    wake: edgeNotifyOn(doc, sinkNodeId, node.id),
  };
};

/** Actors with an undirected edge to the board sink (actor role only). */
export const resolveBoardConnectedActors = (
  doc: CanvasDoc,
  boardNodeId: string,
): ReadonlyArray<BoardConnectedActor> => {
  const board = doc.nodes.find((n) => n.id === boardNodeId);
  if (!board) return [];

  const neighborIds = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.fromNode === boardNodeId) neighborIds.add(edge.toNode);
    if (edge.toNode === boardNodeId) neighborIds.add(edge.fromNode);
  }

  const out: BoardConnectedActor[] = [];
  for (const nodeId of neighborIds) {
    const node = doc.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const actor = actorFromNode(doc, boardNodeId, node);
    if (actor) out.push(actor);
  }
  return out.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
};

/**
 * Pad mention universe: inbound actor edges only. `@` cannot name an
 * unwired or outbound-only seat. Same BoardConnectedActor shape as board
 * tags so tag-notify reuse stays one roster.
 */
export const resolvePadInboundActors = (
  doc: CanvasDoc,
  padNodeId: string,
): ReadonlyArray<BoardConnectedActor> => {
  if (!doc.nodes.some((node) => node.id === padNodeId)) return [];
  const out: BoardConnectedActor[] = [];
  const seen = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.toNode !== padNodeId) continue;
    if (seen.has(edge.fromNode)) continue;
    const node = doc.nodes.find((candidate) => candidate.id === edge.fromNode);
    if (!node) continue;
    const actor = actorFromNode(doc, padNodeId, node);
    if (!actor) continue;
    seen.add(actor.nodeId);
    out.push(actor);
  }
  return out.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
};

const MAX_TAGS = 16;

/**
 * Normalize tag list: trim, drop empties, dedupe, cap.
 * Tags are canvas actor node ids (stable seat cards), not seat_ hashes.
 */
export const normalizeBoardTags = (
  tags: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  if (!tags || tags.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
};

/**
 * Keep only tags that name currently connected actors (wake or not).
 * Unknown ids are dropped — never invent roster members.
 */
export const filterTagsToConnected = (
  tags: ReadonlyArray<string>,
  actors: ReadonlyArray<BoardConnectedActor>,
): ReadonlyArray<string> => {
  const allowed = new Set(actors.map((a) => a.nodeId));
  return tags.filter((id) => allowed.has(id));
};

/** Seats that should receive a soft tag inject (connected + wake edge). */
export const tagNotifyNodeIds = (
  tags: ReadonlyArray<string>,
  actors: ReadonlyArray<BoardConnectedActor>,
  /** Never notify the author of their own tag. */
  authorNodeId?: string,
): ReadonlyArray<string> => {
  const wakeable = new Set(
    actors.filter((a) => a.wake).map((a) => a.nodeId),
  );
  const out: string[] = [];
  for (const id of tags) {
    if (authorNodeId && id === authorNodeId) continue;
    if (!wakeable.has(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
  }
  return out;
};

const EXCERPT_MAX = 160;

/** Soft tag inject — async, no reply required (not mailbox urgency). */
export const composeBoardTagEnvelope = (input: {
  readonly topicTitle?: string;
  readonly topicId?: string;
  readonly authorLabel?: string;
  readonly excerptSource: string;
}): string => {
  const topic =
    typeof input.topicTitle === "string" && input.topicTitle.trim().length > 0
      ? sanitizeDeliveryLine(input.topicTitle).slice(0, 48)
      : input.topicId
        ? sanitizeDeliveryLine(input.topicId).slice(0, 24)
        : "board";
  const who =
    typeof input.authorLabel === "string" && input.authorLabel.trim()
      ? sanitizeDeliveryLine(input.authorLabel).slice(0, 40)
      : "someone";
  const excerpt = sanitizeDeliveryLine(input.excerptSource).slice(0, EXCERPT_MAX);
  const body = excerpt.length > 0 ? excerpt : "(empty)";
  return sanitizeDeliveryLine(
    `[board-tag - ${topic}] ${who} tagged you: ${body} (async — no reply required)`,
  );
};

/** True when post tags include this actor node id. */
export const postTagsActor = (
  tags: ReadonlyArray<string> | undefined,
  actorNodeId: string,
): boolean =>
  Boolean(tags?.some((id) => id === actorNodeId));

export const nodeDisplayLabel = (node: CanvasNode | undefined): string =>
  authorLabel(node);
