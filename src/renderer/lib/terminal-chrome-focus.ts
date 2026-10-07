import { claimFocus, pickPrimaryFocusControl } from "./focus-ownership";
import { FOCUSABLE_SELECTOR } from "./modal-stack";

/**
 * Letting the keyboard out of a terminal. A terminal keeps Tab and Escape
 * for its program, so without a chord the header buttons and the list of
 * connected agents beside it cannot be reached by keyboard at all.
 *
 * Cmd+Up moves the keyboard to the first control of the header above the
 * terminal; Tab then walks the header and the connections as the modal
 * already allows. Cmd+Down hands the keyboard back to the terminal.
 *
 * In the grid a cell's own header has no controls, so the way out of a cell
 * is the grid's header (the layout picker and Close), and the way back is
 * the cell the keyboard left.
 */

const FRONT_PANE = ".workbench-pane:not(.workbench-pane--parked)";
const HEADER = ".native-terminal-surface > header";
const GRID_CELL = ".terminal-grid__cell";
const GRID_HEADER = "[data-testid='terminal-grid-focus'] > header";

type Closest = { readonly closest?: (selector: string) => Element | null };

/**
 * The pane the key was pressed in, so that with several terminals side by
 * side the keyboard stays in its own; the first one in front otherwise.
 */
const frontTerminalPane = (event: KeyboardEvent): HTMLElement | null => {
  if (typeof document === "undefined") return null;
  const own = (event.target as Closest | null)?.closest?.(FRONT_PANE) as HTMLElement | null | undefined;
  const pane = own ?? document.querySelector<HTMLElement>(FRONT_PANE);
  return pane?.querySelector(".native-terminal-surface") ? pane : null;
};

/** The first control of `header` that is on screen. */
const firstControlIn = (header: Element | null | undefined): HTMLElement | null => {
  if (!header) return null;
  for (const candidate of header.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (candidate.closest("[hidden], [aria-hidden='true'], [inert]")) continue;
    if (candidate.getClientRects().length > 0) return candidate;
  }
  return null;
};

/**
 * Where the keyboard lands first: the header's first control. Found by
 * place, not by name, so it stays right when the header gains or loses a
 * button. A control that is not on screen is never the landing place.
 */
export const firstChromeControl = (pane: ParentNode | null): HTMLElement | null =>
  firstControlIn(pane?.querySelector(HEADER));

// The grid cell the keyboard left for the grid's header, to hand it back to.
let leftGridCell: Element | null = null;

const gridHeader = (): Element | null =>
  typeof document === "undefined" ? null : document.querySelector(GRID_HEADER);

/** Move the keyboard from the terminal in front to its header. False when there is none. */
export const focusTerminalChrome = (event: KeyboardEvent): boolean => {
  const cell = (event.target as Closest | null)?.closest?.(GRID_CELL) ?? null;
  if (cell) {
    const target = firstControlIn(gridHeader());
    if (target === null || !claimFocus(target, "gesture", { event })) return false;
    leftGridCell = cell;
    return true;
  }
  const target = firstChromeControl(frontTerminalPane(event));
  return target !== null && claimFocus(target, "gesture", { event });
};

/** The terminal Cmd+Down returns to: in the grid, the cell the keyboard left, or the first one. */
const terminalToReturnTo = (event: KeyboardEvent): HTMLElement | null => {
  const header = gridHeader();
  if (header === null) return pickPrimaryFocusControl(frontTerminalPane(event));
  if (!header.contains(document.activeElement)) return null;
  const cell = leftGridCell?.isConnected ? leftGridCell : null;
  return pickPrimaryFocusControl(cell) ?? pickPrimaryFocusControl(document.querySelector(`${GRID_CELL}:has(.xterm)`));
};

/**
 * Hand the keyboard back to the terminal in front. False when there is none,
 * and when the keyboard is already in it, so the key passes to the program.
 */
export const focusFrontTerminal = (event: KeyboardEvent): boolean => {
  const target = terminalToReturnTo(event);
  if (target === null || target === document.activeElement) return false;
  return claimFocus(target, "gesture", { event, preventScroll: true });
};
