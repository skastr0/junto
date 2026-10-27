import {
  FILES_SEARCH_LIMIT,
  foldForSearch,
  scoreFilePath,
  type FileMatch,
  type FilePath,
} from "@shared/files";

/**
 * The filename index of one Files root: every file under it, by relative
 * path, for quick open. Built from `git ls-files` or a walk (`sources.ts`),
 * kept fresh by the watcher's deltas, and dropped when no node holds it.
 *
 * Packed, with no object per file: every path lives in one string, NUL
 * separated, with its lower-case fold beside it (folded once) and an
 * Int32Array of offsets. Removal finds a path through an open-addressing
 * hash table of offsets (Int32Array) and leaves a tombstone; additions go to
 * a small overlay. When the overlay or the tombstones grow past
 * `COMPACT_AFTER`, the holder rebuilds from disk instead.
 */

const SEPARATOR = "\0";
/** Overlay entries plus tombstones that make a rebuild cheaper than more deltas. */
export const COMPACT_AFTER = 4096;

/** FNV-1a over a slice of a string, folded to 31 bits. */
const hashSlice = (text: string, from: number, to: number): number => {
  let hash = 0x811c9dc5;
  for (let i = from; i < to; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1;
};

const sliceEquals = (text: string, from: number, to: number, other: string): boolean => {
  if (to - from !== other.length) return false;
  for (let i = 0; i < other.length; i += 1) if (text.charCodeAt(from + i) !== other.charCodeAt(i)) return false;
  return true;
};

/**
 * Which kinds of character a slice holds, one bit each: a to z, any digit,
 * ".", "-" or "_", any other ASCII, anything else. A path whose mask lacks a
 * bit of the query's cannot match, so most paths are passed over without
 * being scored. "/" sets no bit, so a query "/" still matches.
 */
const maskOf = (text: string, from: number, to: number): number => {
  let mask = 0;
  for (let i = from; i < to; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 97 && c <= 122) mask |= 1 << (c - 97);
    else if (c >= 48 && c <= 57) mask |= 1 << 26;
    else if (c === 46 || c === 45 || c === 95) mask |= 1 << 27;
    else if (c === 47) continue;
    else if (c < 128) mask |= 1 << 28;
    else mask |= 1 << 29;
  }
  return mask;
};

/** Hand the event loop back between chunks of a build, so no step blocks it past a frame. */
export type Yield = () => Promise<void>;

export const yieldToLoop: Yield = () => new Promise((resolve) => setImmediate(resolve));

/** Entries packed, folded or hashed between two yields. */
const CHUNK = 16_384;
/** Characters folded between two yields. */
const FOLD_CHUNK = 1 << 20;

/**
 * Collects names as they stream in, one joined string per chunk, so the
 * build never holds an array of every path. `finish` packs and indexes them,
 * yielding between chunks.
 */
export class NameIndexBuilder {
  private readonly chunks: string[] = [];
  private count = 0;

  add(names: ReadonlyArray<string>): void {
    const kept = names.filter((name) => name !== "" && !name.includes(SEPARATOR));
    if (kept.length === 0) return;
    this.chunks.push(kept.join(SEPARATOR));
    this.count += kept.length;
  }

  get size(): number {
    return this.count;
  }

  async finish(yieldNow: Yield = yieldToLoop): Promise<NameIndex> {
    const packed = this.chunks.join(SEPARATOR);
    this.chunks.length = 0;
    const count = this.count;
    // Joined, not concatenated: the hot loop reads a flat string, never a rope.
    const foldedParts: string[] = [];
    for (let at = 0; at < packed.length; at += FOLD_CHUNK) {
      foldedParts.push(foldForSearch(packed.slice(at, at + FOLD_CHUNK)));
      await yieldNow();
    }
    const folded = foldedParts.join("");
    const starts = new Int32Array(count + 1);
    let at = 0;
    for (let i = 0; i < count; i += 1) {
      starts[i] = at;
      const next = packed.indexOf(SEPARATOR, at);
      at = next < 0 ? packed.length + 1 : next + 1;
      if (i % CHUNK === CHUNK - 1) await yieldNow();
    }
    starts[count] = packed.length + 1;
    const masks = new Int32Array(count);
    for (let i = 0; i < count; i += 1) {
      masks[i] = maskOf(folded, starts[i]!, starts[i + 1]! - 1);
      if (i % CHUNK === CHUNK - 1) await yieldNow();
    }
    let capacity = 1024;
    while (capacity < count * 2) capacity *= 2;
    const table = new Int32Array(capacity);
    const mask = capacity - 1;
    for (let i = 0; i < count; i += 1) {
      let slot = hashSlice(packed, starts[i]!, starts[i + 1]! - 1) & mask;
      while (table[slot] !== 0) slot = (slot + 1) & mask;
      table[slot] = i + 1;
      if (i % CHUNK === CHUNK - 1) await yieldNow();
    }
    return new NameIndex(packed, folded, starts, masks, table);
  }
}

type Top = { scores: Float64Array; ids: Int32Array; size: number; worst: number };

/** Ids at or above `base` are overlay entries; below are packed entries. */
export type MatchSet = { readonly query: string; readonly generation: number; readonly ids: Int32Array };

export class NameIndex {
  private readonly mask: number;
  private readonly dead: Uint8Array;
  private deadCount = 0;
  private readonly overlay: string[] = [];
  private readonly overlayFolded: string[] = [];
  /** Changes on every delta; a cached match set from another generation is not narrowed. */
  private generation = 0;

  constructor(
    private readonly packed: string,
    private readonly folded: string,
    private readonly starts: Int32Array,
    private readonly masks: Int32Array,
    private readonly table: Int32Array,
  ) {
    this.mask = table.length - 1;
    this.dead = new Uint8Array(starts.length - 1);
  }

