/**
 * The `files` link channel, as closed wire shapes (0.12, plan 12-files-over-ssh,
 * slice X1b): what a window machine may ask another machine's Files service,
 * what comes back, and the events an open session sends.
 *
 * A request names a Files node (canvas and id) and a path relative to its
 * root, and nothing else. A root, an absolute path or a command has no field
 * here, and the contract's codecs refuse an excess property, so a peer cannot
 * send one. The host takes the root from its own copy of the node.
 *
 * `unreachable` is not on the wire: only the window machine can say no link is
 * open. A refusal the host sends is its own `FilesRefused`, the ops' typed
 * error, so it is told apart from a link failure by its type.
 *
 * Not a phone wire module (src/shared/wire/ is the phone's closure): this is
 * desktop to desktop, and it reads `files.ts` for the one path definition.
 */

import { Schema } from "effect";
import { isFileName, parseFilePath, type FileEntry, type FilePath } from "./files";
import { CANONICAL_CANVAS_NAME_PATTERN } from "./wire/canvas-name";
import { NodeId } from "./wire/ids";

const CanvasName = Schema.String.pipe(Schema.check(Schema.isPattern(CANONICAL_CANVAS_NAME_PATTERN)));

/** Longest text a read or write carries in one frame, as JSON, until X3 chunks it (the frame bound is 1 MiB). */
export const FILES_LINK_TEXT_JSON_MAX = 900_000;
/** Most entries a listing, a search or a `paths` event holds; the frame bound is the real limit. */
export const FILES_LINK_ENTRIES_MAX = 10_000;
export const FILES_LINK_QUERY_MAX = 512;

/** Whether `value` fits one frame once it is JSON, in bytes as the frame bound counts them. */
export const fitsOneFrame = (value: unknown): boolean => new TextEncoder().encode(JSON.stringify(value)).byteLength <= FILES_LINK_TEXT_JSON_MAX;

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
const Moves = Schema.Array(Schema.Struct({ from: FilePathWire, to: FilePathWire })).pipe(Schema.check(Schema.isMaxLength(FILES_LINK_ENTRIES_MAX)));
const Name = Schema.String.pipe(Schema.check(Schema.makeFilter((raw: string) => isFileName(raw))));

/** The refusals a host can send: `FilesError` without `unreachable`, which only the window machine makes. */
export const HOST_FILES_ERRORS = [
  "no-node", "elsewhere", "root-missing", "invalid-path", "outside-root", "not-found",
  "exists", "not-dir", "is-dir", "stale", "too-large", "denied", "failed",
] as const;
export type HostFilesError = (typeof HOST_FILES_ERRORS)[number];
export const HostFilesError = Schema.Literals(HOST_FILES_ERRORS);

const Where = { canvas: CanvasName, node: NodeId } as const;

/**
 * One payload per op, named for the op's Rpc tag (the tag crosses beside the
 * payload, not in it). The contract in `core/files/link.ts` pairs each with
 * its answer below.
 */
export const FilesOpen = Schema.Struct(Where);
export const FilesClose = Schema.Struct(Where);
export const FilesCount = Schema.Struct(Where);
export const FilesList = Schema.Struct({ ...Where, dir: FilePathWire });
export const FilesRead = Schema.Struct({ ...Where, path: FilePathWire });
export const FilesWrite = Schema.Struct({
  ...Where, path: FilePathWire,
  text: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024 * 1024))),
  base: Schema.NullOr(Stamp),
});
export const FilesCreate = Schema.Struct({ ...Where, path: FilePathWire, dir: Schema.Boolean });
export const FilesRename = Schema.Struct({ ...Where, path: FilePathWire, name: Name });
export const FilesMove = Schema.Struct({ ...Where, path: FilePathWire, into: FilePathWire });
export const FilesTrash = Schema.Struct({ ...Where, path: FilePathWire });
/**
 * Names the folder to import into and nothing else: a dropped file's source is
 * a path on the window machine, which a host never reads. Answered `denied`
 * until X3 sends the bytes.
 */
export const FilesImport = Schema.Struct({ ...Where, into: FilePathWire });
export const FilesSearch = Schema.Struct({
  ...Where,
  query: Schema.String.pipe(Schema.check(Schema.isMaxLength(FILES_LINK_QUERY_MAX))),
  seq: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

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

/** What each op answers with, named for its tag: an answer carries no request. */
export const FilesOpened = Schema.Struct({ name: Schema.String.pipe(Schema.check(Schema.isMaxLength(255))), repo: Schema.Boolean });
export const FilesCounted = Schema.Struct({ files: Schema.Number, capped: Schema.Boolean });
export const FilesListed = Entries;
export const FilesReadAnswer = Read;
export const FilesWritten = Stamp;
export const FilesCreated = Entry;
export const FilesPathAnswer = FilePathWire;
export const FilesImported = Schema.Array(Schema.Struct({ path: FilePathWire, dir: Schema.Boolean })).pipe(Schema.check(Schema.isMaxLength(FILES_LINK_ENTRIES_MAX)));
export const FilesSearched = Search;
/** An op with nothing to say beyond that it happened. */
export const FilesDone = Schema.Null;

/** The host's own refusal: a real answer, with the link up, and never `unreachable`. */
export class FilesRefused extends Schema.TaggedError<FilesRefused>()("FilesRefused", { error: HostFilesError }) {}

/**
 * The link this request arrived on closed while the host served it. It carries
 * no text from the host, and the window machine reads it as `unreachable`.
 */
export class FilesLinkClosed extends Schema.TaggedError<FilesLinkClosed>()("FilesLinkClosed", { message: Schema.String }) {}

/** What a handler may fail with, and so every op's error schema. */
export const FilesLinkFailure = Schema.Union([FilesRefused, FilesLinkClosed]);
export type FilesLinkFailure = typeof FilesLinkFailure.Type;

/** A change under a node a peer opened; the host's `FilesChanged`, for the link. */
export const FilesEvent = Schema.Union([
  /** `moves`: entries renamed outside Junto that the host paired, so a window follows the new name; as the local event. */
  Schema.Struct({ node: NodeId, kind: Schema.Literal("paths"), paths: Paths, moves: Schema.optionalKey(Moves) }),
  Schema.Struct({ node: NodeId, kind: Schema.Literal("reset") }),
  Schema.Struct({ node: NodeId, kind: Schema.Literal("missing") }),
  Schema.Struct({ node: NodeId, kind: Schema.Literal("back") }),
  Schema.Struct({ node: NodeId, kind: Schema.Literal("closed"), error: HostFilesError }),
]);
export type FilesEvent = typeof FilesEvent.Type;

/**
 * A change under a node opened on another machine, as the window machine says
 * it: the host's own `FilesEvent`, or the one thing only this end can say, that
 * the link to the machine went down (`unreachable` never crosses the link). The
 * core push `files.remoteChanged` carries this schema's Type, so the link's
 * event and the push are one schema, not two shapes kept alike.
 */
export const FilesRemoteChange = Schema.Struct({
  machine: Schema.String,
  change: Schema.Union([
    FilesEvent,
    Schema.Struct({ node: NodeId, kind: Schema.Literal("closed"), error: Schema.Literal("unreachable"), machine: Schema.String, lastReachedAt: Schema.NullOr(Schema.Finite) }),
  ]),
});
export type RemoteChange = typeof FilesRemoteChange.Type;
