import type { NodeId } from "./physics/schema";

/**
 * The Files node's reach into its folder (0.11, F2): what the renderer may
 * ask main for, and what comes back. Main is `src/main/junto/files/`.
 *
 * The renderer never names an absolute path. Every call names the node (its
 * canvas and id) and a path relative to the node's root; main reads the root
 * off the node, `realpath`s the target and refuses anything outside the root,
 * symlinks included. Nothing main sends back names the root or any absolute
 * path either: replies, errors and change events carry node ids and relative
 * paths only. The one exception runs the other way: `import` takes the OS
 * paths of files dropped from Finder, as sources to copy from and never to
 * change (see `docs/security-doctrine.md`, "Files node").
 *
 * A node is served only on its own host: main refuses a node whose host is
 * not this machine (`elsewhere`), so the same root path is never opened on
 * another disk.
 */

declare const filePathBrand: unique symbol;

/**
 * A path relative to the node's root: `/` separated, no leading or trailing
 * `/`, no empty, `.` or `..` segment, no backslash or NUL. The empty string
 * is the root itself. Made only by `parseFilePath` (or `ROOT_PATH`).
 */
export type FilePath = string & { readonly [filePathBrand]: "FilePath" };

export const ROOT_PATH = "" as FilePath;

/** Longest relative path main accepts, in UTF-16 units. */
export const FILE_PATH_MAX = 4096;
/** Longest segment: the common filesystem name limit. */
export const FILE_NAME_MAX = 255;

/** The relative path, or undefined when it is not one. */
export const parseFilePath = (raw: unknown): FilePath | undefined => {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return ROOT_PATH;
  if (raw.length > FILE_PATH_MAX) return undefined;
  if (raw.includes("\\") || raw.includes("\0")) return undefined;
  for (const segment of raw.split("/")) {
    if (!isFileName(segment)) return undefined;
  }
  return raw as FilePath;
};

/** One segment: a name a rename may give, with no `/`. */
export const isFileName = (raw: string): boolean =>
  raw !== "" &&
  raw !== "." &&
  raw !== ".." &&
  raw.length <= FILE_NAME_MAX &&
  !raw.includes("/") &&
  !raw.includes("\\") &&
  !raw.includes("\0");

/** `dir` joined with one `name`; the root joins to the bare name. */
export const joinFilePath = (dir: FilePath, name: string): FilePath | undefined =>
  isFileName(name) ? parseFilePath(dir === ROOT_PATH ? name : `${dir}/${name}`) : undefined;

/** The folder holding `path`; the root for a top-level entry. */
export const parentOf = (path: FilePath): FilePath => {
  const slash = path.lastIndexOf("/");
  return (slash < 0 ? ROOT_PATH : path.slice(0, slash)) as FilePath;
};

/** The last segment. */
export const baseName = (path: FilePath): string => path.slice(path.lastIndexOf("/") + 1);

/** The version of a file a reader saw. A write names it and is refused `stale` when the file moved on. */
export type FileStamp = { readonly mtimeMs: number; readonly size: number };

export const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.mtimeMs === b.mtimeMs && a.size === b.size;

export type FileEntry = { readonly path: FilePath; readonly dir: boolean; readonly stamp: FileStamp };

/** Text reads stop here; a larger text file reads `too-large`. Binaries have no cap: their bytes go over `junto-file:`. */
export const FILE_TEXT_MAX_BYTES = 5 * 1024 * 1024;

export type FileRead =
  | { readonly kind: "text"; readonly text: string; readonly stamp: FileStamp }
  /** Bytes are not read here: load them from `fileUrl(node, path)`. `mime` is `fileMime(path)`. */
  | { readonly kind: "binary"; readonly mime: string; readonly stamp: FileStamp }
  | { readonly kind: "too-large"; readonly size: number; readonly stamp: FileStamp };

/**
 * Why a call was refused. Closed: the renderer switches on it.
 *
 * - `no-node`: no Files node by that id on that canvas.
 * - `elsewhere`: the node's host is not this machine.
 * - `root-missing`: the root is gone or is not a folder.
 * - `invalid-path`: not a `FilePath`, or a name with a `/`.
 * - `outside-root`: the path resolves outside the root (a symlink out, most often).
 * - `not-found`, `exists`, `not-dir`, `is-dir`: what the filesystem said.
 * - `stale`: the file is no longer the version the write named.
 * - `too-large`: a text write over `FILE_TEXT_MAX_BYTES`.
 * - `denied`: the filesystem refused permission.
 * - `failed`: anything else; the reason stays in main's log, never here.
 */
