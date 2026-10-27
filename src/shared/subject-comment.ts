import type { MailMessageId } from "./crew";
import type { NodeId } from "./physics/schema";
import type { ResourceActor } from "./resource-command";
import { subjectNoticeId } from "./subject-notice";
import type {
  ArtifactPlaceAnchor,
  ArtifactSubject,
  BoxAnchor,
  PageBoxAnchor,
  PageSubject,
  ResourceSubject,
  TaskSubject,
} from "./thread-subject";
import type { ItemId, OpId } from "./work-ids";

/**
 * The one write path for a comment on a resource (plan 0.10, 03 section 4):
 * `junto task comment`, `junto artifact comment`, a page comment and a reply
 * to a subject notice all post through `postSubjectComment`
 * (src/main/junto/work/subject-comment.ts). The poster must reach the
 * subject's node (region-reach). The comment is a row in the subject's
 * thread; its notices go to the resource's people, everyone it mentions and
 * everyone who posted in the thread before, each once, never the poster.
 */

/** The resource a comment is on, without its anchor: the anchor rides beside it, narrowed. */
export type CommentTarget =
  | typeof TaskSubject.Type
  | Omit<typeof ArtifactSubject.Type, "anchor">
  | Omit<typeof PageSubject.Type, "anchor">;
export type CommentTargetKind = CommentTarget["kind"];

/**
 * A box as a page comment's writer sends it: a rectangle in page CSS pixels.
 * Main reads the url and the scroll from the live view and takes the shot
 * itself (`PageBoxAnchor`); a writer never sends bytes.
 */
export type PageBoxRequest = Pick<typeof BoxAnchor.Type, "kind" | "x" | "y" | "w" | "h">;

/** Where on each kind a comment may hang: a task is commented whole, an artifact never on lines, a page on a box. */
export type CommentAnchorFor<K extends CommentTargetKind> = K extends "task"
  ? never
  : K extends "artifact"
    ? ArtifactPlaceAnchor
    : PageBoxRequest;

type CommentOn<K extends CommentTargetKind> = {
  readonly subject: Extract<CommentTarget, { readonly kind: K }>;
  /** Absent: the whole resource. The artifact ruler further checks it fits the artifact's type (`admitsAnchor`). */
  readonly anchor?: CommentAnchorFor<K>;
  readonly text: string;
  readonly actor: ResourceActor;
  /** The CLI-minted write id: a retry with the same opId posts nothing twice. */
  readonly opId: OpId;
  /** Post into this thread of the subject; absent, the subject's own thread or a new one. */
  readonly threadId?: MailMessageId;
  /** The mail this answers, in the same thread. */
  readonly inReplyTo?: MailMessageId;
};

export type SubjectCommentInput = { readonly [K in CommentTargetKind]: CommentOn<K> }[CommentTargetKind];

/** A posted comment: the thread it sits in and its own row. */
export type SubjectCommented = {
  readonly threadId: MailMessageId;
  readonly messageId: MailMessageId;
  /** The seats told, each once. */
  readonly notified: ReadonlyArray<NodeId>;
};

/**
 * The subject a comment's rows carry: the target with its anchor. A page's
 * anchor is the box main captured for this write, never the writer's request.
 */
export const commentSubjectOf = (input: SubjectCommentInput, pageBox?: PageBoxAnchor): ResourceSubject => {
  switch (input.subject.kind) {
    case "task":
      return input.subject;
    case "artifact":
      return input.anchor === undefined ? input.subject : ({ ...input.subject, anchor: input.anchor } as ResourceSubject);
    case "page":
      return pageBox === undefined ? input.subject : { ...input.subject, anchor: pageBox };
  }
};

/** A comment's write, before its subject: what a reply in a subject thread carries. */
export type SubjectReplyWrite = Omit<CommentOn<"task">, "subject" | "anchor">;

/**
 * A reply in a subject thread: a comment on the thread's resource, with no
 * anchor of its own (the thread's first row holds it). Exhaustive, so a new
 * subject kind fails tsc here instead of posting as another kind's comment.
 */
export const subjectReplyOf = (subject: ResourceSubject, write: SubjectReplyWrite): SubjectCommentInput => {
  switch (subject.kind) {
    case "task":
      return { ...write, subject: { kind: "task", nodeId: subject.nodeId, taskId: subject.taskId } };
    case "artifact":
      return { ...write, subject: { kind: "artifact", nodeId: subject.nodeId, artifactId: subject.artifactId } };
    case "page":
      return { ...write, subject: { kind: "page", nodeId: subject.nodeId } };
  }
};

/**
 * The comment row's id, derived from (writer installation, opId) so a retry
 * of the same write is the same row and meets identity-conflict.
 */
export const subjectCommentId = (installationId: string, input: Pick<SubjectCommentInput, "opId" | "subject">): MailMessageId =>
  subjectNoticeId({ installationId, sourceId: input.opId, kind: "comment", recipient: input.subject.nodeId });

/**
 * The thread a comment sits in: the one it names, else a task's own thread
 * (its id is the task's), else a new thread rooted at the comment.
 */
export const commentThreadOf = (input: SubjectCommentInput, messageId: MailMessageId): MailMessageId =>
  input.threadId ?? (input.subject.kind === "task" ? (input.subject.taskId as ItemId as string as MailMessageId) : messageId);
