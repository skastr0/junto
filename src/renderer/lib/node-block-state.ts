/**
 * Node shell blocked presentation.
 *
 * Two planes (do not collapse them):
 *
 * 1. **Flags** (blocker / attention / parked) — uniform document tags on any
 *    node. All three show on the rail. No special hide for blocker on boards.
 * 2. **Seat stoppage chrome** (pulse, crimson shell, spinner) — **actors only**,
 *    from graph stoppage, manual blocker flag on a seat, or live herdr blocked.
 *    Flagging a board "blocker" is a tag, not seat stoppage.
 *
 * Herdr agent_status is live runtime: when the pane is blocked, the card
 * wears seat chrome without writing ether.flags.
 */

import type { CanvasNode, EtherFlag } from "@shared/canvas";
import { isBlockableNode } from "@shared/execution-graph";

export const isHerdrCanvasNode = (node: Pick<CanvasNode, "ether">): boolean =>
  node.ether?.herdr !== undefined || node.ether?.entity?.kind === "herdr";

/** Live herdr agent_status === blocked → node shell blocker chrome. */
export const liveHerdrBlocked = (
  node: Pick<CanvasNode, "ether">,
  agentStatus: string | null | undefined,
): boolean => isHerdrCanvasNode(node) && agentStatus === "blocked";

export type NodeBlockPresentation = {
  /** Crimson border / vellum-blocker pulse / primary stoppage paint. */
  readonly isBlocker: boolean;
  /** Crimson wash + pulse (seat stoppage only). */
  readonly shellBlocked: boolean;
  /** Live herdr only — not a document flag. */
  readonly liveHerdrBlocked: boolean;
  /** Flags shown on the rail — same vocabulary for every node kind. */
  readonly flags: ReadonlyArray<EtherFlag>;
};

export const nodeBlockPresentation = (input: {
  readonly node: Pick<CanvasNode, "type" | "ether">;
  readonly graphBlocked: boolean;
  readonly herdrAgentStatus?: string | null;
}): NodeBlockPresentation => {
  const rawFlags = input.node.ether?.flags ?? [];
  const seat = isBlockableNode(input.node as CanvasNode);
  const flagBlocker = rawFlags.includes("blocker");
  const live = liveHerdrBlocked(input.node, input.herdrAgentStatus);
  // Seat stoppage paint: seats only (+ live herdr).
  const flagDrivesSeatChrome = flagBlocker && seat;
  const isBlocker = flagDrivesSeatChrome || live;
  const shellBlocked = (seat && input.graphBlocked) || isBlocker;
  return {
    isBlocker,
    shellBlocked,
    liveHerdrBlocked: live,
    flags: rawFlags,
  };
};
