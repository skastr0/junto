import { Schema } from "effect";
import { MailMessageId } from "./crew";
import { MentionRef } from "./mention";
import { ActorSeatId } from "./wire/resource-actor";
import { NodeId } from "./wire/ids";
import { ResourceSubject } from "./wire/thread-subject";

/**
 * Backlinks over IPC (docs/plans/0.10/03 section 3): where a seat, a task,
 * an artifact or a page is mentioned, newest first, a page at a time. Main
 * reads `work_mentions` (src/core/work/mention-backlinks.ts); the
 * window reads only. A mention counts once, where its words were written:
 * notices and copies of a row are not places.
 */


/** At most this many backlinks in one page, and the page size when none is asked. */
export const MENTION_PAGE_MAX = 200;
export const MENTION_PAGE_DEFAULT = 50;

/** Where the last page ended. Opaque: only main reads it. */
export const MentionCursor = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(1024)));
export type MentionCursor = typeof MentionCursor.Type;

export const MentionPageRequest = Schema.Struct({
  before: Schema.optionalKey(MentionCursor),
  limit: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 1, maximum: MENTION_PAGE_MAX })))),
});
export type MentionPageRequest = typeof MentionPageRequest.Type;

export const MentionListInput = Schema.Struct({
  canvasName: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128))),
  target: MentionRef,
  page: Schema.optionalKey(MentionPageRequest),
});

/**
 * Who wrote a mentioning row, with the name to show: a seat and the operator
 * as they wrote, an automation by its node. The same three a thread post
 * names (`ThreadPostAuthor` in `resource-ipc.ts`).
 */
export const MentionAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), seatId: ActorSeatId, nodeId: NodeId, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("operator"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("automation"), nodeId: NodeId, name: Schema.String }),
]);
export type MentionAuthor = typeof MentionAuthor.Type;

/** One place a thing is mentioned. */
export const MentionedIn = Schema.Struct({
  messageId: MailMessageId,
  threadId: MailMessageId,
  /** The node whose mail holds the row: a seat's, or the task, artifacts or page node a comment is on. */
  mailbox: NodeId,
  /** The task, artifact or page the row comments on; none for a seat's mail. */
  subject: Schema.optionalKey(ResourceSubject),
  /** Who wrote it, named as the canvas names them now. */
  author: MentionAuthor,
  /** Epoch ms the row was written: its message id's time. */
  at: Schema.Number,
});
export type MentionedIn = typeof MentionedIn.Type;

export const MentionPage = Schema.Struct({
  entries: Schema.Array(MentionedIn),
  /** Pass as `before` for the next page; absent on the last one. */
  next: Schema.optionalKey(MentionCursor),
});
export type MentionPage = typeof MentionPage.Type;

/** Said to every window after a commit adds a backlink on a canvas. */
export type MentionsChanged = { readonly canvasName: string };

export type MentionIpcApi = {
  /** Where `target` is mentioned on a canvas, newest first. */
  readonly list: (canvasName: string, target: MentionRef, page?: MentionPageRequest) => Promise<MentionPage>;
  readonly onChanged: (listener: (changed: MentionsChanged) => void) => () => void;
};
