/**
 * Strips: a wire's centreline (route.ts `wireLine`) as a triangle strip the
 * engine uploads as it is.
 *
 * Wires rest at 7% opacity, where any pixel covered twice shows as a dot
 * (architecture section 13), so a strip never overlaps itself. Each sample of
 * the centreline gives one cross-section, a vertex on either side at the half
 * width along the normal. Where a corner bends tighter than the half width
 * the inner side would fold back over itself (a swallowtail); that side's
 * loop is cut at the point where its two straight-ish runs cross, and every
 * cross-section inside the loop shares that point, so the inner side of the
 * corner becomes a fan with no triangle covering another.
 *
 * Vertex layout (one `Float32Array`, `STRIP_FLOATS` floats, `STRIP_STRIDE`
 * bytes per vertex), drawn as `triangle-strip`, cull mode none:
 *
 *   float  offset  name     meaning
 *   0, 1   0       pos      board position, x then y
 *   2, 3   8       extrude  board vector the vertex moves along to widen the
 *                           stroke by one unit of half width (the side's unit
 *                           normal; at a cut point, the miter of the two runs
 *                           that cross there). For widening a sub-pixel wire
 *                           to a pixel and fading it by coverage.
 *   4      16      along    distance along the centreline from the source
 *                           end, board units: what tracks, pulses and dashes
 *                           read. Below 0 or above the wire's length only in
 *                           round caps.
 *   5      20      across   signed distance from the centreline, board units,
 *                           +halfWidth on one side and -halfWidth on the other.
 *   6      24      slot     the wire's record slot, a whole number as a float.
 *
 * Two vertices per cross-section, plus side first. Round caps are drawn as a
 * square extension half a width long at each end with `along` running on
 * linearly; the fragment shader rounds them, keeping a fragment only where
 * `length(vec2(max(-along, along - length, 0), across)) <= halfWidth`. Butt
 * caps (a pulse, which today is clipped at the wire's ends) have no extension.
 *
 * Pure. No DOM, no GPU.
 */

import type { WireLine } from "./route";

export const STRIP_FLOATS = 7;
export const STRIP_STRIDE = STRIP_FLOATS * 4;
/** Byte offsets of each attribute inside a vertex. */
export const STRIP_ATTRIBUTES = {
  pos: { offset: 0, format: "float32x2" },
  extrude: { offset: 8, format: "float32x2" },
  along: { offset: 16, format: "float32" },
  across: { offset: 20, format: "float32" },
  slot: { offset: 24, format: "float32" },
} as const;

export type StripCaps = "round" | "butt";

export type WireStrip = {
  /** `count * STRIP_FLOATS` floats. */
  readonly vertices: Float32Array;
  /** Vertices, always even. */
  readonly count: number;
  /** The centreline's length, for the shader's end cap. */
  readonly length: number;
  readonly halfWidth: number;
  /**
   * True when a fold could not be cut (a corner tighter than the half width
   * with nothing to cut against, which needs a leg shorter than the stroke).
   * Never true for the router's routes at wire, pulse or glow widths.
   */
  readonly folded: boolean;
};

const EMPTY = new Float32Array(0);

type Side = { x: Float64Array; y: Float64Array; ex: Float64Array; ey: Float64Array };

/** Where segments p0p1 and q0q1 cross, as the parameter along p; null when they do not. */
const crossing = (
  p0x: number, p0y: number, p1x: number, p1y: number,
  q0x: number, q0y: number, q1x: number, q1y: number,
): number | null => {
  const rx = p1x - p0x;
  const ry = p1y - p0y;
  const sx = q1x - q0x;
  const sy = q1y - q0y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qx = q0x - p0x;
  const qy = q0y - p0y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
};

/**
 * Cut every swallowtail out of one side. A segment runs backward when it goes
 * against the centreline's tangent; the loop around a backward run closes
 * where a segment before it crosses a segment after it, and the nearest such
 * crossing is the one cut. Returns false when a backward run had no crossing.
 */
