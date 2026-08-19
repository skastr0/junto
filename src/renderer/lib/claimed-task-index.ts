/**
 * One claimed-task projection for the open canvas, rebuilt once per document
 * change and read per seat.
 *
 * Before this existed, every ClaimedTaskStrip subscribed to `state$.doc` and
 * ran its own nodes x tasks scan, so a single unrelated write (one keystroke
 * in a rename box) cost instances x nodes x tasks comparisons and re-rendered
 * every strip on the canvas. This is the incremental-view-maintenance shape
 * the region rollups and the kernel projection already use here: derive once,
 * publish per key, and leave a key untouched when its projection did not
 * change so that key's subscribers never re-render.
 *
 * Rebuild policy — `commitDoc` replaces the document identity wholesale, so
 * identity is not evidence that claims changed, and any cheaper "did claims
 * change?" fingerprint would have to walk the same nodes x tasks to compute
 * it. So the scan runs once per document change (never missing a change), and
 * the *publish* is what is gated: a key is written only when the exact facts
 * this strip renders changed. Cost per unrelated write is therefore one scan,
 * not one scan per mounted strip, and zero re-renders.
 */

import { batch, observable, observe } from "@legendapp/state";
import type { CanvasDoc } from "@shared/canvas";
import { claimedByOf, taskBrief } from "@shared/task";
import type { ActorRef } from "@shared/work-protocol";
import { isActiveClaim, type ClaimedTask } from "./claimed-task";
import { state$ } from "./state";

/**
 * Claimed task per actor **node id** — the key a strip holds. The join key
 * remains the compiled `ActorSeatId`; node identity is never claim authority.
 */
export const claimedTask$ = observable<{
  byNodeId: Record<string, ClaimedTask | undefined>;
}>({ byNodeId: {} });

/**
 * Whole-canvas claimed-task projection in one pass.
 *
 * Match order is the document order + item order that `claimedTaskForActorNode`
 * walks, and one node resolves through the first `ActorRef` carrying it, so
 * the map answers exactly what the per-node scan answered.
 */
export const buildClaimedTaskIndex = (
  doc: CanvasDoc | undefined,
  actorRefs: ReadonlyArray<ActorRef>,
): Record<string, ClaimedTask> => {
  const index: Record<string, ClaimedTask> = {};
  if (actorRefs.length === 0 || !Array.isArray(doc?.nodes)) return index;

  // First ref per node wins, mirroring the `find` the per-node scan used.
  const actorBySeatId = new Map<string, ActorRef>();
  const seenNodeIds = new Set<string>();
  for (const actor of actorRefs) {
    if (seenNodeIds.has(actor.nodeId)) continue;
    seenNodeIds.add(actor.nodeId);
    if (!actorBySeatId.has(actor.seatId)) actorBySeatId.set(actor.seatId, actor);
  }

  for (const node of doc.nodes) {
    for (const task of node.ether?.tasks?.items ?? []) {
      if (!isActiveClaim(task)) continue;
      const seatId = claimedByOf(task);
      if (seatId === undefined) continue;
      const actor = actorBySeatId.get(seatId);
      if (actor === undefined) continue;
      // First active claim wins, exactly like the per-node scan's early return.
      if (index[actor.nodeId] !== undefined) continue;
      index[actor.nodeId] = { task, sinkNodeId: node.id, actor };
    }
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
    taskBrief(previous.task) === taskBrief(next.task)
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

/** Rebuild from the live document + compiled seat projection, then publish. */
export const refreshClaimedTaskIndex = (): void => {
  publishClaimedTaskIndex(
    buildClaimedTaskIndex(
      state$.doc.peek() as CanvasDoc,
      state$.actorRefs.peek() as ReadonlyArray<ActorRef>,
    ),
  );
};

let stop: (() => void) | undefined;

/**
 * Single canvas-wide subscriber, started on import so the index exists before
 * the first strip renders and no strip has to hold a document subscription of
 * its own. Idempotent.
 */
export const startClaimedTaskIndex = (): (() => void) => {
  if (stop === undefined) {
    stop = observe(() => {
      state$.doc.get();
      state$.actorRefs.get();
      refreshClaimedTaskIndex();
    });
  }
  return stopClaimedTaskIndex;
};

/** Tear down the subscriber (tests / renderer teardown). */
export const stopClaimedTaskIndex = (): void => {
  stop?.();
  stop = undefined;
};

startClaimedTaskIndex();
