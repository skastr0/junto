/**
 * Derived task ownership — who a comment on a task should reach.
 *
 * Ownership is NEVER stored: it is computed from the live station row and the
 * station's admission. The row's `claimedBy` names the working seat; an
 * operator-owned station makes the operator the standing mind; terminal or
 * unclaimed work has no owner, so a comment appends without notifying anyone.
 */

import type { Task, TasksSinkContract } from "./work-model";
import { resolveSinkAdmission } from "./work-model";
import { isTerminalTaskState } from "./task";
import type { ActorRef } from "./work-protocol";

export type TaskOwner =
  | { readonly kind: "seat"; readonly seatId: string }
  | { readonly kind: "operator" }
  | { readonly kind: "none" };

/**
 * Owner of the task's live station row.
 *
 * - terminal states (completed, canceled, failed, rejected, archived): no
 *   owner — finished work notifies nobody, even when `claimedBy` remains on
 *   the row as the passage record;
 * - operator-owned station: the operator, always — no seat ever claims there;
 * - a claimed live row: the claiming seat;
 * - anything else (unclaimed inbound, held, awaiting promotion): no owner.
 */
export const currentTaskOwner = (
  task: Task,
  contract: TasksSinkContract | undefined,
): TaskOwner => {
  if (isTerminalTaskState(task.state)) return { kind: "none" };
  if (resolveSinkAdmission(contract) === "operator-owned") {
    return { kind: "operator" };
  }
  if (task.claimedBy !== undefined) {
    return { kind: "seat", seatId: task.claimedBy };
  }
  return { kind: "none" };
};

/**
 * Routing decision for a task-scoped comment: which LIVE seat, if any, gets a
 * mailbox copy. Undefined means append-only, no notification — no owner, the
 * owner is the operator, the sender commenting on their own task, or the
 * owning seat is not live on this canvas (actorRefs are the live process-bound
 * seats; a dead seat has no terminal to notify).
 */
export const taskCommentRecipient = (
  task: Task,
  contract: TasksSinkContract | undefined,
  sender: { readonly seatId: string },
  actorRefs: ReadonlyArray<ActorRef>,
  canvasName: string,
): ActorRef | undefined => {
  const owner = currentTaskOwner(task, contract);
  if (owner.kind !== "seat") return undefined;
  if (owner.seatId === sender.seatId) return undefined;
  return actorRefs.find(
    (ref) => ref.seatId === owner.seatId && ref.canvasName === canvasName,
  );
};
