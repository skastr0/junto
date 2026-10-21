import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Command } from "../src/shared/model";
import { CanvasFactBasis } from "../src/shared/work-protocol";
import { KernelLive, KernelService } from "../src/main/junto/kernel/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelService } from "../src/main/junto/model/service";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { ActorSeatOccupy } from "../src/main/junto/term/actor-seat-occupy";
import {
  createCanvasTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { WorkService } from "../src/main/junto/work/service";
import { THIS_MACHINE } from "./support/machines";
import { NoTasksLive } from "./support/no-tasks";

// The kernel service against the real model and work stores: it holds every
// canvas the model lists, follows canvases that come and go, and reads a
// board's rows again when work changes.

const until = async <A>(read: () => A | undefined, what: string): Promise<A> => {
  for (let tries = 0; tries < 200; tries += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

it("holds the model's canvases and follows their work", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-kernel-live-"));
  const modelLive = Layer.provideMerge(
    Layer.provide(ModelLive, ModelDependents.empty),
    makeStateEngineLive(join(root, "junto.db")),
  );
  const storesLive = Layer.provideMerge(WorkRepositoryLive, modelLive);
  // Every read of a canvas's work, so the test sees the kernel follow it.
  const workReads: string[] = [];
  const workLive = Layer.effect(
    WorkService,
    Effect.map(WorkRepository, (repository) => ({
      readKernelWork: (canvas: string) => {
        workReads.push(canvas);
        return repository.kernelWork(canvas);
      },
      subscribeWorkChanges: (listener: (canvas?: string, node?: string) => void) =>
        repository.subscribeChanges((canvas, node) => listener(canvas, node)),
    }) as never),
  );
  const stubsLive = Layer.mergeAll(
    PausePlaneAllPlaying,
    Layer.succeed(MachineRepository, {
      installationId: Effect.succeed("board-home"),
      machineName: Effect.succeed(THIS_MACHINE),
    } as never),
    Layer.succeed(ActorSeatOccupy, {} as never),
    NoTasksLive,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      KernelLive,
      Layer.mergeAll(Layer.provideMerge(workLive, storesLive), stubsLive),
    ),
  );
  const run = runtime.runPromise;
  let kernel: { readonly suspend: () => void } | undefined;
  try {
    const sql = await run(serviceOf(SqlClient.SqlClient));
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations VALUES ('board-home','2026-10-07')`;
          yield* sql`INSERT INTO installation VALUES (1,'board-home','2026-10-07')`;
          yield* sql`INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at) VALUES (1, ${THIS_MACHINE}, 1, '2026-10-07')`;
        }),
      ),
    );
    const model = await run(serviceOf(ModelService));
    const command = Schema.decodeUnknownSync(Command);
    const send = (input: unknown) => run(model.command(command(input), "operator"));
    await send({ _tag: "CreateCanvas", canvas: "factory" });
    await send({
      _tag: "Add",
      canvas: "factory",
      nodes: [
        { kind: "task", id: "tasks", x: 0, y: 0, width: 200, height: 100, z: 0 },
      ],
      wires: [],
    });

    const live = await run(serviceOf(KernelService));
    kernel = live;
    live.start({
      runPromise: (effect) => runtime.runPromise(effect),
      runFork: (effect) => {
        runtime.runFork(effect);
      },
    });

    await until(() => live.getSnapshot().canvases["factory"], "the canvas to be held");

    // A canvas made after the kernel started is held too; one removed is dropped.
    await send({ _tag: "CreateCanvas", canvas: "annex" });
    await until(() => live.getSnapshot().canvases["annex"], "the new canvas");
    await send({ _tag: "RemoveCanvas", canvas: "annex" });
    await until(
      () => (live.getSnapshot().canvases["annex"] === undefined ? true : undefined),
      "the removed canvas to go",
    );

    // A task row is work, not canvas: the kernel reads it again once work says
    // it changed.
    const readsBefore = workReads.filter((name) => name === "factory").length;
    const repository = await run(serviceOf(WorkRepository));
    const canvas = await run(model.canvas("factory"));
    const sink = { canvasName: "factory", nodeId: "tasks" };
    const at = "2026-10-07T00:01:00.000Z";
    await run(
      repository.createTask({
        sink,
        basis: Schema.decodeUnknownSync(CanvasFactBasis)({
          kind: "canvas",
          canvasName: "factory",
          seq: canvas.seq,
        }),
        dependencyScope: createCanvasTaskDependencyScopeCapability({
          canvas,
          authoringSink: sink,
        }),
        task: {
          id: "t1",
          state: "submitted",
          history: [{ messageId: "brief-t1", role: "user", parts: [{ kind: "text", text: "t1" }] }],
          visits: [{ board: "tasks", enteredAt: at, epoch: 0 }],
        },
        originAt: at,
        receivedAt: at,
      }),
    );
    await until(
      () => (workReads.filter((name) => name === "factory").length > readsBefore ? true : undefined),
      "the kernel to read the board's work again",
    );
  } finally {
    kernel?.suspend();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

/** A service from the runtime, as an effect the runtime can run. */
const serviceOf = <I, S>(tag: Context.Service<I, S>): Effect.Effect<S, never, I> => Effect.gen(function* () {
  return yield* tag;
});
