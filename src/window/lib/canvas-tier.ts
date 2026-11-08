// Canvas level of detail: which tier the camera is in.
//
// A pulled-back camera cannot read what a close one can, and a large board
// pays for every detail it still draws. The canvas renders in four tiers, by
// camera zoom:
//
//   near      full seats, preambles, card text
//   mid       ring and name; no lines, no bubbles
//   far       a seat is its portrait in its ring at a screen size; past a
//             screen's budget of rings the closest seats gather into
//             clusters; cards are faint blocks with their kind's glyph
//   overview  regions and seats; crowded seats gather into clusters
//
// Rings move at every tier (on the compositor): a seat moves wherever it is
// drawn. The tier is stamped on <html> as data-canvas-tier, so CSS switches
// the detail without a React render, and published as canvasTier$ for gates
// in script (seat clusters at the overview). Hysteresis: a boundary must be
// crossed by a margin before the tier flips, so a camera resting on a
// boundary never flaps.

import { observable } from "@legendapp/state";

export type CanvasTier = "near" | "mid" | "far" | "overview";

const ORDER: readonly CanvasTier[] = ["near", "mid", "far", "overview"];

/** Zoom at or above which cards read: region glance starts below it. */
export const TIER_NEAR_MIN = 0.62;
/** Zoom at or above which a seat's ring and name still read (glance fully inked below). */
export const TIER_MID_MIN = 0.34;
/** Below this the board is regions. */
export const TIER_FAR_MIN = 0.2;
/** A boundary must be passed by this much zoom before the tier changes. */
export const TIER_HYSTERESIS = 0.03;

export const TIER_ATTR = "data-canvas-tier";

const tierAt = (zoom: number): CanvasTier =>
  zoom >= TIER_NEAR_MIN ? "near" : zoom >= TIER_MID_MIN ? "mid" : zoom >= TIER_FAR_MIN ? "far" : "overview";

/**
 * The tier for a zoom, given the tier the camera is in now. Moving to less
 * detail needs the zoom a margin below the boundary; moving back needs it a
 * margin above.
 */
export const tierForZoom = (zoom: number, previous?: CanvasTier): CanvasTier => {
  if (!Number.isFinite(zoom) || zoom <= 0) return previous ?? "near";
  if (previous === undefined) return tierAt(zoom);
  const now = ORDER.indexOf(previous);
  const lower = tierAt(zoom + TIER_HYSTERESIS);
  if (ORDER.indexOf(lower) > now) return lower;
  const higher = tierAt(zoom - TIER_HYSTERESIS);
  if (ORDER.indexOf(higher) < now) return higher;
  return previous;
};

export const canvasTier$ = observable<CanvasTier>("near");

/**
 * Counts each time the camera comes to rest after a pan or zoom. For what is
 * placed against the edge of the view once and must be placed again when the
 * view has moved (a seat's bubble), without following every frame of it.
 */
export const cameraSettled$ = observable(0);

/** How long the camera must hold still to count as at rest. */
export const CAMERA_SETTLE_MS = 160;

/** Publish the camera zoom: stamps <html> and the observable when the tier changes. */
export const publishCanvasTier = (zoom: number): CanvasTier => {
  const next = tierForZoom(zoom, canvasTier$.peek());
  if (typeof document !== "undefined" && document.documentElement.getAttribute(TIER_ATTR) !== next) {
    document.documentElement.setAttribute(TIER_ATTR, next);
  }
  if (canvasTier$.peek() !== next) canvasTier$.set(next);
  return next;
};

/** The canvas unmounted: no tier, full detail anywhere else a mark is drawn. */
export const clearCanvasTier = (): void => {
  if (typeof document !== "undefined") document.documentElement.removeAttribute(TIER_ATTR);
  if (canvasTier$.peek() !== "near") canvasTier$.set("near");
};

/** Screen diameter a far seat's ring is held at, when its neighbours leave room. */
export const FAR_RING_SCREEN_PX = 40;
/** The seat ring's own diameter (node-geometry.ts SEAT_RING_PX). */
const SEAT_RING_UNITS = 52;
/** Custom property on the ReactFlow root that canvas-lod.css scales far rings by. */
export const FAR_SEAT_SCALE_VAR = "--far-seat-scale";

/** The largest scale a ring is drawn at: FAR_RING_SCREEN_PX at the camera's minimum zoom (0.15). */
export const SEAT_SCALE_MAX = 5.2;
/**
 * The smallest a seat ring is drawn at the overview, on screen: a crowded
 * ring shrinks to this before its seat gathers into a cluster
 * (seat-clusters.ts SEAT_FLOOR_SCREEN_PX).
 */
export const OVERVIEW_RING_FLOOR_PX = 22;
/** Custom property on the ReactFlow root: the scale that draws a seat ring at the overview floor. */
export const SEAT_FLOOR_SCALE_VAR = "--seat-floor-scale";

