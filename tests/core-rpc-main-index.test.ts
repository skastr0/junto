/**
 * The main-index group (src/contract/core/main-index.ts) through the group's
 * own client on the core's handlers: what `src/app/index.ts` asks the core.
 * The canvas watch is subscribed once per server however often it is asked
 * and ends with it; a play state is read as it is now; a ref or a read the
 * core cannot make fails with the group's errors; and a seat's box comment on
 * a page it cannot name is refused before main takes any shot.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANVAS_CHANGED } from "../src/contract/core/channels";
import { MainIndexRpcs } from "../src/contract/core/main-index";
import { ContentService } from "../src/core/content/service";
import { MachineRepository } from "../src/core/machines/repository";
import { ModelRecords, ModelRefused } from "../src/core/model/records";
import { ModelService } from "../src/core/model/service";
import { MainIndexHandlers } from "../src/core/ops/main-index";
import { PausePlane } from "../src/core/pause-plane";
import { CorePushes } from "../src/core/push";
import { makeStateEngineLive } from "../src/core/state/engine";
import { asCanvasName, type Canvas, type CanvasesChanged, type Changed } from "../src/shared/model";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-main-index-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The core's main-index handlers on a scope of their own, and the group's client on them. */
const served = async (model: Layer.Layer<ModelService>, pause: { playing: boolean }) => {
  const pushed: Array<readonly [string, unknown]> = [];
  const scope = await Effect.runPromise(Scope.make());
  const handlers = await Effect.runPromise(
    Layer.buildWithScope(
      MainIndexHandlers.pipe(
        Layer.provide(
          Layer.mergeAll(
            model,
            Layer.mock(PausePlane, { stateFor: () => ({ playing: pause.playing, everPlayed: true }), subscribe: () => () => undefined }),
            Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => void pushed.push([channel, payload])) }),
            Layer.mock(ModelRecords, {}),
            Layer.mock(MachineRepository, {}),
            Layer.mock(ContentService, { root: join(dir, "content") }),
            makeStateEngineLive(join(dir, "junto.db")),
          ),
        ),
      ),
      scope,
    ),
  );
  const client = await Effect.runPromise(
    RpcTest.makeClient(MainIndexRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
  );
  return { client, pushed, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

const errorTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Option.map(Exit.findErrorOption(exit), (error) => error._tag);

describe("the main-index group", () => {
  it("publishes canvas changes for the browser, subscribed once however often asked and dropped with the server, and reads a play state as it is now", async () => {
    const changes: Array<(event: Changed, next: Canvas) => void> = [];
    const removals: Array<(event: CanvasesChanged) => void> = [];
    let stopped = 0;
    const pause = { playing: true };
    const { client, pushed, close } = await served(
      Layer.mock(ModelService, {
        subscribeChanges: (listener) => {
          changes.push(listener);
          return () => void (stopped += 1);
        },
        subscribeCanvasesChanges: (listener) => {
          removals.push(listener);
          return () => void (stopped += 1);
        },
      }),
      pause,
    );
    await Effect.runPromise(client.MainIndexWatchCanvases());
    await Effect.runPromise(client.MainIndexWatchCanvases());
    expect([changes.length, removals.length]).toEqual([1, 1]);

    const factory: Canvas = { name: asCanvasName("factory"), seq: 1, nodes: new Map(), wires: new Map() };
    changes[0]?.({ canvas: factory.name, seq: 1, nodes: [], wires: [], removedNodes: [], removedWires: [] }, factory);
    removals[0]?.({ _tag: "Removed", canvas: asCanvasName("lab") });
    removals[0]?.({ _tag: "Created", canvas: asCanvasName("new") });
    expect(pushed).toEqual([
      [CANVAS_CHANGED, { canvas: "factory", next: factory }],
      [CANVAS_CHANGED, { canvas: "lab", next: undefined }],
    ]);

    expect(await Effect.runPromise(client.MainIndexCanvasPlaying({ canvas: "factory" }))).toBe(true);
    pause.playing = false;
    expect(await Effect.runPromise(client.MainIndexCanvasPlaying({ canvas: "factory" }))).toBe(false);

    await close();
    expect(stopped).toBe(2);
  });

  it("fails a ref and a canvas list the core cannot read with the group's errors", async () => {
    const { client, close } = await served(
      Layer.mock(ModelService, {
        listCanvases: () => Effect.fail(new ModelRefused({ rule: "the canvases are gone" })),
        subscribeChanges: () => () => undefined,
        subscribeCanvasesChanges: () => () => undefined,
      }),
      { playing: true },
    );
    try {
      const resolved = await Effect.runPromiseExit(client.MainIndexResolveNodeRef({ ref: { canvasName: "factory", nodeId: "seat" } }));
      expect(errorTag(resolved)).toEqual(Option.some("MainIndexNodeRefUnresolved"));
      expect(Option.map(Exit.findErrorOption(resolved), (error) => error.message)).toEqual(Option.some("the canvases are gone"));
      expect(errorTag(await Effect.runPromiseExit(client.MainIndexCanvases()))).toEqual(Option.some("MainIndexModelUnavailable"));
    } finally {
      await close();
    }
  });

  it("refuses a seat's box comment on a page it cannot name before main takes any shot", async () => {
    // A ref that does not parse is refused before any service is asked.
    const { client, close } = await served(
      Layer.mock(ModelService, { subscribeChanges: () => () => undefined, subscribeCanvasesChanges: () => () => undefined }),
      { playing: true },
    );
    try {
      const checked = await Effect.runPromise(client.MainIndexPageBoxCheck({
        owner: "o", sessionId: "s", seatNodeId: "seat", pageRef: "not a ref", rect: { x: 0, y: 0, w: 1, h: 1 }, text: "look",
      }));
      expect(checked).toMatchObject({ ok: false, code: "invalid" });
    } finally {
      await close();
    }
  });
});
