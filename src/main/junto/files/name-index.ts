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
  if (beyond(length, separators, inName, penalty, floor)) return Number.NEGATIVE_INFINITY;
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
    score += pointsAt(codes, from, nameStart, i, previous);
    previous = i;
    qi += 1;
  }
  return score * 1024 - penalty;
};

/**
 * True when a match with `inName` characters in the name and this
 * `penalty` cannot beat `floor` however its points fall. The forward pass
 * can find a run inside a wide span, so no point is taken off for the span;
 * the name's points count only what is in it.
 */
const beyond = (length: number, separators: number, inName: number, penalty: number, floor: number): boolean =>
  floor !== Number.NEGATIVE_INFINITY &&
  (boundOf(length, separators) - 2 + inName * 2 + (inName > 0 ? 2 : 0) - length * 2) * 1024 - penalty <= floor;

/** The points for a query character matched at `i`, after one matched at `previous`. */
const pointsAt = (codes: Codes, from: number, nameStart: number, i: number, previous: number): number => {
  let points = 1;
  if (i >= nameStart) points += 2;
  const before = i === from ? 47 : codes[i - 1]!;
  if (before === 47 || before === 45 || before === 95 || before === 46 || before === 32) points += 3;
  if (previous === i - 1) points += 4;
  if (i === nameStart) points += 2;
  return points;
};

/**
 * One query's passes through each folder, kept for every file in that
 * folder. Slot `folder * query length + qi`, where `qi` is the last query
 * character the name left unmatched. `starts`: 0 not walked yet, -1 the
 * query's first `qi + 1` characters are not in the folder, else 1 + where
 * the backward match starts, from the path's start; `ends` 1 + where it first
 * matched, for a name that held none of the query. From that start, the
 * forward pass's share of the folder: `matched` 0 not run yet, else 1 + the
 * query characters it took; their `points`; and `joined` 1 when the last
 * took the folder's closing "/", so a match at the name's first character
 * is a run.
 */
type FolderPasses = {
  readonly starts: Int32Array;
  readonly ends: Int32Array;
  readonly matched: Int32Array;
  readonly points: Int32Array;
  readonly joined: Uint8Array;
};

/**
 * Past this many slots (17 MB held) a query walks every path whole instead:
 * 20,000 folders allow a 52-character query.
 */
const FOLDER_SLOTS = 1 << 20;

/**
 * Passes for `slots` slots, reusing `held` when it is big enough. Only
 * `starts` and `matched` are cleared: the rest is read only after them.
 */
const folderPasses = (slots: number, held: FolderPasses | undefined): FolderPasses => {
  if (held === undefined || held.starts.length < slots) {
    return {
      starts: new Int32Array(slots),
      ends: new Int32Array(slots),
      matched: new Int32Array(slots),
      points: new Int32Array(slots),
      joined: new Uint8Array(slots),
    };
  }
  held.starts.fill(0, 0, slots);
  held.matched.fill(0, 0, slots);
  return held;
};

/**
 * `scoreCodes` for a packed path whose folder part, `from` to `nameStart`
 * ("/" included), it shares with every file in folder `folder`: the name is
 * walked per path, the folder once per query and unmatched character.
 * Paths are mostly folder (about 85 of 101 units on the 200k fixture), so
 * this saves most of both passes. The same greedy matches, so the same score.
 */
