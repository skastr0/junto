/**
 * The window's mail threads, seat views and collaboration asks, as one group.
 * Main decodes what the renderer sends closed, at its edge
 * (`src/app/threads/threads-ipc.ts`), so each payload here is a value that
 * already decoded. A send is two calls: main holds the authoring gate around
 * `ThreadsWrite` alone, and `ThreadsDeliver` runs after it. Read points that
 * move and mail held past its wait come back on the push stream once
 * `ThreadsWatch` started it. The handlers are `src/core/ops/ipc-threads.ts`.
 *
 * An answer the window reads as data stays an answer: a refused write, a
 * refused collaboration ask, a mark that moved nothing (`null`). A read the
 * core could not make fails with `ThreadsUnavailable`.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import type { OperatorThreadWritten } from "../../core/work/operator-threads";
import { AgentSeatStateEvent } from "../../shared/agent-seat-state";
import {
  MailReadPoint,
  MentionableSeat,
  OperatorThreadSend,
  OperatorThreadSent,
  SeatThreadMarkRead,
  SeatThreadPageQuery,
  SeatThreadReadsQuery,
  SeatThreadsPageQuery,
  SeatThreadsQuery,
} from "../../shared/mail-threads";
import { MailWaitingFact } from "../../shared/mail-waiting";
import { SeatCollaborationAskResult, SeatCollaborationDraft } from "../../shared/seat-collaboration";
import { SeatOnboardingEvent } from "../../shared/seat-onboarding-status";
import { MailThreadMessage, MailThreadSummary } from "../../shared/wire/mail-threads";
import { coreClient } from "./link";

/** A read could not be made; the window's call rejects with what the core said. */
export class ThreadsUnavailable extends Schema.TaggedError<ThreadsUnavailable>()("ThreadsUnavailable", {
  message: Schema.String,
}) {}

/** One page of a seat's threads, newest activity first. `next` is the cursor for the page after it; absent at the end. */
export const ThreadsPage = Schema.Struct({
  threads: Schema.Array(MailThreadSummary),
  next: Schema.optionalKey(Schema.String),
});

/** One page of a thread's messages, oldest first. `older` is the cursor for the page above it; absent at the thread's start. */
export const ThreadMessagesPage = Schema.Struct({
  messages: Schema.Array(MailThreadMessage),
  older: Schema.optionalKey(Schema.String),
});

/** The row a send wrote, before delivery. */
export const ThreadMailWritten = Schema.Struct({
  messageId: Schema.String,
  threadId: Schema.String,
  /** A review's copies: the row each mentioned seat received in the thread, by seat. */
  copies: Schema.optionalKey(Schema.Array(Schema.Struct({ nodeId: Schema.String, messageId: Schema.String }))),
  /** A comment on the thread's subject: held at the resource, its notices already handed to delivery. */
  comment: Schema.optionalKey(Schema.Literal(true)),
});

/** What the write alone answers: the mail was refused, or it is written and owes delivery. */
export const ThreadsWritten = Schema.Union([
  OperatorThreadSent,
  Schema.Struct({ written: ThreadMailWritten, canvasName: Schema.String, nodeId: Schema.String }),
]);

// A Schema's encode drops what it does not name, so the wire must name every
// field the model has.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const writtenIsTheModel: Same<typeof ThreadMailWritten.Type, OperatorThreadWritten> = true;
void [writtenIsTheModel];

export const ThreadsRpcs = RpcGroup.make(
  Rpc.make("ThreadsList", { payload: SeatThreadsPageQuery, success: ThreadsPage, error: ThreadsUnavailable }),
  Rpc.make("ThreadsMessages", { payload: SeatThreadPageQuery, success: ThreadMessagesPage, error: ThreadsUnavailable }),
  Rpc.make("ThreadsMentionables", { payload: SeatThreadsQuery, success: Schema.Array(MentionableSeat), error: ThreadsUnavailable }),
  Rpc.make("ThreadsReads", {
    payload: SeatThreadReadsQuery,
    success: Schema.Record(Schema.String, MailReadPoint),
    error: ThreadsUnavailable,
  }),
  /** The seat's unread count; `null` when it cannot be read, never 0, so a surface keeps its last count. */
  Rpc.make("ThreadsUnread", { payload: SeatThreadReadsQuery, success: Schema.NullOr(Schema.Number), error: ThreadsUnavailable }),
  /** Never fails: a refusal is `null`. */
  Rpc.make("ThreadsMarkRead", { payload: SeatThreadMarkRead, success: Schema.NullOr(MailReadPoint) }),
  /** The write alone: a mail the core refuses answers refused, and one it could not write fails. */
  Rpc.make("ThreadsWrite", { payload: OperatorThreadSend, success: ThreadsWritten, error: ThreadsUnavailable }),
  Rpc.make("ThreadsDeliver", {
    payload: { canvasName: Schema.String, nodeId: Schema.String, written: ThreadMailWritten },
    success: OperatorThreadSent,
  }),
  Rpc.make("ThreadsCollaborationAsk", {
    payload: { draft: SeatCollaborationDraft },
    success: SeatCollaborationAskResult,
    error: ThreadsUnavailable,
  }),
  /** Every seat's state: this core's seats, and those its linked machines told it of. */
  Rpc.make("ThreadsSeatStates", { success: Schema.Array(AgentSeatStateEvent) }),
  /** The operator viewed a seat. Its machine holds the turn, so a view of another machine's goes there; never fails. */
  Rpc.make("ThreadsSeatViewed", { payload: { bindingId: Schema.String } }),
  /** Every seat's last settled onboarding status. */
  Rpc.make("ThreadsOnboarding", { success: Schema.Array(SeatOnboardingEvent) }),
  Rpc.make("ThreadsMailWaiting", { success: Schema.Array(MailWaitingFact) }),
  /** Starts the pushes of read points and waiting mail; asking again of the same core changes nothing. */
  Rpc.make("ThreadsWatch"),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the threads group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class ThreadsCore extends Context.Service<ThreadsCore, RpcClient.FromGroup<typeof ThreadsRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/ThreadsCore",
) {
  static readonly layer = Layer.effect(ThreadsCore, coreClient(ThreadsRpcs));
}
