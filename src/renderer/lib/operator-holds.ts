/**
 * This window's part of the operator's holds on seats: which bindings it shows
 * a terminal for, and which it is typed into. Main keeps the holds and the cut
 * at the cache window asks it (src/main/junto/term/operator-holds.ts).
 */
import { observe } from "@legendapp/state";
import { OPERATOR_TYPED_REPORT_MS } from "@shared/operator-hold";
import { agentSeat$, openSurfaceBindingIds } from "./agent-seat-state";
import { getJuntoApi } from "./junto-api";
import { terminal$ } from "./terminal-state";

/**
 * Tell main every binding this window shows, as a whole list each time it
 * changes. The first list goes even when empty: after a reload it replaces
 * anything the old document left.
 */
export const startOperatorHolds = (): (() => void) => {
  let sent: string | undefined;
  return observe(() => {
    const ids = openSurfaceBindingIds(terminal$.openByNodeId.get(), agentSeat$.bindingIdByNodeId.get());
    const key = ids.join("\n");
    if (key === sent) return;
    sent = key;
    const report = getJuntoApi()?.seatSurfacesOpen;
    if (typeof report === "function") void report(ids).catch(() => undefined);
  });
};

const lastTypedReport = new Map<string, number>();

/** The operator typed into a binding's terminal; told to main at most once per report interval. */
export const reportOperatorTyped = (bindingId: string, now: number = Date.now()): void => {
  const last = lastTypedReport.get(bindingId);
  if (last !== undefined && now - last < OPERATOR_TYPED_REPORT_MS) return;
  lastTypedReport.set(bindingId, now);
  const report = getJuntoApi()?.seatOperatorTyped;
  if (typeof report === "function") void report(bindingId).catch(() => undefined);
};

