import { Effect } from "effect";
import type { SeatCacheDue, SeatCacheDueAnswerResult } from "@shared/seat-cache-due";
import { coreOps, type CoreOp } from "../ops";

/**
 * The auto mode's questions for the window (seat-sessions/operator-offboard-ipc.ts),
 * answered where the seats and their views run: the seats this machine runs,
 * and those a linked machine asked on a view here.
 */
declare module "../ops" {
  interface CoreOps {
    "seatCacheDue.list": CoreOp<Record<string, never>, ReadonlyArray<SeatCacheDue>>;
    /** The window's answer as it came; decoded closed in the core. */
    "seatCacheDue.answer": CoreOp<{ readonly input: unknown }, SeatCacheDueAnswerResult>;
  }
}

const offboardIpc = () => Effect.promise(() => import("../../junto/seat-sessions/operator-offboard-ipc"));

coreOps({
  "seatCacheDue.list": () => Effect.flatMap(offboardIpc(), ({ seatCacheDueHere }) => Effect.promise(() => seatCacheDueHere())),
  "seatCacheDue.answer": ({ input }) =>
    Effect.flatMap(offboardIpc(), ({ answerSeatCacheDueHere }) => Effect.promise(() => answerSeatCacheDueHere(input))),
});
