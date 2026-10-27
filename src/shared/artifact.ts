/**
 * Artifact contract (0.10, docs/plans/0.10/05-artifacts.md).
 *
 * An artifact is a long-lived, versioned thing on an Artifacts node: a link,
 * a markdown document, a pad, a sheet or a file. Every applied edit makes a
 * new immutable version and moves the head. Edits name the version they were
 * written against; the editing machine rules them one at a time here:
 *
 * - `replace` swaps the whole body. Against an old base it is refused
 *   `stale` with the head, always.
 * - `patch` (pad, sheet, document) applies a list of patches as one version.
 *   Against an old base, pad and sheet patches still apply when nothing the
 *   versions since the base touched overlaps what they touch (the rebase);
 *   document text patches never rebase.
 *
 * Comments are threads with an artifact subject and an anchor (03). Which
 * anchors an artifact admits depends on its type, here, so a misuse fails
 * tsc before it fails at runtime.
 *
 * Pure: no Node, no Electron, no storage. Bytes never live in a body; files
 * and pad images are content refs.
 */
import { Result, Schema } from "effect";
import { ContentRef } from "./content";
import { NodeId } from "./physics/schema";
import { ResourceActor } from "./resource-command";
import { Anchor } from "./thread-subject";
import { ItemId } from "./work-ids";
import {
  applyPatch,
  type Pad,
  PadDelete,
  PadFields,
  PadInvariants,
  PadUpsertEdge,
  PadUpsertImage,
  PadUpsertInk,
  PadUpsertShape,
  PadZ,
} from "./pad";
import { padToDigest } from "./pad-project";
import { SheetGrid } from "./model/sheet";
import {
  SHEET_MAX_CELL_LENGTH,
  SHEET_MAX_COLUMNS,
  SHEET_MAX_NAME_LENGTH,
  SHEET_MAX_ROWS,
  sheetToMarkdown,
} from "./sheet";

const STRICT = { onExcessProperty: "error" } as const;

export const ARTIFACT_MAX_TITLE_LENGTH = 200;
/** UTF-16 code units. A document is prose, not a data dump. */
export const ARTIFACT_MAX_DOCUMENT_LENGTH = 512_000;
export const ARTIFACT_MAX_URL_LENGTH = 4_096;
/** Patches in one edit; one edit is one version. */
export const ARTIFACT_MAX_PATCHES = 256;

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

const Int = Schema.Number.pipe(Schema.check(Schema.isInt()));

// ---------------------------------------------------------------------------
// Identity

/** An artifact is a resource item: its id is the shared item id. */
export const ArtifactId = ItemId;
export type ArtifactId = ItemId;

/** A version number. The first version of every artifact is 1. */
export const ArtifactVersion = Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("ArtifactVersion"),
);
export type ArtifactVersion = typeof ArtifactVersion.Type;

export const FIRST_ARTIFACT_VERSION = 1 as ArtifactVersion;

export const nextArtifactVersion = (version: ArtifactVersion): ArtifactVersion =>
  (version + 1) as ArtifactVersion;

export const ArtifactType = Schema.Literals(["link", "document", "pad", "sheet", "file"]);
export type ArtifactType = typeof ArtifactType.Type;

export const ARTIFACT_TYPES: ReadonlyArray<ArtifactType> = ArtifactType.literals;

/** Who wrote something: the resource command's actor (operator, seat or automation). */
export const ArtifactActor = ResourceActor;
export type ArtifactActor = ResourceActor;

// ---------------------------------------------------------------------------
// Bodies

const HttpUrl = NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(ARTIFACT_MAX_URL_LENGTH)),
  Schema.check(Schema.makeFilter((value: string) => isHttpUrl(value), {
    message: "must be an http or https URL",
  })),
);

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export const LinkTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("url"), url: HttpUrl }),
  Schema.Struct({ kind: Schema.Literal("content"), content: ContentRef }),
]);
export type LinkTarget = typeof LinkTarget.Type;

export const LinkBody = Schema.Struct({
  type: Schema.Literal("link"),
  target: LinkTarget,
});
export type LinkBody = typeof LinkBody.Type;

export const DocumentBody = Schema.Struct({
  type: Schema.Literal("document"),
  markdown: Schema.String.pipe(Schema.check(Schema.isMaxLength(ARTIFACT_MAX_DOCUMENT_LENGTH))),
});
export type DocumentBody = typeof DocumentBody.Type;