const cutLoops = (side: Side, tx: Float64Array, ty: Float64Array, m: number): boolean => {
  const { x, y, ex, ey } = side;
  const backward = (j: number): boolean => {
    const dx = x[j + 1]! - x[j]!;
    const dy = y[j + 1]! - y[j]!;
    return dx * (tx[j]! + tx[j + 1]!) + dy * (ty[j]! + ty[j + 1]!) < -1e-9;
  };
  const length = (j: number): number => Math.hypot(x[j + 1]! - x[j]!, y[j + 1]! - y[j]!);
  let clean = true;
  let from = 0;
  for (let guard = 0; guard < m; guard += 1) {
    let j = from;
    while (j < m - 1 && !backward(j)) j += 1;
    if (j >= m - 1) break;
    let e = j;
    while (e + 1 < m - 1 && (backward(e + 1) || length(e + 1) === 0)) e += 1;
    let best: { a: number; b: number; t: number; score: number } | null = null;
    for (let a = j; a >= 0; a -= 1) {
      if (best && j - a > best.score) break;
      if (length(a) === 0) continue;
      for (let b = Math.max(e, a + 2); b < m - 1; b += 1) {
        const score = j - a + (b - e);
        if (best && score >= best.score) break;
        if (length(b) === 0) continue;
        const t = crossing(x[a]!, y[a]!, x[a + 1]!, y[a + 1]!, x[b]!, y[b]!, x[b + 1]!, y[b + 1]!);
        if (t !== null) best = { a, b, t, score };
      }
    }
    if (!best) {
      clean = false;
      from = e + 1;
      continue;
    }
    const { a, b, t } = best;
    const cx = x[a]! + (x[a + 1]! - x[a]!) * t;
    const cy = y[a]! + (y[a + 1]! - y[a]!) * t;
    // The cut point widens along the miter of the two runs that meet there.
    const ax = ex[a]!;
    const ay = ey[a]!;
    const bx = ex[b + 1]!;
    const by = ey[b + 1]!;
    const join = 1 + ax * bx + ay * by;
    const mx = join > 1e-6 ? (ax + bx) / join : ax;
    const my = join > 1e-6 ? (ay + by) / join : ay;
    for (let k = a + 1; k <= b; k += 1) {
      x[k] = cx;
      y[k] = cy;
      ex[k] = mx;
      ey[k] = my;
    }
    from = a;
  }
  return clean;
};

/**
 * The strip for a centreline at a half width. `slot` is written into every
 * vertex; `rewriteSlot` changes it in place.
 */
