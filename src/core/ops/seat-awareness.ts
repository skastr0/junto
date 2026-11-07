/**
 * The core's handler of the window's seat-awareness read
 * (src/contract/core/seat-awareness.ts).
 *
 * The plane and the seats it reads live in the core process, so main asks for
 * the snapshot and for the collaboration gate rather than owning a plane it
 * cannot feed. One call answers both: the enabled check is the same snapshot
 * the renderer hydrates from, so the two cannot disagree.
 */
import { Effect } from "effect";
import { SeatAwarenessRpcs } from "../../contract/core/seat-awareness";
import { SeatAwareness } from "../term/seat-awareness-live";

export const SeatAwarenessHandlers = SeatAwarenessRpcs.toLayer(
  Effect.map(SeatAwareness, (awareness) => ({
    SeatAwarenessSnapshot: () => awareness.snapshot(),
  })),
);