export type FilesError =
  | "no-node"
  | "elsewhere"
  | "root-missing"
  | "invalid-path"
  | "outside-root"
  | "not-found"
  | "exists"
  | "not-dir"
  | "is-dir"
  | "stale"
  | "too-large"
  | "denied"
  | "failed";

export type FilesResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: FilesError };

/** Which Files node a call is for. */
export type FilesNodeRef = { readonly canvas: string; readonly node: NodeId };

/** The node's folder as `open` finds it. `name` is the root's last segment, for the header. */
export type FilesRoot = { readonly name: string; readonly repo: boolean };

/** Filename search: the best `FILES_SEARCH_LIMIT` files under the root for a query. */
export const FILES_SEARCH_LIMIT = 50;

export type FileMatch = {
  readonly path: FilePath;
  /** Indexes into `path` of the matched characters, ascending, for highlighting. */
  readonly positions: ReadonlyArray<number>;
};

export type FilesSearchResult =
  | {
      readonly kind: "results";
      readonly query: string;
      readonly matches: ReadonlyArray<FileMatch>;
      /** Files under the root the index holds. */
      readonly total: number;
    }
  /** A newer search from the same window for the same node took its place. Drop it. */
  | { readonly kind: "superseded"; readonly query: string };

/** How many files are under a root, for the card. `capped`: the count stopped at `FILES_COUNT_CAP` (a home folder, say). */
export type FilesCount = { readonly files: number; readonly capped: boolean };

/** A count outside a git work tree stops here. */
export const FILES_COUNT_CAP = 100_000;

/** One dropped item copied in, by the name it got (` 2`, ` 3` when the name was taken). */
export type FileImported = { readonly path: FilePath; readonly dir: boolean };

/**
 * Main -> renderer: something changed under an open node's root. Paths are
 * the entries that changed (added, removed or written); `reset` means too
 * much changed at once (a checkout, an install) and the tree re-lists.
 */
export type FilesChanged =
  | { readonly node: NodeId; readonly kind: "paths"; readonly paths: ReadonlyArray<FilePath> }
  | { readonly node: NodeId; readonly kind: "reset" }
  /** The root is gone or the node moved to another host; calls now refuse. */
  | { readonly node: NodeId; readonly kind: "closed"; readonly error: FilesError };

export interface JuntoFilesApi {
  readonly files: {
    /**
     * Start serving a node to this window: its changes push to `onChange`
     * and its bytes load on `junto-file://`. Call again after a reload or
     * when the node's root changes; `close` when the node leaves the screen.
     */
    readonly open: (ref: FilesNodeRef) => Promise<FilesResult<FilesRoot>>;
    readonly close: (ref: FilesNodeRef) => Promise<FilesResult<null>>;
    /**
     * Files under the root, for the card; no `open` needed and none made. It
     * reads the index when a window holds the root, else counts once (git
     * ls-files, or a walk up to `FILES_COUNT_CAP`) and keeps that count until
     * the root is opened again. Ask again on `onChange`.
     */
    readonly count: (ref: FilesNodeRef) => Promise<FilesResult<FilesCount>>;
    /** One folder's entries, folders first, then by name. */
    readonly list: (ref: FilesNodeRef, dir: FilePath) => Promise<FilesResult<ReadonlyArray<FileEntry>>>;
    /**
     * Ranked filenames for quick open, on a node this window opened (else
     * `no-node`). Send a rising `seq` per keystroke; an older one answers `superseded`.
     */
    readonly search: (ref: FilesNodeRef, query: string, seq: number) => Promise<FilesResult<FilesSearchResult>>;
    readonly read: (ref: FilesNodeRef, path: FilePath) => Promise<FilesResult<FileRead>>;
    /** Replace a text file. Refused `stale` when it is no longer `base`; answers the new stamp. */
    readonly write: (
      ref: FilesNodeRef,
      path: FilePath,
      text: string,
      base: FileStamp,
    ) => Promise<FilesResult<FileStamp>>;
    /** A new empty file or folder. Refused `exists`. */
    readonly create: (ref: FilesNodeRef, path: FilePath, dir: boolean) => Promise<FilesResult<FileEntry>>;
    /** Give an entry a new name in its folder. Refused `exists`. */
    readonly rename: (ref: FilesNodeRef, path: FilePath, name: string) => Promise<FilesResult<FilePath>>;
    /** Move an entry into another folder under the root, keeping its name. Refused `exists`. */
    readonly move: (ref: FilesNodeRef, path: FilePath, intoDir: FilePath) => Promise<FilesResult<FilePath>>;
    /** Move an entry to the system Trash. Never unlinks. */
    readonly trash: (ref: FilesNodeRef, path: FilePath) => Promise<FilesResult<null>>;
    /**
     * Copy dropped files and folders into `intoDir`, never moving or
     * overwriting: a taken name gets ` 2`, ` 3`. `sources` are what
     * `pathForDroppedFile` gave for each dropped `File`; any other path, or
     * one already imported, is refused `denied`, as is a source inside
     * Junto's home (a dropped folder holding it copies without it).
     */
    readonly import: (
      ref: FilesNodeRef,
      intoDir: FilePath,
      sources: ReadonlyArray<string>,
    ) => Promise<FilesResult<ReadonlyArray<FileImported>>>;
    /**
     * Open a file or folder (the root too: `ROOT_PATH`) in its default app;
     * a folder opens in Finder. Refused `denied` for what would run rather
     * than open: an executable, an `.app` or other launchable bundle or script.
     */
    readonly openInDefaultApp: (ref: FilesNodeRef, path: FilePath) => Promise<FilesResult<null>>;
    /** Show a file or folder (the root too) selected in Finder. */
    readonly revealInFinder: (ref: FilesNodeRef, path: FilePath) => Promise<FilesResult<null>>;
    readonly onChange: (listener: (event: FilesChanged) => void) => () => void;
    /** The OS path of a `File` from a drop (Electron `webUtils.getPathForFile`); "" for one that has none. */
    readonly pathForDroppedFile: (file: File) => string;
  };
}

