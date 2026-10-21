import { Schema } from "effect";
import { ContentRef } from "./content-ref";

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
/**
 * The most a page box's url holds, in UTF-8 bytes. The comment's row has
 * room for the box beside its text (mail-text-bound.ts), as for a lines
 * file at its bound; the url is kept without query or fragment.
 */
export const PAGE_BOX_URL_MAX_BYTES = 2 * 1024;

/** A page box's shot: always the PNG main encoded, with no name of its own. */
const PageShotRef = ContentRef.check(
  Schema.makeFilter((ref) => (ref.mediaType === "image/png" && ref.displayName === undefined) || "a PNG main took, with no name"),
);

/** An http or https address with a host and no name or password, as `admitLinkUrl` admits it, already normalized. */
const isPageUrl = (url: string): boolean => {
  if (new TextEncoder().encode(url).byteLength > PAGE_BOX_URL_MAX_BYTES) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname !== "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.href === url
    );
  } catch {
    return false;
  }
};

/**
 * A box on a browser page, the page subject's only anchor (no anchor is the
 * whole page). The rectangle is in page CSS pixels, with the scroll it was
 * drawn at and the page's url then. `shot` is the crop main took from the
 * live view and claimed for the comment's own row in the same write; a
 * writer never sends it. A reply copies its thread's subject as it is and
 * never takes a new shot. Read the shot through `pageShotOf`.
 */
export const PageBoxAnchor = Schema.Struct({
  kind: Schema.Literal("box"),
  x: Coordinate,
  y: Coordinate,
  w: Extent,
  h: Extent,
  url: Schema.String.check(Schema.makeFilter((url) => isPageUrl(url) || "an http or https address with a host, no name or password, at most 2 KiB")),
  scroll: Schema.Struct({ x: Coordinate, y: Coordinate }),
  shot: PageShotRef,
});
export type PageBoxAnchor = typeof PageBoxAnchor.Type;

export const PageSubject = Schema.Struct({ kind: Schema.Literal("page"), nodeId: SubjectNodeId, anchor: Schema.optionalKey(PageBoxAnchor) });

export const ThreadSubject = Schema.Union([MailboxSubject, TaskSubject, ArtifactSubject, PageSubject]);
export type ThreadSubject = typeof ThreadSubject.Type;

/** A subject that is a resource: every subject but a seat's own mailbox. */
export type ResourceSubject = Exclude<ThreadSubject, { readonly kind: "mailbox" }>;
export const ResourceSubject = Schema.Union([TaskSubject, ArtifactSubject, PageSubject]);
