/**
 * The camera (docs/canvas-gpu-architecture.md, section 14), as arithmetic.
 *
 * Exactly one module does the screen to board and board to screen arithmetic
 * (must 8). A camera is the board's offset on screen in CSS pixels plus the
 * zoom; `screen = board * zoom + (x, y)`. Wheel, pinch, keyboard pan, zoom
 * about a point, fit, centre and the smooth-zoom interpolation all live here,
 * so a test drives them without a DOM and the engine holds no maths of its
 * own.
 *
 * The smooth zoom path is d3's `interpolateZoom` with `p` the view centre and
 * `w` the larger of the view's two sides, because that is what React Flow's
 * transitions did (docs/canvas-gpu-inventory/interaction.md, section 1); the
 * ease is d3's cubic in-out.
 */

import {
  CAMERA_MAX_ZOOM,
  CAMERA_MIN_ZOOM,
  type Camera,
  type Point,
  type Rect,
  type Size,
} from "../contract";
import {
  MAX_PAN_FRAME_MS,
  panRamp,
  panVectorFor,
  PAN_BOOST_MULTIPLIER,
  PAN_SPEED_PX_PER_SECOND,
} from "@shared/canvas-keyboard-pan";

export const CAMERA_SETTLE_MS = 160;
/** React Flow's `panOnScrollSpeed` (Canvas.tsx:1847). */
export const PAN_ON_SCROLL_SPEED = 1.2;
/** `panOnScrollMode` default: both axes. */
export const WHEEL_DELTA_LINE = 0.05;
export const WHEEL_DELTA_PAGE = 1;
export const WHEEL_DELTA_PIXEL = 0.002;
/** macOS trackpad pinch arrives as ctrl+wheel and is ten times faster. */
export const PINCH_CTRL_FACTOR = 10;

export const clampZoom = (zoom: number): number =>
  Math.max(CAMERA_MIN_ZOOM, Math.min(CAMERA_MAX_ZOOM, zoom));

/** The board point under a screen point. */
export const screenToBoard = (camera: Camera, screen: Point): Point => ({
  x: (screen.x - camera.x) / camera.zoom,
  y: (screen.y - camera.y) / camera.zoom,
});

/** The screen point over a board point. */
export const boardToScreen = (camera: Camera, board: Point): Point => ({
  x: board.x * camera.zoom + camera.x,
  y: board.y * camera.zoom + camera.y,
});

/** A board rectangle, on screen. */
export const rectToScreen = (camera: Camera, rect: Rect): Rect => {
  const at = boardToScreen(camera, rect);
  return { x: at.x, y: at.y, width: rect.width * camera.zoom, height: rect.height * camera.zoom };
};

/** Zoom to `zoom` about a screen point, keeping the board point under it. */
export const zoomAbout = (camera: Camera, screen: Point, zoom: number): Camera => {
  const k = clampZoom(zoom);
  if (k === camera.zoom) return camera;
  const board = screenToBoard(camera, screen);
  return { x: screen.x - board.x * k, y: screen.y - board.y * k, zoom: k };
};

/** The camera for a board point centred in a viewport, at a zoom. */
export const centreCamera = (viewport: Size, at: Point, zoom: number): Camera => {
  const k = clampZoom(zoom);
  return { x: viewport.width / 2 - at.x * k, y: viewport.height / 2 - at.y * k, zoom: k };
};

