/**
 * A pool of triangle strips in one vertex array and one index array.
 *
 * Every strip is stored as it came from `paint/wires` (`STRIP_FLOATS` floats a
 * vertex) at a stable run of slots. The index array lists each strip's
 * vertices and ends it with the restart index, so the whole pool is one
 * indexed `triangle-strip` draw. A strip that changes shape in place rewrites
 * its run; one that no longer fits moves, and its old run is neutralised
 * (restart indices only) and handed back. Nothing is allocated per frame.
 */

import { STRIP_FLOATS } from "../../paint/wires/strip";
import { createDirty, createRangeAllocator, type Dirty, type RangeAllocator } from "./ranges";

/** The index that ends a strip (a 32 bit index buffer). */
export const RESTART = 0xffffffff;

/** Where a strip lives: `count` vertices from `start`, in a run of `cap` units. */
export type Slice = { readonly start: number; readonly cap: number; readonly count: number };

export type StripPool = {
  /** Write a strip, reusing `slice`'s run when it fits; returns where it lives. */
  readonly put: (slice: Slice | undefined, vertices: Float32Array, count: number) => Slice;
  readonly free: (slice: Slice | undefined) => void;
  readonly clear: () => void;
  readonly vertices: () => Float32Array;
  readonly indices: () => Uint32Array;
  /** Index entries in use up to the highest run: what an indexed draw covers. */
  readonly extent: () => number;
  readonly dirtyVertices: Dirty;
  readonly dirtyIndices: Dirty;
  /** Bumps when the arrays are reallocated, so the GPU side recreates its buffers. */
  readonly generation: () => number;
};

/** A run's capacity for `count` vertices: the restart unit, plus slack so small changes stay in place. */
const capFor = (count: number): number => count + 1 + Math.ceil(count / 4) + 2;

export const createStripPool = (initialUnits = 1024): StripPool => {
  let vertices = new Float32Array(initialUnits * STRIP_FLOATS);
  let indices = new Uint32Array(initialUnits).fill(RESTART);
  let allocator: RangeAllocator = createRangeAllocator(initialUnits);
  let high = 0;
  let generation = 0;
  const dirtyVertices = createDirty();
  const dirtyIndices = createDirty();

  const grow = (needed: number): void => {
    let next = allocator.capacity();
    while (next < needed) next *= 2;
    const nextVertices = new Float32Array(next * STRIP_FLOATS);
    nextVertices.set(vertices);
    const nextIndices = new Uint32Array(next).fill(RESTART);
    nextIndices.set(indices);
    vertices = nextVertices;
    indices = nextIndices;
    allocator.grow(next);
    generation += 1;
    dirtyVertices.markAll(next * STRIP_FLOATS);
    dirtyIndices.markAll(next);
  };

  const free = (slice: Slice | undefined): void => {
    if (slice === undefined) return;
    indices.fill(RESTART, slice.start, slice.start + slice.cap);
    dirtyIndices.mark(slice.start, slice.start + slice.cap);
    allocator.release(slice.start, slice.cap);
  };

  const put: StripPool["put"] = (slice, strip, count) => {
    let run = slice;
    if (run === undefined || run.cap < count + 1 || run.cap > capFor(count) * 2) {
      free(run);
      const cap = capFor(count);
      let start = allocator.alloc(cap);
      if (start === undefined) {
        grow(allocator.capacity() + cap);
        start = allocator.alloc(cap);
      }
      if (start === undefined) throw new Error("wires: the strip pool could not grow");
      run = { start, cap, count };
    } else if (run.count !== count) {
      run = { start: run.start, cap: run.cap, count };
    }
    const { start, cap } = run;
    vertices.set(strip.length === count * STRIP_FLOATS ? strip : strip.subarray(0, count * STRIP_FLOATS), start * STRIP_FLOATS);
    dirtyVertices.mark(start * STRIP_FLOATS, (start + count) * STRIP_FLOATS);
    for (let k = 0; k < count; k += 1) indices[start + k] = start + k;
    indices.fill(RESTART, start + count, start + cap);
    dirtyIndices.mark(start, start + cap);
    if (start + cap > high) high = start + cap;
    return run;
  };

  const clear = (): void => {
    indices.fill(RESTART, 0, high);
    dirtyIndices.mark(0, high);
    allocator = createRangeAllocator(allocator.capacity());
    high = 0;
  };

  return {
    put,
    free,
    clear,
    vertices: () => vertices,
    indices: () => indices,
    extent: () => high,
    dirtyVertices,
    dirtyIndices,
    generation: () => generation,
  };
};
