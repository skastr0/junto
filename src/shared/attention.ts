import { Schema } from "effect";
import type { Task } from "./work-model";
import type { TasksContract } from "./work-model";
import { claimedByOf, isAttentionTaskState } from "./task";
import { taskAdmissionState } from "./rules";
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
 * Pure work counters and compiled actor identity. Never invents stoppage (phase stays in execution-graph).
 */

export type AttentionSignal = "fire" | "ice" | "idle" | "empty";

const needsHuman = (item: Task): boolean => isAttentionTaskState(item.state);

/** In flight = actively being worked. Queue inventory and human waits are not flight. */
const inFlight = (item: Task): boolean => item.state === "working";

const isQueuedSubmitted = (
  item: Task,
  contract: TasksContract | undefined,
  nowMs: number,
): boolean => {
  if (item.state !== "submitted") return false;
  const admission = taskAdmissionState(item, contract, nowMs);
  return admission === "claimable" || admission === "waiting";
};

const isUnadmittedSubmitted = (
  item: Task,
  contract: TasksContract | undefined,
  nowMs: number,
): boolean => {
  if (item.state !== "submitted") return false;
  return taskAdmissionState(item, contract, nowMs) === "approval";
};

/** Sink-card glance counts (tasks / requests): queued / in flight / needs input. */
export const sinkGlance = (
  items: ReadonlyArray<Task>,
  contract?: TasksContract,
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
 * Compact TaskScan counters. Tasks awaiting approval are approval inventory.
 */
export const taskScanCounts = (
  items: ReadonlyArray<Task>,
  contract?: TasksContract,
  nowMs: number = Date.now(),
): {
  readonly approval: number;
  readonly completed: number;
} => {
  const unadmitted = items.filter((item) =>
    isUnadmittedSubmitted(item, contract, nowMs),
  ).length;
  return {
    approval: unadmitted,
    completed: items.filter((item) => item.state === "completed").length,
  };
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
 * The same resolution for a caller that holds the seat's id and already knows
 * the node is a seat.
 */
export const resolveActorRefAt = (
  resolver: ActorRefResolver,
  canvasName: string,
  nodeId: string,
): ActorRefValue | undefined => {
  const actor = resolver({ canvasName, nodeId });
  if (
    actor === undefined ||
    !Schema.is(ActorRef)(actor) ||
    actor.canvasName !== canvasName ||
    actor.nodeId !== nodeId
  ) {
    return undefined;
  }
  return actor;
};

export { claimedByOf, needsHuman, inFlight };
