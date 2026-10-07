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
 */

const FRONT_PANE = ".workbench-pane:not(.workbench-pane--parked)";
const HEADER = ".native-terminal-surface > header";

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

/**
 * Where the keyboard lands first: the header's first control. Found by
 * place, not by name, so it stays right when the header gains or loses a
 * button. A control that is not on screen is never the landing place.
 */
export const firstChromeControl = (pane: ParentNode | null): HTMLElement | null => {
  const header = pane?.querySelector(HEADER);
  if (!header) return null;
  for (const candidate of header.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (candidate.closest("[hidden], [aria-hidden='true'], [inert]")) continue;
    if (candidate.getClientRects().length > 0) return candidate;
  }
  return null;
};

/** Move the keyboard from the terminal in front to its header. False when there is none. */
export const focusTerminalChrome = (event: KeyboardEvent): boolean => {
  const target = firstChromeControl(frontTerminalPane(event));
  return target !== null && claimFocus(target, "gesture", { event });
};

/**
 * Hand the keyboard back to the terminal in front. False when there is none,
 * and when the keyboard is already in it, so the key passes to the program.
 */
export const focusFrontTerminal = (event: KeyboardEvent): boolean => {
  const target = pickPrimaryFocusControl(frontTerminalPane(event));
  if (target === null || target === document.activeElement) return false;
  return claimFocus(target, "gesture", { event, preventScroll: true });
};
