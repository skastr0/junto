import { Schema } from "effect";

/**
 * The shapes of what a thread is about (plan 0.10, 03 section 4), as the
 * desktop and the phone read them: the one Anchor and the subjects. A wire
 * module, so its import closure is `effect` alone; `src/shared/thread-subject.ts`
 * re-exports these and holds the rules that read and write them.
 */

/**
 * A node id and an item id as the subjects carry them: the same checks and
 * the same brands as `physics/schema.ts` NodeId and `work-ids.ts` ItemId, so
 * the types are one (tests/thread-subject-wire.test.ts locks it).
 */
const SubjectNodeId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("NodeId"),
);
const SubjectItemId = Schema.String.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/u)).pipe(Schema.brand("ItemId"));

const Coordinate = Schema.Number.check(Schema.isFinite());
const Extent = Coordinate.check(Schema.isGreaterThan(0));
const Line = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const CELL = /^([A-Z]{1,3})([1-9][0-9]{0,4})$/u;

const columnNumber = (letters: string): number =>
  [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);

/** An A1 range: `B2` or `A1:C4`, top left first. */
export const isCellRange = (range: string): boolean => {
  const [from, to, ...rest] = range.split(":");
  if (rest.length > 0 || from === undefined) return false;
  const a = CELL.exec(from);
  if (a === null) return false;
  if (to === undefined) return true;
  const b = CELL.exec(to);
  if (b === null) return false;
  return columnNumber(a[1]!) <= columnNumber(b[1]!) && Number(a[2]) <= Number(b[2]);
};

export const WholeAnchor = Schema.Struct({ kind: Schema.Literal("whole") });
export const BoxAnchor = Schema.Struct({
  kind: Schema.Literal("box"),
  x: Coordinate,
  y: Coordinate,
  w: Extent,
  h: Extent,
  /** The page the box was drawn on, for a browser page's comments. */
  url: Schema.optionalKey(Schema.String),
});
export const CellsAnchor = Schema.Struct({
  kind: Schema.Literal("cells"),
  range: Schema.String.check(Schema.makeFilter((range) => isCellRange(range) || "an A1 range: B2 or A1:C4, top left first")),
});
/**
 * The most of a selection a text anchor quotes: enough to find the place
 * again, and bounded so a subject fits a mail's row envelope
 * (`mail-text-bound.ts`). A longer selection is quoted from its start.
 */
export const TEXT_QUOTE_MAX = 1_000;
export const TextAnchor = Schema.Struct({
  kind: Schema.Literal("text"),
  quote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(TEXT_QUOTE_MAX)),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type TextAnchor = typeof TextAnchor.Type;

/** The longest file path a lines anchor names: a repo path, not prose. */
export const LINES_FILE_MAX = 1_024;

/** Git review's: lines of a file. Never an artifact's. */
export const LinesAnchor = Schema.Struct({
  kind: Schema.Literal("lines"),
  file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(LINES_FILE_MAX)),
  from: Line,
  to: Line,
}).check(Schema.makeFilter((lines) => lines.from <= lines.to || "a lines anchor ends at or after its first line"));

/**
 * Where on a resource a thread hangs: the whole of it, or one place in it.
 * The one Anchor; `artifact.ts` narrows it per artifact type.
 */
export const Anchor = Schema.Union([WholeAnchor, BoxAnchor, CellsAnchor, TextAnchor, LinesAnchor]);
export type Anchor = typeof Anchor.Type;

/**
 * The anchor a subject carries: one place, never `whole`. The whole resource
 * is an absent anchor, so one thread has one spelling.
 */
export const PlaceAnchor = Schema.Union([BoxAnchor, CellsAnchor, TextAnchor, LinesAnchor]);
export type PlaceAnchor = typeof PlaceAnchor.Type;
/** An artifact's places: any but git review's lines. */
export const ArtifactPlaceAnchor = Schema.Union([BoxAnchor, CellsAnchor, TextAnchor]);
export type ArtifactPlaceAnchor = typeof ArtifactPlaceAnchor.Type;

export const MailboxSubject = Schema.Struct({ kind: Schema.Literal("mailbox"), seat: SubjectNodeId });
export const TaskSubject = Schema.Struct({ kind: Schema.Literal("task"), nodeId: SubjectNodeId, taskId: SubjectItemId });
/** The writer runs `admitsAnchor` (artifact.ts) for the artifact's type before it writes one. */
export const ArtifactSubject = Schema.Struct({
  kind: Schema.Literal("artifact"),
  nodeId: SubjectNodeId,
  artifactId: SubjectItemId,
  anchor: Schema.optionalKey(ArtifactPlaceAnchor),
});
export const PageSubject = Schema.Struct({ kind: Schema.Literal("page"), nodeId: SubjectNodeId, anchor: Schema.optionalKey(PlaceAnchor) });

export const ThreadSubject = Schema.Union([MailboxSubject, TaskSubject, ArtifactSubject, PageSubject]);
export type ThreadSubject = typeof ThreadSubject.Type;

/** A subject that is a resource: every subject but a seat's own mailbox. */
export type ResourceSubject = Exclude<ThreadSubject, { readonly kind: "mailbox" }>;
export const ResourceSubject = Schema.Union([TaskSubject, ArtifactSubject, PageSubject]);
