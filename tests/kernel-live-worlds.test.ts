import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { it } from "vitest";
import { Command } from "../src/shared/model";
import { KernelLive, KernelService } from "../src/main/junto/kernel/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelService } from "../src/main/junto/model/service";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { ActorSeatOccupy } from "../src/main/junto/term/actor-seat-occupy";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { noteResourceChanged } from "../src/main/junto/work/resource-changes";
import { TaskRepository } from "../src/main/junto/work/task-repository";
import { THIS_MACHINE } from "./support/machines";
import { note } from "./support/model-nodes";

// The kernel service against the real model and work stores: it holds every
// canvas the model lists, follows canvases that come and go, and reads a
// canvas's tasks again when they change.

const until = async <A>(read: () => A | undefined, what: string): Promise<A> => {
  for (let tries = 0; tries < 200; tries += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

it("holds the model's canvases and follows their tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-kernel-live-"));
  const modelLive = Layer.provideMerge(
    Layer.provide(ModelLive, ModelDependents.empty),
    makeStateEngineLive(join(root, "junto.db")),
  );
  const storesLive = Layer.provideMerge(WorkRepositoryLive, modelLive);
  // Every read of a canvas's tasks, so the test sees the kernel follow them.
  const taskReads: string[] = [];
  const tasksLive = Layer.succeed(
    TaskRepository,
    TaskRepository.of({
      list: (canvas) => {
        taskReads.push(canvas);
        return Effect.succeed({ tasks: [], more: false });
      },
      seatTasks: () => Effect.succeed({ tasks: [], leftOut: 0 }),
      get: () => Effect.succeed(Option.none()),
      submit: () => Effect.die(new Error("the kernel rules no task")),
      precheck: () => Effect.succeed(Option.none()),
      overlay: () => Effect.succeed([]),
    }),
  );
  const stubsLive = Layer.mergeAll(
    PausePlaneAllPlaying,
    Layer.succeed(MachineRepository, {
      installationId: Effect.succeed("board-home"),
      machineName: Effect.succeed(THIS_MACHINE),
    } as never),
    Layer.succeed(ActorSeatOccupy, {} as never),
    tasksLive,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      KernelLive,
      Layer.mergeAll(storesLive, stubsLive),
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

    // A task write is not a canvas change: the kernel reads the canvas's
    // tasks again once the task store says they changed.
    const readsBefore = taskReads.filter((name) => name === "factory").length;
    noteResourceChanged("task", "factory");
    await until(
      () => (taskReads.filter((name) => name === "factory").length > readsBefore ? true : undefined),
      "the kernel to read the canvas's tasks again",
    );

    // A commit that moves no task node is applied from its change set: the
    // kernel holds the canvas it left, and reads no task.
    const reads = () => taskReads.filter((name) => name === "factory").length;
    const quiet = reads();
    let cycles = 0;
    const offCycles = live.subscribe(() => { cycles += 1; });
    await send({ _tag: "Add", canvas: "factory", nodes: [note("aside")], wires: [] });
    // The world it left is held: that schedules the pass that follows.
    await until(() => (cycles > 0 ? true : undefined), "the pass after the commit");
    offCycles();
    if (reads() !== quiet) throw new Error(`a commit with no task node read the tasks ${String(reads() - quiet)} times`);
    // A new task node changes what the seat task index reads: it is read again.
    await send({ _tag: "Add", canvas: "factory", nodes: [{ kind: "task", id: "more", x: 300, y: 0, width: 200, height: 100, z: 1 }], wires: [] });
    await until(() => (reads() > quiet ? true : undefined), "a new task node to read the tasks again");
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
