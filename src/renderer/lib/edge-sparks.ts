/**
 * Edge sparks — one-shot visual packets that travel an edge when work-plane
 * activity lands between connected nodes (claim, message, request, artifact,
 * board) or when a new edge is authored. Pure planner + short-lived Legend
 * store; EtherEdge paints the flare.
 *
 * Direction is always the document edge: fromNode → toNode (source → target).
 * Fan-out is pairwise only — never every incident edge of a multi-linked actor
 * (that produced the "sparks storm" when agent↔agent links enabled msg.send).
 */
import { observable } from "@legendapp/state";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import type { ActorRef } from "@shared/work-protocol";
import type { Message, Task } from "@shared/work-model";
import { claimedByOf } from "@shared/task";

export type EdgeSpark = {
  readonly token: number;
  /** Flow travels from this endpoint toward the other (edge source). */
  readonly fromNodeId: string;
};

export type EdgeSparkPlan = {
  readonly edgeId: string;
  readonly fromNodeId: string;
};

/** edgeId → active spark (token changes re-trigger the animation). */
export const edgeSparks$ = observable<Record<string, EdgeSpark>>({});

const SPARK_TTL_MS = 920;
const SPARK_EDGE_CAP = 24;

let tokenSeq = 0;
/** Browser timer handle (DOM `number`; avoid NodeJS.Timeout vs number clash). */
const clearTimers = new Map<string, number>();

/** Compact work-lane fingerprint — geometry/freeform fields never participate. */
export function workLaneFingerprint(node: CanvasNode): string | undefined {
  const e = node.ether;
  if (!e) return undefined;
  const tasks = e.tasks?.items;
  const proposals = e.tasks?.proposals;
  const requests = e.requests?.items;
  const artifacts = e.artifacts?.items;
  const messages = e.messages?.items;
  const board = e.board?.topics;
  if (
    tasks === undefined &&
    proposals === undefined &&
    requests === undefined &&
    artifacts === undefined &&
    messages === undefined &&
    board === undefined
  ) {
    return undefined;
  }
  return JSON.stringify({
    t: tasks?.map((item) => `${item.id}:${item.state}:${claimedByOf(item) ?? ""}`),
    p: proposals?.map((item) => `${item.id}:${item.state}`),
    r: requests?.map((item) => `${item.id}:${item.state}:${claimedByOf(item) ?? ""}`),
    a: artifacts?.map((item) => item.artifactId),
    m: messages?.map(
      (item) =>
        `${item.messageId}:${item.role}:${String(item.metadata?.deliveredAt ?? "")}`,
    ),
    b: board?.map(
      (topic) => `${topic.topicId}:${topic.postCount}:${topic.lastActivityAt}`,
    ),
  });
}

const seatNodeMap = (
  actorRefs: ReadonlyArray<ActorRef>,
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const actor of actorRefs) {
    map.set(actor.seatId, actor.nodeId);
  }
  return map;
};

const edgesBetween = (
  edges: ReadonlyArray<CanvasEdge>,
  a: string,
  b: string,
): CanvasEdge[] =>
  edges.filter(
    (edge) =>
      (edge.fromNode === a && edge.toNode === b) ||
      (edge.fromNode === b && edge.toNode === a),
  );

const taskDeltaSeats = (
  next: ReadonlyArray<Task> | undefined,
  prev: ReadonlyArray<Task> | undefined,
): string[] => {
  const prevById = new Map((prev ?? []).map((task) => [task.id, task] as const));
  const seats: string[] = [];
  for (const task of next ?? []) {
    const before = prevById.get(task.id);
    if (
      before &&
      before.state === task.state &&
      claimedByOf(before) === claimedByOf(task)
    ) {
      continue;
    }
    const seat = claimedByOf(task);
    if (seat) seats.push(seat);
  }
  // New claims only on next — also catch brand-new task rows.
  for (const task of next ?? []) {
    if (!prevById.has(task.id)) {
      const seat = claimedByOf(task);
      if (seat) seats.push(seat);
    }
  }
  return seats;
};

/** peerId / fromSeat / fromNode on newly arrived messages → counterparty node ids. */
const messageDeltaPeers = (
  next: ReadonlyArray<Message> | undefined,
  prev: ReadonlyArray<Message> | undefined,
  seats: Map<string, string>,
): string[] => {
  const prevIds = new Set((prev ?? []).map((m) => m.messageId));
  const peers: string[] = [];
  for (const msg of next ?? []) {
    if (prevIds.has(msg.messageId)) continue;
    const meta = msg.metadata;
    if (!meta) continue;
    const peerId = meta.peerId;
    if (typeof peerId === "string" && peerId.length > 0) {
      peers.push(peerId);
      continue;
    }
    const fromNode = meta.fromNode;
    if (typeof fromNode === "string" && fromNode.length > 0) {
      peers.push(fromNode);
      continue;
    }
    const fromSeat = meta.fromSeat;
    if (typeof fromSeat === "string" && fromSeat.length > 0) {
      const nodeId = seats.get(fromSeat);
      if (nodeId) peers.push(nodeId);
    }
  }
  return peers;
};

