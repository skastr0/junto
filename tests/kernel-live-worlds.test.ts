import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Command } from "../src/shared/model";
import { CanvasFactBasis } from "../src/shared/work-protocol";
import { KernelLive, KernelService } from "../src/main/junto/kernel/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelService } from "../src/main/junto/model/service";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { SchedulerRepository } from "../src/main/junto/scheduler/repository";
import { SnapshotsService } from "../src/main/junto/snapshots";
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
  const workLive = Layer.effect(
    WorkService,
    Effect.map(WorkRepository, (repository) => ({
      readKernelWork: (canvas: string) => repository.kernelWork(canvas),
      subscribeWorkChanges: (listener: (canvas?: string, node?: string) => void) =>
        repository.subscribeChanges((canvas, node) => listener(canvas, node)),
    }) as never),
  );
  const stubsLive = Layer.mergeAll(
    PausePlaneAllPlaying,
    Layer.succeed(SnapshotsService, {
      current: Effect.succeed({ bundles: [] }),
      refresh: () => Effect.void,
      subscribe: () => () => undefined,
    } as never),
    Layer.succeed(SchedulerRepository, {
      claimExpression: () => Effect.succeed({ _tag: "Duplicate" }),
      reconcileHome: () => Effect.succeed(0),
    } as never),
    Layer.succeed(MachineRepository, {
      installationId: Effect.succeed("board-home"),
      machineName: Effect.succeed(THIS_MACHINE),
    } as never),
    Layer.succeed(ActorSeatOccupy, {} as never),
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      KernelLive,
      Layer.mergeAll(Layer.provideMerge(workLive, storesLive), stubsLive),
    ) as never,
  );
  const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
    runtime.runPromise(effect as never) as Promise<A>;
  let kernel: { readonly suspend: () => void } | undefined;
  try {
    const sql = await run(SqlClient.SqlClient as never as Effect.Effect<SqlClient.SqlClient>);
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations VALUES ('board-home','2026-10-07')`;
          yield* sql`INSERT INTO installation VALUES (1,'board-home','2026-10-07')`;
          yield* sql`INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at) VALUES (1, ${THIS_MACHINE}, 1, '2026-10-07')`;
        }),
      ),
    );
    const model = await run(ModelService as never as Effect.Effect<Context>);
    const command = Schema.decodeUnknownSync(Command);
    const send = (input: unknown) => run(model.command(command(input), "operator"));
    await send({ _tag: "CreateCanvas", canvas: "factory" });
    await send({
      _tag: "Add",
      canvas: "factory",
      nodes: [
        { kind: "task", id: "tasks", x: 0, y: 0, width: 200, height: 100, z: 0 },
        { kind: "relay", id: "relay", x: 300, y: 0, width: 200, height: 100, z: 1, host: THIS_MACHINE },
      ],
      wires: [{ id: "w1", from: "tasks", to: "relay", verb: "announces" }],
    });

    const live = await run(KernelService as never as Effect.Effect<Kernel>);
    kernel = live;
    live.start({
      runPromise: (effect) => runtime.runPromise(effect as never) as never,
      runFork: (effect) => {
        runtime.runFork(effect as never);
      },
    });

    const watching = (canvas: string) =>
      live.getSnapshot().canvases[canvas]?.watchers["relay"]?.detail;
    expect(await until(() => watching("factory"), "the relay to be read")).toContain(
      "has no tasks yet",
    );

    // A canvas made after the kernel started is held too; one removed is dropped.
    await send({ _tag: "CreateCanvas", canvas: "annex" });
    await until(() => live.getSnapshot().canvases["annex"], "the new canvas");
    await send({ _tag: "RemoveCanvas", canvas: "annex" });
    await until(
      () => (live.getSnapshot().canvases["annex"] === undefined ? true : undefined),
      "the removed canvas to go",
    );

    // A task row is work, not canvas: the relay sees it once work says it changed.
    const repository = await run(WorkRepository as never as Effect.Effect<Repository>);
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
      () => (watching("factory")?.includes("waiting for a task") ? true : undefined),
      "the relay to see the task",
    );
  } finally {
    kernel?.suspend();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

type Context = import("effect").Context.Service.Shape<typeof ModelService>;
type Kernel = import("effect").Context.Service.Shape<typeof KernelService>;
type Repository = import("effect").Context.Service.Shape<typeof WorkRepository>;