/**
 * A stored pad. Comments on a pad are threads (03), never pad JSON, and the pad
 * has no pin layer. Bodies written before the pin layer left carry `pins: []`.
 * Stored bodies are content-addressed and hash-verified, so they cannot be
 * rewritten: the key still decodes, only ever empty, and re-encodes to the
 * same bytes, so their refs hold. A body written now has no pins key.
 */
const StoredPad = Schema.Struct({
  ...PadFields,
  pins: Schema.optionalKey(Schema.Tuple([])),
}).pipe(Schema.check(PadInvariants));

export const PadBody = Schema.Struct({
  type: Schema.Literal("pad"),
  pad: StoredPad,
});
export type PadBody = typeof PadBody.Type;

/** The pad a body holds, without a stored legacy `pins` key. */
export const padOf = (body: PadBody): Pad => {
  const { pins: _legacy, ...pad } = body.pad;
  return pad;
};

const uniqueSheetIds = (grid: SheetGrid): true | string => {
  const columns = grid.columns.map((column) => column.id);
  if (new Set(columns).size !== columns.length) return "column ids must be unique";
  const rows = grid.rows.map((row) => row.id);
  if (new Set(rows).size !== rows.length) return "row ids must be unique";
  const known = new Set(columns);
  for (const row of grid.rows) {
    for (const columnId of Object.keys(row.cells)) {
      if (!known.has(columnId)) return "a cell names a column that does not exist";
    }
  }
  return true;
};

export const SheetBody = Schema.Struct({
  type: Schema.Literal("sheet"),
  grid: SheetGrid.pipe(Schema.check(Schema.makeFilter(uniqueSheetIds))),
});
export type SheetBody = typeof SheetBody.Type;

const Fraction = Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })));
const Span = Fraction.pipe(Schema.check(Schema.isGreaterThan(0)));

/**
 * A path inside a Files node's folder: relative, `/` separated, no empty,
 * `.` or `..` part. It names a place on the node's machine and nothing more,
 * so it may cross to every machine; an absolute path never does.
 */
const FileSourcePath = NonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((path) => path.split("/").every((part) => part !== "" && part !== "." && part !== "..") || "a path relative to the Files node's folder"),
  ),
);

/**
 * Where an extracted file came from: a box (0..1 of the page or image) drawn
 * on a file in a Files node, and the page for a PDF.
 */
export const FileSource = Schema.Struct({
  nodeId: NodeId,
  path: FileSourcePath,
  page: Schema.optionalKey(Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
  box: Schema.Struct({ x: Fraction, y: Fraction, w: Span, h: Span }),
});
export type FileSource = typeof FileSource.Type;

export const FileBody = Schema.Struct({
  type: Schema.Literal("file"),
  content: ContentRef,
  /** Set when the file was extracted from a file in a Files node. */
  source: Schema.optionalKey(FileSource),
});
export type FileBody = typeof FileBody.Type;

export const ArtifactBody = Schema.Union([LinkBody, DocumentBody, PadBody, SheetBody, FileBody]);
export type ArtifactBody = typeof ArtifactBody.Type;

/** The body of one artifact type. */
export type BodyOf<T extends ArtifactType> = Extract<ArtifactBody, { readonly type: T }>;

export const decodeArtifactBody = Schema.decodeUnknownResult(ArtifactBody, STRICT);

// ---------------------------------------------------------------------------
// The artifact record (the head)

export const Artifact = Schema.Struct({
  artifactId: ArtifactId,
  nodeId: NodeId,
  type: ArtifactType,
  title: NonEmptyString.pipe(Schema.check(Schema.isMaxLength(ARTIFACT_MAX_TITLE_LENGTH))),
  /** The head version. */
  version: ArtifactVersion,
  createdBy: ArtifactActor,
  updatedAt: Int,
  archived: Schema.Boolean,
  /** Tasks this artifact names; shown as chips. A task names artifacts as evidence. */
  taskIds: Schema.Array(ItemId),
});
export type Artifact = typeof Artifact.Type;

export const decodeArtifact = Schema.decodeUnknownResult(Artifact, STRICT);

/** One immutable version: what the head pointed at after an edit. */
export const ArtifactVersionRecord = Schema.Struct({
  artifactId: ArtifactId,
  version: ArtifactVersion,
  author: ArtifactActor,
  at: Int,
  body: ArtifactBody,
});
export type ArtifactVersionRecord = typeof ArtifactVersionRecord.Type;

// ---------------------------------------------------------------------------
// Patches

/** Pad patches an artifact accepts: the drawing layers, never pins. */
export const ArtifactPadPatch = Schema.Union([
  PadUpsertShape,
  PadUpsertEdge,
  PadUpsertImage,
  PadUpsertInk,
  PadDelete,
  PadZ,
]);
export type ArtifactPadPatch = typeof ArtifactPadPatch.Type;

const SheetId = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(64)));
const ColumnName = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_NAME_LENGTH)));

