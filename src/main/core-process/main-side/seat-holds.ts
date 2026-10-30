/**
 * Main's side of the operator's holds: the window reports which terminals it
 * shows, and when the operator typed into one.
 *
 * The holds are kept in the core (`term/operator-holds.ts`), where every reader
 * is, so each report is sent there and main holds none. Only the shape of a
 * report crosses into main: the module that keeps the holds stays out of main's
 * bundle.
 */
import type { OperatorHoldReports } from "../../junto/term/operator-holds";
import type { CoreClient } from "../client";

/** Main's half: the window's reports, sent to the core that keeps them. */
export const coreOperatorHolds = (core: CoreClient): OperatorHoldReports => ({
  surfaces: (windowId, bindingIds) => core.call("seats.holds.surfaces", { windowId, bindingIds }),
  typed: (windowId, bindingId) => core.call("seats.holds.typed", { windowId, bindingId }),
  dropWindow: (windowId) => core.call("seats.holds.dropWindow", { windowId }),
});
