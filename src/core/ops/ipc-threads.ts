/**
 * The core's handlers of the threads group (src/contract/core/threads.ts): the
 * window's mail threads, seat views and collaboration asks. Main has already
 * decoded the renderer's input closed. A send is two calls: main holds the
 * authoring gate around the write alone, and delivery runs after it, as it did
 * in main. Read points that move and mail held past its wait go out as pushes
 * once the window's watch started them, once per core.
 */
import { Effect, Predicate, Ref, Scope } from "effect";
import { ulid } from "ulid";
import { asNodeId } from "@shared/model";
import { makeUserMessage } from "@shared/task";
import type { MailReadChanged } from "@shared/mail-threads";
import { collaborationRequestMetadata, composeCollaborationRequestText } from "@shared/seat-collaboration";
import { MAIL_WAITING, SEAT_THREAD_READ_CHANGED } from "../../contract/core/channels";
import { ThreadsRpcs, ThreadsUnavailable } from "../../contract/core/threads";
import { ModelService } from "../model/service";
import { CorePushes } from "../push";
import { seatStateRuntime } from "../term/agent-state";
import { injectionSupervisor } from "../term/injection-supervisor";
import { mergeSeatStateSnapshot, RemoteSeatState } from "../term/remote-seat-state";
import { makeSeatsProcessClient, remoteSeatMachine } from "../term/seats-client";
import { markRead, onReadChanged, readPoints, unreadTotal } from "../work/mail-reads";
import { messageDelivery } from "../work/message-delivery";
import {
  deliverOperatorThreadMail,
  mentionableSeats,
  seatThreadMessagesPage,
  seatThreadsPage,
  sendOperatorThreadMail,
} from "../work/operator-threads";
import { WorkService } from "../work/service";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : Predicate.hasProperty(error, "message") ? String(error.message) : String(error);

/** A read the core could not make, as the contract names it: what the core said. */
const unavailable = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  Effect.mapError(read, (error) => new ThreadsUnavailable({ message: messageOf(error) }));

export const ThreadsHandlers = ThreadsRpcs.toLayer(
  Effect.gen(function* () {
    const pushes = yield* CorePushes;
    const remoteState = yield* RemoteSeatState;
    const publishing = Effect.runForkWith(yield* Effect.context<never>());
    const scope = yield* Effect.scope;
    // Whether this core already told its pushes to start: asking again changes nothing.
    const watching = yield* Ref.make(false);

    return {
      ThreadsList: ({ canvasName, nodeId, limit, after, group }) =>
        unavailable(
          Effect.gen(function* () {
            // The operator's read points ride the list, so a row knows what it has not read yet (0.11.3).
            const points = yield* readPoints(canvasName, nodeId);
            return yield* seatThreadsPage(canvasName, nodeId, { limit, after, group }, points);
          }),
        ),
      ThreadsMessages: ({ canvasName, nodeId, threadId, limit, before }) =>
        unavailable(seatThreadMessagesPage(canvasName, nodeId, threadId, { limit, before })),
      ThreadsMentionables: ({ canvasName, nodeId }) => unavailable(mentionableSeats(canvasName, nodeId)),
      ThreadsReads: ({ canvasName, nodeId, threadIds }) =>
        unavailable(Effect.map(readPoints(canvasName, nodeId, threadIds), (points) => Object.fromEntries(points))),
      ThreadsUnread: ({ canvasName, nodeId }) =>
        unavailable(Effect.map(unreadTotal(canvasName, nodeId), (total) => total ?? null)),
      ThreadsMarkRead: ({ canvasName, nodeId, threadId, through }) =>
        markRead(canvasName, nodeId, threadId, through).pipe(
          Effect.map((point) => point ?? null),
          Effect.orElseSucceed(() => null),
        ),
      ThreadsWrite: (send) =>
        unavailable(
          Effect.map(sendOperatorThreadMail(send), (sent) =>
            "ok" in sent ? sent : { written: sent, canvasName: send.canvasName, nodeId: send.nodeId },
          ),
        ),
      ThreadsDeliver: ({ canvasName, nodeId, written }) =>
        Effect.promise(() => deliverOperatorThreadMail(canvasName, nodeId, written)),
      ThreadsCollaborationAsk: ({ draft }) =>
        unavailable(
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
        ),
      ThreadsSeatStates: () => Effect.sync(() => mergeSeatStateSnapshot(seatStateRuntime.currentEvents(), remoteState.events())),
      ThreadsOnboarding: () => Effect.sync(() => injectionSupervisor.currentOnboarding()),
      ThreadsSeatViewed: ({ bindingId }) => {
        if (seatStateRuntime.snapshot(bindingId) !== undefined) return Effect.sync(() => { seatStateRuntime.viewed(bindingId); });
        const remote = remoteState.events().find((event) => event.bindingId === bindingId);
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
      ThreadsMailWaiting: () => Effect.sync(() => messageDelivery.mailWaiting()),
      // Subscribed once per core, and let go with it.
      ThreadsWatch: () =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(watching, true)) return;
          const stopReads = onReadChanged((change) => {
            publishing(pushes.publish(SEAT_THREAD_READ_CHANGED, change satisfies MailReadChanged));
          });
          const stopWaiting = messageDelivery.subscribeMailWaiting((fact) => {
            publishing(pushes.publish(MAIL_WAITING, fact));
          });
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              stopReads();
              stopWaiting();
            }),
          );
        }),
    };
  }),
);