/**
 * Sheet patches. New rows and columns carry their id, minted by the writer,
 * so a later patch in the same edit can name them and a rebase is stable.
 */
export const SheetPatch = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("cell"),
    rowId: SheetId,
    columnId: SheetId,
    /** Blank text clears the cell. */
    value: Schema.String.pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_CELL_LENGTH))),
  }),
  Schema.Struct({ op: Schema.Literal("row.add"), rowId: SheetId }),
  Schema.Struct({ op: Schema.Literal("row.remove"), rowId: SheetId }),
  Schema.Struct({
    op: Schema.Literal("column.add"),
    columnId: SheetId,
    name: ColumnName,
  }),
  Schema.Struct({
    op: Schema.Literal("column.rename"),
    columnId: SheetId,
    name: ColumnName,
  }),
  Schema.Struct({ op: Schema.Literal("column.remove"), columnId: SheetId }),
]);
export type SheetPatch = typeof SheetPatch.Type;

/** Replace `remove` UTF-16 code units at `at` with `insert`. */
export const TextPatch = Schema.Struct({
  op: Schema.Literal("splice"),
  at: Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  remove: Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  insert: Schema.String,
});
export type TextPatch = typeof TextPatch.Type;

const patchList = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(ARTIFACT_MAX_PATCHES)),
  );

// ---------------------------------------------------------------------------
// Edits

export const ReplaceEdit = Schema.Struct({
  kind: Schema.Literal("replace"),
  baseVersion: ArtifactVersion,
  body: ArtifactBody,
});
export type ReplaceEdit = typeof ReplaceEdit.Type;

export const PadPatchEdit = Schema.Struct({
  kind: Schema.Literal("patch"),
  type: Schema.Literal("pad"),
  baseVersion: ArtifactVersion,
  patches: patchList(ArtifactPadPatch),
});
export type PadPatchEdit = typeof PadPatchEdit.Type;

export const SheetPatchEdit = Schema.Struct({
  kind: Schema.Literal("patch"),
  type: Schema.Literal("sheet"),
  baseVersion: ArtifactVersion,
  patches: patchList(SheetPatch),
});
export type SheetPatchEdit = typeof SheetPatchEdit.Type;

export const DocumentPatchEdit = Schema.Struct({
  kind: Schema.Literal("patch"),
  type: Schema.Literal("document"),
  baseVersion: ArtifactVersion,
  patches: patchList(TextPatch),
});
export type DocumentPatchEdit = typeof DocumentPatchEdit.Type;

export const ArtifactEdit = Schema.Union([ReplaceEdit, PadPatchEdit, SheetPatchEdit, DocumentPatchEdit]);
export type ArtifactEdit = typeof ArtifactEdit.Type;

/** Artifact types that take patches. Link and file only ever replace whole. */
export type PatchableArtifactType = Extract<ArtifactEdit, { readonly kind: "patch" }>["type"];

/** The edits one artifact type accepts. A replace carries that type's body. */
export type EditFor<T extends ArtifactType> =
  | (Omit<ReplaceEdit, "body"> & { readonly body: BodyOf<T> })
  | Extract<ArtifactEdit, { readonly kind: "patch"; readonly type: T }>;

export const decodeArtifactEdit = Schema.decodeUnknownResult(ArtifactEdit, STRICT);

// ---------------------------------------------------------------------------
// Commands (the artifact domain of ResourceOp, 02)

const Title = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(ARTIFACT_MAX_TITLE_LENGTH)));

/**
 * The op of an artifact command. The artifact is the command's
 * `target.itemId`, never a field here: on `create` the creator mints it.
 */
