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
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { resolveTerminalBinding } from "@shared/terminal";
import { actorEdgeRows } from "./actor-edges";
import { dock$, parseTerminalSurfaceId } from "./dock-state";
import { state$ } from "./state";
import { visiblePanes } from "./surface-registry";
import { openTerminal } from "./terminal-actions";

/**
 * A peer is mirrorable when it is an actor seat this UI can swap to: kind
 * `agent` with a native terminal binding. Geography shells and work sinks
 * open different modals (no rail) — navigation would dead-end there.
 */
export const isMirrorablePeer = (peer: CanvasNode | undefined): peer is CanvasNode =>
  peer !== undefined &&
  peer.ether?.entity?.kind === "agent" &&
  resolveTerminalBinding(peer)?.kind === "native";

/**
 * Unique mirrorable peer ids of `nodeId`, in rail order (peer title, then
 * edge id — same sort as the rendered connections list). Empty when the node
 * is not an actor or has no mirrorable peers.
 */
export const mirrorPeerIds = (
  doc: CanvasDoc,
  nodeId: string,
): readonly string[] => {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of actorEdgeRows(doc, nodeId)) {
    if (seen.has(row.peerId)) continue;
    seen.add(row.peerId);
    if (!isMirrorablePeer(byId.get(row.peerId))) continue;
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
export const actorRingOf = (doc: CanvasDoc, anchorId: string): ActorRing | null => {
  const anchor = doc.nodes.find((n) => n.id === anchorId);
  if (!isMirrorablePeer(anchor)) return null;
  const peers = mirrorPeerIds(doc, anchorId);
  if (peers.length === 0) return null;
  return { anchorId, memberIds: [anchorId, ...peers] };
};

/**
 * Sticky-anchor resolution: keep the standing ring while `currentId` is still
 * inside it; otherwise re-anchor at `currentId`. Membership is derived live
 * from the document, so edge changes take effect on the next step.
 */
export const resolveRing = (
  doc: CanvasDoc,
  currentId: string,
  anchorId: string | null,
): ActorRing | null => {
  if (anchorId !== null) {
    const standing = actorRingOf(doc, anchorId);
    if (standing && standing.memberIds.includes(currentId)) return standing;
  }
  return actorRingOf(doc, currentId);
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
export const openActorMirror = (
  peer: CanvasNode,
  fromNodeId: string,
  zone: "focus" | "pinned" = "focus",
): void => {
  // The anchor orders the FOCUS cycle ring; a pinned rail click must not
  // silently reorder it (membership re-derives live either way).
  if (zone === "focus") {
    const doc = state$.doc.peek();
    const anchor = mirrorAnchor$.peek();
    const standing = anchor !== null ? actorRingOf(doc, anchor) : null;
    if (!standing || !standing.memberIds.includes(peer.id)) {
      mirrorAnchor$.set(fromNodeId);
    }
  }
  void openTerminal(peer, zone);
};

/**
 * Cycle the frontmost focus terminal to the next/previous ring actor.
 * Returns true when a swap was issued (callers consume the key only then).
 */
export const cycleActorMirror = (direction: 1 | -1): boolean => {
  const currentId = frontTerminalNodeId();
  if (!currentId) return false;
  const doc = state$.doc.peek();
  const ring = resolveRing(doc, currentId, mirrorAnchor$.peek());
  if (!ring) return false;
  const nextId = nextInRing(ring.memberIds, currentId, direction);
  if (!nextId) return false;
  const next = doc.nodes.find((n) => n.id === nextId);
  if (!next) return false;
  mirrorAnchor$.set(ring.anchorId);
  void openTerminal(next, "focus");
  return true;
};

/**
 * Cmd+] / Cmd+[ — capture phase so the chord never reaches the focused xterm
 * (or any other surface). The key is consumed only when a swap actually
 * happens; otherwise the event passes through untouched.
 */
export const installActorMirrorHotkeys = (): (() => void) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const direction = event.key === "]" ? 1 : event.key === "[" ? -1 : null;
    if (direction === null) return;
    if (!cycleActorMirror(direction)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // focus-law: Cmd+[ / Cmd+] command chord, never text entry.
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
  };
};
