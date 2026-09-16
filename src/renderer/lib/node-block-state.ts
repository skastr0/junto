/**
 * Node shell blocked presentation.
 *
 * Two planes (do not collapse them):
 *
 * 1. **Flags** (blocker / attention / parked) — uniform document tags on any
 *    node. All three show on the rail. No special hide for blocker on boards.
 * 2. **Seat stoppage chrome** (pulse, crimson shell, spinner) — **actors only**,
 *    from graph stoppage or a manual blocker flag on a seat. Flagging a board
 *    "blocker" is a tag, not seat stoppage.
 */

import type { CanvasNode, EtherFlag } from "@shared/canvas";
import { isBlockableNode } from "@shared/execution-graph";

export type NodeBlockPresentation = {
  /** Crimson border / junto-blocker pulse / primary stoppage paint. */
  readonly isBlocker: boolean;
  /** Crimson wash + pulse (seat stoppage only). */
  readonly shellBlocked: boolean;
  /** Flags shown on the rail — same vocabulary for every node kind. */
  readonly flags: ReadonlyArray<EtherFlag>;
};

export const nodeBlockPresentation = (input: {
  readonly node: Pick<CanvasNode, "type" | "ether">;
  readonly graphBlocked: boolean;
}): NodeBlockPresentation => {
  const rawFlags = input.node.ether?.flags ?? [];
  const seat = isBlockableNode(input.node as CanvasNode);
  const flagBlocker = rawFlags.includes("blocker");
  // Seat stoppage paint: seats only.
  const isBlocker = flagBlocker && seat;
  const shellBlocked = (seat && input.graphBlocked) || isBlocker;
  return {
    isBlocker,
    shellBlocked,
    flags: rawFlags,
  };
};