export const ArtifactOp = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("create"),
    title: Title,
    body: ArtifactBody,
    taskIds: Schema.optionalKey(Schema.Array(ItemId)),
  }),
  Schema.Struct({ op: Schema.Literal("edit"), edit: ArtifactEdit }),
  Schema.Struct({ op: Schema.Literal("retitle"), title: Title }),
  Schema.Struct({ op: Schema.Literal("archive") }),
  Schema.Struct({ op: Schema.Literal("restore") }),
  Schema.Struct({ op: Schema.Literal("tasks"), taskIds: Schema.Array(ItemId) }),
]);
export type ArtifactOp = typeof ArtifactOp.Type;

export const decodeArtifactOp = Schema.decodeUnknownResult(ArtifactOp, STRICT);

// ---------------------------------------------------------------------------
// Anchors

/**
 * Where a comment thread points inside an artifact: 03's `Anchor`
 * (`thread-subject.ts`), narrowed per type. `lines` is git review's, never an
 * artifact's.
 */
export type ArtifactAnchor = Exclude<Anchor, { readonly kind: "lines" }>;
export type ArtifactAnchorKind = ArtifactAnchor["kind"];

/** Anchor kinds per type. `box` on a file holds only for images (runtime check). */
export const ANCHOR_KINDS = {
  link: ["whole"],
  document: ["whole", "text"],
  pad: ["whole", "box"],
  sheet: ["whole", "cells"],
  file: ["whole", "box"],
} as const satisfies Record<ArtifactType, ReadonlyArray<ArtifactAnchorKind>>;

export type AnchorFor<T extends ArtifactType> = Extract<
  ArtifactAnchor,
  { readonly kind: (typeof ANCHOR_KINDS)[T][number] }
>;

const CELL = /^([A-Z]{1,3})([1-9][0-9]{0,4})$/u;

const columnNumber = (letters: string): number =>
  [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);

/** `B2` or `A1:C4`, top left first. */
const isCellRange = (range: string): boolean => {
  const [from, to, ...rest] = range.split(":");
  if (rest.length > 0 || from === undefined) return false;
  const a = CELL.exec(from);
  if (a === null) return false;
  if (to === undefined) return true;
  const b = CELL.exec(to);
  if (b === null) return false;
  return columnNumber(a[1]!) <= columnNumber(b[1]!) && Number(a[2]) <= Number(b[2]);
};

/**
 * Whether a comment may anchor here: the kind fits the type, a box has area
 * and no page url (on a file, only an image), cells are an A1 range, a text
 * quote is in the document as it stands. The subject writer runs this.
 */
export const admitsAnchor = <T extends ArtifactType>(
  body: BodyOf<T>,
  anchor: Anchor,
): anchor is AnchorFor<T> => {
  const kinds: ReadonlyArray<Anchor["kind"]> = ANCHOR_KINDS[body.type as ArtifactType];
  if (!kinds.includes(anchor.kind)) return false;
  switch (anchor.kind) {
    case "box":
      if (anchor.w <= 0 || anchor.h <= 0 || anchor.url !== undefined) return false;
      return body.type !== "file" || (body as FileBody).content.mediaType.startsWith("image/");
    case "cells":
      return isCellRange(anchor.range);
    // A quote hangs on text the document holds, as its source spells it.
    case "text":
      return (body as DocumentBody).markdown.includes(anchor.quote);
    default:
      return true;
  }
};

// ---------------------------------------------------------------------------
// Ruling an edit

export const ArtifactEditErrorCode = Schema.Literals([
  /** The base is behind the head and the edit cannot rebase. `expected` is the head. */
  "stale",
  /** The base is behind and the versions since touched what this patch touches. `expected` is the head. */
  "rebase_conflict",
  /** The edit's type is not the artifact's type. */
  "type_mismatch",
  /** The base names a version after the head. */
  "future_base",
  /** A patch names a row, column or element that is not there. */
  "missing",
  /** A patch adds an id that is already there. */
  "duplicate_id",
  /** The result would exceed a limit (rows, columns, length). */
  "capacity",
  "invalid",
]);
export type ArtifactEditErrorCode = typeof ArtifactEditErrorCode.Type;

export class ArtifactEditError extends Schema.TaggedError<ArtifactEditError>()(
  "ArtifactEditError",
  {
    code: ArtifactEditErrorCode,
    message: Schema.String,
    /** Set on `stale`, `rebase_conflict` and `future_base`: the head version. */
    expected: Schema.optionalKey(ArtifactVersion),
  },
) {}

/** The head's body at its version: what an edit is ruled against. */
export interface ArtifactHead {
  readonly version: ArtifactVersion;
  readonly body: ArtifactBody;
}

