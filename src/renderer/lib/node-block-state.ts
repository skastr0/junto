/**
 * Node shell blocked presentation.
 *
 * Factory law: only **actor** seats join the stoppage set. Schedulers/sinks/
 * geography never wear seat-stoppage chrome (pulse + corner spinner) even if
 * someone put flag:blocker on the card — that flag still appears on the rail
 * so it can be cleared, but the shell does not pretend the node is a blocked
 * seat.
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
  /** Document flags only (rail + toolbar toggle). */
  readonly flags: ReadonlyArray<EtherFlag>;
};

export const nodeBlockPresentation = (input: {
  readonly node: Pick<CanvasNode, "type" | "ether">;
  readonly graphBlocked: boolean;
  readonly herdrAgentStatus?: string | null;
}): NodeBlockPresentation => {
  const flags = input.node.ether?.flags ?? [];
  const flagBlocker = flags.includes("blocker");
  const live = liveHerdrBlocked(input.node, input.herdrAgentStatus);
  // Only seats that can actually stop (actors) get flag→chrome. Schedulers
  // with a stray flag:blocker keep the flag chip, not seat stoppage dress.
  const flagDrivesSeatChrome =
    flagBlocker && isBlockableNode(input.node as CanvasNode);
  const isBlocker = flagDrivesSeatChrome || live;
  return {
    isBlocker,
    shellBlocked: input.graphBlocked || isBlocker,
    liveHerdrBlocked: live,
    flags,
  };
};
