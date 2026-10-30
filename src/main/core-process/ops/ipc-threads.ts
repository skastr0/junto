/**
 * The window's mail threads, seat views and collaboration asks, answered by
 * the core (junto/ipc.ts). Renderer input crosses as it came and is decoded
 * here. A send is two calls: main holds the authoring gate around the write
 * alone, and delivery runs after it, as it did in main. Read points that move
 * and mail held past its wait come back on the push stream.
 */
import { Effect, Result, Schema } from "effect";
import { ulid } from "ulid";
import { asNodeId } from "@shared/model";
import { makeUserMessage } from "@shared/task";
import {
  OperatorThreadSend,
  SeatThreadMarkRead,
  SeatThreadPageQuery,
  SeatThreadReadsQuery,
  SeatThreadsPageQuery,
  SeatThreadsQuery,
  type MailReadChanged,
  type MailReadPoint,
  type OperatorThreadSent,
} from "@shared/mail-threads";
import type { MailWaitingFact } from "@shared/mail-waiting";
import {
  collaborationRequestMetadata,
  composeCollaborationRequestText,
  type SeatCollaborationAskResult,
  type SeatCollaborationDraft,
} from "@shared/seat-collaboration";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { SeatOnboardingEvent } from "@shared/seat-onboarding-status";
import { ModelService } from "../../junto/model/service";
import { seatStateRuntime } from "../../junto/term/agent-state";
import { injectionSupervisor } from "../../junto/term/injection-supervisor";
import { mergeSeatStateSnapshot, remoteSeatStateEvents } from "../../junto/term/remote-seat-state";
import { makeSeatsProcessClient, remoteSeatMachine } from "../../junto/term/seats-client";
import { markRead, onReadChanged, readPoints, unreadTotal } from "../../junto/work/mail-reads";
import { messageDelivery } from "../../junto/work/message-delivery";
import {
  deliverOperatorThreadMail,
  mentionableSeats,
  seatThreadMessagesPage,
  seatThreadsPage,
  sendOperatorThreadMail,
  type OperatorThreadWritten,
} from "../../junto/work/operator-threads";
import { WorkService } from "../../junto/work/service";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";
import { MAIL_WAITING, SEAT_THREAD_READ_CHANGED } from "./main-index";


type Input = { readonly input: unknown };

declare module "../ops" {
  interface CoreOps {
    "ipc.threads.list": CoreOp<Input, unknown>;
    "ipc.threads.messages": CoreOp<Input, unknown>;
    "ipc.threads.mentionables": CoreOp<Input, unknown>;
    "ipc.threads.reads": CoreOp<Input, Record<string, MailReadPoint>>;
    "ipc.threads.unread": CoreOp<Input, unknown>;
    /** Never fails: a refusal is undefined. */
    "ipc.threads.markRead": CoreOp<Input, MailReadPoint | undefined>;
    /** The write alone; an input that does not decode is refused here. */
    "ipc.threads.write": CoreOp<Input, OperatorThreadSent | { readonly written: OperatorThreadWritten; readonly canvasName: string; readonly nodeId: string }>;
    "ipc.threads.deliver": CoreOp<{ readonly canvasName: string; readonly nodeId: string; readonly written: OperatorThreadWritten }, OperatorThreadSent>;
    "ipc.threads.collaborationAsk": CoreOp<{ readonly draft: SeatCollaborationDraft }, SeatCollaborationAskResult>;
    /** Every seat's state: this core's seats, and those its linked machines told it of. */
    "ipc.threads.seatStates": CoreOp<Record<string, never>, ReadonlyArray<AgentSeatStateEvent>>;
    /** The operator viewed a seat. Its machine holds the turn, so a view of another machine's goes there; never fails. */
    "ipc.threads.seatViewed": CoreOp<{ readonly bindingId: string }, void>;
    /** Every seat's last settled onboarding status. */
    "ipc.threads.onboarding": CoreOp<Record<string, never>, ReadonlyArray<SeatOnboardingEvent>>;
    "ipc.threads.mailWaiting": CoreOp<Record<string, never>, ReadonlyArray<MailWaitingFact>>;
    "ipc.threads.watch": CoreOp<Record<string, never>, void>;
  }
}

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input);

let watching = false;