/** The new head after an applied edit. */
export interface ArtifactRuled {
  readonly version: ArtifactVersion;
  readonly body: ArtifactBody;
}

const fail = <A = never>(
  code: ArtifactEditErrorCode,
  message: string,
  expected?: ArtifactVersion,
): Result.Result<A, ArtifactEditError> =>
  Result.fail(
    expected === undefined
      ? ArtifactEditError.make({ code, message })
      : ArtifactEditError.make({ code, message, expected }),
  );

/**
 * Rule one edit against the head. `since` holds the edits applied after the
 * edit's base, oldest first (`head.version - baseVersion` of them); it is
 * read only when the base is behind, to decide whether patches rebase.
 */
export const ruleArtifactEdit = (
  head: ArtifactHead,
  edit: ArtifactEdit,
  since: ReadonlyArray<ArtifactEdit> = [],
): Result.Result<ArtifactRuled, ArtifactEditError> => {
  const editType = edit.kind === "replace" ? edit.body.type : edit.type;
  if (editType !== head.body.type) {
    return fail("type_mismatch", `edit is for a ${editType}, the artifact is a ${head.body.type}`);
  }
  if (edit.baseVersion > head.version) {
    return fail("future_base", `base ${edit.baseVersion} is after the head ${head.version}`, head.version);
  }
  if (edit.baseVersion < head.version) {
    const behind = head.version - edit.baseVersion;
    const rebase = since.length === behind ? rebases(edit, since) : "stale";
    if (rebase === "stale") {
      return fail(
        "stale",
        `written against version ${edit.baseVersion}, the head is ${head.version}`,
        head.version,
      );
    }
    if (rebase === "conflict") {
      return fail(
        "rebase_conflict",
        `written against version ${edit.baseVersion}; the versions since changed the same places`,
        head.version,
      );
    }
  }
  const body = applyEdit(head.body, edit);
  if (Result.isFailure(body)) return Result.fail(body.failure);
  return Result.succeed({ version: nextArtifactVersion(head.version), body: body.success });
};

const applyEdit = (
  body: ArtifactBody,
  edit: ArtifactEdit,
): Result.Result<ArtifactBody, ArtifactEditError> => {
  switch (edit.kind) {
    case "replace": {
      const decoded = decodeArtifactBody(edit.body);
      if (Result.isFailure(decoded)) return fail("invalid", String(decoded.failure));
      return Result.succeed(decoded.success);
    }
    case "patch": {
      switch (edit.type) {
        case "pad":
          return body.type === "pad" ? applyPadPatches(body, edit.patches) : mismatch();
        case "sheet":
          return body.type === "sheet" ? applySheetPatches(body, edit.patches) : mismatch();
        case "document":
          return body.type === "document" ? applyTextPatches(body, edit.patches) : mismatch();
      }
    }
  }
};

const mismatch = (): Result.Result<never, ArtifactEditError> =>
  fail("type_mismatch", "patch type does not match the body");

const applyPadPatches = (
  body: PadBody,
  patches: ReadonlyArray<ArtifactPadPatch>,
): Result.Result<ArtifactBody, ArtifactEditError> => {
  let pad: Pad = padOf(body);
  for (const patch of patches) {
    const next = applyPatch(pad, patch);
    if (Result.isFailure(next)) {
      const { code, message } = next.failure;
      return fail(
        code === "missing" ? "missing" : code === "duplicate_id" ? "duplicate_id" : "invalid",
        message,
      );
    }
    pad = next.success;
  }
  return Result.succeed({ type: "pad", pad });
};

const applySheetPatches = (
  body: SheetBody,
  patches: ReadonlyArray<SheetPatch>,
): Result.Result<ArtifactBody, ArtifactEditError> => {
  let grid: SheetGrid = body.grid;
  for (const patch of patches) {
    const next = applySheetPatch(grid, patch);
    if (Result.isFailure(next)) return Result.fail(next.failure);
    grid = next.success;
  }
  return Result.succeed({ type: "sheet", grid });
};

const hasColumn = (grid: SheetGrid, id: string): boolean =>
  grid.columns.some((column) => column.id === id);
const hasRow = (grid: SheetGrid, id: string): boolean => grid.rows.some((row) => row.id === id);

