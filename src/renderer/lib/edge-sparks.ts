/**
 * Edge sparks — one-shot visual packets that travel an edge when work-plane
 * activity lands between connected nodes (claim, message, request, artifact,
 * board). Pure planner + short-lived Legend store; EtherEdge paints the flare.
 */
import { observable } from "@legendapp/state";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import type { ActorRef } from "@shared/work-protocol";
import type { Task } from "@shared/work-model";
import { claimedByOf } from "@shared/task";

export type EdgeSpark = {
  readonly token: number;
  /** Flow travels from this endpoint toward the other. */
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

const incidentEdges = (
  edges: ReadonlyArray<CanvasEdge>,
  nodeId: string,
): CanvasEdge[] =>
  edges.filter((edge) => edge.fromNode === nodeId || edge.toNode === nodeId);

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

/**
 * Pure: map a prev→next work-lane delta to edge spark plans.
 * Skips brand-new nodes (bulk load / canvas switch) and caps fan-out.
 */
export function planWorkEdgeSparks(
  prev: CanvasDoc,
  next: CanvasDoc,
  actorRefs: ReadonlyArray<ActorRef>,
): ReadonlyArray<EdgeSparkPlan> {
  if (prev.nodes.length === 0 || next.edges.length === 0) return [];

  const prevById = new Map(prev.nodes.map((node) => [node.id, node] as const));
  const seats = seatNodeMap(actorRefs);
  const plans: EdgeSparkPlan[] = [];
  const seen = new Set<string>();

  const push = (edge: CanvasEdge, fromNodeId: string): void => {
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    plans.push({ edgeId: edge.id, fromNodeId });
  };

  for (const node of next.nodes) {
    const before = prevById.get(node.id);
    if (!before) continue;

    const prevFp = workLaneFingerprint(before);
    const nextFp = workLaneFingerprint(node);
    if (prevFp === nextFp) continue;
    // Pure geometry/freeform node with no work lanes either side.
    if (prevFp === undefined && nextFp === undefined) continue;

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

    if (counterparties.size > 0) {
      for (const peer of counterparties) {
        for (const edge of edgesBetween(next.edges, node.id, peer)) {
          // Claim / request traffic rides actor → sink.
          push(edge, peer);
        }
      }
      continue;
    }

    // Messages, artifacts, board, unclaimed task create — light every
    // non-group incident edge from the changed node outward.
    for (const edge of incidentEdges(next.edges, node.id)) {
      push(edge, node.id);
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
