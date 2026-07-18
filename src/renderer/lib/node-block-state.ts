/**
 * Node shell blocked presentation.
 *
 * Document flags and execution-graph `blocked` remain authorial/derived.
 * Herdr agent_status is live runtime: when the pane is blocked, the card
 * must wear the same blocker chrome as flag:blocker — without writing
 * ether.flags (status clears when the host unblocks).
 *
 * Herdr stays non-blockable in the execution graph (no edge relay); this is
 * node chrome only.
 */

import type { CanvasNode, EtherFlag } from "@shared/canvas";

export const isHerdrCanvasNode = (node: Pick<CanvasNode, "ether">): boolean =>
  node.ether?.herdr !== undefined || node.ether?.entity?.kind === "herdr";

/** Live herdr agent_status === blocked → node shell blocker chrome. */
export const liveHerdrBlocked = (
  node: Pick<CanvasNode, "ether">,
  agentStatus: string | null | undefined,
): boolean => isHerdrCanvasNode(node) && agentStatus === "blocked";

export type NodeBlockPresentation = {
  /** Crimson border / vellum-blocker pulse / flag-rail primary. */
  readonly isBlocker: boolean;
  /** Crimson wash background (graph blocked or any seed blocker). */
  readonly shellBlocked: boolean;
  /** Live herdr only — not a document flag. */
  readonly liveHerdrBlocked: boolean;
  /** Document flags only (rail + toolbar toggle). */
  readonly flags: ReadonlyArray<EtherFlag>;
};

export const nodeBlockPresentation = (input: {
  readonly node: Pick<CanvasNode, "ether">;
  readonly graphBlocked: boolean;
  readonly herdrAgentStatus?: string | null;
}): NodeBlockPresentation => {
  const flags = input.node.ether?.flags ?? [];
  const flagBlocker = flags.includes("blocker");
  const live = liveHerdrBlocked(input.node, input.herdrAgentStatus);
  const isBlocker = flagBlocker || live;
  return {
    isBlocker,
    // Flag or live herdr seed the shell even when the node is not in the
    // execution-graph blocked set (herdr is intentionally non-blockable there).
    shellBlocked: input.graphBlocked || isBlocker,
    liveHerdrBlocked: live,
    flags,
  };
};
