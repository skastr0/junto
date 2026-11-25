/**
 * The five-value seat state, read off a seat's snapshot.
 *
 * `SeatStatus` is the seat's state; `AgentSeatState` is what the canvas, the
 * drive and the CLI have always read. Every published seat state is this
 * projection of the slot's folded snapshot (seat-state-machine.ts).
 *
 *   Starting, Unknown   unknown
 *   Idle                idle
 *   Working             working, stalled or not
 *   Blocked             attention, whatever blocks it
 *   Exited              gone
 *
 * A stalled turn stays working. The stall is Junto's own guess from a silent
 * screen, never the harness asking, so it must not claim the operator: it
 * shows as "stalled since" on the seat (`stalledSince`), not as attention in
 * the feed. Working already refuses paste and never reads as a finished turn.
 */

import type { AgentSeatState } from "../../../shared/agent-seat-state";
import type { SeatSnapshot } from "../../../shared/harness-domain";

export const projectAgentSeatState = (snapshot: SeatSnapshot): AgentSeatState => {
  switch (snapshot.status._tag) {
    case "Starting":
    case "Unknown":
      return "unknown";
    case "Idle":
      return "idle";
    case "Working":
      return "working";
    case "Blocked":
      return "attention";
    case "Exited":
      return "gone";
  }
};
