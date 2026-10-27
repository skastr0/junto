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
 * separated, with its lower-case fold beside it as a typed array of char
 * codes (folded once) and an Int32Array of offsets. Removal finds a path
 * through an open-addressing
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
const bitOf = (c: number): number => {
  if (c >= 97 && c <= 122) return 1 << (c - 97);
  if (c >= 48 && c <= 57) return 1 << 26;
  if (c === 46 || c === 45 || c === 95) return 1 << 27;
  if (c === 47) return 0;
  return c < 128 ? 1 << 28 : 1 << 29;
};

const maskOf = (text: string): number => {
  let mask = 0;
  for (let i = 0; i < text.length; i += 1) mask |= bitOf(text.charCodeAt(i));
  return mask;
};

const maskOfCodes = (codes: Codes, from: number, to: number): number => {
  let mask = 0;
  for (let i = from; i < to; i += 1) mask |= bitOf(codes[i]!);
  return mask;
};

const isSeparator = (c: number): boolean => c === 47 || c === 45 || c === 95 || c === 46 || c === 32;

/** Query characters after the first whose previous query character is a separator. */
export const separatorsBefore = (query: Uint16Array): number => {
  let n = 0;
  for (let k = 1; k < query.length; k += 1) if (isSeparator(query[k - 1]!)) n += 1;
  return n;
};

/**
 * The most points any match of a query can take (scoreCodes' points), all
 * characters in the name: 1 each, 2 each for the name, 3 for the first
 * character's word start and 2 for the name start, and for each later
 * character either a run (4) or a word start (3), both only after a
 * separator in the query.
 */
const boundOf = (length: number, separators: number): number =>
  length === 0 ? 0 : length * 3 + 5 + (length - 1) * 4 + separators * 3;

/** Folded char codes of every packed path, separators included. */
type Codes = Uint8Array | Uint16Array;

/**
 * `scoreFilePath` over the packed codes, inlined for the per-keystroke
 * loop: the same passes and points, so it ranks exactly as the shared
 * scorer does (a test holds the two equal). `query` is the folded query's
 * codes.
 */
export const scoreCodes = (
  codes: Codes,
  from: number,
  to: number,
  query: Uint16Array,
  floor: number,
  /** `separatorsBefore(query)`, for the bound. */
  separators = 0,
): number | undefined => {
  const length = query.length;
  if (length === 0) return 0;
  if (length > to - from) return undefined;
  // One backward pass finds the match and, on the way, the last "/".
  let nameStart = -1;
  let qi = length - 1;
  let start = -1;
  let end = -1;
  let inName = 0;
  let want = query[qi]!;
  for (let i = to - 1; i >= from; i -= 1) {
    const c = codes[i]!;
    if (c === 47 && nameStart < 0) nameStart = i + 1;
    if (c !== want) continue;
    if (end < 0) end = i;
    if (nameStart < 0) inName += 1;
    qi -= 1;
    if (qi < 0) {
      start = i;
      break;
    }
    want = query[qi]!;
  }
  if (start < 0) return undefined;
  const penalty = (end - start) * 4 + (to - from);
  if (floor !== Number.NEGATIVE_INFINITY) {
    // The forward pass can find a run inside a wide span, so no point is
    // taken off for the span; the name's points count only what is in it.
    const best = boundOf(length, separators) - 2 + inName * 2 + (inName > 0 ? 2 : 0) - length * 2;
    if (best * 1024 - penalty <= floor) return Number.NEGATIVE_INFINITY;
  }
  if (nameStart < 0) {
    // The match ended before any "/": the name starts further back.
    nameStart = from;
    for (let i = start - 1; i >= from; i -= 1) {
      if (codes[i] === 47) {
        nameStart = i + 1;
        break;
      }
    }
  }
  let score = 0;
  let previous = -2;
  qi = 0;
  for (let i = start; i <= end && qi < length; i += 1) {
    if (codes[i] !== query[qi]) continue;
    let points = 1;
    if (i >= nameStart) points += 2;
    const before = i === from ? 47 : codes[i - 1]!;
    if (before === 47 || before === 45 || before === 95 || before === 46 || before === 32) points += 3;
    if (previous === i - 1) points += 4;
    if (i === nameStart) points += 2;
    score += points;
    previous = i;
    qi += 1;
  }
  return score * 1024 - penalty;
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
    // The hot loop reads folded char codes from a typed array: measured 2.5x
    // faster than charCodeAt on the packed string. One byte per unit unless
    // a path holds a unit above 255.
    let wide = false;
    for (let at = 0; at < packed.length && !wide; at += FOLD_CHUNK) {
      wide = /[^\u0000-\u00ff]/u.test(packed.slice(at, at + FOLD_CHUNK));
      await yieldNow();
    }
    const codes: Codes = wide ? new Uint16Array(packed.length) : new Uint8Array(packed.length);
    for (let at = 0; at < packed.length; at += FOLD_CHUNK) {
      const folded = foldForSearch(packed.slice(at, at + FOLD_CHUNK));
      for (let i = 0; i < folded.length; i += 1) codes[at + i] = folded.charCodeAt(i);
      await yieldNow();
    }
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
      masks[i] = maskOfCodes(codes, starts[i]!, starts[i + 1]! - 1);
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
    return new NameIndex(packed, codes, starts, masks, table);
  }
}

