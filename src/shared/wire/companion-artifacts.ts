/**
 * The phone's artifacts, as wire shapes (0.11.3, docs/artifacts-proposal.md
 * sections 3 and 4). This module holds only the schemas the phone reads and
 * sends: the args and results of the artifact, comment and mention ops, and
 * the events they answer. `companion-protocol.ts` imports them and names the
 * ops; the projections that build them live beside the desktop's own reads
 * (`companion-comments.ts` here, `companion-comment-posts.ts` in main).
 *
 * The rule of the ask is that the phone speaks the desktop's own model: the
 * same actor, the same anchors, the same mention refs. Nothing here is a
 * phone dialect, and every shape reuses the wire module that already holds it.
 *
 * A wire module: its import closure is `effect` and its siblings alone.
 */

import { Schema } from "effect";
import { ActorSeatId } from "./resource-actor";
import { ContentRef } from "./content-ref";
import { ItemId, NodeId, OpId } from "./ids";
import { MentionRef } from "./mention";
import { PlaceAnchor } from "./thread-subject";

const bounded = (min: number, max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(min)), Schema.check(Schema.isMaxLength(max)));

/** A canvas name, as the companion protocol spells one. */
const CanvasName = bounded(1, 256);
/** A message id: a ULID, as the desktop mints one. */
const MessageId = bounded(1, 128);
/** A page cursor, opaque to the phone: it hands back what the Mac gave it. */
const Cursor = bounded(1, 256);

/** Threads one `comments.list` carries at most, newest thread first. */
export const COMPANION_COMMENTS_THREADS_MAX = 200;
/** Posts one thread carries at most: its newest. */
export const COMPANION_COMMENTS_POSTS_MAX = 200;
/** A comment's words, the same bound a phone's mail and answer carry. */
export const COMPANION_COMMENT_TEXT_MAX = 8_000;
/**
 * A comment that named nothing: the typed token, left as plain text, and the
 * nearest names the Mac holds. The desktop's receipt (`LinkedText.unlinked`).
 */
export const CompanionUnlinkedMention = Schema.Struct({
  token: Schema.String,
  nearest: Schema.Array(Schema.String),
});
export type CompanionUnlinkedMention = typeof CompanionUnlinkedMention.Type;

/**
 * What a phone's comments hang on. The phone reads artifacts only in this
 * slice; a task's or a file's comments are the desktop's. The artifact is
 * its id wherever it sits, as the desktop matches it, so a comment written
 * before a move still reads on the artifact.
 */
export const CompanionCommentSubject = Schema.Struct({
  kind: Schema.Literal("artifact"),
  nodeId: NodeId,
  artifactId: ItemId,
});
export type CompanionCommentSubject = typeof CompanionCommentSubject.Type;

/**
 * Who wrote a comment, with the name to show. The desktop's `ThreadPostAuthor`:
 * a seat and the operator are the actor they wrote as; an automation's row
 * names its node only.
 */
export const CompanionCommentAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("operator"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("seat"), seatId: ActorSeatId, nodeId: NodeId, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("automation"), nodeId: NodeId, name: Schema.String }),
]);
export type CompanionCommentAuthor = typeof CompanionCommentAuthor.Type;

/** One comment. */
export const CompanionCommentPost = Schema.Struct({
  postId: MessageId,
  author: CompanionCommentAuthor,
  text: Schema.String,
  /** Epoch ms the comment was written. */
  at: Schema.Number,
  /** Files the operator sent with it; a comment carries none today. */
  attachments: Schema.optionalKey(Schema.Array(ContentRef)),
});
export type CompanionCommentPost = typeof CompanionCommentPost.Type;

/** One thread on the subject, oldest post first. `anchor` is its root's place on the artifact. */
export const CompanionCommentThread = Schema.Struct({
  threadId: MessageId,
  anchor: Schema.optionalKey(PlaceAnchor),
  posts: Schema.Array(CompanionCommentPost),
  /** The thread holds older posts that did not fit this answer; the newest are here. */
  cut: Schema.optionalKey(Schema.Boolean),
});
export type CompanionCommentThread = typeof CompanionCommentThread.Type;

// --- comments.list -----------------------------------------------------------

