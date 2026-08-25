import { Schema } from "effect";
import type { Task, TaskProposal, CanvasDoc, CanvasNode } from "./canvas";
import type { TasksSinkContract } from "./work-model";
import { claimedByOf, isTerminalTaskState } from "./task";
import { taskAdmissionState } from "./claims";
import { isBlockableNode, type ExecutionGraph } from "./execution-graph";
import { resolveSpec, roleOf } from "./physics/kinds";
import {
  ActorRef,
  type ActorRef as ActorRefValue,
  type SinkRef,
} from "./work-protocol";

/**
 * Fire / ice attention language — glance layer over the factory board.
 *
 * - fire: needs human / input-required / residual auth-required / blocked actor with cause
 * - ice: calm capacity (actor free, no open attention on edged work)
 * - idle: present but nothing to do
 * - empty: no occupancy / no items (sink empty)
 *
 * Pure document + graph. Never invents stoppage (phase stays in execution-graph).
 */

export type AttentionSignal = "fire" | "ice" | "idle" | "empty";

const needsHuman = (item: Task): boolean =>
  item.state === "input-required" || item.state === "auth-required";

/** In flight = actively being worked. Queue inventory and human waits are not flight. */
const inFlight = (item: Task): boolean => item.state === "working";

const roleOfNode = (node: CanvasNode) =>
  roleOf(
    resolveSpec({
      isGroup: node.type === "group",
      kind: node.ether?.entity?.kind,
    }),
  );

const isQueuedSubmitted = (
  item: Task,
  contract: TasksSinkContract | undefined,
  nowMs: number,
): boolean => {
  if (item.state !== "submitted") return false;
  const admission = taskAdmissionState(item, contract, nowMs);
  return admission === "claimable" || admission === "held";
};

const isUnadmittedSubmitted = (
  item: Task,
  contract: TasksSinkContract | undefined,
  nowMs: number,
): boolean => {
  if (item.state !== "submitted") return false;
  return taskAdmissionState(item, contract, nowMs) === "operator-gated";
};

/** Sink-card glance counts (tasks / requests): queued / in flight / needs input. */
export const sinkGlance = (
  items: ReadonlyArray<Task>,
  contract?: TasksSinkContract,
  nowMs: number = Date.now(),
): {
  readonly queued: number;
  readonly inFlight: number;
  readonly needsInput: number;
  readonly total: number;
} => {
  let queued = 0;
  let inFlightCount = 0;
  let needsInput = 0;
  for (const item of items) {
    if (isQueuedSubmitted(item, contract, nowMs)) queued += 1;
    if (inFlight(item)) inFlightCount += 1;
    if (needsHuman(item)) needsInput += 1;
  }
  return { queued, inFlight: inFlightCount, needsInput, total: items.length };
};

/**
 * Compact TaskScan counters. Unadmitted submitted tasks (and leftover
 * pending proposals not yet backfilled) are planning inventory.
 */
export const taskScanCounts = (
  items: ReadonlyArray<Task>,
  proposals: ReadonlyArray<Pick<TaskProposal, "id" | "state">> = [],
  contract?: TasksSinkContract,
  nowMs: number = Date.now(),
): {
  readonly proposals: number;
  readonly completed: number;
} => {
  const itemIds = new Set(items.map((item) => item.id));
  const unadmitted = items.filter((item) =>
    isUnadmittedSubmitted(item, contract, nowMs),
  ).length;
  const leftover = proposals.filter(
    (proposal) => proposal.state === "pending" && !itemIds.has(proposal.id),
  ).length;
  return {
    proposals: unadmitted + leftover,
    completed: items.filter((item) => item.state === "completed").length,
  };
};

/**
 * Per-node attention signal for chrome (`data-attention`).
 * Actors: fire when phase-blocked, ice when free with no human queue, idle otherwise.
 * Task sinks: fire when any item needs human; ice when empty or all terminal; idle when queue open but calm.
 */
export const attentionOf = (
  node: CanvasNode,
  graph: ExecutionGraph | undefined,
): AttentionSignal => {
  const role = roleOfNode(node);
  const kind = node.ether?.entity?.kind;

  if (kind === "task") {
    const items = node.ether?.tasks?.items ?? [];
    if (items.length === 0) return "empty";
    if (items.some(needsHuman)) return "fire";
    if (items.every((t) => isTerminalTaskState(t.state))) return "ice";
    return "idle";
  }

  if (kind === "requests") {
    const items = node.ether?.requests?.items ?? [];
    if (items.length === 0) return "empty";
    if (items.some(needsHuman)) return "fire";
    return "ice";
  }

  if (kind === "artifacts") {
    const items = node.ether?.artifacts?.items ?? [];
    return items.length === 0 ? "empty" : "idle";
  }

  if (role === "actor" || isBlockableNode(node)) {
    if (graph?.blocked.has(node.id)) return "fire";
    if (node.ether?.flags?.includes("blocker")) return "fire";
    if (node.ether?.flags?.includes("attention")) return "fire";
    if (node.ether?.flags?.includes("parked")) return "idle";
    return "ice";
  }

  // Non-seats: attention flag only (never blocker fire — stoppage is seat-only).
  if (node.ether?.flags?.includes("attention")) return "fire";
  if (node.ether?.flags?.includes("parked")) return "idle";

  return "idle";
};

/**
 * Compiler-owned actor lookup.
 *
 * The resolver returns an ActorRef only when the canvas reference identifies
 * exactly one compiled executable seat. It returns undefined for unresolved
 * or ambiguous references.
 */
export type ActorRefResolver = (ref: SinkRef) => ActorRefValue | undefined;

/**
 * Resolve one exact canvas-scoped actor reference.
 *
 * A malformed result or a resolver result for another reference fails closed.
 * There is deliberately no node-id claimant fallback.
 */
export const resolveCompiledActorRef = (
  resolver: ActorRefResolver,
  canvasName: string,
  node: CanvasNode | undefined,
): ActorRefValue | undefined => {
  if (node === undefined || roleOfNode(node) !== "actor") return undefined;
  const actor = resolver({ canvasName, nodeId: node.id });
  if (
    actor === undefined ||
    !Schema.is(ActorRef)(actor) ||
    actor.canvasName !== canvasName ||
    actor.nodeId !== node.id
  ) {
    return undefined;
  }
  return actor;
};

export { claimedByOf, needsHuman, inFlight };
