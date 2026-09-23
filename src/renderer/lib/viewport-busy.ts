// Viewport busy gate — freeze *non-chrome* canvas work while the operator pans/zooms.
//
// Does NOT hide UI chrome (MiniMap stays mounted and live). It only defers
// setNodes rebuilds, rollup publishes, and CSS transitions so
// the RF transform path stays free of competing React work.
//
// Mark on move start / continuous move; release after a hold past
// panOnScroll's end debounce. An inactivity watchdog guarantees we never stick
// busy if onMoveEnd is dropped; every mark refreshes it, so a continuous
// gesture never force-releases mid-pan.
//
// The hold is gesture-scoped. A short camera move (fitView, focus, one wheel
// tick) releases after the short end hold. A sustained gesture releases only
// after a longer quiet bridge: operator input arrives in bursts (wheel notches,
// trackpad micro-pauses), and each gap past the short hold used to drop and
// re-latch the gate mid-gesture. Every drop resumed every paused animation for
// one hold window, then froze it again, which read as the whole board
// strobing while the operator panned.
//
// Rendering policy is decoupled from this gate: the viewport's compositor
// promotion (will-change on .react-flow__viewport) is STABLE for the canvas
// mount lifetime (see styles.css). Toggling promotion on these busy
// boundaries promoted and de-promoted the layer — each flip re-rastered the
// visible canvas and read as content popping out.
//
// The marker lives on <html>, not on the ReactFlow root: React rewrites the
// root's className on every canvas render (seat state, selection, mail), and a
// class set imperatively on that element was dropped and re-added mid-gesture.

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
/** Busy this long counts as a sustained operator gesture, not a single camera move. */
export const VIEWPORT_BUSY_SUSTAINED_MS = 200;
/**
 * Release hold for a sustained gesture. It bridges the pauses between input
 * bursts inside one gesture, so the gate releases once when the operator stops
 * rather than once per burst.
 */
export const VIEWPORT_BUSY_GESTURE_HOLD_MS = 480;
/**
 * Inactivity timeout — sustained silence while busy force-releases the gate so
 * deferred work flushes even when onMoveEnd is lost. Every mark refreshes it:
 * a continuous gesture never force-releases mid-pan. (The former absolute cap
 * strobed the gate every 2s on long pans — each drop and re-latch promoted and
 * de-promoted the viewport layer, a full visible re-raster.)
 */
export const VIEWPORT_BUSY_IDLE_MS = 2_000;

// Back-compat aliases used by older call sites / tests.
const END_HOLD_MS = VIEWPORT_BUSY_END_HOLD_MS;
const IDLE_MS = VIEWPORT_BUSY_IDLE_MS;

let endTimer: ReturnType<typeof setTimeout> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
/** When the current busy gesture latched; undefined while idle. */
let busySince: number | undefined;

const clearEndTimer = (): void => {
  if (endTimer === undefined) return;
  clearTimeout(endTimer);
  endTimer = undefined;
};

const clearIdleTimer = (): void => {
  if (idleTimer === undefined) return;
  clearTimeout(idleTimer);
  idleTimer = undefined;
};

const syncDom = (): void => {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute(VIEWPORT_BUSY_ATTR, viewportBusy$.peek());
};

const setIdle = (): void => {
  clearEndTimer();
  clearIdleTimer();
  busySince = undefined;
  if (viewportBusy$.peek()) {
    viewportBusy$.set(false);
    canvasPerformance.recordViewportBusy(false);
  }
  syncDom();
};

/**
 * Enter (or stay in) the busy freeze. Idempotent; cancels a pending release
 * and refreshes the inactivity watchdog — busy means "work arrived recently",
 * so only sustained silence releases the gate.
 */
export const markViewportBusy = (): void => {
  clearEndTimer();
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    setIdle();
  }, IDLE_MS);
  busySince ??= Date.now();
  if (!viewportBusy$.peek()) {
    viewportBusy$.set(true);
    canvasPerformance.recordViewportBusy(true);
  }
  syncDom();
};

/** Release hold for the current gesture: short for a camera move, a bridge for a sustained gesture. */
const releaseHoldMs = (): number =>
  busySince !== undefined && Date.now() - busySince >= VIEWPORT_BUSY_SUSTAINED_MS
    ? VIEWPORT_BUSY_GESTURE_HOLD_MS
    : END_HOLD_MS;

/** Schedule release after the gesture's hold of no further marks. */
export const releaseViewportBusy = (): void => {
  clearEndTimer();
  endTimer = setTimeout(() => {
    endTimer = undefined;
    setIdle();
  }, releaseHoldMs());
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
