import type { Canvas } from "@shared/model";

/** A reseat retires only the session of the occupant it replaced. */
export type SeatSessionTransition = {
  readonly seatId: string;
  readonly bindingId: string;
};

export const seatSessionTransitions = (
  previous: Canvas | undefined,
  next: Canvas | undefined,
): SeatSessionTransition[] => {
  const transitions: SeatSessionTransition[] = [];
  for (const before of previous?.nodes.values() ?? []) {
    if (before.kind !== "agent") continue;
    const after = next?.nodes.get(before.id);
    if (after?.kind !== "agent") continue;
    if (before.bindingId !== after.bindingId || before.harness !== after.harness)
      transitions.push({ seatId: before.id, bindingId: before.bindingId });
  }
  return transitions;
};
