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
// lifecycle: CSS gates promotion on VIEWPORT_BUSY_CLASS so the large subtree
// is promoted only during interaction, never while settled.

import { observable } from "@legendapp/state";
import { canvasPerformance } from "./performance/canvas-performance";

/** True while the canvas viewport is mid-gesture (pan/zoom/scroll). */
export const viewportBusy$ = observable(false);

/**
 * DOM class toggled on the ReactFlow root while busy. CSS uses it for:
 * - paint-freeze (transitions/animations off)
 * - compositor promotion of `.react-flow__viewport` (will-change: transform)
 *
 * Must not be driven by React render state — classList only.
 */
export const VIEWPORT_BUSY_CLASS = "is-viewport-busy";

/** Hold past panOnScroll's ~150ms end debounce so consecutive ticks stay frozen. */
export const VIEWPORT_BUSY_END_HOLD_MS = 160;
/** Absolute cap — if move-end is missed, force idle so deferred work flushes. */
export const VIEWPORT_BUSY_MAX_MS = 2_000;

// Back-compat aliases used by older call sites / tests.
const END_HOLD_MS = VIEWPORT_BUSY_END_HOLD_MS;
const MAX_BUSY_MS = VIEWPORT_BUSY_MAX_MS;

let endTimer: ReturnType<typeof setTimeout> | undefined;
let maxTimer: ReturnType<typeof setTimeout> | undefined;
/** Optional host the busy class is mirrored onto (ReactFlow root). */
let boundHost: HTMLElement | null = null;

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

const syncHostClass = (): void => {
  if (!boundHost) return;
  boundHost.classList.toggle(VIEWPORT_BUSY_CLASS, viewportBusy$.peek());
};

const setIdle = (): void => {
  clearEndTimer();
  clearMaxTimer();
  if (viewportBusy$.peek()) {
    viewportBusy$.set(false);
    canvasPerformance.recordViewportBusy(false);
  }
  syncHostClass();
};

/**
 * Bind (or re-bind) the ReactFlow root so busy ↔ class stays coherent without
 * React renders. Re-call after renders that rewrite className.
 */
export const bindViewportBusyHost = (host: HTMLElement | null): (() => void) => {
  boundHost = host;
  syncHostClass();
  return () => {
    if (boundHost !== host) return;
    host?.classList.remove(VIEWPORT_BUSY_CLASS);
    boundHost = null;
  };
};

/** Enter (or stay in) the busy freeze + compositor promotion. Idempotent; cancels a pending release. */
export const markViewportBusy = (): void => {
  clearEndTimer();
  if (!viewportBusy$.peek()) {
    viewportBusy$.set(true);
    canvasPerformance.recordViewportBusy(true);
    syncHostClass();
    clearMaxTimer();
    maxTimer = setTimeout(() => {
      maxTimer = undefined;
      setIdle();
    }, MAX_BUSY_MS);
  } else {
    // Already busy — keep host class latched (no toggle thrash mid-gesture).
    syncHostClass();
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

/** Test / unmount helper — drop timers, force idle, clear host class. */
export const resetViewportBusy = (): void => {
  setIdle();
  if (boundHost) {
    boundHost.classList.remove(VIEWPORT_BUSY_CLASS);
  }
};
