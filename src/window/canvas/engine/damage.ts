/**
 * Damage (#915): a frame that only motion drives redraws the device pixels
 * its in-view movers can reach, not the whole screen. The engine keeps the
 * last frame in a texture of its own, draws the damaged rectangles into it
 * with `loadOp: "load"` and a scissor each, and copies it to the canvas.
 */

import type { Camera, Rect } from "../contract";

export type PixelRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/**
 * Scissor rectangles past this count merge into their bounding box. Each
 * rectangle re-runs the draw list's vertex stage, so a design value keeps
 * the vertex cost to a few full passes while the pixels stay bounded.
 */
export const DAMAGE_RECTS_MAX = 8;

/** One device pixel of antialiasing ramp on each side of a damaged rectangle. */
const PAD_PX = 1;

const overlaps = (a: PixelRect, b: PixelRect): boolean =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

const union = (a: PixelRect, b: PixelRect): PixelRect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/**
 * Board rectangles to device-pixel scissors: projected with the camera,
 * padded, snapped outwards, clipped to the target, overlapping ones merged,
 * and past `max` one bounding box.
 */
export const damageRects = (
  board: ReadonlyArray<Rect>,
  camera: Camera,
  pixelRatio: number,
  target: { readonly width: number; readonly height: number },
  max: number = DAMAGE_RECTS_MAX,
): PixelRect[] => {
  const out: PixelRect[] = [];
  for (const rect of board) {
    const x0 = Math.max(0, Math.floor((rect.x * camera.zoom + camera.x) * pixelRatio) - PAD_PX);
    const y0 = Math.max(0, Math.floor((rect.y * camera.zoom + camera.y) * pixelRatio) - PAD_PX);
    const x1 = Math.min(target.width, Math.ceil(((rect.x + rect.width) * camera.zoom + camera.x) * pixelRatio) + PAD_PX);
    const y1 = Math.min(target.height, Math.ceil(((rect.y + rect.height) * camera.zoom + camera.y) * pixelRatio) + PAD_PX);
    if (x1 <= x0 || y1 <= y0) continue;
    let next: PixelRect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    // Fold every rectangle this one touches into it, until none is left.
    for (let index = out.length - 1; index >= 0; index -= 1) {
      if (!overlaps(out[index]!, next)) continue;
      next = union(out[index]!, next);
      out.splice(index, 1);
      index = out.length;
    }
    out.push(next);
  }
  if (out.length <= max) return out;
  return [out.reduce(union)];
};
