/**
 * The `files` link channel, as closed wire shapes (0.12, plan 12-files-over-ssh,
 * slice X1b): what a window machine may ask another machine's Files service,
 * what comes back, and the events an open session sends.
 *
 * A request names a Files node (canvas and id) and a path relative to its
 * root, and nothing else. A root, an absolute path or a command has no field
 * here, and every decoder refuses an excess property, so a peer cannot send
 * one. The host takes the root from its own copy of the node.
 *
 * `unreachable` is not on the wire: only the window machine can say no link is
 * open. A refusal the host sends is its own `FilesError`, and crosses as an
 * answer (`Refused`), never as a link failure.
 *
 * A wire module: its import closure is `effect` and its siblings alone.
 */

import { Schema } from "effect";
import { isFileName, parseFilePath, type FileEntry, type FilePath, type FilesError } from "../files";
import { CANONICAL_CANVAS_NAME_PATTERN } from "./canvas-name";
import { NodeId } from "./ids";

const CanvasName = Schema.String.pipe(Schema.check(Schema.isPattern(CANONICAL_CANVAS_NAME_PATTERN)));

/** Longest text a read or write carries in one frame, as JSON, until X3 chunks it (the frame bound is 1 MiB). */
export const FILES_LINK_TEXT_JSON_MAX = 900_000;
/** Most entries a listing, a search or a `paths` event holds; the frame bound is the real limit. */
export const FILES_LINK_ENTRIES_MAX = 10_000;
export const FILES_LINK_QUERY_MAX = 512;

/** Whether `text` fits one frame once it is JSON. */
export const fitsOneFrame = (text: string): boolean => new TextEncoder().encode(JSON.stringify(text)).byteLength <= FILES_LINK_TEXT_JSON_MAX;

/**
 * A path relative to the root, or the root itself (""): `parseFilePath` is the
 * one definition. Typed as the brand `parseFilePath` makes, which a Schema
 * brand cannot name.
 */
export const FilePathWire = Schema.String.pipe(
  Schema.check(Schema.makeFilter((raw: string) => parseFilePath(raw) !== undefined)),
) as unknown as Schema.Codec<FilePath, string>;

const Stamp = Schema.Struct({ mtimeMs: Schema.Number, size: Schema.Number });
const Entry = Schema.Struct({ path: FilePathWire, dir: Schema.Boolean, stamp: Stamp }) satisfies Schema.Codec<FileEntry, unknown>;
const Entries = Schema.Array(Entry).pipe(Schema.check(Schema.isMaxLength(FILES_LINK_ENTRIES_MAX)));
const Paths = Schema.Array(FilePathWire).pipe(Schema.check(Schema.isMaxLength(FILES_LINK_ENTRIES_MAX)));
/** One segment, as `isFileName` reads it: no `/`, no `.` or `..`. */
const Name = Schema.String.pipe(Schema.check(Schema.makeFilter((raw: string) => isFileName(raw))));

/** The refusals a host can send: `FilesError` without `unreachable`, which only the window machine makes. */
export const HOST_FILES_ERRORS = [
  "no-node", "elsewhere", "root-missing", "invalid-path", "outside-root", "not-found",
  "exists", "not-dir", "is-dir", "stale", "too-large", "denied", "failed",
] as const;
export type HostFilesError = (typeof HOST_FILES_ERRORS)[number];
/** Fails to compile when `FilesError` gains a refusal this list does not carry (`unreachable` aside). */
export const hostErrorsAreComplete: Exclude<FilesError, HostFilesError> extends "unreachable" ? true : never = true;
export const HostFilesError = Schema.Literals(HOST_FILES_ERRORS);

const Where = { canvas: CanvasName, node: NodeId } as const;

export const FilesOpen = Schema.Struct({ _tag: Schema.Literal("Open"), ...Where });
export const FilesClose = Schema.Struct({ _tag: Schema.Literal("Close"), ...Where });
export const FilesCount = Schema.Struct({ _tag: Schema.Literal("Count"), ...Where });
export const FilesList = Schema.Struct({ _tag: Schema.Literal("List"), ...Where, dir: FilePathWire });
export const FilesRead = Schema.Struct({ _tag: Schema.Literal("Read"), ...Where, path: FilePathWire });
export const FilesWrite = Schema.Struct({
  _tag: Schema.Literal("Write"), ...Where, path: FilePathWire,
  text: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024 * 1024))),
  base: Schema.NullOr(Stamp),
});
export const FilesCreate = Schema.Struct({ _tag: Schema.Literal("Create"), ...Where, path: FilePathWire, dir: Schema.Boolean });
export const FilesRename = Schema.Struct({ _tag: Schema.Literal("Rename"), ...Where, path: FilePathWire, name: Name });
export const FilesMove = Schema.Struct({ _tag: Schema.Literal("Move"), ...Where, path: FilePathWire, into: FilePathWire });
export const FilesTrash = Schema.Struct({ _tag: Schema.Literal("Trash"), ...Where, path: FilePathWire });
/**
 * Names the folder to import into and nothing else: a dropped file's source is
 * a path on the window machine, which a host never reads. Answered `denied`
 * until X3 sends the bytes.
 */
