import { claimFocus, pickPrimaryFocusControl } from "./focus-ownership";

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
const FOCUSABLE =
  "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1']), input:not([disabled]), select:not([disabled])";

const frontTerminalPane = (): HTMLElement | null => {
  const pane = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(FRONT_PANE);
  return pane?.querySelector(".native-terminal-surface") ? pane : null;
};

/**
 * Where the keyboard lands first: the header's first control. Found by
 * place, not by name, so it stays right when the header gains or loses a
 * button.
 */
export const firstChromeControl = (pane: ParentNode | null): HTMLElement | null => {
  const header = pane?.querySelector(HEADER);
  if (!header) return null;
  for (const candidate of header.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (!candidate.closest("[hidden], [aria-hidden='true'], [inert]")) return candidate;
  }
  return null;
};

/** Move the keyboard from the terminal in front to its header. False when there is none. */
export const focusTerminalChrome = (event: KeyboardEvent): boolean => {
  const target = firstChromeControl(frontTerminalPane());
  return target !== null && claimFocus(target, "gesture", { event });
};

/**
 * Hand the keyboard back to the terminal in front. False when there is none,
 * and when the keyboard is already in it, so the key passes to the program.
 */
export const focusFrontTerminal = (event: KeyboardEvent): boolean => {
  const target = pickPrimaryFocusControl(frontTerminalPane());
  if (target === null || target === document.activeElement) return false;
  return claimFocus(target, "gesture", { event, preventScroll: true });
};
