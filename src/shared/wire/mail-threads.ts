import { Schema } from "effect";
import { AgentSignalState, SeatRaiseKind } from "./agent-signals";
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

/** What a signal asks the operator to hand in, when a reply alone does not close it: an artifact form is a document. */
export const THREAD_SIGNAL_ASKS = ["document", "proof", "secret"] as const;
export const ThreadSignalAsks = Schema.Literals(THREAD_SIGNAL_ASKS);
export type ThreadSignalAsks = typeof ThreadSignalAsks.Type;

/**
 * A signal as a thread carries it, live: its kind, where it stands, its one
 * sentence, and what it asks for when words alone do not close it.
 */
export const ThreadSignal = Schema.Struct({
  signalId: Schema.String,
  kind: SeatRaiseKind,
  state: AgentSignalState,
  text: Schema.String,
  asks: Schema.optionalKey(ThreadSignalAsks),
  /**
   * The operator's answer and the seat's withdrawal crossed: the seat withdrew
   * it before the answer reached it. Either closing may have landed first, so
   * `state` is answered or withdrawn; the other is kept beside it.
   */
  crossed: Schema.optionalKey(Schema.Literal(true)),
});
export type ThreadSignal = typeof ThreadSignal.Type;

/** The signal that began a thread its answer started: drawn at the thread's head, at the signal's own time. */
export const ThreadHeadSignal = Schema.Struct({ ...ThreadSignal.fields, at: Schema.Number });
export type ThreadHeadSignal = typeof ThreadHeadSignal.Type;

/** A signal named by its id, kind and one sentence: what an answer answers, or a thread's open one. Its mail may be on a page not read. */
export const ThreadSignalRef = Schema.Struct({ signalId: Schema.String, kind: SeatRaiseKind, text: Schema.String });
export type ThreadSignalRef = typeof ThreadSignalRef.Type;

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
  /**
   * The operator's own mail that has not reached its seat yet: its row has
   * neither a delivery nor a read receipt. Absent once it has, and on every
   * seat's mail. A send that failed still waits, so it reads as waiting.
   */
  waiting: Schema.optionalKey(Schema.Literal(true)),
  /**
   * The seat's mail that is a signal: one act, two faces. Present only when
   * this machine holds both and each names the other (the signal's
   * `messageId`, the row's `metadata.raisedSignalId`), the mail is in that
   * seat's own mailbox and the seat wrote it. Until then it is a plain reply.
   */
  signal: Schema.optionalKey(ThreadSignal),
  /** The operator's mail that answered a signal of the seat it went to (`metadata.agentSignalId`). */
  answers: Schema.optionalKey(ThreadSignalRef),
  /**
   * The operator's answer kept from its seat: the seat withdrew the signal
   * before the answer arrived, so it is never typed (`answerHeld`). The window
   * says so beside it as the seat's own statement. Present only with `answers`.
   */
  held: Schema.optionalKey(Schema.Literal(true)),
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
  /** The earliest signal raised in it that is still open, paired as a message's `signal` is. */
  openSignal: Schema.optionalKey(ThreadSignalRef),
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
  /** The signal whose answer started the thread, on every page: draw it before the first message. */
  readonly headSignal?: ThreadHeadSignal;
};
