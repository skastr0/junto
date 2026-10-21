import { Result, Schema } from "effect";
import { NodeId } from "./physics/schema";
import { ItemId } from "./work-ids";

/**
 * What a thread is about (plan 0.10, 03 section 4). Today's threads hang off
 * a seat's mailbox; a comment on a task, an artifact or a page is a thread
 * whose subject is that resource, and every row in it carries the subject in
 * `metadata.threadSubject`. A reply in a subject thread posts to the subject,
 * never to the sender. Co-owned by product-feed and pty.
 */

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

/** A quote cut to TEXT_QUOTE_MAX, never through a character's surrogate pair. */
const cutQuote = (quote: string): string => {
  if (quote.length <= TEXT_QUOTE_MAX) return quote;
  const cut = quote.slice(0, TEXT_QUOTE_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/** A text anchor on a selection, its quote cut to TEXT_QUOTE_MAX. */
export const textAnchorOf = (quote: string, offset?: number): TextAnchor => ({
  kind: "text",
  quote: cutQuote(quote),
  ...(offset === undefined ? {} : { offset }),
});

/**
 * A stored subject with its text quote cut to the bound. Rows written before
 * TEXT_QUOTE_MAX hold the whole selection; read as cut, they keep their
 * subject, and a reply copies the cut one.
 */
const withQuoteCut = (held: unknown): unknown => {
  if (typeof held !== "object" || held === null) return held;
  const anchor = (held as { readonly anchor?: unknown }).anchor;
  if (typeof anchor !== "object" || anchor === null) return held;
  const { kind, quote } = anchor as { readonly kind?: unknown; readonly quote?: unknown };
  if (kind !== "text" || typeof quote !== "string" || quote.length <= TEXT_QUOTE_MAX) return held;
  return { ...held, anchor: { ...anchor, quote: cutQuote(quote) } };
};
/** The longest file path a lines anchor names: a repo path, not prose. */
export const LINES_FILE_MAX = 1_024;
/** The most of a file path a notice header prints. */
const LABEL_FILE_MAX = 80;

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
 * is an absent anchor, so one thread has one spelling. {@link subjectAnchorOf}
 * maps an Anchor to it.
 */
const PlaceAnchor = Schema.Union([BoxAnchor, CellsAnchor, TextAnchor, LinesAnchor]);
export type PlaceAnchor = typeof PlaceAnchor.Type;
/** An artifact's places: any but git review's lines. */
const ArtifactPlaceAnchor = Schema.Union([BoxAnchor, CellsAnchor, TextAnchor]);
export type ArtifactPlaceAnchor = typeof ArtifactPlaceAnchor.Type;

/** A subject's anchor for an Anchor: `whole` is none. */
export const subjectAnchorOf = <A extends Anchor>(anchor: A): Exclude<A, { readonly kind: "whole" }> | undefined =>
  anchor.kind === "whole" ? undefined : (anchor as Exclude<A, { readonly kind: "whole" }>);

export const MailboxSubject = Schema.Struct({ kind: Schema.Literal("mailbox"), seat: NodeId });
export const TaskSubject = Schema.Struct({ kind: Schema.Literal("task"), nodeId: NodeId, taskId: ItemId });
/** The writer runs `admitsAnchor` (artifact.ts) for the artifact's type before it writes one. */
export const ArtifactSubject = Schema.Struct({
  kind: Schema.Literal("artifact"),
  nodeId: NodeId,
  artifactId: ItemId,
  anchor: Schema.optionalKey(ArtifactPlaceAnchor),
});
export const PageSubject = Schema.Struct({ kind: Schema.Literal("page"), nodeId: NodeId, anchor: Schema.optionalKey(PlaceAnchor) });

export const ThreadSubject = Schema.Union([MailboxSubject, TaskSubject, ArtifactSubject, PageSubject]);
export type ThreadSubject = typeof ThreadSubject.Type;

/** A subject that is a resource: every subject but a seat's own mailbox. */
export type ResourceSubject = Exclude<ThreadSubject, { readonly kind: "mailbox" }>;
export const ResourceSubject = Schema.Union([TaskSubject, ArtifactSubject, PageSubject]);

/** The metadata key a subject thread's rows carry their subject under. */
export const THREAD_SUBJECT_KEY = "threadSubject";

const decodeSubject = Schema.decodeUnknownResult(ResourceSubject, { onExcessProperty: "error" });
const encodeSubject = Schema.encodeSync(ResourceSubject);

/**
 * A row's resource subject, or undefined for mailbox mail. A stored subject
 * that does not read is no subject: the row reads as mailbox mail.
 */
export const threadSubjectOf = (message: {
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}): ResourceSubject | undefined => {
  const held = message.metadata?.[THREAD_SUBJECT_KEY];
  if (held === undefined) return undefined;
  const read = decodeSubject(withQuoteCut(held));
  return Result.isSuccess(read) ? read.success : undefined;
};

/** The metadata a row in a subject thread carries. */
export const threadSubjectMetadata = (subject: ResourceSubject): { readonly [THREAD_SUBJECT_KEY]: unknown } => ({
  [THREAD_SUBJECT_KEY]: encodeSubject(subject),
});

/** The node a post in the thread is written to: the seat, or the resource's node. */
export const subjectNodeOf = (subject: ThreadSubject): NodeId =>
  subject.kind === "mailbox" ? subject.seat : subject.nodeId;

/** A subject as one string, keys sorted, so key order is not identity. */
const subjectKey = (subject: ThreadSubject): string =>
  JSON.stringify(Schema.encodeSync(ThreadSubject)(subject), (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value);

/** Two subjects name the same thread place: same resource, same anchor. */
export const sameSubject = (a: ThreadSubject, b: ThreadSubject): boolean => subjectKey(a) === subjectKey(b);

const anchorLabel = (anchor: PlaceAnchor | undefined): string => {
  if (anchor === undefined) return "";
  switch (anchor.kind) {
    case "box":
      return ` (box at ${String(anchor.x)},${String(anchor.y)})`;
    case "cells":
      return ` (cells ${anchor.range})`;
    case "text":
      return " (a quote)";
    case "lines":
      return ` (${anchor.file.length > LABEL_FILE_MAX ? `...${anchor.file.slice(-LABEL_FILE_MAX)}` : anchor.file}:${String(anchor.from)}${anchor.to === anchor.from ? "" : `-${String(anchor.to)}`})`;
  }
};

/** The subject as a notice names it: `task <id> at <node>`. */
export const subjectLabel = (subject: ThreadSubject): string => {
  switch (subject.kind) {
    case "mailbox":
      return `mailbox of ${subject.seat}`;
    case "task":
      return `task ${subject.taskId} at ${subject.nodeId}`;
    case "artifact":
      return `artifact ${subject.artifactId} at ${subject.nodeId}${anchorLabel(subject.anchor)}`;
    case "page":
      return `page ${subject.nodeId}${anchorLabel(subject.anchor)}`;
  }
};
