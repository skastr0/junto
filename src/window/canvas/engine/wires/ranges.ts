/**
 * Two small tools the wire buffers share: a first-fit range allocator over a
 * growing run of slots, and a dirty span that merges what changed so an upload
 * is one write per buffer per frame.
 */

/** Hands out contiguous runs of units and takes them back, coalescing neighbours. */
export type RangeAllocator = {
  /** The start of a run of `size` units, or undefined when none is free (call `grow`). */
  readonly alloc: (size: number) => number | undefined;
  readonly release: (start: number, size: number) => void;
  /** Make room for `capacity` units in all; existing runs keep their places. */
  readonly grow: (capacity: number) => void;
  readonly capacity: () => number;
  /** Units handed out and not yet released. */
  readonly used: () => number;
};

export const createRangeAllocator = (initial: number): RangeAllocator => {
  let capacity = initial;
  let used = 0;
  // Free runs, sorted by start, never adjacent.
  const free: Array<{ start: number; size: number }> = [{ start: 0, size: initial }];

  const alloc = (size: number): number | undefined => {
    for (let i = 0; i < free.length; i += 1) {
      const run = free[i]!;
      if (run.size < size) continue;
      const start = run.start;
      if (run.size === size) free.splice(i, 1);
      else {
        run.start += size;
        run.size -= size;
      }
      used += size;
      return start;
    }
    return undefined;
  };

  const release = (start: number, size: number): void => {
    if (size <= 0) return;
    used -= size;
    let at = 0;
    while (at < free.length && free[at]!.start < start) at += 1;
    const before = free[at - 1];
    const after = free[at];
    const touchesBefore = before !== undefined && before.start + before.size === start;
    const touchesAfter = after !== undefined && start + size === after.start;
    if (touchesBefore && touchesAfter) {
      before.size += size + after.size;
      free.splice(at, 1);
    } else if (touchesBefore) {
      before.size += size;
    } else if (touchesAfter) {
      after.start = start;
      after.size += size;
    } else {
      free.splice(at, 0, { start, size });
    }
  };

  const grow = (next: number): void => {
    if (next <= capacity) return;
    release(capacity, next - capacity);
    // `release` counted the new room as returned units.
    used += next - capacity;
    capacity = next;
  };

  return { alloc, release, grow, capacity: () => capacity, used: () => used };
};

/** The span of a buffer written since the last upload. */
export type Dirty = {
  readonly mark: (start: number, end: number) => void;
  readonly markAll: (end: number) => void;
  /** The span and clears it; undefined when nothing changed. */
  readonly take: () => { readonly start: number; readonly end: number } | undefined;
  readonly any: () => boolean;
};

export const createDirty = (): Dirty => {
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  return {
    mark: (start, end) => {
      if (end <= start) return;
      if (start < lo) lo = start;
      if (end > hi) hi = end;
    },
    markAll: (end) => {
      lo = 0;
      hi = Math.max(hi, end);
    },
    take: () => {
      if (hi <= lo) return undefined;
      const span = { start: lo, end: hi };
      lo = Number.POSITIVE_INFINITY;
      hi = 0;
      return span;
    },
    any: () => hi > lo,
  };
};
