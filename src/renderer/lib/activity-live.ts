/**
 * Live rings: every looping ActivityMark on screen is painted fresh on every
 * display frame, by the same painters the atlas bakes (activity-rings.ts),
 * at a continuous phase. Nothing steps, nothing is throttled: the comet
 * glides, the heartbeat swells, the wave travels at the display's own rate.
 *
 * Motion law: the rings are the product's heartbeat, not a cost to trade.
 * Never slow this loop, step it, throttle it, or still a moving ring to save
 * frames; tests/motion-law.test.ts holds the line, and changing it is the
 * operator's call alone.
 *
 * Only a ring on screen is drawn. Hidden windows and reduced motion pause
 * every ring at its rest pose (the atlas cell underneath), and resume them
 * where the clock stands.
 */

import type { ThemeMode } from "@shared/theme";
import type { ActivityTone } from "./activity";
import {
  LAND_FRAMES,
  RING_CYCLE_FRAMES,
  RING_FRAME_MS,
  paintDone,
  paintLoop,
  type LoopRing,
} from "./activity-rings";
import { MARK_BOX, MARK_CELL, paletteFor, tonesFor } from "./activity-atlas";
import { surfaceMotionLive$ } from "./surface-motion";

/** The painter frame at a moment: continuous, never rounded to a step. */
export const ringFrameAt = (ms: number): number => (ms / RING_FRAME_MS) % RING_CYCLE_FRAMES;

export type LiveRing = {
  readonly ring: LoopRing;
  readonly tone: ActivityTone;
  readonly theme: ThemeMode;
  /** Done: draw the ring closing once before the loop takes over. */
  readonly land: boolean;
};

type Live = LiveRing & {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly landStart: number;
  px: number;
  measuredAt: number;
};

const ATTR_LIVE = "data-mark-live";
const REMEASURE_MS = 400;

const live = new Map<HTMLElement, Live>();
/** A done ring lands once per element, however often it scrolls into view. */
const landed = new WeakMap<HTMLElement, number>();
let raf = 0;
let unsubMotion: (() => void) | undefined;

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

const themeOf = (m: Live): ThemeMode => {
  const scoped = m.el.closest("[data-mark-theme]")?.getAttribute("data-mark-theme");
  return scoped === "dark" || scoped === "bright" ? scoped : m.theme;
};

/** Backing pixels for the mark as drawn now, zoom and display density included. */
const measure = (m: Live, t: number): void => {
  m.measuredAt = t;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const px = Math.max(8, Math.min(512, Math.round(m.el.getBoundingClientRect().width * dpr)));
  if (px === m.px) return;
  m.px = px;
  m.canvas.width = px;
  m.canvas.height = px;
};

const draw = (m: Live, t: number): void => {
  if (t - m.measuredAt > REMEASURE_MS) measure(m, t);
  const { ctx, px } = m;
  const mode = themeOf(m);
  const color = tonesFor(mode)[m.tone];
  const base = paletteFor(mode);
  // Bloom is in backing pixels; keep it in proportion to the atlas cell.
  const palette = { ...base, glow: base.glow * (px / MARK_CELL) };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, px, px);
  ctx.setTransform(px / MARK_BOX, 0, 0, px / MARK_BOX, 0, 0);
  const sinceLand = (t - m.landStart) / RING_FRAME_MS;
  if (m.land && sinceLand < LAND_FRAMES) paintDone(ctx, palette, color, sinceLand);
  else paintLoop(ctx, palette, m.ring, color, ringFrameAt(t));
};

const frame = (t: number): void => {
  raf = 0;
  if (!surfaceMotionLive$.peek() || live.size === 0) return;
  for (const m of live.values()) draw(m, t);
  raf = requestAnimationFrame(frame);
};

const schedule = (): void => {
  if (raf !== 0 || live.size === 0 || !surfaceMotionLive$.peek()) return;
  if (typeof requestAnimationFrame !== "function") return;
  raf = requestAnimationFrame(frame);
};

/** Paused: every ring shows its atlas rest pose; live: the canvases take over. */
const showLive = (on: boolean): void => {
  for (const m of live.values()) {
    m.canvas.hidden = !on;
    if (on) m.el.setAttribute(ATTR_LIVE, "");
    else m.el.removeAttribute(ATTR_LIVE);
  }
};

const syncMotion = (): void => {
  const on = surfaceMotionLive$.peek();
  showLive(on);
  if (on) schedule();
};

/**
 * Start painting one on-screen looping mark. The canvas is the mark's first
 * child, under the portrait and the band. Returns the disposer.
 */
export const startLiveRing = (el: HTMLElement, ring: LiveRing): (() => void) => {
  stopLiveRing(el);
  if (typeof document === "undefined") return () => undefined;
  const canvas = document.createElement("canvas");
  canvas.className = "junto-mark__live";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => undefined;
  const t = now();
  const landStart = landed.get(el) ?? t;
  landed.set(el, landStart);
  const m: Live = { ...ring, el, canvas, ctx, landStart, px: 0, measuredAt: -Infinity };
  el.prepend(canvas);
  live.set(el, m);
  unsubMotion ??= surfaceMotionLive$.onChange(syncMotion);
  const on = surfaceMotionLive$.peek();
  canvas.hidden = !on;
  if (on) {
    el.setAttribute(ATTR_LIVE, "");
    // Paint at once so the first frame on screen is already the live ring.
    draw(m, t);
  }
  schedule();
  return () => stopLiveRing(el);
};

export const stopLiveRing = (el: HTMLElement): void => {
  const m = live.get(el);
  if (!m) return;
  live.delete(el);
  m.canvas.remove();
  el.removeAttribute(ATTR_LIVE);
  if (live.size > 0) return;
  if (raf !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
  raf = 0;
  unsubMotion?.();
  unsubMotion = undefined;
};

/** Rings being painted now; for the gallery readout and tests. */
export const liveRingCount = (): number => live.size;

/** Test helper. */
export const resetLiveRingsForTests = (): void => {
  for (const el of [...live.keys()]) stopLiveRing(el);
};
