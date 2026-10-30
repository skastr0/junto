import { Effect } from "effect";
import type { SeatCacheDue, SeatCacheDueAnswerResult } from "@shared/seat-cache-due";
import type { SeatOffboardRunResult, SeatOffboardStatus } from "@shared/seat-offboard";
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
    /** The offboard buttons, decoded in the core, where the operation is installed. */
    "seatOffboard.run": CoreOp<{ readonly input: unknown }, SeatOffboardRunResult>;
    "seatOffboard.status": CoreOp<{ readonly canvasName: unknown; readonly seatIds: unknown }, ReadonlyArray<SeatOffboardStatus>>;
  }
}

const offboardIpc = () => Effect.promise(() => import("../../junto/seat-sessions/operator-offboard-ipc"));

coreOps({
  "seatCacheDue.list": () => Effect.flatMap(offboardIpc(), ({ seatCacheDueHere }) => Effect.promise(() => seatCacheDueHere())),
  "seatCacheDue.answer": ({ input }) =>
    Effect.flatMap(offboardIpc(), ({ answerSeatCacheDueHere }) => Effect.promise(() => answerSeatCacheDueHere(input))),
  "seatOffboard.run": ({ input }) =>
    Effect.flatMap(offboardIpc(), ({ handleSeatOffboardRun }) => Effect.promise(() => handleSeatOffboardRun(input, "operator"))),
  "seatOffboard.status": ({ canvasName, seatIds }) =>
    Effect.flatMap(offboardIpc(), ({ handleSeatOffboardStatus }) => Effect.promise(() => handleSeatOffboardStatus(canvasName, seatIds))),
});
