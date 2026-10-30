/**
 * The window's seat-awareness reads, answered by the core (junto/ipc.ts).
 *
 * The plane and the seats it reads live in the core process, so main asks for
 * the snapshot and for the collaboration gate rather than owning a plane it
 * cannot feed. One operation answers both: the enabled check is the same
 * snapshot the renderer hydrates from, so the two cannot disagree.
 */
import { Effect } from "effect";
import { SeatAwareness, type SeatAwarenessSnapshot } from "../../junto/term/seat-awareness-live";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    /** The live gate, and the latest event per binding for the window's hydration. */
    "seats.awareness": CoreOp<Record<string, never>, SeatAwarenessSnapshot>;
  }
}

coreOps({
  "seats.awareness": () => Effect.flatMap(SeatAwareness, (awareness) => awareness.snapshot()),
});
