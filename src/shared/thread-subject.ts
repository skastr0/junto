import { Result, Schema } from "effect";
import type { NodeId } from "./physics/schema";
import type { ContentRef } from "./wire/content-ref";
import { LINES_QUOTE_MAX } from "./wire/thread-subject";
import {
  LinesAnchor,
  ResourceSubject,
  TEXT_QUOTE_MAX,
  ThreadSubject,
  type Anchor,
  type PlaceAnchor,
  type TextAnchor,
} from "./wire/thread-subject";

/**
 * What a thread is about (plan 0.10, 03 section 4). Today's threads hang off
 * a seat's mailbox; a comment on a task, an artifact or a page is a thread
 * whose subject is that resource, and every row in it carries the subject in
 * `metadata.threadSubject`. A reply in a subject thread posts to the subject,
 * never to the sender. Co-owned by product-feed and pty.
 *
 * The shapes live in the wire module `wire/thread-subject.ts`, so the phone
 * reads the same ones; this module re-exports them and holds the rules.
 */
export {
  Anchor,
  ArtifactPlaceAnchor,
  ArtifactSubject,
  BoxAnchor,
  CellsAnchor,
  FileBoxAnchor,
  FILE_PATH_MAX,
  FilePlaceAnchor,
  FileSubject,
  isCellRange,
  isRelativePath,
  LINES_FILE_MAX,
  LINES_QUOTE_MAX,
  LinesAnchor,
  MailboxSubject,
  PAGE_BOX_PAGE_MAX,
  PAGE_BOX_URL_MAX_BYTES,
  PageBoxAnchor,
  PageSubject,
  PlaceAnchor,
  RelativePath,
  ResourceSubject,
  TaskSubject,
  TEXT_QUOTE_MAX,
  TextAnchor,
  ThreadSubject,
  WholeAnchor,
} from "./wire/thread-subject";

/** A quote cut to TEXT_QUOTE_MAX, never through a character's surrogate pair. */
const cutQuote = (quote: string): string => {
  if (quote.length <= TEXT_QUOTE_MAX) return quote;
  const cut = quote.slice(0, TEXT_QUOTE_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/**
 * A lines quote cut to LINES_QUOTE_MAX: whole characters only, so the cut
 * never splits a surrogate pair. The writer and the anchor share it, so the
 * lines an anchor names are the lines its quote reads.
 */
export const cutLinesQuote = (quote: string): string => {
  if (quote.length <= LINES_QUOTE_MAX) return quote;
  const cut = quote.slice(0, LINES_QUOTE_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/**
 * The text of lines `from`..`to` of a file, as the lines anchor quotes it:
 * joined by `\n`, a trailing `\r` of a CRLF file dropped, and cut to
 * LINES_QUOTE_MAX from its start. Undefined when the file has no such lines,
 * or they hold only spaces: a quote that names no text finds nothing later.
 */
export const quoteOfLines = (text: string, from: number, to: number): string | undefined => {
  const lines = text.split(/\r?\n/u);
  if (from < 1 || to < from || to > lines.length) return undefined;
  const block = lines.slice(from - 1, to).join("\n");
  return block.trim() === "" ? undefined : cutLinesQuote(block);
};

/**
 * Where the lines a comment quoted sit now, after an edit moved them: the
 * place in the text nearest the lines it named whose lines read as the quote
 * does, else undefined when the text no longer holds it. A comment written
 * without a quote is where it says, never moved.
 */
export const locateLines = (
  anchor: { readonly quote?: string | undefined; readonly from: number; readonly to: number },
  text: string,
): { readonly from: number; readonly to: number } | undefined => {
  const quote = anchor.quote;
  if (quote === undefined) return { from: anchor.from, to: anchor.to };
  // Whole lines only: a quote is a block of lines, so it never matches a piece
  // of a longer line. CRLF files quote with plain "\n", one line either way.
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const quoted = quote.split("\n");
  if (quoted.length > lines.length) return undefined;
  const found: number[] = [];
  for (let at = 0; at <= lines.length - quoted.length; at += 1) {
    if (quoted.every((line, offset) => lines[at + offset] === line)) found.push(at + 1);
  }
  if (found.length === 0) return undefined;
  const nearest = found.reduce((best, from) => (Math.abs(from - anchor.from) < Math.abs(best - anchor.from) ? from : best));
  return { from: nearest, to: nearest + quoted.length - 1 };
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
/** The most of a file path a notice header prints. */
const LABEL_FILE_MAX = 80;

/** A subject's anchor for an Anchor: `whole` is none. */
export const subjectAnchorOf = <A extends Anchor>(anchor: A): Exclude<A, { readonly kind: "whole" }> | undefined =>
  anchor.kind === "whole" ? undefined : (anchor as Exclude<A, { readonly kind: "whole" }>);

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

/**
 * The shot a page comment's row names, read only here, never from raw
 * `metadata.threadSubject`. Naming is not holding: main serves the bytes
 * only while the comment's own record holds the claim it made in the write.
 */
export const pageShotOf = (message: {
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}): ContentRef | undefined => {
  if (message.metadata?.factoryMail !== true) return undefined;
  const subject = threadSubjectOf(message);
  return subject?.kind === "page" ? subject.anchor?.shot : undefined;
};

/**
 * A mailbox row's place: a git review comment is a row in the reviewed
 * seat's mailbox thread (its mailbox subject), anchored on lines of a file.
 * Kept beside the row's text, which says the same in words.
 */
export const MAIL_LINES_ANCHOR_KEY = "linesAnchor";

const decodeLines = Schema.decodeUnknownResult(LinesAnchor, { onExcessProperty: "error" });
const encodeLines = Schema.encodeSync(LinesAnchor);

/** A row's lines anchor, or undefined; one that does not read is none. */
export const linesAnchorOf = (message: {
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}): LinesAnchor | undefined => {
  const held = message.metadata?.[MAIL_LINES_ANCHOR_KEY];
  if (held === undefined) return undefined;
  const read = decodeLines(held);
  return Result.isSuccess(read) ? read.success : undefined;
};

/** The metadata a mailbox row anchored on lines carries. */
export const linesAnchorMetadata = (anchor: LinesAnchor): { readonly [MAIL_LINES_ANCHOR_KEY]: unknown } => ({
  [MAIL_LINES_ANCHOR_KEY]: encodeLines(anchor),
});

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
    case "pageBox":
      return ` (page ${String(anchor.page)}, a box)`;
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
    case "file":
      return `file ${subject.path} in ${subject.nodeId}${anchorLabel(subject.anchor)}`;
  }
};
