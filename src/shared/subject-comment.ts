import type { MailMessageId } from "./crew";
import type { NodeId } from "./physics/schema";
import type { ResourceActor } from "./resource-command";
import { subjectNoticeId } from "./subject-notice";
import type {
  ArtifactPlaceAnchor,
  ArtifactSubject,
  PageSubject,
  PlaceAnchor,
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

/** Where on each kind a comment may hang: a task is commented whole, an artifact never on lines. */
export type CommentAnchorFor<K extends CommentTargetKind> = K extends "task"
  ? never
  : K extends "artifact"
    ? ArtifactPlaceAnchor
    : PlaceAnchor;

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

/** The subject a comment's rows carry: the target with its anchor. */
export const commentSubjectOf = (input: SubjectCommentInput): ResourceSubject => {
  switch (input.subject.kind) {
    case "task":
      return input.subject;
    case "artifact":
    case "page":
      return input.anchor === undefined ? input.subject : ({ ...input.subject, anchor: input.anchor } as ResourceSubject);
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
