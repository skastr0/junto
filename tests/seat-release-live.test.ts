/**
 * The seat release through the real stores: the model, the task ruler with
 * its ruling recorder, and the work store that holds the task's thread. A
 * removed seat's task goes back to the backlog with its line in the thread,
 * and undo gives it back.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { editCanvases } from "../src/main/junto/overseer/portfolio";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { commandReleasingSeats, SEAT_RELEASE_LINE } from "../src/main/junto/work/seat-release";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import { taskCanvasEnv, taskRulingContext } from "../src/main/junto/work/task-control";
import { TaskRepository, TaskRepositoryLive } from "../src/main/junto/work/task-repository";
import { asCanvasName, asNodeId, type Command } from "../src/shared/model";
import { mintItemId, mintOpId } from "../src/shared/resource-command";
import { seatNodeId, taskNodeId, type TaskCommand, type TaskId } from "../src/shared/task-model";
import { nameThisMachine } from "./support/name-this-machine";
import { ModelStoresLive, readSeeded, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";
import { seat, taskBoard } from "./support/model-nodes";

const NAME = "factory";
const board = taskNodeId(asNodeId("board"));
const ada = seatNodeId(asNodeId("ada"));

const makeRuntime = (dir: string) => {
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(dir, "content"), skipInlineMediaMigration: true }),
      Layer.provide(TaskRepositoryLive, Layer.provide(RulingRecorderLive, WorkRepositoryLive)),
    ),
    Layer.mergeAll(makeStateEngineLive(join(dir, "junto.db")), makeInstallOpsLive(join(dir, "install-ops.db"))),
  );
  return ManagedRuntime.make(Layer.provideMerge(WorkLive, Layer.provideMerge(ModelStoresLive, repositories)));
};

let dir: string | undefined;
let runtime: ReturnType<typeof makeRuntime> | undefined;
afterEach(async () => {
  clearMachines();
  await runtime?.dispose();
  runtime = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const boot = async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-seat-release-"));
  runtime = makeRuntime(dir);
  await runtime.runPromise(nameThisMachine);
  seedThisMachine();
  await runtime.runPromise(seedCanvas(NAME, [seat("ada"), taskBoard("board", { x: 400 })]));
  return runtime;
};

/** A task on the board, assigned to ada; its current layer, read again on each call. */
const assignedTask = async (rt: Awaited<ReturnType<typeof boot>>) => {
  const taskId = mintItemId();
  const rule = (op: TaskCommand, id?: TaskId) =>
    rt.runPromise(Effect.gen(function* () {
      const canvas = yield* readSeeded(NAME);
      const writer = yield* (yield* MachineRepository).installationId;
      const outcome = yield* (yield* TaskRepository).submit(
        writer,
        { opId: mintOpId(), canvasName: NAME, actor: { kind: "operator" }, target: { kind: "task", nodeId: board, ...(id === undefined ? {} : { itemId: id }) }, basis: null, after: [], op },
        taskRulingContext(canvas),
        taskCanvasEnv(canvas),
      );
      if (outcome.kind !== "applied") throw new Error(outcome.error.message);
    }));
  await rule({ kind: "create", taskId, title: "fix tabs" });
  await rule({ kind: "assign", seat: ada }, taskId);
  const current = () =>
    rt.runPromise(Effect.map(Effect.flatMap(TaskRepository, (repo) => repo.get(NAME, taskId)), (view) => Option.getOrThrow(view).current));
  return { taskId, current };
};

const releaseRows = (rt: Awaited<ReturnType<typeof boot>>) =>
  rt.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly task_id: string }>`SELECT task_id FROM task_seat_releases`));

const removeAda: Command = { _tag: "Remove", canvas: asCanvasName(NAME), nodes: [asNodeId("ada")], wires: [] };