/**
 * Steps a scale is rounded up to. Tenths, not halves: the ring must never be
 * more than 2px over its screen floor (seat-ring-room.test.ts), and at the
 * far tier's closest zoom 40 + 2px leaves room for a step of only about 0.09.
 * A coarser step bought fewer whole-board restyles but broke that bound.
 */
const SCALE_STEP = 0.1;

const scaleFor = (screenPx: number, zoom: number, floor: number): number => {
  if (!Number.isFinite(zoom) || zoom <= 0) return floor;
  const exact = screenPx / (SEAT_RING_UNITS * zoom);
  return Math.min(SEAT_SCALE_MAX, Math.max(floor, Math.ceil(exact / SCALE_STEP) * SCALE_STEP));
};

/**
 * The scale that draws a 52-unit seat ring FAR_RING_SCREEN_PX across at this
 * zoom, rounded up to a tenth so the ring never passes its screen floor.
 * Never below the 1.75 a ring is drawn at before the floor
 * bites, never above SEAT_SCALE_MAX.
 */
export const farSeatScale = (zoom: number): number => scaleFor(FAR_RING_SCREEN_PX, zoom, 1.75);

/** The scale that draws a seat ring OVERVIEW_RING_FLOOR_PX across at this zoom. */
export const seatFloorScale = (zoom: number): number => scaleFor(OVERVIEW_RING_FLOOR_PX, zoom, 1);

/** The text a scale is written as; the ease must use the value the page reads back. */
const scaleText = (value: number): string => value.toFixed(1);
const writtenScale = (value: number): number => Number(scaleText(value));

/** The two scales a ring's size is drawn from at far and overview (canvas-lod.css --seat-s). */
export type SeatScales = { readonly far: number; readonly floor: number };

const publishedScales = new WeakMap<HTMLElement, SeatScales>();

/** Write a custom property only when its text changes; returns whether it wrote. */
const writeCustom = (el: HTMLElement, name: string, text: string): boolean => {
  if (el.style.getPropertyValue(name) === text) return false;
  el.style.setProperty(name, text);
  return true;
};

/**
 * The scale consumers, written where they are read. A write on the ReactFlow
 * root inherits into every element on the board, so Blink restyles all 17,843
 * of them at a rest. Writing on the consumers scopes the restyle to them.
 *
 * The spine card carries its instruments at near and mid; at far and
 * overview it is a chip and a pip, and a note or label keeps its tick. Those
 * are the elements whose boxes are held in screen pixels.
 */
const writeNodeScale = (host: HTMLElement, tier: CanvasTier, value: number): void => {
  const text = scaleText(value);
  const selector = tier === "near" || tier === "mid"
    ? ".react-flow__viewport :is(.spine-card, .tasks-enqueue)"
    : ".react-flow__viewport :is(.spine-chip, .spine-pip, .tasks-enqueue), .react-flow__viewport .junto-node[data-look='spine'][data-node-kind='text'], .react-flow__viewport .junto-node[data-look='spine'][data-node-kind='label'] .label-surface";
  for (const element of host.querySelectorAll<HTMLElement>(selector)) {
    writeCustom(element, NODE_SCALE_VAR, text);
  }
};

/** The cluster badges are outside the viewport: their body carries the far scale directly. */
const writeClusterScale = (far: number): void => {
  if (typeof document === "undefined") return;
  const text = `translate(-50%, -50%) scale(${String(far)})`;
  for (const body of document.querySelectorAll<HTMLElement>(".junto-seat-cluster__body")) {
    if (body.style.transform !== text) body.style.transform = text;
  }
};

/**
 * Publish the ring size on the marks that are on screen and not gathered.
 * The inline --seat-s stops at the mark and its seat, rather than inheriting
 * from the ReactFlow root into every card. A gathered seat is hidden and
 * takes its size when it comes out and the rest writes the marks again.
 */
const writeSeatScales = (
  host: HTMLElement,
  tier: CanvasTier,
  to: SeatScales,
  camera?: CameraWindow,
): boolean => {
  const gathered = gatheredSeatIds();
  let changed = false;
  for (const mark of host.querySelectorAll<HTMLElement>(".react-flow__viewport .junto-seat > .junto-mark")) {
    const seat = mark.parentElement;
    const node = mark.closest<HTMLElement>(".react-flow__node");
    if (seat === null) continue;
    if (node !== null && gathered.has(node.dataset.id ?? "")) continue;
    if (node !== null && camera !== undefined && camera.zoom > 0 && !onScreen(node, camera, RING_UNITS * Math.max(to.far, to.floor))) continue;
    const cap = Number(node?.style.getPropertyValue("--ring-cap")) || 1.75;
    const size = String(seatScale(tier, to, cap));
    if (writeCustom(mark, "--seat-s", size)) changed = true;
    const text = seat.querySelector<HTMLElement>(".junto-seat__text");
    if (text !== null) {
      writeCustom(text, "--seat-s", size);
      writeCustom(text, FAR_SEAT_SCALE_VAR, scaleText(to.far));
    }
    const ring = mark.getAttribute("data-mark-ring") ?? "rest";
    const selected = node?.classList.contains("selected") === true || node?.matches(":hover") === true;
    if (selected || ring === "call" || ring === "wait" || ring === "halt") {
      writeCustom(seat, "--seat-s", size);
    }
  }
  return changed;
};

