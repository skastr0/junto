/**
 * What the Tasks node reads off the canvas: the seats that reach the node (01),
 * named, and a node's name. Pure over a reach canvas and a naming function.
 */
import { seatsInReach, type ReachCanvas } from "@shared/region-reach";
import { seatNodeId, type TaskNodeId } from "@shared/task-model";
import type { SeatChoice } from "../../lib/task-ui";

/** Seats in reach of a task node, by name, A to Z (the order a picker reads). */
export const seatChoicesInReach = (
  canvas: ReachCanvas,
  node: TaskNodeId,
  nameOf: (id: string) => string,
): ReadonlyArray<SeatChoice> =>
  seatsInReach(canvas, node)
    .map((seat) => ({ node: seatNodeId(seat.id), name: nameOf(seat.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