/** One sheet patch. Unlike the operator-era helpers, a miss is refused, never ignored. */
export const applySheetPatch = (
  grid: SheetGrid,
  patch: SheetPatch,
): Result.Result<SheetGrid, ArtifactEditError> => {
  switch (patch.op) {
    case "cell": {
      if (!hasRow(grid, patch.rowId)) return fail("missing", `no row ${patch.rowId}`);
      if (!hasColumn(grid, patch.columnId)) return fail("missing", `no column ${patch.columnId}`);
      const blank = patch.value.trim().length === 0;
      return Result.succeed({
        ...grid,
        rows: grid.rows.map((row) => {
          if (row.id !== patch.rowId) return row;
          const cells = { ...row.cells };
          if (blank) delete cells[patch.columnId];
          else cells[patch.columnId] = patch.value;
          return { ...row, cells };
        }),
      });
    }
    case "row.add": {
      if (hasRow(grid, patch.rowId)) return fail("duplicate_id", `row ${patch.rowId} exists`);
      if (grid.rows.length >= SHEET_MAX_ROWS) return fail("capacity", `a sheet holds ${SHEET_MAX_ROWS} rows`);
      return Result.succeed({ ...grid, rows: [...grid.rows, { id: patch.rowId, cells: {} }] });
    }
    case "row.remove": {
      if (!hasRow(grid, patch.rowId)) return fail("missing", `no row ${patch.rowId}`);
      return Result.succeed({ ...grid, rows: grid.rows.filter((row) => row.id !== patch.rowId) });
    }
    case "column.add": {
      if (hasColumn(grid, patch.columnId)) return fail("duplicate_id", `column ${patch.columnId} exists`);
      if (grid.columns.length >= SHEET_MAX_COLUMNS) {
        return fail("capacity", `a sheet holds ${SHEET_MAX_COLUMNS} columns`);
      }
      return Result.succeed({
        ...grid,
        columns: [...grid.columns, { id: patch.columnId, name: patch.name }],
      });
    }
    case "column.rename": {
      if (!hasColumn(grid, patch.columnId)) return fail("missing", `no column ${patch.columnId}`);
      return Result.succeed({
        ...grid,
        columns: grid.columns.map((column) =>
          column.id === patch.columnId ? { ...column, name: patch.name } : column,
        ),
      });
    }
    case "column.remove": {
      if (!hasColumn(grid, patch.columnId)) return fail("missing", `no column ${patch.columnId}`);
      return Result.succeed({
        columns: grid.columns.filter((column) => column.id !== patch.columnId),
        rows: grid.rows.map((row) => {
          if (!(patch.columnId in row.cells)) return row;
          const cells = { ...row.cells };
          delete cells[patch.columnId];
          return { ...row, cells };
        }),
      });
    }
  }
};

const applyTextPatches = (
  body: DocumentBody,
  patches: ReadonlyArray<TextPatch>,
): Result.Result<ArtifactBody, ArtifactEditError> => {
  let markdown = body.markdown;
  for (const patch of patches) {
    if (patch.at + patch.remove > markdown.length) {
      return fail("invalid", `splice ${patch.at}+${patch.remove} runs past the end (${markdown.length})`);
    }
    markdown = markdown.slice(0, patch.at) + patch.insert + markdown.slice(patch.at + patch.remove);
  }
  if (markdown.length > ARTIFACT_MAX_DOCUMENT_LENGTH) {
    return fail("capacity", `a document holds ${ARTIFACT_MAX_DOCUMENT_LENGTH} characters`);
  }
  return Result.succeed({ type: "document", markdown });
};

// ---------------------------------------------------------------------------
// Rebase

/**
 * What a patch touches, as keys. Two edits rebase when their key sets are
 * disjoint. Sheet keys are coarse on purpose: a column or row change touches
 * the whole column or row, so a cell edit never lands in a removed row.
 */
export const patchKeys = (edit: ArtifactEdit): ReadonlySet<string> | "all" => {
  if (edit.kind === "replace") return "all";
  const keys = new Set<string>();
  switch (edit.type) {
    case "document":
      return "all";
    case "pad":
      for (const patch of edit.patches) {
        if (patch.op === "delete" || patch.op === "z") keys.add(patch.id);
        else if (patch.layer === "shape") keys.add(patch.shape.id);
        else if (patch.layer === "image") keys.add(patch.image.id);
        else if (patch.layer === "ink") keys.add(patch.ink.id);
        else {
          keys.add(patch.edge.id);
          keys.add(patch.edge.from);
          keys.add(patch.edge.to);
        }
      }
      return keys;
    case "sheet":
      for (const patch of edit.patches) {
        switch (patch.op) {
          case "cell":
            keys.add(`row:${patch.rowId}`);
            keys.add(`column:${patch.columnId}`);
            break;
          case "row.add":
          case "row.remove":
            keys.add(`row:${patch.rowId}`);
            break;
          case "column.add":
          case "column.rename":
          case "column.remove":
            keys.add(`column:${patch.columnId}`);
            break;
        }
      }
      return keys;
  }
};

