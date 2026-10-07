import type { WorkLaneRow } from "@shared/work-sinks";
import type { Task } from "@shared/work-model";
import type { ActorRef } from "@shared/work-protocol";
import { taskBrief, claimedByOf } from "@shared/task";

export type ClaimedTask = {
  readonly task: Task;
  readonly sinkNodeId: string;
  readonly actor: ActorRef;
};

/** A claim the operator is meant to see on the seat right now. */
export const isActiveClaim = (task: Task): boolean =>
  task.state === "working" ||
  task.state === "input-required" ||
  task.state === "auth-required";

/**
 * Resolve the one active task held by an actor node from the compiled seat
 * projection. Node identity alone is never claim authority.
 */
export const claimedTaskForActorNode = (
  rows: ReadonlyArray<WorkLaneRow>,
  actorRefs: ReadonlyArray<ActorRef>,
  nodeId: string,
): ClaimedTask | undefined => {
  const actor = actorRefs.find((candidate) => candidate.nodeId === nodeId);
  if (actor === undefined) return undefined;

  for (const { nodeId: sinkNodeId, item: task } of rows) {
    if (isActiveClaim(task) && claimedByOf(task) === actor.seatId) {
      return { task, sinkNodeId, actor };
    }
  }
  return undefined;
};


/** Attention rows carry a first-line title without fetching the full thread. */
export const claimedTaskBrief = (task: Task): string =>
  typeof task.metadata?.title === "string" ? task.metadata.title : taskBrief(task);
