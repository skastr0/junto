/**
 * The uniform grid the engine culls with and picks over
 * (docs/canvas-gpu-architecture.md, section 6, "Culling": a grid over the
 * board, the spike used 512 units for hits and 1536 for text).
 *
 * It indexes whole cards by their drawn rectangle and wires by the segments of
 * their route. Both answers come back as integer slots; the scene turns them
 * into the contract's paint-ordered ids. Nothing here allocates per query
 * beyond the caller's out array.
 */

import type { Point, Rect } from "../contract";

/** Hit and cull cells: the spike's 512. */
export const CARD_CELL = 512;
/** Wire segments are long; a coarser cell keeps the per-wire cell count small. */
export const WIRE_CELL = 1536;

/**
 * One exact key per cell, for any cell a board can name. Zigzag folds the
 * signs (doubling them), and Szudzik's pairing is exact while the larger
 * half squared stays inside Number's safe integers: |cell| < 2^25, which is
 * 1.7e10 board units at 512. Past that the key is a string, exact everywhere.
 */
const PAIR_SAFE = 2 ** 25;
const zigzag = (n: number): number => (n >= 0 ? 2 * n : -2 * n - 1);
const keyOf = (cx: number, cy: number): number | string => {
  if (Math.abs(cx) >= PAIR_SAFE || Math.abs(cy) >= PAIR_SAFE) return `${String(cx)},${String(cy)}`;
  const a = zigzag(cx);
  const b = zigzag(cy);
  return a >= b ? a * a + a + b : a + b * b;
};

type Entry = { rect: Rect; cells: Array<number | string> };

/** A grid over rectangles, keyed by integer slot. */
export class RectGrid {
  private readonly cells = new Map<number | string, number[]>();
  private readonly entries = new Map<number, Entry>();

  constructor(private readonly cell: number) {}

  /**
   * The cells any rectangle has ever covered, since the last clear: a query
   * walks no cell outside them, so a huge rectangle costs the board, not the
   * rectangle (issue 915). It only grows; a removal leaves it as an upper bound.
   */
  private span = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };

  /** The board the grid has seen, in board units, or undefined while empty. */
  extent(): Rect | undefined {
    const { left, top, right, bottom } = this.span;
    if (!(right >= left)) return undefined;
    return { x: left * this.cell, y: top * this.cell, width: (right - left + 1) * this.cell, height: (bottom - top + 1) * this.cell };
  }

  set(slot: number, rect: Rect): void {
    this.remove(slot);
    const left = Math.floor(rect.x / this.cell);
    const top = Math.floor(rect.y / this.cell);
    const right = Math.floor((rect.x + rect.width) / this.cell);
    const bottom = Math.floor((rect.y + rect.height) / this.cell);
    const span = this.span;
    if (left < span.left) span.left = left;
    if (top < span.top) span.top = top;
    if (right > span.right) span.right = right;
    if (bottom > span.bottom) span.bottom = bottom;
    const cells: Array<number | string> = [];
    for (let cy = top; cy <= bottom; cy += 1) {
      for (let cx = left; cx <= right; cx += 1) {
        const key = keyOf(cx, cy);
        let bucket = this.cells.get(key);
        if (bucket === undefined) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(slot);
        cells.push(key);
      }
    }
    this.entries.set(slot, { rect, cells });
  }

  remove(slot: number): void {
    const entry = this.entries.get(slot);
    if (entry === undefined) return;
    for (const key of entry.cells) {
      const bucket = this.cells.get(key);
      if (bucket === undefined) continue;
      const at = bucket.indexOf(slot);
      if (at >= 0) bucket.splice(at, 1);
      if (bucket.length === 0) this.cells.delete(key);
    }
    this.entries.delete(slot);
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
    this.span = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  }

  /**
   * Slots whose rectangle meets `rect`, each once, appended to `out`. Extra
   * candidates are fine: the caller tests the exact rectangle.
   */
  query(rect: Rect, out: number[]): number[] {
    const span = this.span;
    const left = Math.max(span.left, Math.floor(rect.x / this.cell));
    const top = Math.max(span.top, Math.floor(rect.y / this.cell));
    const right = Math.min(span.right, Math.floor((rect.x + rect.width) / this.cell));
    const bottom = Math.min(span.bottom, Math.floor((rect.y + rect.height) / this.cell));
    const stamp = ++this.queryStamp;
    for (let cy = top; cy <= bottom; cy += 1) {
      for (let cx = left; cx <= right; cx += 1) {
        const bucket = this.cells.get(keyOf(cx, cy));
        if (bucket === undefined) continue;
        for (const slot of bucket) {
          if (this.seen.get(slot) === stamp) continue;
          this.seen.set(slot, stamp);
          out.push(slot);
        }
      }
    }
    return out;
  }

  private queryStamp = 0;
  private readonly seen = new Map<number, number>();

  /** The stored rectangle, for the caller's exact test. */
  rectOf(slot: number): Rect | undefined {
    return this.entries.get(slot)?.rect;
  }
}

const contains = (rect: Rect, at: Point): boolean =>
  at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height;

const near = (rect: Rect, at: Point, slop: number): boolean =>
  at.x >= rect.x - slop && at.x <= rect.x + rect.width + slop
  && at.y >= rect.y - slop && at.y <= rect.y + rect.height + slop;

/** The scene's spatial index: cards by rectangle, wires by route. */
export type SpatialIndex = import("../contract").SpatialIndex;

export type CardQuery = {
  /** Slot ids of every card whose rectangle contains the point, bottom first. */
  readonly cardsAt: (at: Point) => number[];
  readonly cardsNear: (at: Point, slop: number) => number[];
  readonly wiresAt: (at: Point, slop: number) => number[];
};

export const createCardQuery = (grid: RectGrid): CardQuery => {
  const scratch: number[] = [];
  const cardsNearSlots = (at: Point, slop: number): number[] => {
    scratch.length = 0;
    const rect = { x: at.x - slop, y: at.y - slop, width: slop * 2, height: slop * 2 };
    grid.query(rect, scratch);
    return scratch;
  };
  return {
    cardsAt: (at) => {
      const slots = cardsNearSlots(at, 0);
      const hit: number[] = [];
      for (const slot of slots) {
        const rect = grid.rectOf(slot);
        if (rect !== undefined && contains(rect, at)) hit.push(slot);
      }
      return hit;
    },
    cardsNear: (at, slop) => {
      const slots = cardsNearSlots(at, slop);
      const hit: number[] = [];
      for (const slot of slots) {
        const rect = grid.rectOf(slot);
        if (rect !== undefined && near(rect, at, slop)) hit.push(slot);
      }
      return hit;
    },
    wiresAt: () => [],
  };
};

/** Distance from a point to a segment, for the wire index and the tests. */
export const segmentDistance = (at: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(at.x - a.x, at.y - a.y);
  const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / length2));
  return Math.hypot(at.x - (a.x + dx * t), at.y - (a.y + dy * t));
};
