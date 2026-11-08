/**
 * Main's side of the operator's holds: the window reports which terminals it
 * shows, and when the operator typed into one.
 *
 * The holds are kept in the core (`term/operator-holds.ts`), where every reader
 * is, so each report is sent there through the holds group
 * (src/contract/core/seat-holds.ts) and main holds none. Only the shape of a
 * report crosses into main: the module that keeps the holds stays out of main's
 * bundle.
 */
import { Context } from "effect";
import type { OperatorHoldReports } from "../../../core/term/operator-holds";
import { SeatHoldsCore } from "../../../contract/core/seat-holds";
import { AppRuntime } from "../../runtime";

/** Main's half: the window's reports, sent to the core that keeps them. */
export const coreOperatorHolds = (core: Context.Context<SeatHoldsCore>): OperatorHoldReports => {
  const holds = Context.get(core, SeatHoldsCore);
  return {
    surfaces: (windowId, bindingIds) => AppRuntime.runPromise(holds.SeatHoldsSurfaces({ windowId, bindingIds })),
    typed: (windowId, bindingId) => AppRuntime.runPromise(holds.SeatHoldsTyped({ windowId, bindingId })),
    dropWindow: (windowId) => AppRuntime.runPromise(holds.SeatHoldsDropWindow({ windowId })),
  };
};
