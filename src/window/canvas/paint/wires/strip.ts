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
 * corner becomes a fan with no triangle covering another. Where the
 * centreline doubles straight back on itself (`piecesOf`), the retraced run
 * is drawn once and the strip is several bands joined by zero-area
 * triangles; a band that meets another from the side is clipped at its edge.
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
 * A band that stops at a retrace apex ends square there (its `along` stays
 * inside the wire's length), a cusp too small to see at wire widths.
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

/** One stretch of the centreline drawn as its own band. */
type Piece = {
  readonly from: number;
  readonly to: number;
  readonly startCap: StripCaps;
  readonly endCap: StripCaps;
  /** The first sample is a retrace apex: its tangent points into the apex, so the band leaves by the next one's. */
  readonly startsAtApex: boolean;
  /** Where the piece runs into another piece's band: keep only `(p - o) . n >= keep` near that end. */
  readonly clip?: { readonly ox: number; readonly oy: number; readonly nx: number; readonly ny: number; readonly keep: number; readonly atEnd: boolean };
};

const ON_LINE = 1e-6;

/**
 * Split a centreline where it doubles straight back on itself. The router
 * can return a leg that runs past a point and returns along the same line
 * (`routeWire` with a stub past the target, 5 of 410 router routes in the
 * property test). Today's SVG paints one stroke, so the retraced run is
 * covered once; a strip would cover it twice. At each such apex the shorter
 * of the two collinear runs lies inside the longer one's band and is
 * dropped. When it ends the wire the band simply stops at the apex; when it
 * leads on to more wire, that wire joins the longer run's band from the side
 * (a T), so it is a separate band clipped at the longer band's edge.
 */
const piecesOf = (line: WireLine, from: number, to: number, startCap: StripCaps, endCap: StripCaps, startsAtApex: boolean, clip: Piece["clip"]): Piece[] => {
  const { x, y, tx, ty, s } = line;
  for (let c = from + (startsAtApex ? 1 : 0); c + 1 <= to; c += 1) {
    if (tx[c]! * tx[c + 1]! + ty[c]! * ty[c + 1]! >= -0.999) continue;
    const dx = tx[c]!;
    const dy = ty[c]!;
    const off = (k: number): number => (x[k]! - x[c]!) * -dy + (y[k]! - y[c]!) * dx;
    let a0 = c;
    while (a0 > from && Math.abs(off(a0 - 1)) < ON_LINE) a0 -= 1;
    let b1 = c;
    while (b1 < to && Math.abs(off(b1 + 1)) < ON_LINE) b1 += 1;
    const la = s[c]! - s[a0]!;
    const lb = s[b1]! - s[c]!;
    if (b1 === to && lb <= la) return piecesOf(line, from, c, startCap, "round", startsAtApex, clip);
    if (a0 === from && la <= lb) return piecesOf(line, c, to, "round", endCap, true, clip);
    // A T: the shorter run leads on to more wire, which joins the longer run's band from its side.
    const halfPlane = (k: number, atEnd: boolean): NonNullable<Piece["clip"]> => {
      const side = off(k) >= 0 ? 1 : -1;
      return { ox: x[c]!, oy: y[c]!, nx: -dy * side, ny: dx * side, keep: 0, atEnd };
    };
    if (la < lb) {
      return [
        ...piecesOf(line, from, a0, startCap, "butt", startsAtApex, halfPlane(a0 - 1, true)),
        ...piecesOf(line, c, to, "round", endCap, true, clip),
      ];
    }
    return [
      ...piecesOf(line, from, c, startCap, "round", startsAtApex, clip),
      ...piecesOf(line, b1, to, "butt", endCap, false, halfPlane(b1 + 1, false)),
    ];
  }
  return [{ from, to, startCap, endCap, startsAtApex, clip }];
};

type Band = { vertices: Float32Array; count: number; folded: boolean };

/** One piece as a band: a cross-section per sample, plus one per round cap. */
const bandOf = (line: WireLine, piece: Piece, halfWidth: number, slot: number): Band => {
  const { from, to } = piece;
  const head = piece.startCap === "round" ? 1 : 0;
  const tail = piece.endCap === "round" ? 1 : 0;
  const n = to - from + 1;
  const m = n + head + tail;
  const px = new Float64Array(m);
  const py = new Float64Array(m);
  const tx = new Float64Array(m);
  const ty = new Float64Array(m);
  const s = new Float64Array(m);
  for (let i = 0; i < n; i += 1) {
    px[i + head] = line.x[from + i]!;
    py[i + head] = line.y[from + i]!;
    tx[i + head] = line.tx[from + i]!;
    ty[i + head] = line.ty[from + i]!;
    s[i + head] = line.s[from + i]!;
  }
  if (piece.startsAtApex && n > 1) {
    tx[head] = tx[head + 1]!;
    ty[head] = ty[head + 1]!;
  }
  if (head) {
    px[0] = px[1]! - tx[1]! * halfWidth;
    py[0] = py[1]! - ty[1]! * halfWidth;
    tx[0] = tx[1]!;
    ty[0] = ty[1]!;
    s[0] = s[1]! - halfWidth;
  }
  if (tail) {
    px[m - 1] = px[m - 2]! + tx[m - 2]! * halfWidth;
    py[m - 1] = py[m - 2]! + ty[m - 2]! * halfWidth;
    tx[m - 1] = tx[m - 2]!;
    ty[m - 1] = ty[m - 2]!;
    s[m - 1] = s[m - 2]! + halfWidth;
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
  const clean = cutLoops(plus, tx, ty, m) && cutLoops(minus, tx, ty, m);
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
  const band = { vertices, count, folded: !clean };
  return piece.clip ? clipBand(band, { ...piece.clip, keep: halfWidth }) : band;
};

/**
 * Cut a band where it runs into another band: the cross-sections from the
 * last one wholly on the kept side to the joining end are clipped to the
 * half-plane, triangle by triangle, every attribute carried linearly. The
 * rest of the band is kept as it is, so a half-plane never reaches wire far
 * from the join.
 */
const clipBand = (band: Band, clip: NonNullable<Piece["clip"]>): Band => {
  const v = band.vertices;
  const sections = band.count / 2;
  const kept = (i: number): number => (v[i * STRIP_FLOATS]! - clip.ox) * clip.nx + (v[i * STRIP_FLOATS + 1]! - clip.oy) * clip.ny - clip.keep;
  const whole = (k: number): boolean => kept(k * 2) >= 0 && kept(k * 2 + 1) >= 0;
  let edge = clip.atEnd ? sections - 1 : 0;
  while (clip.atEnd ? edge > 0 && !whole(edge) : edge < sections - 1 && !whole(edge)) edge += clip.atEnd ? -1 : 1;
  const strip = clip.atEnd ? v.slice(0, (edge + 1) * 2 * STRIP_FLOATS) : v.slice(edge * 2 * STRIP_FLOATS);
  const lo = clip.atEnd ? edge * 2 : 0;
  const hi = clip.atEnd ? band.count - 1 : edge * 2 + 1;
  const parts: Array<{ vertices: Float32Array; count: number }> = [{ vertices: strip, count: strip.length / STRIP_FLOATS }];
  const lerp = (a: number, b: number, t: number): Float32Array => {
    const out = new Float32Array(STRIP_FLOATS);
    for (let f = 0; f < STRIP_FLOATS; f += 1) {
      const fa = v[a * STRIP_FLOATS + f]!;
      out[f] = fa + (v[b * STRIP_FLOATS + f]! - fa) * t;
    }
    return out;
  };
  for (let i = lo; i + 2 <= hi; i += 1) {
    const tri = [i, i + 1, i + 2];
    const polygon: Float32Array[] = [];
    for (let e = 0; e < 3; e += 1) {
      const a = tri[e]!;
      const b = tri[(e + 1) % 3]!;
      const da = kept(a);
      const db = kept(b);
      if (da >= 0) polygon.push(v.slice(a * STRIP_FLOATS, (a + 1) * STRIP_FLOATS));
      if ((da >= 0) !== (db >= 0)) polygon.push(lerp(a, b, da / (da - db)));
    }
    if (polygon.length < 3) continue;
    // A triangle as a four-vertex strip (its last vertex repeated); a quad in strip order.
    const order = polygon.length === 3 ? [0, 1, 2, 2] : [1, 0, 2, 3];
    const vertices = new Float32Array(4 * STRIP_FLOATS);
    order.forEach((p, k) => vertices.set(polygon[p]!, k * STRIP_FLOATS));
    parts.push({ vertices, count: 4 });
  }
  if (!clip.atEnd) parts.push(parts.shift()!);
  const vertices = joinStrips(parts);
  return { vertices, count: vertices.length / STRIP_FLOATS, folded: band.folded };
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
  if (line.count < 2 || line.length <= 0 || halfWidth <= 0) {
    return { vertices: EMPTY, count: 0, length: line.length, halfWidth, folded: false };
  }
  const bands = piecesOf(line, 0, line.count - 1, caps, caps, false, undefined).map((piece) =>
    bandOf(line, piece, halfWidth, slot),
  );
  if (bands.length === 1) {
    const band = bands[0]!;
    return { vertices: band.vertices, count: band.count, length: line.length, halfWidth, folded: band.folded };
  }
  const vertices = joinStrips(bands);
  return {
    vertices,
    count: vertices.length / STRIP_FLOATS,
    length: line.length,
    halfWidth,
    folded: bands.some((band) => band.folded),
  };
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