coreOps({
  "ipc.threads.list": ({ input }) =>
    Effect.gen(function* () {
      const query = yield* decode(SeatThreadsPageQuery, input);
      // The operator's read points ride the list, so a row knows what it has not read yet (0.11.3).
      const points = yield* readPoints(query.canvasName, query.nodeId);
      return yield* seatThreadsPage(query.canvasName, query.nodeId, { limit: query.limit, after: query.after, group: query.group }, points);
    }),
  "ipc.threads.messages": ({ input }) =>
    Effect.gen(function* () {
      const query = yield* decode(SeatThreadPageQuery, input);
      return yield* seatThreadMessagesPage(query.canvasName, query.nodeId, query.threadId, { limit: query.limit, before: query.before });
    }),
  "ipc.threads.mentionables": ({ input }) =>
    Effect.flatMap(decode(SeatThreadsQuery, input), (query) => mentionableSeats(query.canvasName, query.nodeId)),
  "ipc.threads.reads": ({ input }) =>
    Effect.gen(function* () {
      const query = yield* decode(SeatThreadReadsQuery, input);
      return Object.fromEntries(yield* readPoints(query.canvasName, query.nodeId, query.threadIds));
    }),
  "ipc.threads.unread": ({ input }) =>
    Effect.flatMap(decode(SeatThreadReadsQuery, input), (query) => unreadTotal(query.canvasName, query.nodeId)),
  "ipc.threads.markRead": ({ input }) => {
    const decoded = Schema.decodeUnknownResult(SeatThreadMarkRead, { onExcessProperty: "error" })(input);
    if (Result.isFailure(decoded)) return Effect.succeed(undefined);
    const { canvasName, nodeId, threadId, through } = decoded.success;
    return markRead(canvasName, nodeId, threadId, through).pipe(Effect.orElseSucceed(() => undefined));
  },
  "ipc.threads.write": ({ input }) => {
    const decoded = Schema.decodeUnknownResult(OperatorThreadSend, { onExcessProperty: "error" })(input);
    if (Result.isFailure(decoded)) return Effect.succeed({ ok: false as const, reason: "invalid" as const, message: "That mail could not be read." });
    const { canvasName, nodeId } = decoded.success;
    return Effect.map(sendOperatorThreadMail(decoded.success), (sent) => ("ok" in sent ? sent : { written: sent, canvasName, nodeId }));
  },
  "ipc.threads.deliver": ({ canvasName, nodeId, written }) =>
    Effect.promise(() => deliverOperatorThreadMail(canvasName, nodeId, written)),
  "ipc.threads.collaborationAsk": ({ draft }) =>
    Effect.gen(function* () {
      const model = yield* ModelService;
      const read = yield* Effect.result(model.canvas(draft.canvas));
      if (read._tag === "Failure") return { ok: false as const, error: `canvas ${JSON.stringify(draft.canvas)} could not be read` };
      const nodes = read.success.nodes;
      const source = nodes.get(asNodeId(draft.sourceNodeId));
      const target = nodes.get(asNodeId(draft.targetNodeId));
      if (source === undefined) return { ok: false as const, error: `seat ${JSON.stringify(draft.sourceNodeId)} is not on this canvas` };
      if (target === undefined) return { ok: false as const, error: `seat ${JSON.stringify(draft.targetNodeId)} is not on this canvas` };
      if (target.kind !== "agent") return { ok: false as const, error: "a collaboration request can only be sent to an agent seat" };
      const work = yield* WorkService;
      const requestId = ulid();
      const result = yield* work.workSystemMailboxNotify(
        draft.canvas,
        draft.targetNodeId,
        makeUserMessage({
          messageId: requestId,
          text: composeCollaborationRequestText(draft, requestId),
          contextId: draft.canvas,
          metadata: collaborationRequestMetadata(draft, requestId),
        }),
      );
      if (!result.ok) return { ok: false as const, error: result.message };
      return { ok: true as const, requestId };
    }),
  "ipc.threads.seatStates": () => Effect.sync(() => mergeSeatStateSnapshot(seatStateRuntime.currentEvents())),
  "ipc.threads.onboarding": () => Effect.sync(() => injectionSupervisor.currentOnboarding()),
  "ipc.threads.seatViewed": ({ bindingId }) => {
    if (seatStateRuntime.snapshot(bindingId) !== undefined) return Effect.sync(() => { seatStateRuntime.viewed(bindingId); });
    const remote = remoteSeatStateEvents().find((event) => event.bindingId === bindingId);
    if (remote === undefined || remote.state === "gone") return Effect.void;
    const epoch = remote.epoch;
    return remoteSeatMachine(bindingId).pipe(
      Effect.tapCause((cause) => Effect.logWarning("seat view not sent: its machine could not be read", cause)),
      Effect.annotateLogs({ area: "seats", seat: bindingId }),
      Effect.orElseSucceed(() => undefined),
      Effect.flatMap((machine) =>
        machine === undefined
          ? Effect.void
          : Effect.promise(() => makeSeatsProcessClient(machine).viewed(bindingId, epoch).catch(() => false))),
      Effect.asVoid,
    );
  },
  "ipc.threads.mailWaiting": () => Effect.sync(() => messageDelivery.mailWaiting()),
  // Subscribed once per core.
  "ipc.threads.watch": () =>
    Effect.sync(() => {
      if (watching) return;
      watching = true;
      onReadChanged((change) => publish(SEAT_THREAD_READ_CHANGED, change satisfies MailReadChanged));
      messageDelivery.subscribeMailWaiting((fact) => publish(MAIL_WAITING, fact));
    }),
});
