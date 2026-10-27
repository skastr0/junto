import { claimFocus } from "./focus-ownership";
import { topModal } from "./modal-stack";

/**
 * Moving the keyboard between the panes of a TwoPane (an artifact's list,
 * its content and its comments; an automation's list and its detail) with
 * Cmd+Alt+Left and Right (`pane.next`, `pane.previous`). Only the TwoPane in
 * the modal in front is reached, and a pane that is hidden is stepped over.
 */

const PANES = [".two-pane__sidebar", ".two-pane__main", ".two-pane__rail"] as const;

/**
 * Where the keyboard lands in each pane, best first. A pane names its own
 * landing with `data-pane-entry`; without one, the picked row in a list, an
 * editor's surface, then the pane's first control.
 */
const ENTRY_SELECTORS = [
  "[data-pane-entry]",
  "[data-selected='true']",
  ".artifact-document__live",
  ".cm-content",
  "textarea:not([disabled])",
  "[data-comments-toggle]",
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
] as const;

const isShown = (element: HTMLElement): boolean => element.closest("[hidden]") === null && element.getClientRects().length > 0;

/** It can hold the keyboard: a host div with no tab stop cannot, focus() on it moves nothing. */
const isFocusable = (element: HTMLElement): boolean => element.tabIndex >= 0 || element.isContentEditable;

/** The pane's landing, or null when nothing in it can hold the keyboard. */
export const paneEntryOf = (pane: HTMLElement): HTMLElement | null => {
  for (const selector of ENTRY_SELECTORS) {
    for (const element of pane.querySelectorAll<HTMLElement>(selector)) {
      if (isShown(element) && isFocusable(element)) return element;
    }
  }
  return null;
};

/** The panes that show, in reading order, of the TwoPane in the modal in front. */
const panesInFront = (): HTMLElement[] => {
  const front = topModal()?.container();
  const layout = front?.querySelector<HTMLElement>(".two-pane");
  if (!layout) return [];
  return PANES.flatMap((selector) => {
    const pane = layout.querySelector<HTMLElement>(`:scope > ${selector}`);
    return pane !== null && isShown(pane) && paneEntryOf(pane) !== null ? [pane] : [];
  });
};

/** The index of the pane after `from` in `direction`, wrapping; -1 for none. */
export const stepPane = (count: number, from: number, direction: 1 | -1): number => {
  if (count === 0) return -1;
  if (from < 0) return direction === 1 ? 0 : count - 1;
  return (from + direction + count) % count;
};

/**
 * Put the keyboard in the next or previous pane. False when no TwoPane is
 * in front, or it has one pane: the key passes.
 */
export const movePaneFocus = (direction: 1 | -1, event?: KeyboardEvent): boolean => {
  const panes = panesInFront();
  if (panes.length < 2) return false;
  const active = document.activeElement;
  const from = panes.findIndex((pane) => active !== null && pane.contains(active));
  const to = panes[stepPane(panes.length, from, direction)];
  if (to === undefined) return false;
  // A refused claim moved nothing: the key passes.
  return claimFocus(paneEntryOf(to), "gesture", { event, preventScroll: false });
};
