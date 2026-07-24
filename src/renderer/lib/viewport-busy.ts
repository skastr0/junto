// Viewport busy gate — freeze expensive canvas work while the operator pans/zooms.
//
// React Flow's panOnScroll updates `transform` every wheel tick. Subscribers that
// recompute from that (MiniMap mask, Background pattern, setNodes rebuilds, herdr
// meta mounts) fight the compositor and make scroll feel stuttery — especially in
// the React development build. Mark busy on move start; release after a short
// hold so wheel bursts stay one continuous freeze.

import { observable } from "@legendapp/state";

/** True while the canvas viewport is mid-gesture (pan/zoom/scroll). */
export const viewportBusy$ = observable(false);

/** Hold past panOnScroll's ~150ms end debounce so consecutive ticks stay frozen. */
const END_HOLD_MS = 160;

let endTimer: ReturnType<typeof setTimeout> | undefined;

/** Enter (or stay in) the busy freeze. Idempotent; cancels a pending release. */
export const markViewportBusy = (): void => {
  if (endTimer !== undefined) {
    clearTimeout(endTimer);
    endTimer = undefined;
  }
  if (!viewportBusy$.peek()) viewportBusy$.set(true);
};

/** Schedule release after END_HOLD_MS of no further marks. */
export const releaseViewportBusy = (): void => {
  if (endTimer !== undefined) clearTimeout(endTimer);
  endTimer = setTimeout(() => {
    endTimer = undefined;
    if (viewportBusy$.peek()) viewportBusy$.set(false);
  }, END_HOLD_MS);
};

/** Test / unmount helper — drop timers and force idle. */
export const resetViewportBusy = (): void => {
  if (endTimer !== undefined) {
    clearTimeout(endTimer);
    endTimer = undefined;
  }
  viewportBusy$.set(false);
};
