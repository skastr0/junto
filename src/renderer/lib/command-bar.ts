import { batch } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import { fuzzyMatch } from "./fuzzy-match";
import { touchActiveMru } from "./hotbar-slots";
import { roleOfKind } from "./model-kind";
import { nodeTitle, searchText } from "./presentation";
import { selectNode, state$ } from "./state";
import { nodeAt } from "./use-model";

/**
 * Command bar (cmd+K) — quick node navigation without touching the canvas.
 *
 * The palette filters a LIST of nodes and commits through the existing focus
 * path (selectNode + focusNodeId camera fit). The canvas graph is never
 * reminted or thinned while searching, unlike the retired canvas-filter
 * search field.
 */

/** A seat or terminal earns a slot on the hotbar by being used: the kinds that act. */
const leasesHotbarSlot = (canvas: string, nodeId: string): boolean => {
  const node = nodeAt(canvas, nodeId);
  return node !== undefined && roleOfKind(node.kind) === "actor";
};

/** Focus a node from the command bar: select it, request the one-shot camera
 * fit, and lease actor MRU exactly like the RTS focus key. */
export const focusCanvasNode = (nodeId: string): void => {
  batch(() => {
    selectNode(nodeId);
    state$.focusNodeId.set(nodeId);
    if (leasesHotbarSlot(state$.canvasName.peek(), nodeId)) {
      state$.hotbarActiveMru.set(
        touchActiveMru(state$.hotbarActiveMru.peek(), nodeId),
      );
    }
  });
};

export interface CommandBarMatch {
  readonly node: CanvasNode;
  readonly score: number;
  readonly index: number;
}

/** Resting: the urgency an agent without a reading ranks at. */
const URGENCY_UNKNOWN = 4;

const isAgent = (node: CanvasNode): boolean => node.ether?.entity?.kind === "agent";

/** Empty-query groups: agents, then regions, then notes, then everything else. */
const kindRank = (node: CanvasNode): number => {
  if (isAgent(node)) return 0;
  if (node.type === "group") return 1;
  if (node.type === "text") return 2;
  return 3;
};

/**
 * Filter and rank the command bar node list. The palette is biased toward
 * agents: they are what the operator most often jumps to.
 *
 * Empty query: agents first, most urgent first (`urgencyById`, lower is more
 * urgent: see seatUrgency), then regions, then notes, then every other kind.
 * Non-empty: the palettes' shared fuzzy matcher (lib/fuzzy-match) scores the
 * title, so "productlead" and "prdld" both find product-lead; other text and
 * the node's region path (`regionPathById`) match as plain substrings, so a
 * region name finds the nodes inside it. A title hit outranks the same hit in
 * other text; at equal match quality agents rank above other kinds, the most urgent agent first. Remaining ties break
 * by hotbar MRU recency, then document order.
 */
export const filterCommandBarNodes = (
  nodes: ReadonlyArray<CanvasNode>,
  query: string,
  recentIds: ReadonlyArray<string>,
  urgencyById: ReadonlyMap<string, number> = new Map(),
  regionPathById: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<CommandBarMatch> => {
  const q = query.trim().toLowerCase();
  const recentRank = new Map<string, number>();
  for (const [rank, id] of recentIds.entries()) recentRank.set(id, rank);
  const matches: CommandBarMatch[] = [];
  for (const [index, node] of nodes.entries()) {
    if (!q) {
      matches.push({ node, score: 0, index });
      continue;
    }
    // The trailing space keeps a whole-title match in the prefix tier, so a
    // note named exactly like the query does not outrank the agents.
    const title = `${nodeTitle(node)} `;
    const inTitle = fuzzyMatch(q, { identity: [title] });
    const anywhere = fuzzyMatch(q, {
      identity: [title],
      metadata: [searchText(node), regionPathById.get(node.id) ?? ""],
    });
    const score = Math.max(anywhere?.score ?? 0, inTitle ? inTitle.score + 1 : 0);
    if (score > 0) matches.push({ node, score, index });
  }
  const urgency = (node: CanvasNode): number => urgencyById.get(node.id) ?? URGENCY_UNKNOWN;
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aAgent = isAgent(a.node);
    const bAgent = isAgent(b.node);
    if (q) {
      if (aAgent !== bAgent) return aAgent ? -1 : 1;
    } else {
      const byKind = kindRank(a.node) - kindRank(b.node);
      if (byKind !== 0) return byKind;
    }
    if (aAgent && bAgent) {
      const byUrgency = urgency(a.node) - urgency(b.node);
      if (byUrgency !== 0) return byUrgency;
    }
    const aRecent = recentRank.get(a.node.id);
    const bRecent = recentRank.get(b.node.id);
    if (aRecent !== undefined && bRecent !== undefined) return aRecent - bRecent;
    if (aRecent !== undefined) return -1;
    if (bRecent !== undefined) return 1;
    return a.index - b.index;
  });
  return matches;
};
