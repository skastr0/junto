/**
 * Crew attention clock — discrete 90 ms phases, no CSS interpolation.
 *
 * Chromium samples interpolating CSS animations every vsync, which keeps the
 * GPU helper and WindowServer presenting the whole window. This clock stamps
 * `html[data-attention-phase]` / `html[data-attention-beat]` so ActivityMark
 * cells jump through precomposed states. Between ticks the compositor can idle.
 *
 * Refcounted: runs only while at least one animated ActivityMark is mounted.
 * Pauses with surface-motion (hidden / reduced-motion) and freezes mid-pan.
 */

import { observable } from "@legendapp/state";
import { surfaceMotionLive$ } from "./surface-motion";
import { viewportBusy$ } from "./viewport-busy";

export const ATTENTION_CLOCK_TICK_MS = 90;
export const ATTENTION_CLOCK_PHASES = 8;

const ATTR_PHASE = "attentionPhase";
const ATTR_BEAT = "attentionBeat";

export const attentionPhase$ = observable(0);
export const attentionBeat$ = observable(0);

let refs = 0;
let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let unsubMotion: (() => void) | undefined;
let unsubBusy: (() => void) | undefined;

const stamp = (phase: number, beat: number): void => {
  if (typeof document === "undefined") return;
  const dataset = document.documentElement.dataset;
  dataset[ATTR_PHASE] = String(phase);
  dataset[ATTR_BEAT] = String(beat);
};

const clearStamp = (): void => {
  if (typeof document === "undefined") return;
  delete document.documentElement.dataset[ATTR_PHASE];
  delete document.documentElement.dataset[ATTR_BEAT];
};

const applyTick = (): void => {
  const phase = tick % ATTENTION_CLOCK_PHASES;
  const beat = Math.floor(tick / ATTENTION_CLOCK_PHASES) % 2;
  if (attentionPhase$.peek() !== phase) attentionPhase$.set(phase);
  if (attentionBeat$.peek() !== beat) attentionBeat$.set(beat);
  stamp(phase, beat);
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

/** Keep the clock alive for one animated mark. Returns a disposer. */
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
  attentionPhase$.set(0);
  attentionBeat$.set(0);
  clearStamp();
};
