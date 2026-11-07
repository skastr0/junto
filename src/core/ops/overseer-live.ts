/**
 * The core's handlers of the live overseer group
 * (src/contract/core/overseer-live.ts): the window's live controls, answered
 * by the live overseer this core composed. Each snapshot change leaves on the
 * `LIVE_CHANGED` push from the moment the core's server starts until it
 * closes, so a new core needs no ask to start them.
 */
import { Context, Effect, Layer, Queue } from "effect";
import type { LiveSnapshot, OverseerLiveApi } from "@shared/overseer-live";
import { LIVE_CHANGED } from "../../contract/core/channels";
import { OverseerLiveFailed, OverseerLiveRpcs } from "../../contract/core/overseer-live";
import { CorePushes } from "../push";

/** The live overseer as the core composes it: the window's controls, and its snapshot changes to listen to. */
export type LiveService = Omit<OverseerLiveApi, "onLiveChanged"> & {
  readonly subscribe: (listener: (snapshot: LiveSnapshot) => void) => () => void;
};

/** The live overseer this core composed; `service` is absent where this build or core runs none. */
export class RunningLiveOverseer extends Context.Service<RunningLiveOverseer, { readonly service: LiveService | undefined }>()(
  "@junto/core/RunningLiveOverseer",
) {
  static readonly layerOf = (service: LiveService | undefined) => Layer.succeed(RunningLiveOverseer, { service });
}

const failed = (cause: unknown): OverseerLiveFailed =>
  new OverseerLiveFailed({ message: cause instanceof Error ? cause.message : String(cause) });

export const OverseerLiveHandlers = OverseerLiveRpcs.toLayer(
  Effect.gen(function* () {
    const { service } = yield* RunningLiveOverseer;
    if (service !== undefined) {
      // Snapshots leave in the order the overseer told them, one at a time.
      const pushes = yield* CorePushes;
      const changes = yield* Queue.unbounded<LiveSnapshot>();
      yield* Queue.take(changes).pipe(
        Effect.flatMap((snapshot) => pushes.publish(LIVE_CHANGED, snapshot)),
        Effect.forever,
        Effect.forkScoped,
      );
      const unsubscribe = service.subscribe((snapshot) => {
        Queue.offerUnsafe(changes, snapshot);
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    }
    const live = <A>(use: (running: LiveService) => Promise<A>): Effect.Effect<A, OverseerLiveFailed> =>
      service === undefined
        ? Effect.fail(new OverseerLiveFailed({ message: "the live overseer is not running in this core" }))
        : Effect.tryPromise({ try: () => use(service), catch: failed });
    return {
      OverseerLiveStart: ({ input }) => live((running) => running.liveStart(input)),
      OverseerLiveEnd: ({ sessionId }) => live((running) => running.liveEnd(sessionId)),
      OverseerLiveSnapshot: () => live((running) => running.liveSnapshot()),
      OverseerLiveReady: ({ sessionId, connectionEpoch }) => live((running) => running.liveReady(sessionId, connectionEpoch)),
      OverseerLiveProviderEvent: ({ sessionId, connectionEpoch, event }) =>
        live((running) => running.liveProviderEvent(sessionId, connectionEpoch, event)),
      OverseerLiveAttention: ({ sessionId, attention }) => live((running) => running.liveAttention(sessionId, attention)),
      OverseerLiveCancel: ({ sessionId, requestId }) => live((running) => running.liveCancel(sessionId, requestId)),
      OverseerLiveSteer: ({ sessionId, requestId, text, attention }) =>
        live((running) => running.liveSteer(sessionId, requestId, text, attention)),
      OverseerLiveStopActions: ({ sessionId }) => live((running) => running.liveStopActions(sessionId)),
    };
  }),
);