type Top = { scores: Float64Array; ids: Int32Array; size: number; worst: number };

/**
 * Every id that may match `query`: all its matches and perhaps some that do
 * not, so a longer query scores only these. Ids at or above `base` are
 * overlay entries; below are packed entries.
 */
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
    private readonly codes: Codes,
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

  /** Every path under any of `dirs`, for folders that went away: one pass for the batch. */
  removeUnder(dirs: ReadonlyArray<string>): void {
    if (dirs.length === 0) return;
    const prefixes = dirs.map((dir) => `${dir}/`);
    for (let id = 0; id < this.base; id += 1) {
      if (this.dead[id] !== 0) continue;
      const from = this.starts[id]!;
      const to = this.starts[id + 1]! - 1;
      for (const prefix of prefixes) {
        if (to - from > prefix.length && sliceEquals(this.packed, from, from + prefix.length, prefix)) {
          this.dead[id] = 1;
          this.deadCount += 1;
          this.generation += 1;
          break;
        }
      }
    }
    for (let at = this.overlay.length - 1; at >= 0; at -= 1) {
      if (prefixes.some((prefix) => this.overlay[at]!.startsWith(prefix))) {
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
    const want = maskOf(query);
    const queryCodes = new Uint16Array(query.length);
    for (let i = 0; i < query.length; i += 1) queryCodes[i] = query.charCodeAt(i);
    const top: Top = { scores: new Float64Array(limit), ids: new Int32Array(limit), size: 0, worst: 0 };
    const narrow =
      previous !== undefined && previous.generation === this.generation && query.startsWith(previous.query);
    const base = this.base;
    const total = base + this.overlay.length;
    const { codes, starts, masks, dead } = this;
    const found = new Int32Array(narrow ? previous.ids.length : total);
    let foundCount = 0;
    const count = narrow ? previous.ids.length : total;
    const ids = narrow ? previous.ids : undefined;
    // The most any match can score, less the path's length: every point
    // for every character, the tightest span (see scoreCodes).
    const separators = separatorsBefore(queryCodes);
    const perfect = boundOf(query.length, separators) * 1024 - (query.length - 1) * 4;
    for (let at = 0; at < count; at += 1) {
      const id = ids === undefined ? at : ids[at]!;
      let score: number | undefined;
      if (id < base) {
        if (dead[id] !== 0 || (masks[id]! & want) !== want) continue;
        const from = starts[id]!;
        const to = starts[id + 1]! - 1;
        const floor = top.size < limit ? Number.NEGATIVE_INFINITY : top.scores[top.worst]!;
        // Too long to beat the 50th even matched perfectly: kept for the next
        // keystroke unscored. The set only has to hold every match, not only matches.
        if (perfect - (to - from) <= floor) {
          found[foundCount] = id;
          foundCount += 1;
          continue;
        }
        score = scoreCodes(codes, from, to, queryCodes, floor, separators);
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
