import { Schema } from "effect";
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
 * Compiled actor identity. Never invents stoppage (phase stays in execution-graph).
 */

export type AttentionSignal = "fire" | "ice" | "idle" | "empty";

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
