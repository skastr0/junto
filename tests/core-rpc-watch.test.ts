/**
 * The model watches over the watch group (src/contract/core/watch.ts): each
 * watch starts once per server however often main asks, publishes every
 * change through `CorePushes` on its own channel, and stops with the server
 * that started it, so a core that closes leaves no listener behind.
 */
import { Effect, Exit, Layer, PubSub, Scope, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, it } from "vitest";
import { WatchRpcs } from "../src/contract/core/watch";
import type { ActorRefsChanged } from "../src/core/model/actor-refs";
import { ModelActorRefs } from "../src/core/model/actor-refs";
import { ModelService } from "../src/core/model/service";
import { WatchHandlers } from "../src/core/ops/ipc-watch";
import { CorePushes } from "../src/core/push";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { asCanvasName, canvasFromOpened, type Canvas, type CanvasesChanged, type Changed } from "../src/shared/model";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it("starts each model watch once, publishes through CorePushes, and stops with the server", async () => {
  const canvas = asCanvasName("main");
  const current: Canvas = canvasFromOpened({ canvas, seq: 1, nodes: [], wires: [] });
  const pushed: Array<readonly [string, unknown]> = [];
  const changeListeners = new Set<(event: Changed, current: Canvas) => void>();
  const canvasListeners = new Set<(event: CanvasesChanged, current?: Canvas) => void>();
  const refs = await Effect.runPromise(PubSub.unbounded<ActorRefsChanged>());
  const scope = await Effect.runPromise(Scope.make());

  const handlers = await Effect.runPromise(
    Layer.buildWithScope(
      WatchHandlers.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => void pushed.push([channel, payload])) }),
            Layer.mock(ModelService, {
              subscribeChanges: (listener) => {
                changeListeners.add(listener);
                return () => void changeListeners.delete(listener);
              },
              subscribeCanvasesChanges: (listener) => {
                canvasListeners.add(listener);
                return () => void canvasListeners.delete(listener);
              },
            }),
            Layer.mock(ModelActorRefs, { changes: Stream.fromPubSub(refs) }),
          ),
        ),
      ),
      scope,
    ),
  );
  const watch = await Effect.runPromise(
    RpcTest.makeClient(WatchRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
  );

  // Main asks every core that says ready; a second ask starts nothing new.
  for (let ask = 0; ask < 2; ask += 1) {
    await Effect.runPromise(watch.WatchModel());
    await Effect.runPromise(watch.WatchModelCanvases());
    await Effect.runPromise(watch.WatchModelActorRefs());
  }
  expect(changeListeners.size).toBe(1);
  expect(canvasListeners.size).toBe(1);
  await settle();

  const changed: Changed = { canvas, seq: 2, nodes: [], wires: [], removedNodes: [], removedWires: [] };
  const created: CanvasesChanged = { _tag: "Created", canvas };
  const actorRefs: ActorRefsChanged = { canvas: "main", refs: [] };
  for (const listener of changeListeners) listener(changed, current);
  for (const listener of canvasListeners) listener(created, current);
  await Effect.runPromise(PubSub.publish(refs, actorRefs));
  await settle();

  expect(pushed).toEqual([
    [IPC_CHANNELS.modelChanged, changed],
    [IPC_CHANNELS.modelCanvasesChanged, created],
    [IPC_CHANNELS.modelActorRefsChanged, actorRefs],
  ]);

  // The server's scope closes: its subscriptions and its reader end with it.
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(changeListeners.size).toBe(0);
  expect(canvasListeners.size).toBe(0);
  await Effect.runPromise(PubSub.publish(refs, actorRefs));
  await settle();
  expect(pushed).toHaveLength(3);
});
