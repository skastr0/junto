import { batch, observable, observe } from "@legendapp/state";
import type { WorkLaneRow } from "@shared/work-sinks";
import { workAttentionStore } from "./use-work-sink";
import { claimedByOf } from "@shared/task";
import type { ActorRef } from "@shared/work-protocol";
import { claimedTaskBrief, isActiveClaim, type ClaimedTask } from "./claimed-task";
import { state$ } from "./state";

/**
 * Claimed task per actor **node id** — the key a strip holds. The join key
 * remains the compiled `ActorSeatId`; node identity is never claim authority.
 */
export const claimedTask$ = observable<{
  byNodeId: Record<string, ClaimedTask | undefined>;
}>({ byNodeId: {} });

/** Join compact claim rows by compiled seat identity. First active claim wins. */
export const buildClaimedTaskIndex = (
  rows: ReadonlyArray<WorkLaneRow>,
  actorRefs: ReadonlyArray<ActorRef>,
): Record<string, ClaimedTask> => {
  const index: Record<string, ClaimedTask> = {};
  if (actorRefs.length === 0) return index;

  // First ref per node wins, mirroring the `find` the per-node scan used.
  const actorBySeatId = new Map<string, ActorRef>();
  const seenNodeIds = new Set<string>();
  for (const actor of actorRefs) {
    if (seenNodeIds.has(actor.nodeId)) continue;
    seenNodeIds.add(actor.nodeId);
    if (!actorBySeatId.has(actor.seatId)) actorBySeatId.set(actor.seatId, actor);
  }

  for (const { nodeId: sinkNodeId, item: task } of rows) {
    if (!isActiveClaim(task)) continue;
    const seatId = claimedByOf(task);
    if (seatId === undefined) continue;
    const actor = actorBySeatId.get(seatId);
    if (actor === undefined || index[actor.nodeId] !== undefined) continue;
    index[actor.nodeId] = { task, sinkNodeId, actor };
  }
  return index;
};

/**
 * Equal for what a strip paints: the dot's state hue and the brief, plus the
 * sink and seat the claim was resolved through. Nothing else reaches the DOM,
 * so a key that compares equal here cannot be serving a stale render.
 */
const samePaintedClaim = (
  previous: ClaimedTask | undefined,
  next: ClaimedTask | undefined,
): boolean => {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  if (
    previous.sinkNodeId !== next.sinkNodeId ||
    previous.actor.seatId !== next.actor.seatId
  ) {
    return false;
  }
  if (previous.task === next.task) return true;
  return (
    previous.task.id === next.task.id &&
    previous.task.state === next.task.state &&
    claimedTaskBrief(previous.task) === claimedTaskBrief(next.task)
  );
};

/** Write only the keys whose painted projection actually moved. */
export const publishClaimedTaskIndex = (
  next: Record<string, ClaimedTask>,
): void => {
  const previous = claimedTask$.byNodeId.peek() as Record<
    string,
    ClaimedTask | undefined
  >;
  batch(() => {
    for (const nodeId of Object.keys(next)) {
      const claim = next[nodeId];
      if (claim === undefined) continue;
      if (samePaintedClaim(previous[nodeId], claim)) continue;
      claimedTask$.byNodeId[nodeId].set(claim);
    }
    for (const nodeId of Object.keys(previous)) {
      if (next[nodeId] !== undefined) continue;
      if (previous[nodeId] === undefined) continue;
      claimedTask$.byNodeId[nodeId].delete();
    }
  });
};

/** Compact claim rows and actor identities change independently of geometry. */
export const refreshClaimedTaskIndex = (): void => {
  const canvasName = state$.canvasName.peek();
  const items = workAttentionStore.state(canvasName).claimItemsByNodeId.peek();
  publishClaimedTaskIndex(buildClaimedTaskIndex(
    Object.entries(items).flatMap(([nodeId, tasks]) => (tasks ?? []).map((item) => ({ nodeId, item }))),
    state$.actorRefs.peek() as ReadonlyArray<ActorRef>,
  ));
};

let stop: (() => void) | undefined;
let releaseCanvas: (() => void) | undefined;

export const startClaimedTaskIndex = (): (() => void) => {
  if (stop === undefined) {
    let retainedCanvas = "";
    stop = observe(() => {
      const canvasName = state$.canvasName.get();
      if (canvasName !== retainedCanvas) {
        releaseCanvas?.();
        retainedCanvas = canvasName;
        releaseCanvas = canvasName ? workAttentionStore.retain(canvasName) : undefined;
      }
      workAttentionStore.state(canvasName).claimItemsByNodeId.get();
      state$.actorRefs.get();
      refreshClaimedTaskIndex();
    });
  }
  return stopClaimedTaskIndex;
};

export const stopClaimedTaskIndex = (): void => {
  stop?.(); stop = undefined;
  releaseCanvas?.(); releaseCanvas = undefined;
};

startClaimedTaskIndex();
