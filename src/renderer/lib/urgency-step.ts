import { seatUrgencyNow } from "../components/SeatRing";
import { isAgentSeatNode } from "./multi-selection";
import { playCue } from "./sound";
import { selectNode, state$ } from "./state";
import { urgencyOrder } from "./urgency-order";

/**
 * The canvas step keys (Space and the backtick): walk the agents on the
 * canvas in the one urgency order, most urgent first. Same order as the
 * agent switcher; here there is no surface, the camera goes to the agent.
 *
 * A walk holds its order still: urgency is read once when the walk starts,
 * and the walk carries on for as long as the operator is still on the agent
 * it last went to. Selecting something else, or reaching the end, starts a
 * new walk from the most urgent.
 */
export type UrgencyWalk = { readonly ids: ReadonlyArray<string>; readonly index: number };

/** Where the next press goes, or null with no agent on the canvas. */
export const stepUrgencyWalk = (
  walk: UrgencyWalk | null,
  order: ReadonlyArray<string>,
  selectedId: string,
): UrgencyWalk | null => {
  if (order.length === 0) return null;
  if (walk && walk.ids[walk.index] === selectedId) {
    const live = new Set(order);
    // An agent deleted since the walk began is stepped over.
    for (let index = walk.index + 1; index < walk.ids.length; index += 1) {
      if (live.has(walk.ids[index]!)) return { ids: walk.ids, index };
    }
  }
  // A new walk does not start on the agent the operator is already on.
  return { ids: order, index: order[0] === selectedId && order.length > 1 ? 1 : 0 };
};

const PRESSABLE =
  "button, a[href], summary, select, [role='button'], [role='link'], [role='checkbox'], [role='switch'], [role='radio'], [role='tab'], [role='menuitem'], [role='option']";
const CANVAS_ITSELF = ".react-flow__node, .react-flow__edge, .react-flow__pane";

type Matches = { readonly matches?: (selector: string) => boolean };

/**
 * Space on a control with the keyboard presses that control: a button or a
 * link, on the canvas and the top bar as much as in a modal. The step to
 * the next agent is for when the canvas itself (the pane or a node) has
 * the keyboard.
 */
export const spacePressesControl = (event: Pick<KeyboardEvent, "code" | "target">): boolean => {
  if (event.code !== "Space") return false;
  const target = event.target as Matches | null;
  if (typeof target?.matches !== "function") return false;
  return target.matches(PRESSABLE) && !target.matches(CANVAS_ITSELF);
};

let walk: UrgencyWalk | null = null;

/** Go to the next agent. False with no agent on the canvas: the key passes. */
export const stepToNextAgent = (): boolean => {
  const agents = state$.doc.peek().nodes.filter(isAgentSeatNode);
  const order = urgencyOrder(agents, seatUrgencyNow).map((agent) => agent.id);
  walk = stepUrgencyWalk(walk, order, state$.selectedNodeId.peek());
  if (walk === null) return false;
  const nodeId = walk.ids[walk.index]!;
  playCue("navigate");
  selectNode(nodeId);
  state$.focusNodeId.set(nodeId);
  return true;
};
