/**
 * Seat-block plane for escalate / Blocked CLI enforcement.
 *
 * App-local (like pause arming): not stored on the canvas document.
 * Escalate marks the calling seat blocked after filing a request; work ops
 * refuse with type Blocked + stop_directive until the request leaves
 * input-required (operator resolve) or clearSeatBlocked runs.
 *
 * TODO: optional bounded hold — block the socket until the human answers and
 * return the answer in-band (bound below harness bash timeout). Ship
 * fire-and-block first.
 */
import type { CanvasDoc } from "@shared/canvas";
import type { WorkBlockedSeat } from "@shared/execution-graph";
import {
  makeStopDirective,
  type StopDirective,
} from "@shared/work-control";
import { isTerminalTaskState } from "@shared/task";

export type SeatBlock = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly requestId: string;
  readonly target: string;
  readonly brief: string;
  readonly blockedAt: number;
};

const seatKey = (canvasName: string, nodeId: string): string =>
  `${canvasName}\0${nodeId}`;

/** Process-local: one map per main process. */
const blocks = new Map<string, SeatBlock>();
const listeners = new Set<(canvasName: string) => void>();

const publish = (canvasName: string): void => {
  for (const listener of listeners) {
    try {
      listener(canvasName);
    } catch {
      // Projection observers never participate in enforcement.
    }
  }
};

export const subscribeSeatBlocks = (
  listener: (canvasName: string) => void,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const markSeatBlocked = (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly requestId: string;
  readonly target: string;
  readonly brief: string;
}): SeatBlock => {
  const block: SeatBlock = {
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    requestId: input.requestId,
    target: input.target,
    brief: input.brief,
    blockedAt: Date.now(),
  };
  blocks.set(seatKey(input.canvasName, input.nodeId), block);
  publish(input.canvasName);
  return block;
};

export const clearSeatBlocked = (canvasName: string, nodeId: string): boolean => {
  const cleared = blocks.delete(seatKey(canvasName, nodeId));
  if (cleared) publish(canvasName);
  return cleared;
};

/** Clear any seat blocked on this request (resolve path). */
export const clearSeatBlockedByRequest = (
  canvasName: string,
  requestId: string,
): boolean => {
  let cleared = false;
  for (const [key, block] of blocks) {
    if (block.canvasName === canvasName && block.requestId === requestId) {
      blocks.delete(key);
      cleared = true;
    }
  }
  if (cleared) publish(canvasName);
  return cleared;
};

export const getSeatBlock = (
  canvasName: string,
  nodeId: string,
): SeatBlock | undefined => blocks.get(seatKey(canvasName, nodeId));

/** Test/harness: drop all blocks. */
export const resetSeatBlocks = (): void => {
  const canvases = new Set(Array.from(blocks.values(), (block) => block.canvasName));
  blocks.clear();
  for (const canvasName of canvases) publish(canvasName);
};

/**
 * True when the request still holds the seat (input-required; residual auth-required).
 * Missing target or missing request → treat as still blocked (fail closed)
 * only if we cannot prove resolution; if request is terminal, clear.
 */
export const requestStillBlocking = (
  doc: CanvasDoc,
  block: SeatBlock,
): boolean => {
  const node = doc.nodes.find((n) => n.id === block.target);
  if (!node) return true;
  const items = node.ether?.requests?.items ?? [];
  const task = items.find((t) => t.id === block.requestId);
  if (!task) {
    // Request removed from the board — treat as resolved.
    return false;
  }
  if (isTerminalTaskState(task.state)) return false;
  // Still open attention (or intermediate) — keep the CLI block.
  return task.state === "input-required" || task.state === "auth-required";
};

/**
 * Live block for a seat, auto-clearing when the request no longer blocks.
 * Pure against doc; mutates the map only on auto-clear.
 */
export const liveSeatBlock = (
  canvasName: string,
  nodeId: string,
  doc: CanvasDoc,
): SeatBlock | undefined => {
  const block = getSeatBlock(canvasName, nodeId);
  if (!block) return undefined;
  if (!requestStillBlocking(doc, block)) {
    clearSeatBlocked(canvasName, nodeId);
    return undefined;
  }
  return block;
};

/** Active work stoppage projection for execution graph / region rollups. */
export const liveSeatBlocksForCanvas = (
  canvasName: string,
  doc: CanvasDoc,
): ReadonlyMap<string, WorkBlockedSeat> => {
  const live = new Map<string, WorkBlockedSeat>();
  for (const block of [...blocks.values()]) {
    if (block.canvasName !== canvasName) continue;
    if (!requestStillBlocking(doc, block)) {
      clearSeatBlocked(canvasName, block.nodeId);
      continue;
    }
    live.set(block.nodeId, {
      requestId: block.requestId,
      targetNodeId: block.target,
      detail: block.brief,
    });
  }
  return live;
};

export const stopDirectiveFromBlock = (block: SeatBlock): StopDirective =>
  makeStopDirective({
    requestId: block.requestId,
    target: block.target,
    brief: block.brief,
  });