/**
 * Text a filename query matches against: lower case, one UTF-16 unit for
 * one, so match positions index the original path. A character whose lower
 * case is longer ("İ") stays as it is.
 */
export const foldForSearch = (text: string): string => {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charAt(i);
    const folded = unit.toLowerCase();
    out += folded.length === 1 ? folded : unit;
  }
  return out;
};

/**
 * Score one candidate path for a query already folded with `foldForSearch`.
 * Every query character must appear in order. Higher is better; undefined
 * means no match. Pure, so main's index and its tests share it.
 *
 * Favoured, in order: matches in the last segment (the file name), a match
 * at the start of a segment or after `-`, `_`, `.`, a run of consecutive
 * matches, and a shorter path.
 */
export const scoreFilePath = (
  folded: string,
  query: string,
  positions?: number[],
  /** Score `folded.slice(from, to)` without copying it (main's packed index); positions stay relative to `from`. */
  from = 0,
  to = folded.length,
  /**
   * The score to beat (main's 50th best so far). A match that cannot beat
   * it answers `-Infinity` without being scored: still a match, for the
   * next keystroke's narrowing, never a result.
   */
  floor = Number.NEGATIVE_INFINITY,
): number | undefined => {
  if (query.length === 0) return 0;
  if (query.length > to - from) return undefined;
  const slash = folded.lastIndexOf("/", to - 1);
  const nameStart = slash < from ? from : slash + 1;
  // Greedy from the end backwards finds the match nearest the file name; a
  // forward pass from its start then tightens it. Two linear passes, no tables.
  let qi = query.length - 1;
  let start = -1;
  let end = -1;
  let inName = 0;
  for (let i = to - 1; i >= from; i -= 1) {
    if (folded.charCodeAt(i) !== query.charCodeAt(qi)) continue;
    if (end < 0) end = i;
    if (i >= nameStart) inName += 1;
    qi -= 1;
    if (qi < 0) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const penalty = (end - start) * 4 + (to - from);
  if (floor !== Number.NEGATIVE_INFINITY) {
    // The most the points below can add up to for this span: every character
    // at a word start, a run wherever the span allows one, the name's bonuses
    // only for characters the backward pass found in the name.
    const length = query.length;
    // A wide span can still hold a run the forward pass finds: no point off for it.
    const runs = length - 1;
    const best = length * 4 + inName * 2 + (inName > 0 ? 2 : 0) + runs * 4;
    if (best * 1024 - penalty <= floor) return Number.NEGATIVE_INFINITY;
  }
  let score = 0;
  let previous = -2;
  qi = 0;
  for (let i = start; i <= end && qi < query.length; i += 1) {
    if (folded.charCodeAt(i) !== query.charCodeAt(qi)) continue;
    positions?.push(i - from);
    let points = 1;
    if (i >= nameStart) points += 2;
    const before = i === from ? 47 : folded.charCodeAt(i - 1);
    // "/", "-", "_", ".", " "
    if (before === 47 || before === 45 || before === 95 || before === 46 || before === 32) points += 3;
    if (previous === i - 1) points += 4;
    if (i === nameStart) points += 2;
    score += points;
    previous = i;
    qi += 1;
  }
  // Tighter spans and shorter paths win ties.
  return score * 1024 - penalty;
};
