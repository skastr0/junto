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
import { ArtifactEdit } from "./artifact";
import { CompanionArtifactListItem } from "./companion-artifact-reads";
import { ActorSeatId, ResourceActor } from "./resource-actor";
import { ContentRef } from "./content-ref";
import { ArtifactType, ArtifactVersion } from "./artifact";
import { ItemId, NodeId, OpId, TaskNumber } from "./ids";
import { MentionRef } from "./mention";
import { RingState } from "./rings";
import { ResourceSubject } from "./thread-subject";
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

// --- artifacts.subscribe and artifact.changed --------------------------------

/** The most edit an `artifact.changed` carries inline; a larger one is left out and the phone refetches. */
export const COMPANION_ARTIFACT_EDIT_MAX_BYTES = 32 * 1024;

export const CompanionArtifactsSubscribeArgs = Schema.Struct({ canvasName: CanvasName });
export type CompanionArtifactsSubscribeArgs = typeof CompanionArtifactsSubscribeArgs.Type;

/**
 * A change to an artifact on the canvas this connection subscribed to, by
 * anyone: the desktop, a seat, an automation, the phone itself. `edit` rides
 * along when it fits, so an open editor applies the patch without a refetch;
 * absent, the phone reads the artifact again. An archive or a move is the
 * same event with the new head.
 */
export const CompanionArtifactChanged = Schema.Struct({
  canvasName: CanvasName,
  artifact: CompanionArtifactListItem,
  /** Who wrote it. */
  author: ResourceActor,
  /** Epoch ms the change was ruled. */
  at: Schema.Int,
  edit: Schema.optionalKey(ArtifactEdit),
  /** The body's ref at the new version; `content.get` serves its bytes when the phone needs them. */
  bodyRef: Schema.optionalKey(ContentRef),
});
export type CompanionArtifactChanged = typeof CompanionArtifactChanged.Type;

// --- mentions.resolve --------------------------------------------------------

/** Hrefs one resolve asks about at most. */
export const COMPANION_MENTION_HREFS_MAX = 64;
const FaceText = bounded(0, 400);

/** The seat states the phone's StateRing draws: `COMPANION_SEAT_STATES`, held equal by a test. */
export const COMPANION_FACE_SEAT_STATES = [
  "working",
  "waiting_on_you",
  "needs_input",
  "blocked",
  "trouble",
  "done_unread",
  "resting",
  "starting",
  "stopped",
  "offline",
] as const;

/** A task's state, the desktop's own words. */
export const CompanionFaceTaskState = Schema.Literals([
  "backlog",
  "assigned",
  "working",
  "input-required",
  "in-review",
  "done",
  "canceled",
  "archived",
]);

/**
 * What a mention draws: the face a chip or an embed card shows, read from the
 * live thing. The phone never rebuilds a card from fragments.
 */
export const CompanionFace = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("seat"),
    nodeId: NodeId,
    name: FaceText,
    portraitIdentity: FaceText,
    state: Schema.Literals(COMPANION_FACE_SEAT_STATES),
    /** The ring the desktop draws for the seat now. */
    ring: Schema.optionalKey(RingState),
  }),
  Schema.Struct({
    kind: Schema.Literal("task"),
    nodeId: NodeId,
    taskId: ItemId,
    number: Schema.optionalKey(TaskNumber),
    title: FaceText,
    state: CompanionFaceTaskState,
  }),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    nodeId: NodeId,
    artifactId: ItemId,
    type: ArtifactType,
    title: FaceText,
    version: ArtifactVersion,
    /** The body's first two lines, as words; empty while its bytes are not here yet. */
    lines: Schema.Array(FaceText),
    archived: Schema.Boolean,
    /** Where it sits now, when it moved since the link was written. */
    movedTo: Schema.optionalKey(NodeId),
  }),
  Schema.Struct({
    kind: Schema.Literal("page"),
    nodeId: NodeId,
    title: FaceText,
    url: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(2048)))),
    /** A page rests: the desktop's own word for a live page. */
    state: Schema.Literals(["resting"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("missing"),
    /** The link's label, as the text wrote it. */
    label: FaceText,
    reason: Schema.Literals(["loading", "gone"]),
    of: Schema.optionalKey(Schema.Literals(["seat", "task", "artifact", "page"])),
  }),
]);
export type CompanionFace = typeof CompanionFace.Type;

export const CompanionMentionResolveArgs = Schema.Struct({
  canvasName: CanvasName,
  hrefs: Schema.Array(bounded(1, 2048)).pipe(Schema.check(Schema.isMaxLength(COMPANION_MENTION_HREFS_MAX))),
});
export type CompanionMentionResolveArgs = typeof CompanionMentionResolveArgs.Type;

export const CompanionMentionResolveData = Schema.Struct({
  /** One face per href, in the order asked. */
  faces: Schema.Array(CompanionFace),
});
export type CompanionMentionResolveData = typeof CompanionMentionResolveData.Type;

// --- mentions.linkedFrom -----------------------------------------------------

/** An artifact whose body links the target: what "Linked from" lists. */
export const CompanionLinkedFromBody = Schema.Struct({
  nodeId: NodeId,
  artifactId: ItemId,
  title: FaceText,
  type: ArtifactType,
  /** The line the link sits on, as the body holds it now. */
  line: FaceText,
  at: Schema.Int,
});
export type CompanionLinkedFromBody = typeof CompanionLinkedFromBody.Type;

/** One place the target is mentioned: mail, or a comment on a resource. */
export const CompanionMentionedIn = Schema.Struct({
  messageId: bounded(1, 128),
  threadId: bounded(1, 128),
  /** The node whose mail holds the row. */
  mailbox: NodeId,
  subject: Schema.optionalKey(ResourceSubject),
  author: CompanionCommentAuthor,
  at: Schema.Int,
});
export type CompanionMentionedIn = typeof CompanionMentionedIn.Type;

export const COMPANION_LINKED_FROM_MAX = 50;
export const CompanionMentionLinkedFromArgs = Schema.Struct({
  canvasName: CanvasName,
  target: MentionRef,
  before: Schema.optionalKey(Cursor),
});
export type CompanionMentionLinkedFromArgs = typeof CompanionMentionLinkedFromArgs.Type;

export const CompanionMentionLinkedFromData = Schema.Struct({
  bodies: Schema.Array(CompanionLinkedFromBody),
  mail: Schema.Array(CompanionMentionedIn),
  /** Pass as `before` for the next page of mail; absent on the last one. */
  next: Schema.optionalKey(Cursor),
});
export type CompanionMentionLinkedFromData = typeof CompanionMentionLinkedFromData.Type;