describe("a removed seat lets go of its task, through the real stores", () => {
  it("an overseer's canvas edit that removes the seat releases its task too", async () => {
    const rt = await boot();
    const { current } = await assignedTask(rt);
    await rt.runPromise(editCanvases(() => ({ ok: true, commands: [removeAda], result: undefined })));
    expect(await current()).toMatchObject({ state: "backlog" });
    expect(await releaseRows(rt)).toHaveLength(1);
  });

  it("a release the ruler refuses rolls the delete back, with the reason", async () => {
    const rt = await boot();
    const { current } = await assignedTask(rt);
    const exit = await rt.runPromise(Effect.exit(Effect.gen(function* () {
      const repo = yield* TaskRepository;
      return yield* commandReleasingSeats(removeAda, "operator").pipe(
        Effect.provideService(TaskRepository, {
          ...repo,
          submit: (_writer, command) =>
            Effect.succeed({ kind: "refused" as const, opId: command.opId, root: command.opId, error: { type: "InvalidTransition", message: "not now" } as never }),
        }),
      );
    })));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("could not go back to the backlog");
    expect((await rt.runPromise(readSeeded(NAME))).nodes.has(asNodeId("ada"))).toBe(true);
    expect(await current()).toMatchObject({ state: "assigned", assignee: ada });
    expect(await releaseRows(rt)).toEqual([]);
  });

  it("removing the canvas takes its releases with it", async () => {
    const rt = await boot();
    await assignedTask(rt);
    await rt.runPromise(commandReleasingSeats(removeAda, "operator"));
    expect(await releaseRows(rt)).toHaveLength(1);
    await rt.runPromise(commandReleasingSeats({ _tag: "RemoveCanvas", canvas: asCanvasName(NAME) }, "operator"));
    expect(await releaseRows(rt)).toEqual([]);
  });

  it("sends the task to the backlog with its line in the thread, and undo gives it back", async () => {
    const rt = await boot();
    const taskId = mintItemId();
    const rule = (op: TaskCommand, id?: TaskId) =>
      rt.runPromise(Effect.gen(function* () {
        const canvas = yield* readSeeded(NAME);
        const writer = yield* (yield* MachineRepository).installationId;
        const outcome = yield* (yield* TaskRepository).submit(
          writer,
          { opId: mintOpId(), canvasName: NAME, actor: { kind: "operator" }, target: { kind: "task", nodeId: board, ...(id === undefined ? {} : { itemId: id }) }, basis: null, after: [], op },
          taskRulingContext(canvas),
          taskCanvasEnv(canvas),
        );
        if (outcome.kind !== "applied") throw new Error(outcome.error.message);
      }));
    const current = () =>
      rt.runPromise(Effect.map(Effect.flatMap(TaskRepository, (repo) => repo.get(NAME, taskId)), (view) => Option.getOrThrow(view).current));
    await rule({ kind: "create", taskId, title: "fix tabs" });
    await rule({ kind: "assign", seat: ada }, taskId);
    const node = (await rt.runPromise(readSeeded(NAME))).nodes.get(asNodeId("ada"))!;
    const run = (command: Command) => rt.runPromise(commandReleasingSeats(command, "operator"));

    await run({ _tag: "Remove", canvas: asCanvasName(NAME), nodes: [asNodeId("ada")], wires: [] });
    expect(await current()).toMatchObject({ state: "backlog" });
    expect((await current()).assignee).toBeUndefined();
    // The line is posted once the delete commits: read the task node's thread until it lands.
    let thread: ReadonlyArray<unknown> = [];
    for (let tries = 0; tries < 50 && thread.length === 0; tries += 1) {
      const mailbox = await rt.runPromise(Effect.flatMap(WorkService, (work) => work.readMailbox(NAME, board)));
      thread = mailbox.filter((message) => JSON.stringify(message).includes(SEAT_RELEASE_LINE));
      if (thread.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(thread).toHaveLength(1);
    expect(JSON.stringify(thread[0])).toContain(taskId);

    expect(await run({ _tag: "Add", canvas: asCanvasName(NAME), nodes: [node], wires: [] })).not.toHaveProperty("tasksKept");
    expect(await current()).toMatchObject({ state: "assigned", assignee: ada });
  });
});
