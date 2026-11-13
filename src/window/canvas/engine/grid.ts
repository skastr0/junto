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

const keyOf = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

type Entry = { rect: Rect; cells: number[] };

/** A grid over rectangles, keyed by integer slot. */
export class RectGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly entries = new Map<number, Entry>();

  constructor(private readonly cell: number) {}

  set(slot: number, rect: Rect): void {
    this.remove(slot);
    const left = Math.floor(rect.x / this.cell);
    const top = Math.floor(rect.y / this.cell);
    const right = Math.floor((rect.x + rect.width) / this.cell);
    const bottom = Math.floor((rect.y + rect.height) / this.cell);
    const cells: number[] = [];
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
  }

  /**
   * Slots whose rectangle meets `rect`, each once, appended to `out`. Extra
   * candidates are fine: the caller tests the exact rectangle.
   */
  query(rect: Rect, out: number[]): number[] {
    const left = Math.floor(rect.x / this.cell);
    const top = Math.floor(rect.y / this.cell);
    const right = Math.floor((rect.x + rect.width) / this.cell);
    const bottom = Math.floor((rect.y + rect.height) / this.cell);
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
