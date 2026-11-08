/**
 * The core's handlers of the auto mode's question and the offboard buttons
 * (src/contract/core/seat-cache-due.ts), answered where the seats and their
 * views run (seat-sessions/operator-offboard-ipc.ts): the seats this machine
 * runs, and those a linked machine asked on a view here. Main decoded each
 * input closed; the operation still holds every rule of its own.
 */
import { Effect } from "effect";
import { SeatCacheDueRpcs } from "../../contract/core/seat-cache-due";

const offboardIpc = () => Effect.promise(() => import("../seat-sessions/operator-offboard-ipc"));

export const SeatCacheDueHandlers = SeatCacheDueRpcs.toLayer({
  SeatCacheDueList: () => Effect.flatMap(offboardIpc(), ({ seatCacheDueHere }) => Effect.promise(() => seatCacheDueHere())),
  SeatCacheDueAnswer: ({ input }) =>
    Effect.flatMap(offboardIpc(), ({ answerSeatCacheDueHere }) => Effect.promise(() => answerSeatCacheDueHere(input))),
  SeatCacheDueOffboardRun: ({ input }) =>
    Effect.flatMap(offboardIpc(), ({ handleSeatOffboardRun }) => Effect.promise(() => handleSeatOffboardRun(input, "operator"))),
  SeatCacheDueOffboardStatus: ({ canvasName, seatIds }) =>
    Effect.flatMap(offboardIpc(), ({ handleSeatOffboardStatus }) => Effect.promise(() => handleSeatOffboardStatus(canvasName, seatIds))),
});