const scoreInFolder = (
  codes: Codes,
  from: number,
  to: number,
  nameStart: number,
  folder: number,
  passes: FolderPasses,
  query: Uint16Array,
  floor: number,
  separators: number,
): number | undefined => {
  const length = query.length;
  if (length === 0) return 0;
  if (length > to - from) return undefined;
  let qi = length - 1;
  let start = -1;
  let end = -1;
  let inName = 0;
  let want = query[qi]!;
  for (let i = to - 1; i >= nameStart; i -= 1) {
    if (codes[i] !== want) continue;
    if (end < 0) end = i;
    inName += 1;
    qi -= 1;
    if (qi < 0) {
      start = i;
      break;
    }
    want = query[qi]!;
  }
  let slot = -1;
  if (start < 0) {
    slot = folder * length + qi;
    let walked = passes.starts[slot]!;
    if (walked === 0) {
      walked = -1;
      let first = -1;
      for (let i = nameStart - 1; i >= from; i -= 1) {
        if (codes[i] !== want) continue;
        if (first < 0) first = i;
        qi -= 1;
        if (qi < 0) {
          walked = i - from + 1;
          break;
        }
        want = query[qi]!;
      }
      passes.starts[slot] = walked;
      passes.ends[slot] = first - from + 1;
    }
    if (walked < 0) return undefined;
    start = from + walked - 1;
    if (end < 0) end = from + passes.ends[slot]! - 1;
  }
  const penalty = (end - start) * 4 + (to - from);
  if (beyond(length, separators, inName, penalty, floor)) return Number.NEGATIVE_INFINITY;
  let score = 0;
  let previous = -2;
  let i = start;
  qi = 0;
  if (slot >= 0) {
    // The forward pass through the folder. A match that ends in the folder
    // (none in the name) is complete there, so running to the folder's end
    // instead of `end` takes the same characters.
    let matched = passes.matched[slot]!;
    if (matched === 0) {
      let points = 0;
      let last = -2;
      for (let at = start; at < nameStart && qi < length; at += 1) {
        if (codes[at] !== query[qi]) continue;
        points += pointsAt(codes, from, nameStart, at, last);
        last = at;
        qi += 1;
      }
      matched = qi + 1;
      passes.matched[slot] = matched;
      passes.points[slot] = points;
      passes.joined[slot] = last === nameStart - 1 ? 1 : 0;
    }
    score = passes.points[slot]!;
    qi = matched - 1;
    previous = passes.joined[slot] === 1 ? nameStart - 1 : -2;
    i = nameStart;
  }
  for (; i <= end && qi < length; i += 1) {
    if (codes[i] !== query[qi]) continue;
    score += pointsAt(codes, from, nameStart, i, previous);
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

/** A unit above U+00FF: one such path would make the whole packed string two bytes a unit. */
const WIDE = /[^\u0000-\u00ff]/u;

/**
 * Collects names as they stream in, one joined string per chunk, so the
 * build never holds an array of every path. `finish` packs and indexes them,
 * yielding between chunks. Names with a unit above U+00FF (`日本語.md`, a
 * few in most trees) stay apart as plain strings, so the packed string and
 * its codes stay one byte a unit: on a real 200k tree, 1,112 such names
 * would otherwise double 40 MB to 80 MB.
 */
export class NameIndexBuilder {
  private readonly chunks: string[] = [];
  private readonly wide: string[] = [];
  private count = 0;

  add(names: ReadonlyArray<string>): void {
    const kept: string[] = [];
    for (const name of names) {
      if (name === "" || name.includes(SEPARATOR)) continue;
      if (WIDE.test(name)) this.wide.push(name);
      else kept.push(name);
    }
    if (kept.length === 0) return;
    this.chunks.push(kept.join(SEPARATOR));
    this.count += kept.length;
  }

  get size(): number {
    return this.count + this.wide.length;
  }

  async finish(yieldNow: Yield = yieldToLoop): Promise<NameIndex> {
    // Names cut from a two-byte string (git output that held one wide name)
    // stay two-byte however narrow their content: one Latin-1 round trip
    // makes the packed string one byte a unit, which every name here fits.
    const packed = Buffer.from(this.chunks.join(SEPARATOR), "latin1").toString("latin1");
    this.chunks.length = 0;
    const count = this.count;
    // The hot loop reads folded char codes from a typed array: measured 2.5x
    // faster than charCodeAt on the packed string. One byte per unit: wide
    // names are kept apart, and folding keeps Latin-1 in Latin-1.
    const codes: Codes = new Uint8Array(packed.length);
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
    // Each path's folder ("" for a file at the root), by the folder part's text.
    const folders = new Int32Array(count);
    const folderIds = new Map<string, number>();
    const lengths: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const from = starts[i]!;
      const slash = packed.lastIndexOf("/", starts[i + 1]! - 2);
      const length = slash < from ? 0 : slash - from + 1;
      const folder = packed.slice(from, from + length);
      let id = folderIds.get(folder);
      if (id === undefined) {
        id = lengths.length;
        folderIds.set(folder, id);
        lengths.push(length);
      }
      folders[i] = id;
      if (i % CHUNK === CHUNK - 1) await yieldNow();
    }
    folderIds.clear();
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
    const wide = this.wide.splice(0);
    return new NameIndex(packed, codes, starts, masks, table, folders, Int32Array.from(lengths), wide);
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
  /** Paths not in the packed string: wide names from the build, and every add since. */
  private readonly overlay: string[];
  private readonly overlayFolded: string[];
  /** Adds and removes since the build. */
  private changes = 0;
  /** Changes on every delta; a cached match set from another generation is not narrowed. */
  private generation = 0;
  /** The last search's folder passes, cleared and reused by the next. */
  private passes: FolderPasses | undefined;

  constructor(
    private readonly packed: string,
    private readonly codes: Codes,
    private readonly starts: Int32Array,
    private readonly masks: Int32Array,
    private readonly table: Int32Array,
    /** Each packed path's folder, and per folder the length of its part of the path, "/" included. */
    private readonly folders: Int32Array,
    private readonly folderLengths: Int32Array,
    wide: ReadonlyArray<string> = [],
  ) {
    this.overlay = [...wide];
    this.overlayFolded = wide.map(foldForSearch);
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
    return this.changes;
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
    this.changes += 1;
  }

  remove(path: string): void {
    const id = this.findPacked(path);
    if (id >= 0) {
      this.dead[id] = 1;
      this.deadCount += 1;
      this.generation += 1;
      this.changes += 1;
      return;
    }
    const at = this.overlay.indexOf(path);
    if (at < 0) return;
    this.overlay.splice(at, 1);
    this.overlayFolded.splice(at, 1);
    this.generation += 1;
    this.changes += 1;
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
          this.changes += 1;
          break;
        }
      }
    }
    for (let at = this.overlay.length - 1; at >= 0; at -= 1) {
      if (prefixes.some((prefix) => this.overlay[at]!.startsWith(prefix))) {
        this.overlay.splice(at, 1);
        this.overlayFolded.splice(at, 1);
        this.generation += 1;
        this.changes += 1;
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
    const { codes, starts, masks, dead, folders, folderLengths } = this;
    const slots = folderLengths.length * query.length;
    const passes = slots <= FOLDER_SLOTS ? folderPasses(slots, this.passes) : undefined;
    this.passes = passes ?? this.passes;
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
        if (passes === undefined) score = scoreCodes(codes, from, to, queryCodes, floor, separators);
        else {
          const folder = folders[id]!;
          const nameStart = from + folderLengths[folder]!;
          score = scoreInFolder(codes, from, to, nameStart, folder, passes, queryCodes, floor, separators);
        }
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