/** How long the ring's size eases after a camera rest. Same 160 ms the CSS keyframe ran. */
export const SEAT_EASE_MS = 160;
/** The ease's curve, unchanged from the CSS keyframe. */
export const SEAT_EASE_CURVE = "cubic-bezier(.33, 1, .68, 1)";
/** The animation's id, so a second rest in the same second replaces the first instead of stacking. */
export const SEAT_EASE_ID = "junto-seat-ease";

/** The size a ring draws at, for a tier and the room around it (canvas-lod.css --seat-s). */
const seatScale = (tier: CanvasTier, scales: SeatScales, cap: number): number =>
  tier === "overview"
    ? Math.max(scales.floor, Math.min(scales.far, cap))
    : Math.max(1, Math.min(scales.far, cap));

/**
 * The ratio a ring eases from: the size it drew at before this publish over
 * the size it draws now. Capped rings (no room to grow) come out at 1 and do
 * not move, exactly as the CSS min()/max() gave.
 */
export const seatEaseRatio = (tier: CanvasTier, from: SeatScales, to: SeatScales, cap: number): number => {
  const before = seatScale(tier, from, cap);
  const after = seatScale(tier, to, cap);
  if (!(before > 0) || !(after > 0)) return 1;
  return before / after;
};

const motionPaused = (): boolean =>
  typeof document !== "undefined" && document.documentElement.getAttribute("data-surface-motion") === "paused";

/**
 * Start the ring's size ease on every seat mark in the camera's plane, in the
 * same task as the size publish: the new size is already in layout, so the
 * first frame draws at the old size and eases to no transform at all.
 *
 * A far ring is sized by layout (its --mark-u), not by a scale transform: a
 * continuous scale over the turning parts made Chromium draw every ring
 * offscreen on every frame ("2D scale transform with composited descendants",
 * 16 render passes a frame on the operator's board at the overview). The ease
 * is a FLIP, 160 ms long, which is a different thing.
 *
 * Transform only, run by the compositor through the Web Animations API. The
 * CSS keyframe this replaces read --seat-s in its from/to, so Blink treated
 * it as a main-thread animation and restyled every mark it started on: 2304
 * Animation invalidations and half the zoom's style recalc (canvas-tier.budget
 * probe, 2026-11-08). A numeric ratio composites and restyles nothing.
 *
 * Every seat mark is eased, not just the looping ones: a resting or stopped
 * ring on screen changes size after a rest too, and Chromium drops an
 * offscreen animation that has nothing to show.
 */
const runningEases = new WeakMap<HTMLElement, { cancel: () => void }>();

