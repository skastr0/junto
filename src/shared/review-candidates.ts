import type { CanvasDoc, CanvasNode } from "./canvas";
import { groupMembers, regionDisplayName, regionStack } from "./graph";
import type { ReviewCandidate } from "./git-review";

/**
 * Who a review can go to: the agent seats in the same region as the place
 * the review was opened from, the innermost region's seats first, then each
 * containing region's, so a lead in the parent region can be mentioned. From
 * the open field, every agent on the canvas. An agent that is offline is
 * still a candidate: mail wakes it.
 */
export const reviewCandidates = (
  doc: CanvasDoc,
  /** The node the review was opened from: a seat, or a git node. */
  anchorNodeId: string | undefined,
  nameOf: (node: CanvasNode) => string,
): ReadonlyArray<ReviewCandidate> => {
  const agents = doc.nodes.filter((node) => node.type !== "group" && node.ether?.entity?.kind === "agent");
  const candidate = (node: CanvasNode): ReviewCandidate => ({
    nodeId: node.id,
    name: nameOf(node),
    regionPath: regionStack(doc, node.id).map(regionDisplayName),
  });
  const stack = anchorNodeId === undefined ? [] : regionStack(doc, anchorNodeId);
  if (stack.length === 0) return agents.map(candidate);
  const members = groupMembers(doc);
  const out: ReviewCandidate[] = [];
  const seen = new Set<string>();
  // regionStack is outer to inner; walk it inner to outer.
  for (const region of [...stack].reverse()) {
    const inside = new Set(members.get(region.id) ?? []);
    for (const agent of agents) {
      if (seen.has(agent.id) || !inside.has(agent.id)) continue;
      seen.add(agent.id);
      out.push(candidate(agent));
    }
  }
  return out;
};
