import type { Seat } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { SEAT_URGENCY, type SeatUrgency } from "./seat-line";

/**
 * The one order of agents by how soon they want the operator. Every list
 * and every key that steps "to the next agent that needs me" reads it: the
 * rail, the agent switcher, and the canvas step keys. Most urgent first (see
 * SEAT_URGENCY), then by name, then by id so the order never flickers.
 *
 * `urgencyOf` is passed in so a caller can read urgency once (seatUrgencyOf)
 * and hold the order still while the operator moves through it.
 */
export const seatUrgencyOrder = <S extends Seat>(
  seats: ReadonlyArray<S>,
  urgencyOf: (seat: S) => SeatUrgency,
): S[] => ordered(seats, urgencyOf, titleOf);

const ordered = <N extends { readonly id: string }>(
  agents: ReadonlyArray<N>,
  urgencyOf: (agent: N) => SeatUrgency,
  nameOf: (agent: N) => string,
): N[] => {
  const rank = new Map(agents.map((agent) => [agent.id, urgencyOf(agent)] as const));
  return [...agents].sort(
    (a, b) =>
      rank.get(a.id)! - rank.get(b.id)! ||
      nameOf(a).localeCompare(nameOf(b)) ||
      a.id.localeCompare(b.id),
  );
};

/** A seat that wants the operator now: blocked, waiting on them, or ready for review. */
export const needsOperator = (urgency: SeatUrgency): boolean => urgency <= SEAT_URGENCY.review;
