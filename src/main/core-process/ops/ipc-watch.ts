/**
 * The model watches (junto/ipc.ts): a canvas changed, the canvas list
 * changed, the compiled actor refs changed. Each starts once per core and
 * publishes on its channel, which main subscribes to once and forwards to the
 * window, as `model.watchCanvases` does in ops/main-index.ts. Starting a watch
 * twice is a no-op, so a reconnect cannot double the stream.
 */
import { Effect, Stream } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { ModelActorRefs } from "../../junto/model/actor-refs";
import { ModelService } from "../../junto/model/service";
import { publish } from "../push";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.watch.model": CoreOp<Record<string, never>, void>;
    "ipc.watch.modelCanvases": CoreOp<Record<string, never>, void>;
    "ipc.watch.modelActorRefs": CoreOp<Record<string, never>, void>;
  }
}

const watched = new Set<string>();

/** True the first time this key is asked for; false after. */
const first = (key: string): boolean => {
  if (watched.has(key)) return false;
  watched.add(key);
  return true;
};

coreOps({
  "ipc.watch.model": () =>
    Effect.gen(function* () {
      if (!first("model")) return;
      (yield* ModelService).subscribeChanges((event) => publish(IPC_CHANNELS.modelChanged, event));
    }),
  "ipc.watch.modelCanvases": () =>
    Effect.gen(function* () {
      if (!first("modelCanvases")) return;
      (yield* ModelService).subscribeCanvasesChanges((event) => publish(IPC_CHANNELS.modelCanvasesChanged, event));
    }),
  "ipc.watch.modelActorRefs": () =>
    Effect.gen(function* () {
      if (!first("modelActorRefs")) return;
      // The refs expose their changes as a stream, not a callback: detach a
      // reader that publishes each one.
      const events = (yield* ModelActorRefs).changes;
      yield* Effect.forkDetach(
        Stream.runForEach(events, (event) => Effect.sync(() => publish(IPC_CHANNELS.modelActorRefsChanged, event))),
      );
    }),
});
