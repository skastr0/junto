import type { Seat } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { compareView, SeatUrgency } from "@shared/wire/urgency";
import type { SeatGroup } from "./seat-line";

/**
 * The one order of agents by how soon they want the operator. Every list
 * and every key that steps "to the next agent that needs me" reads it: the
 * rail and the canvas step keys. Most urgent first (the seat rail's view of
 * the urgency ladder), then by name, then by id so the order never flickers.
 *
 * `urgencyOf` is passed in so a caller can read urgency once (seatUrgencyOf)
 * and hold the order still while the operator moves through it.
 */
export const seatUrgencyOrder = <S extends Seat>(
  seats: ReadonlyArray<S>,
  urgencyOf: (seat: S) => SeatGroup,
): S[] => {
  const compare = compareView(SeatUrgency);
  const group = new Map(seats.map((seat) => [seat.id, urgencyOf(seat)] as const));
  return [...seats].sort(
    (a, b) =>
      compare(group.get(a.id)!, group.get(b.id)!) ||
      titleOf(a).localeCompare(titleOf(b)) ||
      a.id.localeCompare(b.id),
  );
};
