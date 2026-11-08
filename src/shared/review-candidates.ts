import { asNodeId, inPaintOrder, regionMembers, regionName, regionStack, type Canvas, type Seat } from "./model";
import { titleOf } from "./model/title";
import type { ReviewCandidate } from "./git-review";
import { seatsInReach } from "./region-reach";

/**
 * Who a review can go to: the agent seats in reach of the place the review
 * was opened from (region-reach.ts), so never a sibling region's. The anchor's
 * innermost region's seats come first, then each containing region's, then
 * the loose seats on the root, each group in paint order. From the open field,
 * every agent on the canvas. An agent that is not running is still a
 * candidate: mail wakes it.
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
  const anchor = anchorNodeId === undefined ? undefined : asNodeId(anchorNodeId);
  if (anchor === undefined || !canvas.nodes.has(anchor)) return agents.map(candidate);
  const reached = new Set<string>(seatsInReach(canvas, anchor).map((node) => node.id));
  if (canvas.nodes.get(anchor)?.kind === "agent") reached.add(anchor);
  // regionStack is outer to inner; rank inner first, the root last.
  const inner = [...regionStack(canvas, anchor)].reverse()
    .map((region) => new Set<string>(regionMembers(canvas, region).map((node) => node.id)));
  const rank = (seat: Seat): number => {
    const index = inner.findIndex((members) => members.has(seat.id));
    return index === -1 ? inner.length : index;
  };
  return agents
    .filter((seat) => reached.has(seat.id))
    .map((seat, order) => ({ seat, order, rank: rank(seat) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ seat }) => candidate(seat));
};
