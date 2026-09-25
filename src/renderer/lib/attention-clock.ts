/**
 * Crew attention clock — discrete 90 ms phases, no CSS interpolation.
 *
 * Chromium samples interpolating CSS animations every vsync, which keeps the
 * GPU helper and WindowServer presenting the whole window. This clock stamps
 * `html[data-mark-frame]` so ActivityMark sprites step through precomposed
 * atlas frames (activity-atlas.ts). Between ticks the compositor can idle.
 *
 * Refcounted: runs only while at least one looping ActivityMark is on screen.
 * Pauses with surface-motion (hidden / reduced-motion) and freezes mid-pan.
 */

import { observable } from "@legendapp/state";
import { surfaceMotionLive$ } from "./surface-motion";
import { viewportBusy$ } from "./viewport-busy";

export const ATTENTION_CLOCK_TICK_MS = 90;
/** Frames per cycle: 32 x 90 ms = 2.88 s, the period every loop is drawn to. */
export const ATTENTION_CLOCK_FRAMES = 32;

const ATTR_FRAME = "markFrame";

export const attentionFrame$ = observable(0);

let refs = 0;
let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let unsubMotion: (() => void) | undefined;
let unsubBusy: (() => void) | undefined;

const stamp = (frame: number): void => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset[ATTR_FRAME] = String(frame);
};

const clearStamp = (): void => {
  if (typeof document === "undefined") return;
  delete document.documentElement.dataset[ATTR_FRAME];
};

const applyTick = (): void => {
  const frame = tick % ATTENTION_CLOCK_FRAMES;
  if (attentionFrame$.peek() !== frame) attentionFrame$.set(frame);
  stamp(frame);
};

const canRun = (): boolean =>
  refs > 0 && surfaceMotionLive$.peek() && !viewportBusy$.peek();

const advance = (): void => {
  if (!canRun()) return;
  tick += 1;
  applyTick();
};

const stopTimer = (): void => {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
};

const startTimer = (): void => {
  if (timer !== undefined || typeof setInterval !== "function") return;
  if (!canRun()) return;
  applyTick();
  timer = setInterval(advance, ATTENTION_CLOCK_TICK_MS);
};

const sync = (): void => {
  if (canRun()) startTimer();
  else {
    stopTimer();
    if (refs === 0 || !surfaceMotionLive$.peek()) clearStamp();
  }
};

const bindObservers = (): void => {
  if (unsubMotion || unsubBusy) return;
  unsubMotion = surfaceMotionLive$.onChange(() => sync());
  unsubBusy = viewportBusy$.onChange(() => sync());
};

const unbindObservers = (): void => {
  unsubMotion?.();
  unsubBusy?.();
  unsubMotion = undefined;
  unsubBusy = undefined;
};

/** Keep the clock alive for one visible looping mark. Returns a disposer. */
export const retainAttentionClock = (): (() => void) => {
  refs += 1;
  bindObservers();
  sync();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refs = Math.max(0, refs - 1);
    if (refs === 0) {
      stopTimer();
      unbindObservers();
      clearStamp();
    }
  };
};

/** Test helper — drop timer, stamps, and refcount. */
export const resetAttentionClockForTests = (): void => {
  refs = 0;
  tick = 0;
  stopTimer();
  unbindObservers();
  attentionFrame$.set(0);
  clearStamp();
};
