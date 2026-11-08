/**
 * The resources group (src/contract/core/resources.ts) through the group's own
 * client on the core's handlers: a read the store cannot make fails with the
 * contract's error, and a write any surface makes reaches the window as a push
 * for as long as the handlers live.
 */
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, it } from "vitest";
import { RESOURCE_CHANGED, RESOURCE_THREAD_CHANGED } from "../src/contract/core/channels";
import { ResourcesRpcs } from "../src/contract/core/resources";
import { ResourcesHandlers } from "../src/core/ops/ipc-resources";
import { CorePushes } from "../src/core/push";
import { noteResourceChanged, noteThreadChanged } from "../src/core/work/resource-changes";
import { WorkService, WorkServiceError } from "../src/core/work/service";
import { RESOURCE_IPC_CHANNELS } from "../src/shared/resource-ipc";

/** A work-service member this test never reaches: reaching it fails the test, loudly. */
const unsubscribed = (member: string) => (): (() => void) => {
  throw new Error(`${member}: the resources test never subscribes`);
};

it("fails a read the store cannot make with the contract's error, and tells the window of every write while it lives", async () => {
  const pushed: Array<readonly [string, unknown]> = [];
  const scope = await Effect.runPromise(Scope.make());
  const handlers = await Effect.runPromise(
    Layer.buildWithScope(
      ResourcesHandlers.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => void pushed.push([channel, payload])) }),
            Layer.mock(WorkService, {
              readTopology: (canvas) =>
                Effect.fail(new WorkServiceError({ code: "canvas_not_found", message: `the canvas ${canvas} could not be read` })),
              subscribeTopologyChanges: unsubscribed("WorkService.subscribeTopologyChanges"),
              subscribeWorkChanges: unsubscribed("WorkService.subscribeWorkChanges"),
              subscribeMailChanges: unsubscribed("WorkService.subscribeMailChanges"),
            }),
          ),
        ),
      ),
      scope,
    ),
  );
  const resources = await Effect.runPromise(
    RpcTest.makeClient(ResourcesRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
  );

  const read = await Effect.runPromiseExit(resources.ResourceTaskAll({ canvasName: "factory" }));
  expect(Option.map(Exit.findErrorOption(read), (error) => error._tag)).toEqual(Option.some("ResourceUnavailable"));

  noteResourceChanged("artifact", "factory");
  noteThreadChanged("task", "factory");
  expect(pushed).toEqual([
    [RESOURCE_CHANGED, { channel: RESOURCE_IPC_CHANNELS.artifact.changed, canvasName: "factory" }],
    // A change of an artifact is a change of its threads: a comment on it is one.
    [RESOURCE_THREAD_CHANGED, { channel: RESOURCE_IPC_CHANNELS.thread.changed, canvasName: "factory", kind: "artifact" }],
    [RESOURCE_THREAD_CHANGED, { channel: RESOURCE_IPC_CHANNELS.thread.changed, canvasName: "factory", kind: "task" }],
  ]);

  await Effect.runPromise(Scope.close(scope, Exit.void));
  noteResourceChanged("task", "factory");
  expect(pushed).toHaveLength(3);
});