  private get base(): number {
    return this.starts.length - 1;
  }

  /** Files the index holds now. */
  get size(): number {
    return this.base - this.deadCount + this.overlay.length;
  }

  /** Deltas held since the build; past `COMPACT_AFTER` the holder rebuilds. */
  get drift(): number {
    return this.deadCount + this.overlay.length;
  }

  private findPacked(path: string): number {
    let slot = hashSlice(path, 0, path.length) & this.mask;
    for (;;) {
      const entry = this.table[slot]!;
      if (entry === 0) return -1;
      const id = entry - 1;
      if (this.dead[id] === 0 && sliceEquals(this.packed, this.starts[id]!, this.starts[id + 1]! - 1, path)) return id;
      slot = (slot + 1) & this.mask;
    }
  }

  has(path: string): boolean {
    return this.findPacked(path) >= 0 || this.overlay.includes(path);
  }

  add(path: string): void {
    if (path === "" || path.includes(SEPARATOR) || this.has(path)) return;
    this.overlay.push(path);
    this.overlayFolded.push(foldForSearch(path));
    this.generation += 1;
  }

  remove(path: string): void {
    const id = this.findPacked(path);
    if (id >= 0) {
      this.dead[id] = 1;
      this.deadCount += 1;
      this.generation += 1;
      return;
    }
    const at = this.overlay.indexOf(path);
    if (at < 0) return;
    this.overlay.splice(at, 1);
    this.overlayFolded.splice(at, 1);
    this.generation += 1;
  }

  /** Every path under `dir/` (or equal to it), for a folder that went away. */
  removeUnder(dir: string): void {
    const prefix = `${dir}/`;
    for (let id = 0; id < this.base; id += 1) {
      if (this.dead[id] !== 0) continue;
      const from = this.starts[id]!;
      const to = this.starts[id + 1]! - 1;
      if (sliceEquals(this.packed, from, Math.min(to, from + prefix.length), prefix)) {
        this.dead[id] = 1;
        this.deadCount += 1;
        this.generation += 1;
      }
    }
    for (let at = this.overlay.length - 1; at >= 0; at -= 1) {
      if (this.overlay[at]!.startsWith(prefix)) {
        this.overlay.splice(at, 1);
        this.overlayFolded.splice(at, 1);
        this.generation += 1;
      }
    }
  }

  private pathOf(id: number): string {
    return id < this.base
      ? this.packed.slice(this.starts[id]!, this.starts[id + 1]! - 1)
      : this.overlay[id - this.base]!;
  }

  /**
   * The best `limit` paths for `query`, and the full match set for the next
   * keystroke. When `previous` is this generation's set for a prefix of the
   * query, only its ids are scored: a growing query only narrows. The loops
   * are inlined on purpose: this runs per keystroke over every path.
   */
  search(
    rawQuery: string,
    previous?: MatchSet,
    limit = FILES_SEARCH_LIMIT,
  ): { readonly matches: ReadonlyArray<FileMatch>; readonly set: MatchSet } {
    const query = foldForSearch(rawQuery.trim());
    const want = maskOf(query, 0, query.length);
    const top: Top = { scores: new Float64Array(limit), ids: new Int32Array(limit), size: 0, worst: 0 };
    const narrow =
      previous !== undefined && previous.generation === this.generation && query.startsWith(previous.query);
    const base = this.base;
    const total = base + this.overlay.length;
    const { folded, starts, masks, dead } = this;
    const found = new Int32Array(narrow ? previous.ids.length : total);
    let foundCount = 0;
    const count = narrow ? previous.ids.length : total;
    const ids = narrow ? previous.ids : undefined;
    for (let at = 0; at < count; at += 1) {
      const id = ids === undefined ? at : ids[at]!;
      let score: number | undefined;
      if (id < base) {
        if (dead[id] !== 0 || (masks[id]! & want) !== want) continue;
        const floor = top.size < limit ? Number.NEGATIVE_INFINITY : top.scores[top.worst]!;
        score = scoreFilePath(folded, query, undefined, starts[id]!, starts[id + 1]! - 1, floor);
      } else {
        const own = this.overlayFolded[id - base];
        if (own === undefined) continue;
        score = scoreFilePath(own, query);
      }
      if (score === undefined) continue;
      found[foundCount] = id;
      foundCount += 1;
      if (top.size < limit || score > top.scores[top.worst]!) offer(top, id, score);
    }
    const order = [...Array(top.size).keys()].sort((a, b) => top.scores[b]! - top.scores[a]!);
    const matches = order.map((slot): FileMatch => {
      const id = top.ids[slot]!;
      const path = this.pathOf(id);
      const positions: number[] = [];
      scoreFilePath(foldForSearch(path), query, positions);
      return { path: path as FilePath, positions };
    });
    return {
      matches,
      set: { query, generation: this.generation, ids: found.slice(0, foundCount) },
    };
  }
}

/** Keep the `limit` best: replace the current worst when a better one comes. */
const offer = (top: Top, id: number, score: number): void => {
  const limit = top.ids.length;
  if (top.size < limit) {
    top.scores[top.size] = score;
    top.ids[top.size] = id;
    top.size += 1;
    if (top.size === limit) top.worst = worstOf(top.scores);
    return;
  }
  if (score <= top.scores[top.worst]!) return;
  top.scores[top.worst] = score;
  top.ids[top.worst] = id;
  top.worst = worstOf(top.scores);
};

const worstOf = (scores: Float64Array): number => {
  let worst = 0;
  for (let i = 1; i < scores.length; i += 1) if (scores[i]! < scores[worst]!) worst = i;
  return worst;
};