export const FilesImport = Schema.Struct({ _tag: Schema.Literal("Import"), ...Where, into: FilePathWire });
export const FilesSearch = Schema.Struct({
  _tag: Schema.Literal("Search"), ...Where,
  query: Schema.String.pipe(Schema.check(Schema.isMaxLength(FILES_LINK_QUERY_MAX))),
  seq: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const FilesRequest = Schema.Union([
  FilesOpen, FilesClose, FilesCount, FilesList, FilesRead, FilesWrite, FilesCreate,
  FilesRename, FilesMove, FilesTrash, FilesImport, FilesSearch,
]);
export type FilesRequest = typeof FilesRequest.Type;

const Read = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024 * 1024))), stamp: Stamp }),
  Schema.Struct({ kind: Schema.Literal("binary"), mime: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))), stamp: Stamp }),
  Schema.Struct({ kind: Schema.Literal("too-large"), size: Schema.Number, stamp: Stamp }),
]);
const Match = Schema.Struct({ path: FilePathWire, positions: Schema.Array(Schema.Int).pipe(Schema.check(Schema.isMaxLength(FILES_LINK_ENTRIES_MAX))) });
const Search = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("results"),
    query: Schema.String.pipe(Schema.check(Schema.isMaxLength(FILES_LINK_QUERY_MAX))),
    matches: Schema.Array(Match).pipe(Schema.check(Schema.isMaxLength(FILES_LINK_ENTRIES_MAX))),
    total: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("superseded"), query: Schema.String.pipe(Schema.check(Schema.isMaxLength(FILES_LINK_QUERY_MAX))) }),
]);

/** Every answer says which op it answers: a response carries no request. */
export const FilesResponse = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Opened"), root: Schema.Struct({ name: Schema.String.pipe(Schema.check(Schema.isMaxLength(255))), repo: Schema.Boolean }) }),
  Schema.Struct({ _tag: Schema.Literal("Closed") }),
  Schema.Struct({ _tag: Schema.Literal("Counted"), files: Schema.Number, capped: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("Listed"), entries: Entries }),
  Schema.Struct({ _tag: Schema.Literal("Read"), read: Read }),
  Schema.Struct({ _tag: Schema.Literal("Written"), stamp: Stamp }),
  Schema.Struct({ _tag: Schema.Literal("Created"), entry: Entry }),
  Schema.Struct({ _tag: Schema.Literal("Renamed"), path: FilePathWire }),
  Schema.Struct({ _tag: Schema.Literal("Moved"), path: FilePathWire }),
  Schema.Struct({ _tag: Schema.Literal("Trashed") }),
  Schema.Struct({ _tag: Schema.Literal("Imported"), imported: Schema.Array(Schema.Struct({ path: FilePathWire, dir: Schema.Boolean })).pipe(Schema.check(Schema.isMaxLength(FILES_LINK_ENTRIES_MAX))) }),
  Schema.Struct({ _tag: Schema.Literal("Searched"), search: Search }),
  /** The host's own refusal: a real answer, with the link up. */
  Schema.Struct({ _tag: Schema.Literal("Refused"), error: HostFilesError }),
]);
export type FilesResponse = typeof FilesResponse.Type;

/** A change under a node a peer opened; the host's `FilesChanged`, for the link. */
export const FilesEvent = Schema.Union([
  Schema.Struct({ node: NodeId, kind: Schema.Literal("paths"), paths: Paths }),
  Schema.Struct({ node: NodeId, kind: Schema.Literal("reset") }),
  Schema.Struct({ node: NodeId, kind: Schema.Literal("missing") }),
  Schema.Struct({ node: NodeId, kind: Schema.Literal("back") }),
  Schema.Struct({ node: NodeId, kind: Schema.Literal("closed"), error: HostFilesError }),
]);
export type FilesEvent = typeof FilesEvent.Type;

const options = { onExcessProperty: "error" } as const;
export const decodeFilesRequest = Schema.decodeUnknownSync(FilesRequest, options);
export const decodeFilesResponse = Schema.decodeUnknownSync(FilesResponse, options);
export const decodeFilesEvent = Schema.decodeUnknownSync(FilesEvent, options);
