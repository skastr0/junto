/**
 * The operator's holds, recorded in the core (junto/ipc.ts).
 *
 * The window says which terminals it shows and when the operator typed into
 * one; everything that asks lives here, where the seats and their views run:
 * the cache cut leaves a held seat's session alone
 * (seat-sessions/operator-offboard-live.ts), a key warms its clock, and a
 * peer's Hold frame carries the same facts to the machine that runs the seat
 * (term/seat-views.ts, term/seat-attach.ts).
 *
 * Main kept this map before, so nothing it reported reached the cut: a seat the
 * operator was watching, or typing into, could be offboarded under their hands
 * (0.11.7). Main now sends the two reports on (`operator-holds-ipc.ts`) and
 * keeps no map of its own.
 */
import { Effect } from "effect";
import { liveOperatorHolds } from "../../junto/term/operator-holds";
import { coreOps, type CoreOp } from "../ops";
import type { CoreClient } from "../client";

/** What the window sends, and all main knows of the holds. */
export type OperatorHoldReports = {
  /** The bindings one window shows now, replacing what it said before. */
  readonly surfaces: (windowId: number, bindingIds: ReadonlyArray<string>) => void | Promise<unknown>;
  /** The operator typed into a binding's terminal in one window. */
  readonly typed: (windowId: number, bindingId: string) => void | Promise<unknown>;
  /** The window closed or reloaded: every hold it had goes. */
  readonly dropWindow: (windowId: number) => void | Promise<unknown>;
};

declare module "../ops" {
  interface CoreOps {
    "seats.holds.surfaces": CoreOp<{ readonly windowId: number; readonly bindingIds: ReadonlyArray<string> }, void>;
    "seats.holds.typed": CoreOp<{ readonly windowId: number; readonly bindingId: string }, void>;
    "seats.holds.dropWindow": CoreOp<{ readonly windowId: number }, void>;
  }
}

coreOps({
  "seats.holds.surfaces": ({ windowId, bindingIds }) =>
    Effect.sync(() => {
      liveOperatorHolds.surfaces(windowId, bindingIds);
    }),
  "seats.holds.typed": ({ windowId, bindingId }) =>
    Effect.sync(() => {
      liveOperatorHolds.typed(windowId, bindingId);
    }),
  "seats.holds.dropWindow": ({ windowId }) =>
    Effect.sync(() => {
      liveOperatorHolds.dropWindow(windowId);
    }),
});

/** Main's half: the window's reports, sent to the core that keeps them. */
export const coreOperatorHolds = (core: CoreClient): OperatorHoldReports => ({
  surfaces: (windowId, bindingIds) => core.call("seats.holds.surfaces", { windowId, bindingIds }),
  typed: (windowId, bindingId) => core.call("seats.holds.typed", { windowId, bindingId }),
  dropWindow: (windowId) => core.call("seats.holds.dropWindow", { windowId }),
});
