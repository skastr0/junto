/**
 * The msg ops of the work socket, as one Effect `RpcGroup`: each op's
 * arguments, its answer and its refusal. The core serves the group
 * (`src/core/work-control/msg.ts`) and the CLI calls it (`src/cli`), so a
 * change to an op's arguments or answer fails the compile of both, and a
 * missing handler fails the core's.
 *
 * Each op's tag is its v1 name, and the wire stays v1: the arguments are the
 * frame's `args`, the answer its `data`, and the refusal its `error`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  MSG_LIST_ARGS_SHAPE,
  MsgListArgs,
  MsgPromptArgs,
  MsgReactArgs,
  MsgReadArgs,
  MsgReplyArgs,
  MsgSendArgs,
  MsgSentArgs,
} from "../../shared/work-control";
import { Message } from "../../shared/work-model";
import { WorkFailure, WorkInputRefusal } from "./failure";

/** One region around a seat: its id and the name it is called by. */
export const SeatRegion = Schema.Struct({ id: Schema.String, name: Schema.String });

/** Who a seat is as another reads it: its id, its name, and every region around it, outermost first. */
export const SeatIdentity = Schema.Struct({
  nodeId: Schema.String,
  name: Schema.String,
  regions: Schema.Array(SeatRegion),
});

/** Where a mail is once it is written: typed into its seat, kept for it, handed to a link, or held for one. */
export const MailDelivery = Schema.Literals(["delivered", "waiting", "handed", "held"]);

/** A write applied here, or queued for the machine that edits the canvas, with its words when it has any. */
const mutation = {
  disposition: Schema.Literals(["applied", "queued"]),
  message: Schema.optionalKey(Schema.String),
};

/** A mention that linked to nothing, with the nearest names it could have meant. */
export const UnlinkedMention = Schema.Struct({ token: Schema.String, nearest: Schema.Array(Schema.String) });
const unlinked = { unlinked: Schema.optionalKey(Schema.Array(UnlinkedMention)) };

/** A mail as a seat reads it: the thread it is in, and the mail it answers when it answers one. */
const thread = { threadId: Schema.String, inReplyTo: Schema.optionalKey(Schema.String) };
export const SeatMail = Schema.Struct({ ...Message.fields, ...thread });

/** The page box shot a seat's own mail names: ready at a path, on its way, or removed. */
export const SeatPageShot = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ready"), path: Schema.String }),
  Schema.Struct({ state: Schema.Literal("pending") }),
  Schema.Struct({ state: Schema.Literal("removed") }),
]);

/** A seat's own mail: its thread, the operator's files where the seat opens them, and its page box shot. */
export const SeatOwnMail = Schema.Struct({
  ...Message.fields,
  ...thread,
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  shot: Schema.optionalKey(SeatPageShot),
});

/** A mail this seat sent, with the mailbox it sits in. */
export const SeatSentMail = Schema.Struct({ ...Message.fields, toNodeId: Schema.String, ...thread });

/** A mail marked read in this seat's mailbox. */
export const MailRead = Schema.Struct({ messageId: Schema.String, readAt: Schema.String, ...mutation });

/** `msg list` on the seat's own mailbox: a page of its inbox, marked read unless peeked, and a page of what it sent. */
export const MsgListOwn = Schema.Struct({
  target: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  items: Schema.Array(SeatOwnMail),
  more: Schema.Boolean,
  remaining: Schema.Number,
  sent: Schema.Array(SeatSentMail),
  sentMore: Schema.Boolean,
  sentRemaining: Schema.Number,
});

/** `msg list` on another seat's thread: a page of its mailbox. */
export const MsgListPeer = Schema.Struct({
  target: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  items: Schema.Array(SeatMail),
  more: Schema.Boolean,
  remaining: Schema.Number,
});

/** `msg list --task`: the task's one thread, whole and in order. */
export const MsgListTask = Schema.Struct({ target: Schema.String, taskId: Schema.String, items: Schema.Array(Message) });

