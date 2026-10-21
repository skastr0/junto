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
const Line = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Where on a resource a thread hangs: the whole of it, or one place in it. */
export const Anchor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("whole") }),
  Schema.Struct({
    kind: Schema.Literal("box"),
    x: Coordinate,
    y: Coordinate,
    w: Coordinate.check(Schema.isGreaterThanOrEqualTo(0)),
    h: Coordinate.check(Schema.isGreaterThanOrEqualTo(0)),
    url: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("cells"), range: Schema.String.check(Schema.isMinLength(1)) }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    quote: Schema.String.check(Schema.isMinLength(1)),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    kind: Schema.Literal("lines"),
    file: Schema.String.check(Schema.isMinLength(1)),
    from: Line,
    to: Line,
  }).check(Schema.makeFilter((lines) => lines.from <= lines.to || "a lines anchor ends at or after its first line")),
]);
export type Anchor = typeof Anchor.Type;

export const MailboxSubject = Schema.Struct({ kind: Schema.Literal("mailbox"), seat: NodeId });
export const TaskSubject = Schema.Struct({ kind: Schema.Literal("task"), nodeId: NodeId, taskId: ItemId });
export const ArtifactSubject = Schema.Struct({
  kind: Schema.Literal("artifact"),
  nodeId: NodeId,
  artifactId: ItemId,
  anchor: Schema.optionalKey(Anchor),
});
export const PageSubject = Schema.Struct({ kind: Schema.Literal("page"), nodeId: NodeId, anchor: Schema.optionalKey(Anchor) });

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
  const read = decodeSubject(held);
  return Result.isSuccess(read) ? read.success : undefined;
};

/** The metadata a row in a subject thread carries. */
export const threadSubjectMetadata = (subject: ResourceSubject): { readonly [THREAD_SUBJECT_KEY]: unknown } => ({
  [THREAD_SUBJECT_KEY]: encodeSubject(subject),
});

/** The node a post in the thread is written to: the seat, or the resource's node. */
export const subjectNodeOf = (subject: ThreadSubject): NodeId =>
  subject.kind === "mailbox" ? subject.seat : subject.nodeId;

/** Two subjects name the same thread place: same resource, same anchor. */
export const sameSubject = (a: ThreadSubject, b: ThreadSubject): boolean =>
  JSON.stringify(Schema.encodeSync(ThreadSubject)(a)) === JSON.stringify(Schema.encodeSync(ThreadSubject)(b));

const anchorLabel = (anchor: Anchor | undefined): string => {
  if (anchor === undefined) return "";
  switch (anchor.kind) {
    case "whole":
      return "";
    case "box":
      return ` (box at ${String(anchor.x)},${String(anchor.y)})`;
    case "cells":
      return ` (cells ${anchor.range})`;
    case "text":
      return " (a quote)";
    case "lines":
      return ` (${anchor.file}:${String(anchor.from)}${anchor.to === anchor.from ? "" : `-${String(anchor.to)}`})`;
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
