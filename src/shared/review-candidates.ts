import { asNodeId, inPaintOrder, regionMembers, regionName, regionStack, type Canvas, type Seat } from "./model";
import { titleOf } from "./model/title";
import type { ReviewCandidate } from "./git-review";

/**
 * Who a review can go to: the agent seats in the same region as the place
 * the review was opened from, the innermost region's seats first, then each
 * containing region's, so a lead in the parent region can be mentioned. From
 * the open field, every agent on the canvas. An agent that is offline is
 * still a candidate: mail wakes it.
 */
export const reviewCandidates = (
  canvas: Canvas,
  /** The node the review was opened from: a seat, or a git node. */
  anchorNodeId: string | undefined,
): ReadonlyArray<ReviewCandidate> => {
  const agents = inPaintOrder(canvas).filter((node): node is Seat => node.kind === "agent");
  const candidate = (seat: Seat): ReviewCandidate => ({
    nodeId: seat.id,
    name: titleOf(seat),
    regionPath: regionStack(canvas, seat.id).map(regionName),
  });
  const stack = anchorNodeId === undefined ? [] : regionStack(canvas, asNodeId(anchorNodeId));
  if (stack.length === 0) return agents.map(candidate);
  const out: ReviewCandidate[] = [];
  const seen = new Set<string>();
  // regionStack is outer to inner; walk it inner to outer.
  for (const region of [...stack].reverse()) {
    const inside = new Set<string>(regionMembers(canvas, region).map((node) => node.id));
    for (const agent of agents) {
      if (seen.has(agent.id) || !inside.has(agent.id)) continue;
      seen.add(agent.id);
      out.push(candidate(agent));
    }
  }
  return out;
};
