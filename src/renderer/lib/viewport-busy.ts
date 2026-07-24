// Viewport busy gate — freeze *non-chrome* canvas work while the operator pans/zooms.
//
// Does NOT hide UI chrome (MiniMap stays mounted and live). It only defers
// setNodes rebuilds, herdr meta IPC, rollup publishes, and CSS transitions so
// the RF transform path stays free of competing React work.
//
// Mark on move start / continuous move; release after a short hold past
// panOnScroll's end debounce. A hard max duration guarantees we never stick busy
// if onMoveEnd is dropped.

import { observable } from "@legendapp/state";

/** True while the canvas viewport is mid-gesture (pan/zoom/scroll). */
export const viewportBusy$ = observable(false);

/** Hold past panOnScroll's ~150ms end debounce so consecutive ticks stay frozen. */
const END_HOLD_MS = 160;
/** Absolute cap — if move-end is missed, force idle so deferred work flushes. */
const MAX_BUSY_MS = 2_000;

let endTimer: ReturnType<typeof setTimeout> | undefined;
let maxTimer: ReturnType<typeof setTimeout> | undefined;

const clearEndTimer = (): void => {
  if (endTimer === undefined) return;
  clearTimeout(endTimer);
  endTimer = undefined;
};

const clearMaxTimer = (): void => {
  if (maxTimer === undefined) return;
  clearTimeout(maxTimer);
  maxTimer = undefined;
};

const setIdle = (): void => {
  clearEndTimer();
  clearMaxTimer();
  if (viewportBusy$.peek()) viewportBusy$.set(false);
};

/** Enter (or stay in) the busy freeze. Idempotent; cancels a pending release. */
export const markViewportBusy = (): void => {
  clearEndTimer();
  if (!viewportBusy$.peek()) {
    viewportBusy$.set(true);
    clearMaxTimer();
    maxTimer = setTimeout(() => {
      maxTimer = undefined;
      setIdle();
    }, MAX_BUSY_MS);
  }
};

/** Schedule release after END_HOLD_MS of no further marks. */
export const releaseViewportBusy = (): void => {
  clearEndTimer();
  endTimer = setTimeout(() => {
    endTimer = undefined;
    setIdle();
  }, END_HOLD_MS);
};

/** Test / unmount helper — drop timers and force idle. */
export const resetViewportBusy = (): void => {
  setIdle();
};
