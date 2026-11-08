/**
 * ActivityFeed producer: managed-terminal seat state.
 *
 * Binds `@shared/occupancy`'s ActivityFeed seam from the seat events the app
 * already holds (`agentSeat$`, bindingId-keyed), classified by
 * `clueFromAgentSeat` in the harness vocabulary.
 *
 * PTY producers stay a separate, hot-owned lane.
 */
import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { OccupancyClue } from "@shared/occupancy";
import { agentSeat$, clueFromAgentSeat } from "./agent-seat-state";

const NO_BINDING = "__junto-occupancy-no-binding__";

/**
 * A seat's occupancy clue for card chrome: subscribes only to the seat
 * event of its terminal session's binding, never the whole canvas.
 */
export function useSeatOccupancyClue(bindingId: string | undefined): OccupancyClue | undefined {
  const seatEvent = use$(agentSeat$.byBindingId[bindingId ?? NO_BINDING]);
  return useMemo(() => clueFromAgentSeat(seatEvent), [seatEvent]);
}
