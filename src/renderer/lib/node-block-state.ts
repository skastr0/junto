/**
 * Node shell blocked presentation.
 *
 * Factory law: only **actor** seats join the stoppage set. Schedulers/sinks/
 * geography never wear seat-stoppage chrome (pulse, spinner, crimson shell)
 * and never show a **blocker** flag rail chip — stoppage is seat-only.
 * A stray flag:blocker on a non-seat is ignored for chrome (clear via toolbar
 * if the flag still exists in the document).
 *
 * Herdr agent_status is live runtime: when the pane is blocked, the card
 * wears the same chrome as a blocked seat without writing ether.flags.
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
  /** Crimson border / vellum-blocker pulse / flag-rail primary stoppage. */
  readonly isBlocker: boolean;
  /** Crimson wash + pulse + corner spinner (seat stoppage only). */
  readonly shellBlocked: boolean;
  /** Live herdr only — not a document flag. */
  readonly liveHerdrBlocked: boolean;
  /**
   * Flags shown on the rail. Non-seats never surface `blocker` here —
   * that chip is seat stoppage language only.
   */
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
  // Flag drives seat chrome only on blockable actors.
  const flagDrivesSeatChrome = flagBlocker && seat;
  const isBlocker = flagDrivesSeatChrome || live;
  // Graph blocked set is seats-only by factory law; never dress non-seats.
  const shellBlocked = (seat && input.graphBlocked) || isBlocker;
  const flags = seat
    ? rawFlags
    : rawFlags.filter((flag) => flag !== "blocker");
  return {
    isBlocker,
    shellBlocked,
    liveHerdrBlocked: live,
    flags,
  };
};
