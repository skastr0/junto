// Viewport busy gate — freeze *non-chrome* canvas work while the operator pans/zooms.
//
// Does NOT hide UI chrome (MiniMap stays mounted and live). It only defers
// setNodes rebuilds, rollup publishes, and CSS transitions so
// the RF transform path stays free of competing React work.
//
// Mark on move start / continuous move; release after a short hold past
// panOnScroll's end debounce. A hard max duration guarantees we never stick busy
// if onMoveEnd is dropped.
//
// Compositor promotion (will-change on .react-flow__viewport) is the same
// lifecycle: CSS gates promotion on the html[data-viewport-busy] attribute so
// the large subtree is promoted only during interaction, never while settled.
//
// The marker lives on <html>, not on the ReactFlow root: React rewrites the
// root's className on every canvas render (seat state, selection, mail), and a
// class set imperatively on that element was dropped and re-added mid-gesture.
// Every such flip de-promotes and re-promotes the viewport layer, which costs
// a full re-raster of the visible canvas and reads as content popping out.

import { observable } from "@legendapp/state";
import { canvasPerformance } from "./performance/canvas-performance";

/** True while the canvas viewport is mid-gesture (pan/zoom/scroll). */
export const viewportBusy$ = observable(false);

/**
 * Attribute stamped on `<html>` while busy. CSS uses it for:
 * - paint-freeze (transitions/animations off)
 * - compositor promotion of `.react-flow__viewport` (will-change: transform)
 *
 * Must not be driven by React render state — a direct DOM write on an element
 * React never renders, so no render can clear it mid-gesture.
 */
export const VIEWPORT_BUSY_ATTR = "data-viewport-busy";

/** Hold past panOnScroll's ~150ms end debounce so consecutive ticks stay frozen. */
export const VIEWPORT_BUSY_END_HOLD_MS = 160;
/** Absolute cap — if move-end is missed, force idle so deferred work flushes. */
export const VIEWPORT_BUSY_MAX_MS = 2_000;

// Back-compat aliases used by older call sites / tests.
const END_HOLD_MS = VIEWPORT_BUSY_END_HOLD_MS;
const MAX_BUSY_MS = VIEWPORT_BUSY_MAX_MS;

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

const syncDom = (): void => {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute(VIEWPORT_BUSY_ATTR, viewportBusy$.peek());
};

const setIdle = (): void => {
  clearEndTimer();
  clearMaxTimer();
  if (viewportBusy$.peek()) {
    viewportBusy$.set(false);
    canvasPerformance.recordViewportBusy(false);
  }
  syncDom();
};

/** Enter (or stay in) the busy freeze + compositor promotion. Idempotent; cancels a pending release. */
export const markViewportBusy = (): void => {
  clearEndTimer();
  if (!viewportBusy$.peek()) {
    viewportBusy$.set(true);
    canvasPerformance.recordViewportBusy(true);
    syncDom();
    clearMaxTimer();
    maxTimer = setTimeout(() => {
      maxTimer = undefined;
      setIdle();
    }, MAX_BUSY_MS);
  } else {
    // Already busy — keep the attribute latched (no toggle thrash mid-gesture).
    syncDom();
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

/**
 * Run work under busy/promotion for programmatic camera moves (fitView / focus)
 * when RF move callbacks may lag the first animation frames. Always schedules
 * release — does not leave the gate latched on throw/reject.
 */
export const withViewportBusy = async <T>(work: () => Promise<T>): Promise<T> => {
  markViewportBusy();
  try {
    return await work();
  } finally {
    releaseViewportBusy();
  }
};

/** Test / unmount helper — drop timers, force idle, clear the attribute. */
export const resetViewportBusy = (): void => {
  setIdle();
};
