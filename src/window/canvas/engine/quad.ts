/**
 * The quad record (docs/canvas-gpu-architecture.md, section 6; contract.ts,
 * "Drawing records"). One record type, one pipeline, one ordered list.
 *
 * A `Quad` from `paint/` is plain data: a rectangle, a style, an atlas cell, a
 * motion and a tier mask. The engine interns it into this fixed-size record at
 * a stable slot and writes only that slot's bytes when it changes. This module
 * is the one place that knows the byte layout; the shader in `renderer.ts`
 * carries the same field order.
 *
 * Layout, 32 words (128 bytes) per record:
 *
 *   0  rect x,y,w,h            f32x4   relative to the card's top-left
 *   16 radii tl,tr,br,bl       f32x4   board units
 *   32 fill rgba               unorm8x4  reserved (colour is in the style)
 *   36 fillTo rgba             unorm8x4  reserved
 *   40 stroke rgba             unorm8x4  reserved
 *   44 strokeWidth             f32       reserved
 *   48 opacity                 f32       reserved
 *   52 shape                   u32     0 rect, 1 disc, 2 triangle
 *   56 kind                    u32     0 shape, 1 shadow, 2 sprite, 3 text
 *   60 owner                   u32     card slot, into the owner buffer
 *   64 tiers                    u32     one bit per tier (contract TIER_BIT)
 *   68 scaleRule               u32     0 board, 1 seat, 2 node
 *   72 scaleCap                f32
 *   76 motion                  u32     see MOTION
 *   80 motionPeriod            f32     ms
 *   84 motionSince             f32     wall-clock ms (land/landed)
 *   88 motionFlags             u32     bit 0 ccw, bit 1 fade
 *   92 source                  u32     atlas cell, 0xffffffff none
 *   96 gradientAngle           f32     degrees, CSS convention
 *   100 anchorX                f32     card units, for seat/node scale rules
 *   104 anchorY               f32
 *   108 style                  u32     style table id (styles.ts)
 *   112 previousStyle          u32     reserved for the style transition
 *   116 changeAt               f32     wall-clock ms of the style change
 *   120 dash                   u16x2   reserved
 *   124 hole                   f32     element inset a shadow must not fill
 *
 * Colour lives in the style table (engine/styles.ts): the record names its
 * style by id and the fill, fillTo and stroke words below are reserved (zero),
 * so a theme switch rewrites no record. Nothing outside this module reads or
 * writes the layout.
 */

import type { GpuColor } from "@shared/theme";
import type { Part } from "../contract";

export const QUAD_FLOATS = 32;
export const QUAD_BYTES = QUAD_FLOATS * 4;

export const NO_ATLAS_CELL = 0xffffffff;
export const INLINE_STYLE = 0xffffffff;

export const SHAPE = { rect: 0, disc: 1, triangle: 2 } as const;
export const QUAD_KIND = { shape: 0, shadow: 1, sprite: 2, text: 3 } as const;

/** Motion kinds, shared with the shader's switch. */
export const MOTION = {
  none: 0,
  turn: 1,
  send: 2,
  beat: 3,
  breathe: 4,
  bandFade: 5,
  blink: 6,
  ripple: 7,
  glint: 8,
  shake: 9,
  reach: 10,
  land: 11,
  landed: 12,
  rise: 13,
} as const;
export type MotionKind = (typeof MOTION)[keyof typeof MOTION];

export const MOTION_FLAG = { ccw: 1, fade: 2 } as const;

/** Scale-rule ids, shared with the shader's switch. */
export const SCALE_RULE = { board: 0, seat: 1, node: 2, seatTag: 3, hover: 4 } as const;

/** One slot's CPU side: what the record cannot carry (the part it answers to). */
export type SlotPart = Part | undefined;

const clamp01 = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value);

/** Pack straight sRGB into the record's unorm8x4 word. */
export const packColor = (color: GpuColor): number => {
  const r = Math.round(clamp01(color.r) * 255);
  const g = Math.round(clamp01(color.g) * 255);
  const b = Math.round(clamp01(color.b) * 255);
  const a = Math.round(clamp01(color.a) * 255);
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
};

export const TRANSPARENT = packColor({ r: 0, g: 0, b: 0, a: 0 });