/** The camera, as React Flow holds it: the translate, the zoom and the window size. */
export type CameraWindow = {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Whether a seat's ring can be on screen, from the node's own translate and
 * the camera window: no layout read, so the ease never flushes the board it
 * is about to animate. A seat is 240x96 units and its ring reaches half its
 * drawn size past the centre; a generous margin keeps a ring entering the
 * window in the ease rather than snapping.
 */
const SEAT_UNITS = 240;
const SEAT_HEIGHT_UNITS = 96;
const RING_UNITS = 52;
const SCREEN_MARGIN_UNITS = 160;

const onScreen = (node: HTMLElement, camera: CameraWindow, ringUnits: number): boolean => {
  const match = /translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/u.exec(node.style.transform);
  if (match === null) return true;
  if (!(camera.zoom > 0) || !(camera.width > 0) || !(camera.height > 0)) return true;
  const reach = ringUnits / 2 + SCREEN_MARGIN_UNITS;
  const left = -camera.x / camera.zoom - reach;
  const top = -camera.y / camera.zoom - reach;
  const right = (-camera.x + camera.width) / camera.zoom + reach;
  const bottom = (-camera.y + camera.height) / camera.zoom + reach;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return x + SEAT_UNITS >= left && x <= right && y + SEAT_HEIGHT_UNITS >= top && y <= bottom;
};

/**
 * The seats the cluster sheet hides at this tier (SeatClusterLayer): gathered
 * into a badge, `visibility: hidden !important`. Their ids are read from the
 * sheet's own text, never from a computed style: a style read here would flush
 * the board the size publish just invalidated, inside the frame (p95 83 ms
 * against 19 ms without the ease, factory fixture, 2026-11-08).
 */
const gatheredSeatIds = (): Set<string> => {
  const sheet = typeof document === "undefined" ? null : document.getElementById("junto-seat-clusters");
  const text = sheet?.textContent ?? "";
  if (text === "") return new Set();
  return new Set([...text.matchAll(/data-id="([^"]+)"/gu)].map((match) => match[1]!));
};

const easeSeatRings = (host: HTMLElement, tier: CanvasTier, from: SeatScales, to: SeatScales, camera?: CameraWindow): void => {
  if (motionPaused()) return;
  const gathered = gatheredSeatIds();
  const started: Array<[HTMLElement, number]> = [];
  // Geometry, not data-mark-visible: a resting or stopped ring on screen
  // changes size after a rest too. A ring outside the camera window is
  // skipped, since an animation nobody can see is main-thread work.
  for (const mark of host.querySelectorAll<HTMLElement>(".react-flow__viewport .junto-seat > .junto-mark")) {
    const node = mark.closest<HTMLElement>(".react-flow__node");
    if (node !== null && camera !== undefined && !onScreen(node, camera, RING_UNITS * Math.max(to.far, to.floor))) continue;
    // A gathered seat is visibility:hidden, and a transform animation on it
    // cannot composite (Blink runs it on the main thread for nothing: 171 of
    // them in one zoom sweep). Only a mark that can be seen eases.
    if (node !== null && gathered.has(node.dataset.id ?? "")) continue;
    const cap = Number(node?.style.getPropertyValue("--ring-cap")) || 1.75;
    const ratio = seatEaseRatio(tier, from, to, cap);
    if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.002) continue;
    started.push([mark, ratio]);
  }
  // Started in this task, after the size write: the first frame renders the
  // new size under an animation at t=0, which is the old size.
  for (const [mark, ratio] of started) {
    runningEases.get(mark)?.cancel();
    runningEases.set(mark, mark.animate([{ transform: `scale(${String(ratio)})` }, { transform: "none" }], {
      id: SEAT_EASE_ID,
      duration: SEAT_EASE_MS,
      easing: SEAT_EASE_CURVE,
    }));
  }
};

/**
 * A ring entering far or overview grows from its near size, as the transform
 * transition did when the tier rule first applied. Mid-gesture, so it writes
 * nothing: the ease alone starts it, from the size published at the last rest.
 */
export const easeSeatScaleOnTierEntry = (
  host: HTMLElement | null,
  was: CanvasTier,
  next: CanvasTier,
  camera?: CameraWindow,
): void => {
  const enlarged = (tier: CanvasTier): boolean => tier === "far" || tier === "overview";
  if (host === null || enlarged(was) || !enlarged(next)) return;
  const published = publishedScales.get(host);
  if (published === undefined) return;
  easeSeatRings(host, next, { far: 1, floor: 1 }, published, camera);
};

/** Custom property on the ReactFlow root: the inverse zoom, for sizes held in screen pixels (spine discs, focus rings). */
export const NODE_SCALE_VAR = "--node-s";

/** The largest node scale: the inverse of the camera's minimum zoom (0.15). */
const NODE_SCALE_MAX = 6.7;

/** The inverse zoom, rounded up to a tenth like the seat scales, between 1 and NODE_SCALE_MAX. */
export const nodeScale = (zoom: number): number => {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(NODE_SCALE_MAX, Math.max(1, Math.ceil((1 / zoom) * 10) / 10));
};

/**
 * Write the far seat scale, the overview floor and the node scale on `host`
 * (the ReactFlow root) when they change, and start the ring's size ease in
 * the same task, so the first frame after a rest draws at the old size.
 */
export const publishFarSeatScale = (
  host: HTMLElement | null,
  zoom: number,
  tier: CanvasTier = canvasTier$.peek(),
  camera?: CameraWindow,
): void => {
  if (host === null) return;
  writeNodeScale(host, tier, nodeScale(zoom));
  const to = { far: writtenScale(farSeatScale(zoom)), floor: writtenScale(seatFloorScale(zoom)) };
  const from = publishedScales.get(host);
  const rings = tier === "far" || tier === "overview";
  if (rings) writeSeatScales(host, tier, to, camera);
  writeClusterScale(to.far);
  if (rings && from !== undefined && (from.far !== to.far || from.floor !== to.floor)) {
    easeSeatRings(host, tier, from, to, camera);
  }
  publishedScales.set(host, to);
  try {
    // The rest-trace probe lands its frame on this publish.
    performance.mark("seat-scale-publish");
  } catch {
    // performance.mark is diagnostics; the publish must still land.
  }
};
