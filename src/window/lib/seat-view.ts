/**
 * Opening a seat on a view. A seat's modal has two views, Terminal and
 * Threads, and every open starts on the operator's Seat opens on setting.
 * `openSeatOn` is the one way to open a seat on a named view whatever the
 * setting says: the seat's surface reads the ask, shows that view, and holds
 * it until the view closes. The next open is back on the setting.
 */
import { observable } from "@legendapp/state";
import type { SeatOpenView } from "@shared/settings";
import { terminalBindingOf } from "@shared/terminal";
import { openTerminal } from "./terminal-actions";
import { closeTerminalGrid, terminalGrid$ } from "./terminal-grid-state";
import { terminal$ } from "./terminal-state";
import { nodeAt } from "./use-model";

/**
 * The view asked for, by seat, until the seat's surface has taken it. Only a
 * surface that offers the two views takes an ask: it reads it as it renders
 * and answers it once it has. A surface that is parked, or a grid cell,
 * leaves it waiting, and an ask nothing took ends when the seat's view
 * closes. So an ask never outlives the open it was made for.
 */
export const seatViewAsked$ = observable<Record<string, SeatOpenView | undefined>>({});

// A view that closes takes its untaken ask with it: the next open of that
// seat is another open, and starts on the setting.
terminal$.openByNodeId.onChange(({ value }) => {
  for (const seatId of Object.keys(seatViewAsked$.peek())) {
    if (value?.[seatId] === undefined) seatViewAsked$[seatId].delete();
  }
});

/** The seat's surface has taken the ask: it is not read again. */
export const answerSeatViewAsk = (seatId: string): void => {
  if (seatViewAsked$[seatId].peek() !== undefined) seatViewAsked$[seatId].delete();
};

/**
 * Open this seat on this view. A seat that is closed opens on it; one that is
 * already open comes to the front and changes to it. Opening is the same
 * open as any other (a cold seat starts, the visit is recorded); only the
 * view differs. Anything that is not an agent seat with a terminal of its own
 * is left alone. A seat the grid shows is opened out of it: the grid is a
 * look at many, it sits over any seat modal, and it would stay on top of the
 * one the operator asked for.
 */
export const openSeatOn = (canvas: string, seatId: string, view: SeatOpenView): Promise<void> => {
  const seat = nodeAt(canvas, seatId);
  if (seat?.kind !== "agent" || terminalBindingOf(seat)?.kind !== "native") return Promise.resolve();
  seatViewAsked$[seatId].set(view);
  const inGrid = terminalGrid$.nodeIds.peek().includes(seatId);
  // The open takes the seat out of the grid's hands (it joins the workbench)
  // before the grid closes, so closing releases only the other cells.
  const opening = openTerminal(canvas, seatId);
  if (inGrid) closeTerminalGrid();
  return opening;
};