export const MsgListAnswer = Schema.Union([MsgListOwn, MsgListPeer, MsgListTask]);

/** A mail written to a seat's mailbox: the stored mail, the write, who it went to and where it is now. */
const writtenMail = { ...Message.fields, ...mutation };

export const MsgPromptAnswer = Schema.Struct({ ...writtenMail, recipient: SeatIdentity, delivery: MailDelivery });

/** `msg send` on a task: a comment in the task's one thread. */
export const MsgSendTaskComment = Schema.Struct({
  disposition: Schema.Literal("applied"),
  opId: Schema.String,
  taskId: Schema.String,
  nodeId: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  notified: Schema.Array(Schema.String),
  ...unlinked,
  recipient: SeatIdentity,
});

export const MsgSendMail = Schema.Struct({
  ...writtenMail,
  threadId: Schema.String,
  recipient: SeatIdentity,
  delivery: MailDelivery,
  ...unlinked,
});

export const MsgSendAnswer = Schema.Union([MsgSendMail, MsgSendTaskComment]);

export const MsgSentAnswer = Schema.Struct({
  target: Schema.String,
  items: Schema.Array(Schema.Struct({ ...Message.fields, toNodeId: Schema.String, to: SeatIdentity })),
});

export const MsgReadAnswer = Schema.Struct({
  messageId: Schema.String,
  readAt: Schema.String,
  disposition: mutation.disposition,
  /** The mail itself, as the seat reads it; absent when the id names no mail here. */
  message: Schema.optional(SeatOwnMail),
});

export const MsgReactAnswer = Schema.Struct({
  messageId: Schema.String,
  reaction: Schema.Literal("ack"),
  reactedAt: Schema.String,
  ...mutation,
});

/** `msg reply` in a subject thread: a comment on the subject, and the parent marked read. */
export const MsgReplySubject = Schema.Struct({
  threadId: Schema.String,
  messageId: Schema.String,
  notified: Schema.Array(Schema.String),
  inReplyTo: Schema.String,
  recipient: SeatIdentity,
  read: MailRead,
  ...unlinked,
});

/** `msg reply` to a mail: the reply in the parent's thread, and the parent marked read. */
export const MsgReplyMail = Schema.Struct({
  ...writtenMail,
  inReplyTo: Schema.String,
  threadId: Schema.String,
  recipient: SeatIdentity,
  read: MailRead,
  ...unlinked,
});

export const MsgReplyAnswer = Schema.Union([MsgReplyMail, MsgReplySubject]);

export const MsgList = Rpc.make("msg.list", { payload: MsgListArgs, success: MsgListAnswer, error: WorkFailure })
  // The schema's own words can quote the input; these never do.
  .annotate(WorkInputRefusal, { type: "InputError", message: MSG_LIST_ARGS_SHAPE, details: { path: "args", retryable: false } });
export const MsgPrompt = Rpc.make("msg.prompt", { payload: MsgPromptArgs, success: MsgPromptAnswer, error: WorkFailure });
export const MsgSent = Rpc.make("msg.sent", { payload: MsgSentArgs, success: MsgSentAnswer, error: WorkFailure });
export const MsgSend = Rpc.make("msg.send", { payload: MsgSendArgs, success: MsgSendAnswer, error: WorkFailure });
export const MsgRead = Rpc.make("msg.read", { payload: MsgReadArgs, success: MsgReadAnswer, error: WorkFailure });
export const MsgReact = Rpc.make("msg.react", { payload: MsgReactArgs, success: MsgReactAnswer, error: WorkFailure });
export const MsgReply = Rpc.make("msg.reply", { payload: MsgReplyArgs, success: MsgReplyAnswer, error: WorkFailure });

/** Decoded strictly where the core serves it: an argument or an answer field the contract does not name is refused. */
export const MsgRpcs = RpcGroup.make(MsgList, MsgPrompt, MsgSent, MsgSend, MsgRead, MsgReact, MsgReply).annotateRpcs(
  Rpc.ParseOptions,
  { onExcessProperty: "error" },
);
