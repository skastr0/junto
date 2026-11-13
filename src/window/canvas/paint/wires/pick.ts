/**
 * Wire picking. Today a wire is picked by an invisible stroke along its path,
 * 20 units wide, or one lane (3) for a cable member (RF index.js:2570,
 * WireEdge.tsx:121-123), and only where the stylesheet lets it take the
 * pointer (style.ts `wirePaint().pickable`). A board point picks a wire when
 * it lies within half that width of the centreline. The stroke has butt ends
 * (React Flow's interaction path sets no cap), so a point past either end
 * along the end's tangent misses. Where hit strokes overlap, the one painted
 * last wins, as the DOM's topmost element does.
 *
 * Pure. No DOM.
 */

import type { Point } from "../../contract";
import type { WireLine } from "./route";

export type WireDistance = {
  /** Board units from the point to the nearest point of the centreline. */
  readonly distance: number;
  /** How far along the wire that nearest point is. */
  readonly along: number;
  /** The point lies past an end, along that end's tangent: a butt end misses it. */
  readonly pastEnd: boolean;
};

/** Distance from a board point to a centreline. */
export const wireDistance = (line: WireLine, point: Point): WireDistance => {
  if (line.count === 0) return { distance: Number.POSITIVE_INFINITY, along: 0, pastEnd: true };
  if (line.count === 1) {
    return { distance: Math.hypot(point.x - line.x[0]!, point.y - line.y[0]!), along: 0, pastEnd: true };
  }
  let best = Number.POSITIVE_INFINITY;
  let along = 0;
  for (let i = 0; i + 1 < line.count; i += 1) {
    const ax = line.x[i]!;
    const ay = line.y[i]!;
    const dx = line.x[i + 1]! - ax;
    const dy = line.y[i + 1]! - ay;
    const span = dx * dx + dy * dy;
    const t = span > 0 ? Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / span)) : 0;
    const d = Math.hypot(point.x - (ax + dx * t), point.y - (ay + dy * t));
    if (d < best) {
      best = d;
      along = line.s[i]! + (line.s[i + 1]! - line.s[i]!) * t;
    }
  }
  const last = line.count - 1;
  const beforeStart =
    along <= 0 && (point.x - line.x[0]!) * line.tx[0]! + (point.y - line.y[0]!) * line.ty[0]! < 0;
  const afterEnd =
    along >= line.length &&
    (point.x - line.x[last]!) * line.tx[last]! + (point.y - line.y[last]!) * line.ty[last]! > 0;
  return { distance: best, along, pastEnd: beforeStart || afterEnd };
};

/** Whether a board point picks this wire, given its hit half width. */
export const wireHit = (line: WireLine, point: Point, hitHalfWidth: number): WireDistance | null => {
  const found = wireDistance(line, point);
  return found.distance <= hitHalfWidth && !found.pastEnd ? found : null;
};

export type PickCandidate<Id> = {
  readonly id: Id;
  readonly line: WireLine;
  readonly hitHalfWidth: number;
  /** Axis-aligned bounds of the centreline, grown by nothing; checked first. */
  readonly bounds?: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
};

/** The wire a board point picks among candidates given in paint order (last painted on top). */
export const pickWire = <Id>(
  candidates: ReadonlyArray<PickCandidate<Id>>,
  point: Point,
): { readonly id: Id; readonly hit: WireDistance } | null => {
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]!;
    const box = candidate.bounds;
    const reach = candidate.hitHalfWidth;
    if (
      box &&
      (point.x < box.minX - reach || point.x > box.maxX + reach || point.y < box.minY - reach || point.y > box.maxY + reach)
    ) {
      continue;
    }
    const hit = wireHit(candidate.line, point, reach);
    if (hit) return { id: candidate.id, hit };
  }
  return null;
};

/** A centreline's bounds, for the spatial index and `pickWire`. */
export const lineBounds = (line: WireLine): { minX: number; minY: number; maxX: number; maxY: number } => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < line.count; i += 1) {
    minX = Math.min(minX, line.x[i]!);
    minY = Math.min(minY, line.y[i]!);
    maxX = Math.max(maxX, line.x[i]!);
    maxY = Math.max(maxY, line.y[i]!);
  }
  return { minX, minY, maxX, maxY };
};
