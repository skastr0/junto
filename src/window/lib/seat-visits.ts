import { touchActiveMru } from "./hotbar-slots";
import { state$ } from "./state";
import { nodeAt } from "./use-model";

/** The most seats the visit order remembers. */
const VISIT_CAP = 256;

/**
 * The seats the operator brought to the front, most recent first: a terminal
 * opened (card double-click, rail, cmd+K, the switcher), or a seat stepped to.
 * The agent switcher (cmd+`) cycles this order. It is separate from the
 * hotbar MRU, which leases hotbar slots and records far fewer moves.
 */
export const recordSeatVisit = (canvas: string, nodeId: string): void => {
  if (nodeAt(canvas, nodeId)?.kind !== "agent") return;
  state$.seatVisitOrder.set(touchActiveMru(state$.seatVisitOrder.peek(), nodeId, VISIT_CAP));
};