/** Every field a packed quad can carry, as the painter specified it. */
export type PackedQuad = {
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly radii: readonly [number, number, number, number];
  readonly fill: number;
  readonly fillTo: number;
  readonly stroke: number;
  readonly strokeWidth: number;
  readonly opacity: number;
  readonly shape: number;
  readonly kind: number;
  readonly tiers: number;
  readonly scaleRule: number;
  readonly scaleCap: number;
  readonly motion: number;
  readonly motionPeriod: number;
  readonly motionSince: number;
  readonly motionFlags: number;
  readonly source: number;
  readonly gradientAngle: number;
  readonly anchorX: number;
  readonly anchorY: number;
  /** A shadow's element inset in board units: no layer paints inside it. */
  readonly hole: number;
  readonly style: number;
  readonly previousStyle: number;
  readonly changeAt: number;
  readonly dash: number;
};

export const EMPTY_QUAD: PackedQuad = {
  rect: { x: 0, y: 0, width: 0, height: 0 },
  radii: [0, 0, 0, 0],
  fill: TRANSPARENT,
  fillTo: TRANSPARENT,
  stroke: TRANSPARENT,
  strokeWidth: 0,
  opacity: 1,
  shape: SHAPE.rect,
  kind: QUAD_KIND.shape,
  tiers: 15,
  scaleRule: SCALE_RULE.board,
  scaleCap: 1,
  motion: MOTION.none,
  motionPeriod: 0,
  motionSince: 0,
  motionFlags: 0,
  source: NO_ATLAS_CELL,
  gradientAngle: 0,
  anchorX: 0,
  anchorY: 0,
  hole: 0,
  style: INLINE_STYLE,
  previousStyle: INLINE_STYLE,
  changeAt: 0,
  dash: 0,
};

/** A record buffer with float and uint views over the same bytes. */
export type QuadBuffer = {
  readonly bytes: ArrayBuffer;
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
};

export const createQuadBuffer = (records: number): QuadBuffer => {
  const bytes = new ArrayBuffer(Math.max(1, records) * QUAD_BYTES);
  return { bytes, f32: new Float32Array(bytes), u32: new Uint32Array(bytes) };
};

/** Write one quad at `slot`, owned by the card at `owner` (its owner-buffer index). */
export const writeQuad = (buffer: QuadBuffer, slot: number, quad: PackedQuad, owner: number): void => {
  const at = slot * QUAD_FLOATS;
  const f = buffer.f32;
  const u = buffer.u32;
  const { rect, radii } = quad;
  f[at] = rect.x;
  f[at + 1] = rect.y;
  f[at + 2] = rect.width;
  f[at + 3] = rect.height;
  f[at + 4] = radii[0];
  f[at + 5] = radii[1];
  f[at + 6] = radii[2];
  f[at + 7] = radii[3];
  u[at + 8] = quad.fill;
  u[at + 9] = quad.fillTo;
  u[at + 10] = quad.stroke;
  f[at + 11] = quad.strokeWidth;
  f[at + 12] = quad.opacity;
  u[at + 13] = quad.shape;
  u[at + 14] = quad.kind;
  u[at + 15] = owner;
  u[at + 16] = quad.tiers;
  u[at + 17] = quad.scaleRule;
  f[at + 18] = quad.scaleCap;
  u[at + 19] = quad.motion;
  f[at + 20] = quad.motionPeriod;
  f[at + 21] = quad.motionSince;
  u[at + 22] = quad.motionFlags;
  u[at + 23] = quad.source;
  f[at + 24] = quad.gradientAngle;
  f[at + 25] = quad.anchorX;
  f[at + 26] = quad.anchorY;
  u[at + 27] = quad.style;
  u[at + 28] = quad.previousStyle;
  f[at + 29] = quad.changeAt;
  u[at + 30] = quad.dash;
  f[at + 31] = quad.hole;
};

/** Pack a dash/gap pair into one word; both are board units, rounded. */
export const packDash = (dash: number, gap: number): number => {
  const d = Math.max(0, Math.min(0xffff, Math.round(dash)));
  const g = Math.max(0, Math.min(0xffff, Math.round(gap)));
  return (d | (g << 16)) >>> 0;
};