/**
 * Sheet cell edits in the same row but different columns, or the same column
 * but different rows, do not collide; only the cell itself does. Rows and
 * columns that were added, removed or renamed collide with anything in them.
 */
const sheetCollides = (a: SheetPatchEdit, b: SheetPatchEdit): boolean => {
  const structural = (edit: SheetPatchEdit): Set<string> => {
    const keys = new Set<string>();
    for (const patch of edit.patches) {
      if (patch.op === "row.add" || patch.op === "row.remove") keys.add(`row:${patch.rowId}`);
      if (patch.op === "column.add" || patch.op === "column.rename" || patch.op === "column.remove") {
        keys.add(`column:${patch.columnId}`);
      }
    }
    return keys;
  };
  const cells = (edit: SheetPatchEdit): Set<string> => {
    const keys = new Set<string>();
    for (const patch of edit.patches) {
      if (patch.op === "cell") keys.add(`${patch.rowId}\u0000${patch.columnId}`);
    }
    return keys;
  };
  const sa = structural(a);
  const sb = structural(b);
  const ka = patchKeys(a);
  const kb = patchKeys(b);
  if (ka === "all" || kb === "all") return true;
  for (const key of sa) if (kb.has(key)) return true;
  for (const key of sb) if (ka.has(key)) return true;
  const cb = cells(b);
  for (const key of cells(a)) if (cb.has(key)) return true;
  return false;
};

/**
 * Whether a patch written against an old base still applies: `stale` when it
 * cannot rebase at all (a replace or a text patch on either side), `conflict`
 * when it touches what the versions since touched.
 */
const rebases = (
  edit: ArtifactEdit,
  since: ReadonlyArray<ArtifactEdit>,
): "ok" | "stale" | "conflict" => {
  if (edit.kind !== "patch" || edit.type === "document") return "stale";
  for (const prior of since) {
    if (prior.kind !== "patch" || prior.type !== edit.type) return "stale";
    if (edit.type === "sheet" && prior.type === "sheet") {
      if (sheetCollides(edit, prior)) return "conflict";
      continue;
    }
    const mine = patchKeys(edit);
    const theirs = patchKeys(prior);
    if (mine === "all" || theirs === "all") return "stale";
    for (const key of mine) if (theirs.has(key)) return "conflict";
  }
  return "ok";
};

// ---------------------------------------------------------------------------
// Text projection (`junto artifact show`)

/** The body as text an agent reads: markdown, pad digest, sheet table, link or file line. */
export const artifactText = (body: ArtifactBody): string => {
  switch (body.type) {
    case "document":
      return body.markdown;
    case "pad":
      return padToDigest(body.pad);
    case "sheet":
      return sheetToMarkdown(body.grid);
    case "link":
      return body.target.kind === "url"
        ? body.target.url
        : `content ${body.target.content.displayName ?? body.target.content.sha256} (${body.target.content.mediaType}, ${body.target.content.byteLength} bytes)`;
    case "file":
      return `file ${body.content.displayName ?? body.content.sha256} (${body.content.mediaType}, ${body.content.byteLength} bytes)`;
  }
};

/** A fresh body for a type: what `create` makes when no body is given. */
export const emptyBody = <T extends Exclude<ArtifactType, "link" | "file">>(type: T): BodyOf<T> => {
  const bodies: { readonly [K in Exclude<ArtifactType, "link" | "file">]: BodyOf<K> } = {
    document: { type: "document", markdown: "" },
    pad: { type: "pad", pad: { revision: 0, images: [], shapes: [], edges: [], inks: [] } },
    sheet: {
      type: "sheet",
      grid: { columns: [{ id: "c1", name: "Column A" }, { id: "c2", name: "Column B" }], rows: [{ id: "r1", cells: {} }] },
    },
  };
  return bodies[type];
};
