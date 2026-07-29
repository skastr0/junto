/**
 * Surface motion gate — freezes continuous CSS/compositor animation when the
 * page cannot be seen (hidden tab / minimized / obscured) or the operator has
 * asked for reduced motion.
 *
 * Sets `document.documentElement.dataset.surfaceMotion` to `"live" | "paused"`.
 * CSS under `html[data-surface-motion="paused"]` stops infinite paints so the
 * GPU process can idle (fans). See styles.css + RtsBottomBar.css.
 *
 * This is independent of viewportBusy$ (pan/zoom freeze) and of fleet WebGL
 * loops (those gate on their own visibility).
 */

import { observable } from "@legendapp/state";

export type SurfaceMotion = "live" | "paused";

const ATTR = "surfaceMotion";

/** True when continuous decorative motion is allowed to run. */
export const surfaceMotionLive$ = observable(true);

const readReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

const readPageVisible = (): boolean => {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible";
};

/** Window focus is advisory — a blurred-but-visible window still paints; we
 * only pause on full hide / reduced-motion. Blur alone stays live so glance
 * status remains correct on a second display. */
export const computeSurfaceMotion = (input: {
  readonly pageVisible: boolean;
  readonly reducedMotion: boolean;
}): SurfaceMotion => (input.pageVisible && !input.reducedMotion ? "live" : "paused");

const applyDom = (motion: SurfaceMotion): void => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset[ATTR] = motion;
  const live = motion === "live";
  if (surfaceMotionLive$.peek() !== live) surfaceMotionLive$.set(live);
};

const recompute = (): SurfaceMotion => {
  const motion = computeSurfaceMotion({
    pageVisible: readPageVisible(),
    reducedMotion: readReducedMotion(),
  });
  applyDom(motion);
  return motion;
};

let started = false;
let stop: (() => void) | undefined;

/**
 * Install document/window listeners and stamp the initial dataset value.
 * Idempotent. Returns a disposer (tests + hot reload).
 */
export const startSurfaceMotionGate = (): (() => void) => {
  if (started && stop) return stop;
  started = true;

  const onVisibility = (): void => {
    recompute();
  };

  let motionQuery: MediaQueryList | undefined;
  const onMotionChange = (): void => {
    recompute();
  };

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Safari still has addListener; modern browsers use addEventListener.
    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", onMotionChange);
    } else {
      motionQuery.addListener(onMotionChange);
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  recompute();

  stop = () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
      delete document.documentElement.dataset[ATTR];
    }
    if (motionQuery) {
      if (typeof motionQuery.removeEventListener === "function") {
        motionQuery.removeEventListener("change", onMotionChange);
      } else {
        motionQuery.removeListener(onMotionChange);
      }
    }
    surfaceMotionLive$.set(true);
    started = false;
    stop = undefined;
  };

  return stop;
};

/** Test helper — force a motion state without listeners. */
export const setSurfaceMotionForTests = (motion: SurfaceMotion): void => {
  applyDom(motion);
};

/** Test helper — drop listeners and clear the dataset. */
export const resetSurfaceMotionGate = (): void => {
  stop?.();
  if (typeof document !== "undefined") {
    delete document.documentElement.dataset[ATTR];
  }
  surfaceMotionLive$.set(true);
  started = false;
};
