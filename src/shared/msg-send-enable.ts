// Rising-edge notices when actor↔actor msg.send becomes newly granted.
// Pure: previous/next canvas docs → mailbox notice plan. No I/O.

import { Result, HashSet } from "effect";
import type { CanvasDoc, CanvasNode } from "./canvas";
import { isGroup } from "./graph";
import {
  ACTOR_ACTOR_INBOX_PORTS,
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  offersOf,
  resolveSpec,
  roleOf,
} from "./physics";

export type MsgSendPeer = {
  readonly peerId: string;
  readonly peerTitle: string;
};

export type MsgSendEnableNotice = {
  /** Actor seat that newly gained msg.send to peer. */
  readonly recipientId: string;
  readonly peerId: string;
  readonly peerTitle: string;
};

const nodeKind = (node: CanvasNode): string | undefined =>
  node.ether?.entity?.kind;

const nodeTitle = (node: CanvasNode): string => {
  if (node.type === "text") {
    const first = node.text?.split("\n")[0]?.trim();
    if (first) return first;
  }
  if (node.type === "group" && node.label?.trim()) return node.label.trim();
  if (node.type === "link" && node.url) return node.url;
  if (node.type === "file" && node.file) return node.file;
  return node.ether?.entity?.name ?? node.id;
};

const isActorWithInbox = (node: CanvasNode): boolean => {
  const spec = resolveSpec({ isGroup: isGroup(node), kind: nodeKind(node) });
  if (roleOf(spec) !== "actor") return false;
  const offers = offersOf(spec);
  return ACTOR_ACTOR_INBOX_PORTS.every((port) => HashSet.has(offers, port));
};

/**
 * Undirected-stable key for one directed (caller → peer) msg.send grant.
 * Used only for set diffs — not a durable identity.
 */
const grantKey = (callerId: string, peerId: string): string =>
  `${callerId}\0${peerId}`;

/**
 * Every directed actor→actor msg.send grant currently admitted by physics.
 * An unmasked actor edge yields an entry through the Full default; an authored
 * port mask can attenuate the grant back to discovery-only or another subset.
 */
export const listMsgSendGrants = (
  doc: CanvasDoc,
): ReadonlyMap<string, MsgSendPeer> => {
  const actors = doc.nodes.filter(isActorWithInbox);
  if (actors.length < 2) return new Map();

  const view = canvasDocToCapabilityView(doc);
  const byId = new Map(actors.map((n) => [n.id, n] as const));
  const out = new Map<string, MsgSendPeer>();

  for (const caller of actors) {
    for (const peer of actors) {
      if (peer.id === caller.id) continue;
      const admitted = admitPure(
        view,
        asNodeId(caller.id),
        asNodeId(peer.id),
        "msg.send",
      );
      if (Result.isFailure(admitted)) continue;
      out.set(grantKey(caller.id, peer.id), {
        peerId: peer.id,
        peerTitle: nodeTitle(byId.get(peer.id) ?? peer),
      });
    }
  }
  return out;
};

/**
 * Rising edges only: grants present in `next` but not in `previous`.
 * Callers must skip when `previous` is missing (canvas open / first paint).
 */
export const planMsgSendEnableNotices = (
  previous: CanvasDoc,
  next: CanvasDoc,
): ReadonlyArray<MsgSendEnableNotice> => {
  const before = listMsgSendGrants(previous);
  const after = listMsgSendGrants(next);
  const notices: MsgSendEnableNotice[] = [];
  for (const [key, peer] of after) {
    if (before.has(key)) continue;
    const recipientId = key.slice(0, key.indexOf("\0"));
    notices.push({
      recipientId,
      peerId: peer.peerId,
      peerTitle: peer.peerTitle,
    });
  }
  notices.sort((a, b) => {
    const byRecipient = a.recipientId.localeCompare(b.recipientId);
    return byRecipient !== 0 ? byRecipient : a.peerId.localeCompare(b.peerId);
  });
  return notices;
};

/** Durable mailbox body + PTY nudge text for one enable notice. */
export const composeMsgSendEnableMailboxText = (
  notice: MsgSendEnableNotice,
): string => {
  const title =
    notice.peerTitle.trim().length > 0 ? notice.peerTitle.trim() : notice.peerId;
  return [
    `[factory - link] msg.send is now enabled to agent "${title}" (\`${notice.peerId}\`).`,
    `Send a message with: vellum-command msg send '{"target":"${notice.peerId}","text":"..."}'`,
    "If this agent is missing from your view, re-run `vellum-command onboard` (or `vellum-command capabilities`).",
  ].join("\n");
};
