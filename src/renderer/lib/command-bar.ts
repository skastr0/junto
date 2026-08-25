import { batch } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import { roleOf } from "@shared/physics";
import { touchActiveMru } from "./hotbar-slots";
import { specOf } from "./node-spec";
import { nodeTitle, searchText } from "./presentation";
import { selectNode, state$ } from "./state";

/**
 * Command bar (cmd+K) — quick node navigation without touching the canvas.
 *
 * The palette filters a LIST of nodes and commits through the existing focus
 * path (selectNode + focusNodeId camera fit). The canvas graph is never
 * reminted or thinned while searching, unlike the retired canvas-filter
 * search field.
 */

/** Open the palette. The open canvas and current selection are untouched —
 * the bar reads them (e.g. copy-node-reference) and commits only on Enter. */
export const openCommandBar = (): void => {
  state$.commandBarOpen.set(true);
};

export const closeCommandBar = (): void => {
  state$.commandBarOpen.set(false);
};

/** Hotbar lease eligibility is factory-role based: actors only. Shared with
 * RtsBottomBar so the command bar focus commit and the RTS focus key apply
 * identical lease semantics. */
export const isHotbarLeaseActor = (node: CanvasNode | undefined): boolean =>
  node !== undefined && roleOf(specOf(node)) === "actor";

/** Focus a node from the command bar: select it, request the one-shot camera
 * fit, and lease actor MRU exactly like the RTS focus key. */
export const focusCanvasNode = (nodeId: string): void => {
  const node = state$.doc.peek().nodes.find((candidate) => candidate.id === nodeId);
  batch(() => {
    selectNode(nodeId);
    state$.focusNodeId.set(nodeId);
    if (isHotbarLeaseActor(node)) {
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

/**
 * Filter and rank the command bar node list.
 *
 * Empty query: document order (the authoring order on the canvas).
 * Non-empty: title-prefix (4) above title-substring (3) above any other
 * matched text (2). Ties break by hotbar MRU recency, then document order.
 */
export const filterCommandBarNodes = (
  nodes: ReadonlyArray<CanvasNode>,
  query: string,
  recentIds: ReadonlyArray<string>,
): ReadonlyArray<CommandBarMatch> => {
  const q = query.trim().toLowerCase();
  if (!q) {
    return nodes.map((node, index) => ({ node, score: 0, index }));
  }
  const recentRank = new Map<string, number>();
  for (const [rank, id] of recentIds.entries()) recentRank.set(id, rank);
  const matches: CommandBarMatch[] = [];
  for (const [index, node] of nodes.entries()) {
    const title = nodeTitle(node).toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score = 4;
    else if (title.includes(q)) score = 3;
    else if (searchText(node).includes(q)) score = 2;
    if (score > 0) matches.push({ node, score, index });
  }
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aRecent = recentRank.get(a.node.id);
    const bRecent = recentRank.get(b.node.id);
    if (aRecent !== undefined && bRecent !== undefined) return aRecent - bRecent;
    if (aRecent !== undefined) return -1;
    if (bRecent !== undefined) return 1;
    return a.index - b.index;
  });
  return matches;
};