export const CompanionCommentsListArgs = Schema.Struct({
  canvasName: CanvasName,
  subject: CompanionCommentSubject,
  /** The `next` of the page before; absent, the newest threads. */
  before: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: COMPANION_COMMENTS_THREADS_MAX })),
  ),
});
export type CompanionCommentsListArgs = typeof CompanionCommentsListArgs.Type;

/** Threads on the subject, newest thread first, as many as fit one frame. */
export const CompanionCommentsListData = Schema.Struct({
  threads: Schema.Array(CompanionCommentThread),
  /** Some threads were left out. */
  cut: Schema.Boolean,
  /** Pass as `before` for the next page; absent on the last one. */
  next: Schema.optionalKey(Cursor),
});
export type CompanionCommentsListData = typeof CompanionCommentsListData.Type;

// --- comment.post ------------------------------------------------------------

export const CompanionCommentPostArgs = Schema.Struct({
  canvasName: CanvasName,
  subject: CompanionCommentSubject,
  /** The write's id: a resend with the same opId answers as the first did, never a second post. */
  opId: OpId,
  text: bounded(1, COMPANION_COMMENT_TEXT_MAX),
  /** Where on the artifact the thread hangs; absent, the whole artifact. */
  anchor: Schema.optionalKey(PlaceAnchor),
  /** Reply in a thread; absent, a new thread. */
  threadId: Schema.optionalKey(MessageId),
});
export type CompanionCommentPostArgs = typeof CompanionCommentPostArgs.Type;

export const CompanionCommentPostData = Schema.Struct({
  threadId: MessageId,
  messageId: MessageId,
  /** Mentions the text named that linked to nothing, as the desktop's receipt lists them. */
  unlinked: Schema.optionalKey(Schema.Array(CompanionUnlinkedMention)),
});
export type CompanionCommentPostData = typeof CompanionCommentPostData.Type;

// --- comments.changed --------------------------------------------------------

/** Sent while a `comments.list` is open on that subject: list it again. */
export const CompanionCommentsChanged = Schema.Struct({
  canvasName: CanvasName,
  subject: CompanionCommentSubject,
});
export type CompanionCommentsChanged = typeof CompanionCommentsChanged.Type;

// --- mentions.candidates -----------------------------------------------------

/** Candidates one answer carries at most. */
export const COMPANION_MENTION_CANDIDATES_MAX = 50;
/** What the composer is typing: `@` a seat or a page, `#` a task or an artifact, `[[` an artifact by title. */
export const CompanionMentionTrigger = Schema.Literals(["@", "#", "[["]);
export type CompanionMentionTrigger = typeof CompanionMentionTrigger.Type;

const CandidateText = bounded(1, 320);

/** One thing the phone may mention, as its picker shows it. */
export const CompanionMentionCandidate = Schema.Struct({
  ref: MentionRef,
  /** The ref's kind, for a row's glyph. */
  kind: Schema.Literals(["seat", "task", "artifact", "page"]),
  /** The chip's text, trigger included: `@Atlas`, `#1 launch pricing`. */
  label: CandidateText,
  /** The bare name or title, without the trigger or a task's number. */
  title: CandidateText,
  /** Where it is, when the label alone would not say: a region path or the node. */
  subtitle: Schema.optionalKey(CandidateText),
  /** Its state in words, such as "not running, mail wakes it". */
  note: Schema.optionalKey(CandidateText),
});
export type CompanionMentionCandidate = typeof CompanionMentionCandidate.Type;

export const CompanionMentionCandidatesArgs = Schema.Struct({
  canvasName: CanvasName,
  /** The node the picker is opened from: the scope is its reach (`mentionableNodesFrom`). */
  from: NodeId,
  trigger: CompanionMentionTrigger,
  query: Schema.optionalKey(bounded(0, 100)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: COMPANION_MENTION_CANDIDATES_MAX }))),
});
export type CompanionMentionCandidatesArgs = typeof CompanionMentionCandidatesArgs.Type;

export const CompanionMentionCandidatesData = Schema.Struct({
  candidates: Schema.Array(CompanionMentionCandidate).pipe(
    Schema.check(Schema.isMaxLength(COMPANION_MENTION_CANDIDATES_MAX)),
  ),
});
export type CompanionMentionCandidatesData = typeof CompanionMentionCandidatesData.Type;
