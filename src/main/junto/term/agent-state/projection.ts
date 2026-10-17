/**
 * The five-value seat state, read off a seat's snapshot.
 *
 * `SeatStatus` is the seat's state; `AgentSeatState` is what the canvas, the
 * drive and the CLI have always read. Every published seat state is this
 * projection of the slot's folded snapshot (seat-state-machine.ts).
 *
 *   Starting, Unknown   unknown
 *   Idle                idle
 *   Working             working, or attention while its turn is stalled
 *   Blocked             attention, whatever blocks it
 *   Exited              gone
 *
 * A stalled turn reads attention because that is how the turn-stall latch
 * has always surfaced (runtime.ts TURN_STALLED_REASON): it refuses paste and
 * never reads as a finished turn.
 */

import type { AgentSeatState } from "../../../../shared/agent-seat-state";
import type { SeatSnapshot } from "../../../../shared/harness-domain";

export const projectAgentSeatState = (snapshot: SeatSnapshot): AgentSeatState => {
  switch (snapshot.status._tag) {
    case "Starting":
    case "Unknown":
      return "unknown";
    case "Idle":
      return "idle";
    case "Working":
      return snapshot.stalledSince === undefined ? "working" : "attention";
    case "Blocked":
      return "attention";
    case "Exited":
      return "gone";
  }
};
