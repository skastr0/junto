import { Schema } from "effect";

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
  /** Seats the mail names as a reference; they are not sent it. */
  mentions: Schema.optionalKey(Schema.Array(Schema.Struct({ kind: Schema.Literal("seat"), nodeId: Schema.String, name: Schema.String }))),
});
export type MailThreadMessage = typeof MailThreadMessage.Type;

export const MailThreadSummary = Schema.Struct({
  threadId: Schema.String,
  /** The root mail's first line, or the oldest mail's when the root is not held. */
  title: Schema.String,
  /** Everyone who wrote or was written to, in order of first appearance. */
  participants: Schema.Array(MailParty),
  startedAt: Schema.Number,
  lastAt: Schema.Number,
  last: MailThreadMessage,
  messageCount: Schema.Number,
  /** The operator sent mail in it, or mail in it is addressed to the operator. */
  canReply: Schema.Boolean,
});
export type MailThreadSummary = typeof MailThreadSummary.Type;

/** One page of a seat's threads, newest activity first. `next` is the cursor for the page after it; absent at the end. */
export type MailThreadsPage = {
  readonly threads: ReadonlyArray<MailThreadSummary>;
  readonly next?: string;
};

/** One page of a thread's messages, oldest first. `older` is the cursor for the page above it; absent at the thread's start. */
export type MailThreadMessagesPage = {
  readonly messages: ReadonlyArray<MailThreadMessage>;
  readonly older?: string;
};