/**
 * Pure: map a prev→next work-lane / topology delta to edge spark plans.
 * Skips brand-new nodes (bulk load / canvas switch) and caps fan-out.
 * Never lights every incident edge of a node — only the edge that was created
 * or the edge between the two parties of the work act.
 */
export function planWorkEdgeSparks(
  prev: CanvasDoc,
  next: CanvasDoc,
  actorRefs: ReadonlyArray<ActorRef>,
): ReadonlyArray<EdgeSparkPlan> {
  if (prev.nodes.length === 0 || next.edges.length === 0) return [];

  const prevById = new Map(prev.nodes.map((node) => [node.id, node] as const));
  const prevEdgeIds = new Set(prev.edges.map((edge) => edge.id));
  const seats = seatNodeMap(actorRefs);
  const plans: EdgeSparkPlan[] = [];
  const seen = new Set<string>();

  /** Always travel document source → target. */
  const push = (edge: CanvasEdge): void => {
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    plans.push({ edgeId: edge.id, fromNodeId: edge.fromNode });
  };

  // 1. Newly authored edges — spark only those, source → target.
  for (const edge of next.edges) {
    if (!prevEdgeIds.has(edge.id)) push(edge);
  }

  // 2. Work-lane changed nodes (existing nodes only).
  const changed = new Set<string>();
  for (const node of next.nodes) {
    const before = prevById.get(node.id);
    if (!before) continue;
    const prevFp = workLaneFingerprint(before);
    const nextFp = workLaneFingerprint(node);
    if (prevFp === nextFp) continue;
    if (prevFp === undefined && nextFp === undefined) continue;
    changed.add(node.id);
  }

  // 3. Pairwise work: seat claims, message peer metadata, co-changed ends.
  for (const node of next.nodes) {
    if (!changed.has(node.id)) continue;
    const before = prevById.get(node.id);
    if (!before) continue;

    const counterparties = new Set<string>();
    for (const seat of taskDeltaSeats(
      node.ether?.tasks?.items,
      before.ether?.tasks?.items,
    )) {
      const actorNode = seats.get(seat);
      if (actorNode && actorNode !== node.id) counterparties.add(actorNode);
    }
    for (const seat of taskDeltaSeats(
      node.ether?.requests?.items,
      before.ether?.requests?.items,
    )) {
      const actorNode = seats.get(seat);
      if (actorNode && actorNode !== node.id) counterparties.add(actorNode);
    }
    for (const peer of messageDeltaPeers(
      node.ether?.messages?.items,
      before.ether?.messages?.items,
      seats,
    )) {
      if (peer !== node.id) counterparties.add(peer);
    }

    for (const peer of counterparties) {
      for (const edge of edgesBetween(next.edges, node.id, peer)) {
        push(edge);
      }
    }
  }

  // 4. Co-changed endpoints (both sides of the edge moved work lanes together).
  for (const edge of next.edges) {
    if (changed.has(edge.fromNode) && changed.has(edge.toNode)) {
      push(edge);
    }
  }

  return plans.slice(0, SPARK_EDGE_CAP);
}

/** Arm edge animations; re-entrant tokens re-fire the same edge. */
export function emitEdgeSparks(plans: ReadonlyArray<EdgeSparkPlan>): void {
  if (plans.length === 0) return;
  for (const plan of plans) {
    const token = ++tokenSeq;
    edgeSparks$[plan.edgeId].set({
      token,
      fromNodeId: plan.fromNodeId,
    });
    const prior = clearTimers.get(plan.edgeId);
    if (prior !== undefined) clearTimeout(prior);
    if (typeof window === "undefined") continue;
    const handle = window.setTimeout(() => {
      clearTimers.delete(plan.edgeId);
      const current = edgeSparks$[plan.edgeId].peek();
      if (current?.token === token) {
        edgeSparks$[plan.edgeId].delete();
      }
    }, SPARK_TTL_MS);
    clearTimers.set(plan.edgeId, handle);
  }
}

/** Diff two docs and emit sparks (no-op when nothing work-related moved). */
export function noteWorkDocChange(
  prev: CanvasDoc,
  next: CanvasDoc,
  actorRefs: ReadonlyArray<ActorRef>,
): void {
  emitEdgeSparks(planWorkEdgeSparks(prev, next, actorRefs));
}

/** Immediate spark on freeform edge create (before work notices land). */
export function noteEdgeCreated(edge: CanvasEdge): void {
  emitEdgeSparks([{ edgeId: edge.id, fromNodeId: edge.fromNode }]);
}
