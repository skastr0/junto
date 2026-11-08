/**
 * The core's handlers of the watch group (src/contract/core/watch.ts): a
 * canvas changed, the canvas list changed, the compiled actor refs changed.
 * Each watch starts once per server and publishes on its channel through
 * `CorePushes`; main subscribes to each channel once and forwards it to the
 * window. Starting a watch twice is a no-op, so a reconnect cannot double the
 * stream. A watch lives as long as the server that started it: its
 * subscription and its reader end with the server's scope.
 */
import { Effect, Scope, Stream } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { WatchRpcs } from "../../contract/core/watch";
import { ModelActorRefs } from "../model/actor-refs";
import { ModelService } from "../model/service";
import { CorePushes } from "../push";

type WatchKey = "model" | "modelCanvases" | "modelActorRefs";

export const WatchHandlers = WatchRpcs.toLayer(
  Effect.gen(function* () {
    const pushes = yield* CorePushes;
    const scope = yield* Effect.scope;
    const started = new Set<WatchKey>();
    /** True the first time this watch is asked for; false after. */
    const first = (key: WatchKey): boolean => {
      if (started.has(key)) return false;
      started.add(key);
      return true;
    };
    return {
      WatchModel: () =>
        Effect.gen(function* () {
          const model = yield* ModelService;
          if (!first("model")) return;
          // The model calls its listeners as each change commits; each push leaves in that order.
          const stop = model.subscribeChanges((event) => void Effect.runFork(pushes.publish(IPC_CHANNELS.modelChanged, event)));
          yield* Scope.addFinalizer(scope, Effect.sync(stop));
        }),
      WatchModelCanvases: () =>
        Effect.gen(function* () {
          const model = yield* ModelService;
          if (!first("modelCanvases")) return;
          const stop = model.subscribeCanvasesChanges((event) =>
            void Effect.runFork(pushes.publish(IPC_CHANNELS.modelCanvasesChanged, event)),
          );
          yield* Scope.addFinalizer(scope, Effect.sync(stop));
        }),
      WatchModelActorRefs: () =>
        Effect.gen(function* () {
          // The refs expose their changes as a stream, not a callback: fork a
          // reader that publishes each one. The service is acquired before the
          // watch is marked started, so a failed acquisition leaves it startable.
          const events = (yield* ModelActorRefs).changes;
          if (!first("modelActorRefs")) return;
          yield* Stream.runForEach(events, (event) => pushes.publish(IPC_CHANNELS.modelActorRefsChanged, event)).pipe(
            Effect.forkIn(scope),
          );
        }),
    };
  }),
);
