/**
 * Whether anything is open over the window that can cross the top bar.
 *
 * On darwin the bar is a window drag region, and a drag region ignores
 * z-index: an overlay that crosses the bar's band would hand its clicks to
 * the window drag. While any overlay is open the bar is no drag region
 * (styles.css), keyed on one attribute on <html>, `data-junto-overlay`. It is
 * a counted set, so two overlays open at once do not clear each other.
 *
 * It is an attribute and not a `:has()` on the root: a `:has()` there
 * invalidates the style of the whole document at every DOM change (measured:
 * about 20x the layout-tree update of a dialog open on a large canvas), where
 * a root attribute with one class below it invalidates that class alone.
 */
import { useEffect } from "react";

const ATTRIBUTE = "data-junto-overlay";

const holds = new Set<symbol>();

const mark = (): void => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (holds.size > 0) root.setAttribute(ATTRIBUTE, "open");
  else root.removeAttribute(ATTRIBUTE);
};

/** An overlay is open. Returns the way to say it closed (once). */
export const holdOverlay = (): (() => void) => {
  const hold = Symbol("overlay");
  holds.add(hold);
  mark();
  return () => {
    if (!holds.delete(hold)) return;
    mark();
  };
};

/** An overlay component is open while it is mounted, or while `active` says so. */
export const useOverlayHold = (active = true): void => {
  useEffect(() => (active ? holdOverlay() : undefined), [active]);
};

/** How many overlays are open: for tests. */
export const overlaysOpen = (): number => holds.size;

/** Test seam: forget every hold. */
export const resetOverlays = (): void => {
  holds.clear();
  mark();
};
