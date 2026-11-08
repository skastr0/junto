import { Schema } from "effect";
import { ContentRef } from "./content-ref";
import { ResourceSubject } from "./thread-subject";

/**
 * Mail threads as the desktop and the phone read them: the mail that hangs
 * off one root message. A mail's thread is its `threadId`, or its own id when
 * it starts one. The derivation lives in `src/shared/mail-threads.ts`; these
 * are only the shapes it answers in.
 */

export const MailParty = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("operator") }),
  Schema.Struct({ kind: Schema.Literal("seat"), nodeId: Schema.String, name: Schema.String }),
]);
export type MailParty = typeof MailParty.Type;

export const MailThreadMessage = Schema.Struct({
  messageId: Schema.String,
  threadId: Schema.String,
  inReplyTo: Schema.optionalKey(Schema.String),
  from: MailParty,
  /** Who it was written to: always one. */
  to: Schema.Array(MailParty),
  /** The operator wrote it. */
  mine: Schema.Boolean,
  text: Schema.String,
  /** Epoch ms, from the ULID. */
  at: Schema.Number,
  /** Files the mail carries, by reference into the Mac content store; the bytes are served by `content.get`. */
  attachments: Schema.optionalKey(Schema.Array(ContentRef)),
  /** The resource the thread is about; absent for a seat's mailbox thread. */
  subject: Schema.optionalKey(ResourceSubject),
});
export type MailThreadMessage = typeof MailThreadMessage.Type;

export const MailThreadSummary = Schema.Struct({
  threadId: Schema.String,
  /** A subject thread's resource name (a task thread is `#42 fix tabs`); else the root mail's first line, or the oldest mail's when the root is not held. */
  title: Schema.String,
  /** Everyone who wrote or was written to, in order of first appearance. */
  participants: Schema.Array(MailParty),
  startedAt: Schema.Number,
  lastAt: Schema.Number,
  last: MailThreadMessage,
  messageCount: Schema.Number,
  /** The operator sent mail in it, or mail in it is addressed to the operator. */
  canReply: Schema.Boolean,
  /** The operator wrote at least one mail in it. */
  owned: Schema.Boolean,
  /** The operator's last explicit mark, on the Mac's clock; writing does not move it. Absent when never marked. */
  readAt: Schema.optionalKey(Schema.Number),
  /** Replies to the operator past their read, in a thread they are in; 0 for a thread between seats (0.11.5). */
  unread: Schema.Number,
  /** The resource the thread is about, as its mail names it; absent for a mailbox thread. */
  subject: Schema.optionalKey(ResourceSubject),
});
export type MailThreadSummary = typeof MailThreadSummary.Type;

/** One page of a seat's threads, newest activity first (or those the operator is in first). `next` is the cursor for the page after it; absent at the end. */
export type MailThreadsPage = {
  readonly threads: ReadonlyArray<MailThreadSummary>;
  readonly next?: string;
};

/** One page of a thread's messages, oldest first. `older` is the cursor for the page above it; absent at the thread's start. */
export type MailThreadMessagesPage = {
  readonly messages: ReadonlyArray<MailThreadMessage>;
  readonly older?: string;
};
