/**
 * Crew attention clock — discrete 90 ms phases, no CSS interpolation.
 *
 * Chromium samples interpolating CSS animations every vsync, which keeps the
 * GPU helper and WindowServer presenting the whole window. This clock stamps
 * `html[data-mark-frame]` so ActivityMark sprites step through precomposed
 * atlas frames (activity-atlas.ts). Between ticks the compositor can idle.
 *
 * Refcounted: runs only while at least one looping ActivityMark is on screen.
 * Pauses with surface-motion (hidden / reduced-motion) and below the near
 * level-of-detail tier (loops fall to their rest pose), and freezes mid-pan.
 * After a pan it resumes only once the camera has been quiet for a hold:
 * operator input arrives in bursts, and the busy gate can drop between them.
 */

import { observable } from "@legendapp/state";
import { canvasTier$, tierMoves } from "./canvas-tier";
import { surfaceMotionLive$ } from "./surface-motion";
import { viewportBusy$ } from "./viewport-busy";

export const ATTENTION_CLOCK_TICK_MS = 90;
/** Frames per cycle: 32 x 90 ms = 2.88 s, the period every loop is drawn to. */
export const ATTENTION_CLOCK_FRAMES = 32;
/** Quiet camera time after a pan before the loops step again. */
export const ATTENTION_CLOCK_RESUME_MS = 600;

const ATTR_FRAME = "markFrame";

export const attentionFrame$ = observable(0);

let refs = 0;
let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let unsubMotion: (() => void) | undefined;
let unsubBusy: (() => void) | undefined;
let unsubTier: (() => void) | undefined;
/** Pending resume after the camera went quiet. */
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
/** The camera moved and has not yet been quiet for the resume hold. */
let settling = false;

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

/** Motion allowed at all: loops show their pose only while this holds. */
const motionAllowed = (): boolean => surfaceMotionLive$.peek() && tierMoves(canvasTier$.peek());

const canRun = (): boolean =>
  refs > 0 && motionAllowed() && !viewportBusy$.peek() && !settling;

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

const clearResume = (): void => {
  if (resumeTimer === undefined) return;
  clearTimeout(resumeTimer);
  resumeTimer = undefined;
};

const sync = (): void => {
  if (canRun()) startTimer();
  else {
    stopTimer();
    if (refs === 0 || !motionAllowed()) clearStamp();
  }
};

/** Busy froze the loops; release waits out the resume hold before stepping. */
const onBusy = (): void => {
  clearResume();
  if (viewportBusy$.peek()) {
    settling = true;
  } else if (settling) {
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      settling = false;
      sync();
    }, ATTENTION_CLOCK_RESUME_MS);
  }
  sync();
};

const bindObservers = (): void => {
  if (unsubMotion || unsubBusy || unsubTier) return;
  settling = viewportBusy$.peek();
  unsubMotion = surfaceMotionLive$.onChange(() => sync());
  unsubBusy = viewportBusy$.onChange(onBusy);
  unsubTier = canvasTier$.onChange(() => sync());
};

const unbindObservers = (): void => {
  unsubMotion?.();
  unsubBusy?.();
  unsubTier?.();
  unsubMotion = undefined;
  unsubBusy = undefined;
  unsubTier = undefined;
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
      clearResume();
      settling = false;
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
  clearResume();
  settling = false;
  unbindObservers();
  attentionFrame$.set(0);
  clearStamp();
};
