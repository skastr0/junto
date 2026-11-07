import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, it, vi } from "vitest";
import { MAIL_WAITING, SEAT_THREAD_READ_CHANGED } from "../src/contract/core/channels";
import { ThreadsRpcs } from "../src/contract/core/threads";
import { MachineRepository } from "../src/core/machines/repository";
import { ModelNotFound, ModelRecords } from "../src/core/model/records";
import { ModelService } from "../src/core/model/service";
import { CorePushes } from "../src/core/push";
import { makeStateEngineLive } from "../src/core/state/engine";
import { messageDelivery } from "../src/core/work/message-delivery";
import { WorkRepository } from "../src/core/work/repository";
import { WorkService } from "../src/core/work/service";
import {
  decodeOperatorThreadSend,
  decodeSeatThreadMarkRead,
  decodeSeatThreadsPageQuery,
} from "../src/shared/mail-threads";
import { asCanvasName } from "../src/shared/model/base";
import { asNodeId } from "../src/shared/physics/schema";

const readListeners = vi.hoisted(() => [] as Array<(change: unknown) => void>);
vi.mock("../src/core/work/mail-reads", async (original) => ({
  ...(await original<typeof import("../src/core/work/mail-reads")>()),
  onReadChanged: (listener: (change: unknown) => void) => (readListeners.push(listener), () => undefined),
}));

const { ThreadsHandlers } = await import("../src/core/ops/ipc-threads");

const THREAD = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** A member this test never reaches: reaching it fails the test, loudly. */
const unreached = (member: string) => () => Effect.die(`${member}: the threads test never reaches it`);
const unsubscribed = (member: string) => (): (() => void) => {
  throw new Error(`${member}: the threads test never subscribes`);
};

/**
 * What the threads handlers read beside the model: every canvas read fails
 * with the model's own not-found, so each ask stops there. Members a mock
 * leaves out die when reached; the members it must name fail the same way.
 */
const services = Layer.mergeAll(
  Layer.mock(ModelService, {
    canvas: (name) => Effect.fail(new ModelNotFound({ what: "canvas", id: name })),
    subscribeChanges: unsubscribed("ModelService.subscribeChanges"),
    subscribeCanvasesChanges: unsubscribed("ModelService.subscribeCanvasesChanges"),
  }),
  Layer.mock(ModelRecords, {}),
  Layer.mock(MachineRepository, {}),
  Layer.mock(WorkService, {
    subscribeTopologyChanges: unsubscribed("WorkService.subscribeTopologyChanges"),
    subscribeWorkChanges: unsubscribed("WorkService.subscribeWorkChanges"),
    subscribeMailChanges: unsubscribed("WorkService.subscribeMailChanges"),
  }),
  Layer.mock(WorkRepository, {
    seatControlRows: {
      outcome: unreached("WorkRepository.seatControlRows.outcome"),
      recentForSeat: unreached("WorkRepository.seatControlRows.recentForSeat"),
      record: unreached("WorkRepository.seatControlRows.record"),
      settle: unreached("WorkRepository.seatControlRows.settle"),
      pending: unreached("WorkRepository.seatControlRows.pending"),
      control: unreached("WorkRepository.seatControlRows.control"),
    },
    subscribeChanges: unsubscribed("WorkRepository.subscribeChanges"),
  }),
);

// What the renderer sends is decoded closed at main's edge, so the core is only
// handed input that decoded; that is where a malformed ask is refused.
it("refuses at main's edge what does not decode", () => {
  expect(decodeSeatThreadMarkRead({ canvasName: "factory" })._tag).toBe("Failure");
  expect(decodeOperatorThreadSend({ text: "hi" })._tag).toBe("Failure");
  expect(decodeSeatThreadsPageQuery({ nope: true })._tag).toBe("Failure");
});

// The window's threads ask the core through the threads group; read points and
// waiting mail come back as pushes, subscribed once per core.
it("answers thread asks in the core, and pushes read points and waiting mail once the watch started", async () => {
  const pushed: Array<readonly [string, unknown]> = [];
  const waiting: Array<(fact: unknown) => void> = [];
  const spy = vi.spyOn(messageDelivery, "subscribeMailWaiting").mockImplementation((listener) => (waiting.push(listener as never), () => undefined));
  const scope = await Effect.runPromise(Scope.make());
  // The read points' SQL client: the core's own, on a database of this test's.
  const dir = await mkdtemp(join(tmpdir(), "junto-threads-"));
  try {
    const handlers = await Effect.runPromise(
      Layer.buildWithScope(
        ThreadsHandlers.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => void pushed.push([channel, payload])) }),
              services,
              makeStateEngineLive(join(dir, "junto.db")),
            ),
          ),
        ),
        scope,
      ),
    );
    const threads = await Effect.runPromise(
      RpcTest.makeClient(ThreadsRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
    );
    const seat = asNodeId("a");
    const factory = asCanvasName("factory");

    // A mark never fails: a refusal is null.
    expect(await Effect.runPromise(threads.ThreadsMarkRead({ canvasName: factory, nodeId: seat, threadId: THREAD }))).toBeNull();
    // A read the core cannot make fails with the contract's error.
    const listed = await Effect.runPromiseExit(threads.ThreadsList({ canvasName: factory, nodeId: seat }));
    expect(Option.map(Exit.findErrorOption(listed), (error) => error._tag)).toEqual(Option.some("ThreadsUnavailable"));
    expect(
      await Effect.runPromise(
        threads.ThreadsCollaborationAsk({
          draft: { canvas: "factory", sourceNodeId: "a", sourceLabel: "A", targetNodeId: "b", targetLabel: "B", question: "q", why: "", evidence: [] },
        }),
      ),
    ).toEqual({ ok: false, error: "canvas \"factory\" could not be read" });

    await Effect.runPromise(threads.ThreadsWatch());
    await Effect.runPromise(threads.ThreadsWatch());
    expect([readListeners.length, waiting.length]).toEqual([1, 1]);
    readListeners[0]!({ canvasName: "factory", threadId: "t1" });
    waiting[0]!({ canvasName: "factory", nodeId: "n1" });
    expect(pushed).toEqual([
      [SEAT_THREAD_READ_CHANGED, { canvasName: "factory", threadId: "t1" }],
      [MAIL_WAITING, { canvasName: "factory", nodeId: "n1" }],
    ]);
  } finally {
    spy.mockRestore();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(dir, { recursive: true, force: true });
  }
});
