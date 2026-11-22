/**
 * A uniform grid over the cards a wire routes around, so a route reads the
 * cards near its corridor instead of every card on the canvas. Pure: the
 * index owns only integers and references to the rects it was built from.
 *
 * Cells are `cell` board units square; a rect is stored in every cell it
 * touches. A query collects the cells its box touches and returns the rects
 * in the order the index was built with, so a caller's tie-breaks cannot
 * depend on which cell a rect happened to fall in.
 */

import { segmentHitsRect, type WireRect } from "./wire-route";

export type GridBox = { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number };

export type ObstacleIndex<T extends WireRect> = {
  /** How many rects the index holds. */
  readonly size: number;
  /** The rects touching `box`, grown by `pad`, in the order the index was built. */
  readonly near: (box: GridBox, pad?: number) => T[];
  /** Does any leg of `points` hit a rect within `pad`? `skip` drops rects by identity. */
  readonly hits: (points: ReadonlyArray<{ readonly x: number; readonly y: number }>, pad?: number, skip?: (rect: T) => boolean) => boolean;
  /** Every rect, in the order the index was built. */
  readonly all: () => ReadonlyArray<T>;
};

const CELL = 512;

const cellKey = (cx: number, cy: number): number => cx * 2097152 + (cy + 1048576);
const firstCell = (value: number): number => Math.floor(value / CELL);
const lastCell = (value: number): number => Math.floor(value / CELL);

export const createObstacleIndex = <T extends WireRect>(rects: ReadonlyArray<T>): ObstacleIndex<T> => {
  const cells = new Map<number, T[]>();
  const order = new Map<T, number>();
  rects.forEach((rect, ordinal) => {
    order.set(rect, ordinal);
    const x0 = firstCell(rect.x);
    const x1 = lastCell(rect.x + rect.width);
    const y0 = firstCell(rect.y);
    const y1 = lastCell(rect.y + rect.height);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = cellKey(cx, cy);
        const bucket = cells.get(key);
        if (bucket === undefined) cells.set(key, [rect]);
        else bucket.push(rect);
      }
    }
  });

  const near = (box: GridBox, pad = 0): T[] => {
    if (rects.length === 0) return [];
    const minX = box.minX - pad;
    const maxX = box.maxX + pad;
    const minY = box.minY - pad;
    const maxY = box.maxY + pad;
    const found: T[] = [];
    const seen = new Set<T>();
    for (let cx = firstCell(minX); cx <= lastCell(maxX); cx += 1) {
      for (let cy = firstCell(minY); cy <= lastCell(maxY); cy += 1) {
        const bucket = cells.get(cellKey(cx, cy));
        if (bucket === undefined) continue;
        for (const rect of bucket) {
          if (seen.has(rect)) continue;
          seen.add(rect);
          if (rect.x + rect.width < minX || rect.x > maxX || rect.y + rect.height < minY || rect.y > maxY) continue;
          found.push(rect);
        }
      }
    }
    // The caller's order must be the board's order, not the grid's.
    found.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    return found;
  };

  const hits = (
    points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
    pad = 0,
    skip?: (rect: T) => boolean,
  ): boolean => {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const box: GridBox = {
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      };
      for (const rect of near(box, pad)) {
        if (skip !== undefined && skip(rect)) continue;
        if (
          segmentHitsRect(a, b, {
            x: rect.x - pad,
            y: rect.y - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
          })
        ) {
          return true;
        }
      }
    }
    return false;
  };

  return { size: rects.length, near, hits, all: () => rects };
};
