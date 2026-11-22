/**
 * Two small tools the wire buffers share: a first-fit range allocator over a
 * growing run of slots, and a dirty list that keeps the runs that changed so
 * an upload writes each run, never the ground between two distant writes.
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
  /** The start of the free tail that ends at capacity: the highest unit ever allocated. */
  readonly top: () => number;
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

  const top = (): number => {
    const tail = free[free.length - 1];
    return tail !== undefined && tail.start + tail.size === capacity ? tail.start : capacity;
  };

  return { alloc, release, grow, capacity: () => capacity, used: () => used, top };
};

/** One written run of a buffer: `[start, end)` in units. */
export type DirtyRun = { readonly start: number; readonly end: number };

/** The runs of a buffer written since the last upload. */
export type Dirty = {
  readonly mark: (start: number, end: number) => void;
  readonly markAll: (end: number) => void;
  /** The runs, sorted and merged, and clears them; empty when nothing changed. */
  readonly take: () => ReadonlyArray<DirtyRun>;
  readonly any: () => boolean;
};

export const createDirty = (): Dirty => {
  // Runs in write order; `take` sorts and merges whatever overlap, so two
  // distant writes cost two uploads and never the ground between them.
  let runs: DirtyRun[] = [];
  return {
    mark: (start, end) => {
      if (end <= start) return;
      runs.push({ start, end });
    },
    markAll: (end) => {
      runs = [{ start: 0, end }];
    },
    take: () => {
      if (runs.length === 0) return [];
      runs.sort((a, b) => a.start - b.start);
      const merged: DirtyRun[] = [];
      for (const run of runs) {
        const last = merged[merged.length - 1];
        if (last !== undefined && run.start <= last.end) {
          merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, run.end) };
        } else merged.push(run);
      }
      runs = [];
      return merged;
    },
    any: () => runs.length > 0,
  };
};
