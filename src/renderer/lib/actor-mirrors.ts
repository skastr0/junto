/**
 * Actor mirrors — the connections rail as navigation.
 *
 * A mirror is a connected actor's chip inside the terminal modal: it shows the
 * peer's live seat status and, on activation, swaps the modal to that actor in
 * place (the dock keeps the previous surface parked and alive, so returning is
 * instant). Cmd+] / Cmd+[ cycles the ring.
 *
 * Ring rule: the ring is one anchor actor plus its connected actor peers, in
 * rail order. The anchor re-derives ONLY when navigation lands on an actor
 * outside the current ring. Deriving the ring from the current node on every
 * step would ping-pong on hub-and-spoke graphs (hub peers are usually not
 * connected to each other); the sticky anchor keeps the full ring reachable.
 *
 * Presentation and navigation only — nothing here writes the canvas.
 */
import { observable } from "@legendapp/state";
import { asNodeId, type Canvas, type Node, type Seat } from "@shared/model";
import { actorEdgeRows } from "./actor-edges";
import { dock$, parseTerminalSurfaceId } from "./dock-state";
import { state$ } from "./state";
import { visiblePanes } from "./surface-registry";
import { openTerminal } from "./terminal-actions";
import { modelStore } from "./use-model";

/**
 * A peer is mirrorable when it is a seat: the one kind this UI can swap to,
 * and the model requires a terminal binding of every seat. Geography shells
 * and work sinks open different modals (no rail) — navigation would dead-end
 * there.
 */
export const isMirrorablePeer = (peer: Node | undefined): peer is Seat => peer?.kind === "agent";

/**
 * Unique mirrorable peer ids of `nodeId`, in rail order (peer title, then
 * edge id — same sort as the rendered connections list). Empty when the node
 * is not an actor or has no mirrorable peers.
 */
export const mirrorPeerIds = (
  canvas: Canvas,
  nodeId: string,
): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of actorEdgeRows(canvas, nodeId)) {
    if (seen.has(row.peerId)) continue;
    seen.add(row.peerId);
    if (!isMirrorablePeer(canvas.nodes.get(asNodeId(row.peerId)))) continue;
    out.push(row.peerId);
  }
  return out;
};

export type ActorRing = {
  readonly anchorId: string;
  /** Anchor first, then its mirrorable peers in rail order. */
  readonly memberIds: readonly string[];
};

/** Ring for an anchor. Null when the anchor cannot mirror-cycle (no peers). */
export const actorRingOf = (canvas: Canvas, anchorId: string): ActorRing | null => {
  if (!isMirrorablePeer(canvas.nodes.get(asNodeId(anchorId)))) return null;
  const peers = mirrorPeerIds(canvas, anchorId);
  if (peers.length === 0) return null;
  return { anchorId, memberIds: [anchorId, ...peers] };
};

/**
 * Sticky-anchor resolution: keep the standing ring while `currentId` is still
 * inside it; otherwise re-anchor at `currentId`. Membership is derived live
 * from the canvas, so wire changes take effect on the next step.
 */
export const resolveRing = (
  canvas: Canvas,
  currentId: string,
  anchorId: string | null,
): ActorRing | null => {
  if (anchorId !== null) {
    const standing = actorRingOf(canvas, anchorId);
    if (standing && standing.memberIds.includes(currentId)) return standing;
  }
  return actorRingOf(canvas, currentId);
};

/** Next member after `currentId` in ring order, wrapping. Null when absent. */
export const nextInRing = (
  memberIds: readonly string[],
  currentId: string,
  direction: 1 | -1,
): string | null => {
  if (memberIds.length < 2) return null;
  const at = memberIds.indexOf(currentId);
  if (at < 0) return null;
  const next = memberIds[(at + direction + memberIds.length) % memberIds.length];
  return next === undefined || next === currentId ? null : next;
};

/** The open canvas as the store holds it. */
const canvasNow = (): Canvas => modelStore.canvasOf(state$.canvasName.peek());

/** Sticky ring anchor. Presentation state only — never persisted. */
export const mirrorAnchor$ = observable<string | null>(null);

/** Node id of the frontmost focus-zone terminal surface, if any. */
export const frontTerminalNodeId = (): string | null => {
  const registry = dock$.registry.peek();
  const front = visiblePanes(registry, "focus").pane0;
  if (!front) return null;
  const surface = registry.surfaces.find((s) => s.id === front);
  if (!surface || surface.kind !== "terminal") return null;
  return parseTerminalSurfaceId(front);
};

/**
 * Open a mirror from a rail chip. `fromNodeId` is the actor whose rail was
 * clicked; the sticky anchor keeps the standing ring when the target is
 * already inside it, else re-anchors at the clicked rail's actor (whose ring
 * contains the target by construction).
 */
export const openActorMirror = (peer: Seat, fromNodeId: string): void => {
  const anchor = mirrorAnchor$.peek();
  const standing = anchor !== null ? actorRingOf(canvasNow(), anchor) : null;
  if (!standing || !standing.memberIds.includes(peer.id)) {
    mirrorAnchor$.set(fromNodeId);
  }
  void openTerminal(state$.canvasName.peek(), peer.id, "focus");
};

/**
 * Cycle the frontmost focus terminal to the next/previous ring actor.
 * Returns true when a swap was issued (callers consume the key only then).
 */
export const cycleActorMirror = (direction: 1 | -1): boolean => {
  const currentId = frontTerminalNodeId();
  if (!currentId) return false;
  const canvas = canvasNow();
  const ring = resolveRing(canvas, currentId, mirrorAnchor$.peek());
  if (!ring) return false;
  const nextId = nextInRing(ring.memberIds, currentId, direction);
  if (!nextId) return false;
  if (!canvas.nodes.has(asNodeId(nextId))) return false;
  mirrorAnchor$.set(ring.anchorId);
  void openTerminal(state$.canvasName.peek(), nextId, "focus");
  return true;
};
