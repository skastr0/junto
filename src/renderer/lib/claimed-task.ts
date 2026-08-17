import type { CanvasDoc } from "@shared/canvas";
import type { Task } from "@shared/work-model";
import type { ActorRef } from "@shared/work-protocol";
import { claimedByOf } from "@shared/task";

export type ClaimedTask = {
  readonly task: Task;
  readonly sinkNodeId: string;
  readonly actor: ActorRef;
};

const isActiveClaim = (task: Task): boolean =>
  task.state === "working" ||
  task.state === "input-required" ||
  task.state === "auth-required";

/**
 * Resolve the one active task held by an actor node from the compiled seat
 * projection. Node identity alone is never claim authority.
 */
export const claimedTaskForActorNode = (
  doc: CanvasDoc,
  actorRefs: ReadonlyArray<ActorRef>,
  nodeId: string,
): ClaimedTask | undefined => {
  const actor = actorRefs.find((candidate) => candidate.nodeId === nodeId);
  if (actor === undefined) return undefined;
  if (!Array.isArray(doc?.nodes)) return undefined;

  for (const node of doc.nodes) {
    for (const task of node.ether?.tasks?.items ?? []) {
      if (isActiveClaim(task) && claimedByOf(task) === actor.seatId) {
        return { task, sinkNodeId: node.id, actor };
      }
    }
  }
  return undefined;
};
