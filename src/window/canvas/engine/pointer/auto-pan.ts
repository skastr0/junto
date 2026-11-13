/**
 * Edge auto-pan: how far the camera moves each display frame while a drag, a
 * connect or a marquee holds the pointer near the canvas's edge (section 15).
 *
 * It replaces React Flow's `calcAutoPan` (rf-system:570-583) with the same
 * numbers: speed 15 within 40 px of an edge, the velocity rising from 1/40 of
 * the speed at the inner line to the whole speed at the edge and beyond. The
 * result is in screen pixels per frame and is what `panBy` adds to the camera
 * offset: positive x moves the board right, which shows more of its left.
 */

import type { Point, Size } from "../../contract";

export const AUTO_PAN_SPEED = 15;
export const AUTO_PAN_DISTANCE = 40;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** One axis: 0 between the lines, otherwise a share of the speed in (0, 1]. */
const axisVelocity = (value: number, min: number, max: number): number => {
  if (value < min) return clamp(Math.abs(value - min), 1, min) / min;
  if (value > max) return -clamp(Math.abs(value - max), 1, min) / min;
  return 0;
};

/**
 * The pan for a pointer at `at` (screen, relative to the canvas's top left)
 * over a canvas of `bounds`. Null when the pointer is clear of every edge.
 */
export const autoPan = (
  at: Point,
  bounds: Size,
  speed: number = AUTO_PAN_SPEED,
  distance: number = AUTO_PAN_DISTANCE,
): Point | null => {
  const x = axisVelocity(at.x, distance, bounds.width - distance) * speed;
  const y = axisVelocity(at.y, distance, bounds.height - distance) * speed;
  return x === 0 && y === 0 ? null : { x, y };
};