export const buildStrip = (
  line: WireLine,
  halfWidth: number,
  options: { readonly caps?: StripCaps; readonly slot?: number } = {},
): WireStrip => {
  const caps = options.caps ?? "round";
  const slot = options.slot ?? 0;
  const n = line.count;
  if (n < 2 || line.length <= 0 || halfWidth <= 0) {
    return { vertices: EMPTY, count: 0, length: line.length, halfWidth, folded: false };
  }
  const extra = caps === "round" ? 1 : 0;
  const m = n + extra * 2;
  const px = new Float64Array(m);
  const py = new Float64Array(m);
  const tx = new Float64Array(m);
  const ty = new Float64Array(m);
  const s = new Float64Array(m);
  for (let i = 0; i < n; i += 1) {
    px[i + extra] = line.x[i]!;
    py[i + extra] = line.y[i]!;
    tx[i + extra] = line.tx[i]!;
    ty[i + extra] = line.ty[i]!;
    s[i + extra] = line.s[i]!;
  }
  if (extra) {
    px[0] = line.x[0]! - line.tx[0]! * halfWidth;
    py[0] = line.y[0]! - line.ty[0]! * halfWidth;
    tx[0] = line.tx[0]!;
    ty[0] = line.ty[0]!;
    s[0] = -halfWidth;
    px[m - 1] = line.x[n - 1]! + line.tx[n - 1]! * halfWidth;
    py[m - 1] = line.y[n - 1]! + line.ty[n - 1]! * halfWidth;
    tx[m - 1] = line.tx[n - 1]!;
    ty[m - 1] = line.ty[n - 1]!;
    s[m - 1] = line.length + halfWidth;
  }
  const plus: Side = { x: new Float64Array(m), y: new Float64Array(m), ex: new Float64Array(m), ey: new Float64Array(m) };
  const minus: Side = { x: new Float64Array(m), y: new Float64Array(m), ex: new Float64Array(m), ey: new Float64Array(m) };
  for (let k = 0; k < m; k += 1) {
    const nx = -ty[k]!;
    const ny = tx[k]!;
    plus.x[k] = px[k]! + nx * halfWidth;
    plus.y[k] = py[k]! + ny * halfWidth;
    plus.ex[k] = nx;
    plus.ey[k] = ny;
    minus.x[k] = px[k]! - nx * halfWidth;
    minus.y[k] = py[k]! - ny * halfWidth;
    minus.ex[k] = -nx;
    minus.ey[k] = -ny;
  }
  const cleanPlus = cutLoops(plus, tx, ty, m);
  const cleanMinus = cutLoops(minus, tx, ty, m);
  const count = m * 2;
  const vertices = new Float32Array(count * STRIP_FLOATS);
  let o = 0;
  for (let k = 0; k < m; k += 1) {
    vertices[o++] = plus.x[k]!;
    vertices[o++] = plus.y[k]!;
    vertices[o++] = plus.ex[k]!;
    vertices[o++] = plus.ey[k]!;
    vertices[o++] = s[k]!;
    vertices[o++] = halfWidth;
    vertices[o++] = slot;
    vertices[o++] = minus.x[k]!;
    vertices[o++] = minus.y[k]!;
    vertices[o++] = minus.ex[k]!;
    vertices[o++] = minus.ey[k]!;
    vertices[o++] = s[k]!;
    vertices[o++] = -halfWidth;
    vertices[o++] = slot;
  }
  return { vertices, count, length: line.length, halfWidth, folded: !(cleanPlus && cleanMinus) };
};

/** Write a new record slot into every vertex of a strip, in place. */
export const rewriteSlot = (vertices: Float32Array, slot: number): void => {
  for (let o = 6; o < vertices.length; o += STRIP_FLOATS) vertices[o] = slot;
};

/**
 * Several strips as one `triangle-strip` draw: each joined to the next by
 * repeating the last vertex of one and the first of the next, which adds
 * only zero-area triangles. Every strip here has an even count, so the
 * winding of each strip is kept.
 */
export const joinStrips = (strips: ReadonlyArray<{ readonly vertices: Float32Array; readonly count: number }>): Float32Array => {
  const parts = strips.filter((strip) => strip.count > 0);
  if (parts.length === 0) return EMPTY;
  let total = 0;
  for (const part of parts) total += part.count;
  total += (parts.length - 1) * 2;
  const out = new Float32Array(total * STRIP_FLOATS);
  let o = 0;
  parts.forEach((part, index) => {
    if (index > 0) {
      out.copyWithin(o, o - STRIP_FLOATS, o);
      o += STRIP_FLOATS;
      out.set(part.vertices.subarray(0, STRIP_FLOATS), o);
      o += STRIP_FLOATS;
    }
    out.set(part.vertices, o);
    o += part.count * STRIP_FLOATS;
  });
  return out;
};

/** The triangles a strip draws, as vertex index triples (zero-area ones included). For tests and picking. */
export const stripTriangles = (count: number): Array<readonly [number, number, number]> => {
  const out: Array<readonly [number, number, number]> = [];
  for (let i = 0; i + 2 < count; i += 1) out.push([i, i + 1, i + 2]);
  return out;
};