export const boundsOfRects = (rects: ReadonlyArray<Rect>): Rect | undefined => {
  if (rects.length === 0) return undefined;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/**
 * `getViewportForBounds` (rf-system:754-780) for uniform padding: the bounds
 * letterboxed with `padding` of each side, then centred at the clamped zoom.
 */
export const fitCamera = (
  bounds: Rect,
  viewport: Size,
  padding: number,
  maxZoom: number,
): Camera => {
  const width = Math.max(bounds.width, 1);
  const height = Math.max(bounds.height, 1);
  const zoom = Math.min(viewport.width / (width * (1 + padding)), viewport.height / (height * (1 + padding)));
  const k = Math.max(CAMERA_MIN_ZOOM, Math.min(maxZoom, zoom));
  return {
    x: viewport.width / 2 - (bounds.x + bounds.width / 2) * k,
    y: viewport.height / 2 - (bounds.y + bounds.height / 2) * k,
    zoom: k,
  };
};

/** The camera's view in board units. */
export const viewRect = (camera: Camera, viewport: Size): Rect => ({
  x: -camera.x / camera.zoom,
  y: -camera.y / camera.zoom,
  width: viewport.width / camera.zoom,
  height: viewport.height / camera.zoom,
});

/** d3's cubic in-out ease (`defaultEase` in rf-system:2693). */
export const easeCubicInOut = (t: number): number => {
  const u = t * 2;
  return u <= 1 ? (u * u * u) / 2 : (2 - (2 - u) * (2 - u) * (2 - u)) / 2;
};

// d3-interpolate's zoom interpolator (rho = sqrt 2), copied here because the
// engine imports only src/shared/ and the app never depended on d3 directly.
const RHO = Math.SQRT2;
const RHO2 = 2;
const RHO4 = 4;

const cosh = (x: number): number => (Math.exp(x) + 1 / Math.exp(x)) / 2;
const sinh = (x: number): number => (Math.exp(x) - 1 / Math.exp(x)) / 2;
const tanh = (x: number): number => (Math.exp(2 * x) - 1) / (Math.exp(2 * x) + 1);

/** [world centre, width] for a camera over a viewport, as d3 interpolates. */
const viewState = (camera: Camera, viewport: Size): readonly [number, number, number] => {
  const p = { x: viewport.width / 2, y: viewport.height / 2 };
  const centre = screenToBoard(camera, p);
  return [centre.x, centre.y, Math.max(viewport.width, viewport.height) / camera.zoom];
};

/** One frame of a smooth camera move: d3 `interpolateZoom.f(t)` then back to a camera. */
export const interpolateCamera = (
  from: Camera,
  to: Camera,
  viewport: Size,
  t: number,
): Camera => {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const p = { x: viewport.width / 2, y: viewport.height / 2 };
  const [ux0, uy0, w0] = viewState(from, viewport);
  const [ux1, uy1, w1] = viewState(to, viewport);
  const dx = ux1 - ux0;
  const dy = uy1 - uy0;
  const d2 = dx * dx + dy * dy;
  let ux: number;
  let uy: number;
  let w: number;
  if (d2 < 1e-12) {
    const S = Math.log(w1 / w0) / RHO;
    ux = ux0 + t * dx;
    uy = uy0 + t * dy;
    w = w0 * Math.exp(RHO * t * S);
  } else {
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    const S = (r1 - r0) / RHO;
    const s = t * S;
    const coshr0 = cosh(r0);
    const u = (w0 / (RHO2 * d1)) * (coshr0 * tanh(RHO * s + r0) - sinh(r0));
    ux = ux0 + u * dx;
    uy = uy0 + u * dy;
    w = (w0 * coshr0) / cosh(RHO * s + r0);
  }
  const k = Math.max(CAMERA_MIN_ZOOM, Math.min(CAMERA_MAX_ZOOM, Math.max(viewport.width, viewport.height) / w));
  return { x: p.x - ux * k, y: p.y - uy * k, zoom: k };
};

/** How much of the smooth move's duration d3 would have chosen, for parity. */
export const smoothDurationMs = (from: Camera, to: Camera, viewport: Size): number => {
  const [ux0, uy0, w0] = viewState(from, viewport);
  const [ux1, uy1, w1] = viewState(to, viewport);
  const dx = ux1 - ux0;
  const dy = uy1 - uy0;
  const d2 = dx * dx + dy * dy;
  let S: number;
  if (d2 < 1e-12) {
    S = Math.log(w1 / w0) / RHO;
  } else {
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (r1 - r0) / RHO;
  }
  return (S * 1000 * RHO) / Math.SQRT2;
};

// ---------------------------------------------------------------------------
// Wheel and pinch
// ---------------------------------------------------------------------------

export type WheelEvent = {
  readonly at: Point;
  readonly dx: number;
  readonly dy: number;
  readonly deltaMode: number;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
};

export type WheelOutcome = {
  readonly camera: Camera;
  readonly kind: "pan" | "zoom" | "pinch" | "none";
};

/** d3's wheel delta: lines and pages are translated to pixels first. */
export const wheelDelta = (dy: number, deltaMode: number, ctrlFactor: boolean): number =>
  -dy * (deltaMode === 1 ? WHEEL_DELTA_LINE : deltaMode ? WHEEL_DELTA_PAGE : WHEEL_DELTA_PIXEL) * (ctrlFactor ? PINCH_CTRL_FACTOR : 1);

/**
 * The camera after one wheel event, exactly as today's canvas reads it
 * (rf-system:2704-2743, d3-zoom:234-268):
 *
 * - ctrl+wheel on macOS is a trackpad pinch: zoom by `2 ^ (-dy * 0.002 * 10)`
 *   about the pointer.
 * - the platform's zoom key (Meta on macOS, Control elsewhere) zooms by
 *   `2 ^ (-dy * 0.002)` about the pointer.
 * - anything else pans by `-(delta / zoom) * 1.2`, with `deltaMode 1` (lines)
 *   multiplied by 20 first; Shift on non-macOS pans sideways.
 */
export const wheelCamera = (camera: Camera, event: WheelEvent, mac: boolean): WheelOutcome => {
  const zoomKey = mac ? event.meta : event.ctrl;
  if (event.ctrl && mac) {
    const delta = wheelDelta(event.dy, event.deltaMode, true);
    const next = zoomAbout(camera, event.at, camera.zoom * 2 ** delta);
    return next === camera ? { camera, kind: "none" } : { camera: next, kind: "pinch" };
  }
  if (zoomKey) {
    const delta = wheelDelta(event.dy, event.deltaMode, false);
    const next = zoomAbout(camera, event.at, camera.zoom * 2 ** delta);
    return next === camera ? { camera, kind: "none" } : { camera: next, kind: "zoom" };
  }
  const deltaNormalize = event.deltaMode === 1 ? 20 : 1;
  let deltaX = event.dx * deltaNormalize;
  let deltaY = event.dy * deltaNormalize;
  if (!mac && event.shift) {
    deltaX = event.dy * deltaNormalize;
    deltaY = 0;
  }
  if (deltaX === 0 && deltaY === 0) return { camera, kind: "none" };
  return {
    camera: {
      x: camera.x - (deltaX / camera.zoom) * PAN_ON_SCROLL_SPEED,
      y: camera.y - (deltaY / camera.zoom) * PAN_ON_SCROLL_SPEED,
      zoom: camera.zoom,
    },
    kind: "pan",
  };
};

// ---------------------------------------------------------------------------
// Keyboard pan
// ---------------------------------------------------------------------------

const PAN_CODE: Readonly<Record<string, string>> = {
  KeyW: "w",
  KeyA: "a",
  KeyS: "s",
  KeyD: "d",
  ArrowUp: "arrowup",
  ArrowLeft: "arrowleft",
  ArrowDown: "arrowdown",
  ArrowRight: "arrowright",
};

/** A pan key's code (`KeyW`, `ArrowUp`, or already `w`) as the pure pan module names it. */
export const panKeyForCode = (code: string): string | null => {
  const mapped = PAN_CODE[code];
  if (mapped !== undefined) return mapped;
  const lower = code.toLowerCase();
  return lower === "w" || lower === "a" || lower === "s" || lower === "d" || lower === "arrowup" || lower === "arrowleft" || lower === "arrowdown" || lower === "arrowright"
    ? lower
    : null;
};

/** The camera after one keyboard-pan frame, using today's ramp and speeds. */
export const panCamera = (
  camera: Camera,
  keys: Iterable<string>,
  frameMs: number,
  heldMs: number,
  boost: boolean,
): Camera => {
  const vector = panVectorFor(keys);
  if (vector.x === 0 && vector.y === 0) return camera;
  const dt = Math.max(0, Math.min(frameMs, MAX_PAN_FRAME_MS)) / 1000;
  const speed = PAN_SPEED_PX_PER_SECOND * (boost ? PAN_BOOST_MULTIPLIER : 1);
  const step = speed * dt * panRamp(heldMs);
  return { x: camera.x - vector.x * step, y: camera.y - vector.y * step, zoom: camera.zoom };
};

/** Whether two cameras are the same view. */
export const sameCamera = (a: Camera, b: Camera): boolean =>
  a.x === b.x && a.y === b.y && a.zoom === b.zoom;
