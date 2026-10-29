/**
 * Behind the authority (0.11/06 F2), through the real stores: a task command
 * is judged on its canvas's authority and lands when its entry applies, and
 * a seat's release is the bridge until structure.changed is logged. The
 * seat's removal commits first, then each owed unassign is judged on its
 * own; what is owed is read from state, so a failed or crashed unassign is
 * healed by the next release or boot. With the authority off, the release
 * stays the one transaction it was (tests/seat-release-live.test.ts).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ authority: true }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get AUTHORITY_ENABLED() { return flags.authority; },
}));

import { makeContentServiceLive } from "../src/main/junto/content/service";
import { CanvasAuthoritiesLive } from "../src/main/junto/fleet/host";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelRecords } from "../src/main/junto/model/records";
import { SettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { commandReleasingSeats, healSeatReleases } from "../src/main/junto/work/seat-release";
import { WorkLive } from "../src/main/junto/work/service";
import { taskCanvasEnv, taskRulingContext } from "../src/main/junto/work/task-control";
import { TaskPersistenceError, TaskRepository, TaskRepositoryLive } from "../src/main/junto/work/task-repository";
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
  // The recorder sees the machine and the canvas, so an applied ruling writes its notices here.
  const recorder = Layer.provide(RulingRecorderLive, Layer.mergeAll(WorkRepositoryLive, MachineRepositoryLive, ModelRecords.layer));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(dir, "content"), skipInlineMediaMigration: true }),
      // As core-product wires it: the task ruler judges on the host's authorities.
      Layer.provide(TaskRepositoryLive, Layer.provideMerge(Layer.provide(CanvasAuthoritiesLive, MachineRepositoryLive), recorder)),
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

const boot = async (authority: boolean) => {
  flags.authority = authority;
  dir = await mkdtemp(join(tmpdir(), "junto-seat-release-authority-"));
  runtime = makeRuntime(dir);
  await runtime.runPromise(nameThisMachine);
  seedThisMachine();
  await runtime.runPromise(seedCanvas(NAME, [seat("ada"), taskBoard("board", { x: 400 })]));
  return runtime;
};
type Runtime = Awaited<ReturnType<typeof boot>>;

const rule = (rt: Runtime, op: TaskCommand, id?: TaskId) =>
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

/** A task on the board, assigned to ada; its current layer, read again on each call. */
const assignedTask = async (rt: Runtime) => {
  const taskId = mintItemId();
  await rule(rt, { kind: "create", taskId, title: "fix tabs" });
  await rule(rt, { kind: "assign", seat: ada }, taskId);
  const current = () =>
    rt.runPromise(Effect.map(Effect.flatMap(TaskRepository, (repo) => repo.get(NAME, taskId)), (view) => Option.getOrThrow(view).current));
  return { taskId, current };
};

/** Read on a connection of its own, as another reader of the disk does. */
const onDisk = <A>(read: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(join(dir!, "junto.db"), { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
};
const count = (sql: string, ...values: Array<string>) => (onDisk((db) => db.prepare(sql).get(...values)) as { n: number }).n;

const removeAda: Command = { _tag: "Remove", canvas: asCanvasName(NAME), nodes: [asNodeId("ada")], wires: [] };
const restoreAda: Command = { _tag: "Add", canvas: asCanvasName(NAME), nodes: [seat("ada")], wires: [] };
const run = (rt: Runtime, command: Command) => rt.runPromise(commandReleasingSeats(command, "operator"));

/** The task ruler, one of whose commands the authority cannot judge, or the ruler refuses. */
const withSubmit = (outcome: "fails" | "refuses") =>
  Effect.flatMap(TaskRepository, (repo) =>
    Effect.succeed(TaskRepository.of({
      ...repo,
      submit: (writer, command, context, env) =>
        command.op.kind !== "unassign"
          ? repo.submit(writer, command, context, env)
          : outcome === "fails"
            ? Effect.fail(TaskPersistenceError.make({ operation: "submit", message: "the machine went down", cause: undefined }))
            : Effect.succeed({ kind: "refused" as const, opId: command.opId, root: command.opId, error: { type: "InvalidTransition", message: "not now" } as never }),
    })));

describe.each([false, true])("with the authority %s", (authority) => {
  it("a removed seat's task goes back to the backlog, and comes back when the seat is restored", async () => {
    const rt = await boot(authority);
    const { taskId, current } = await assignedTask(rt);
    await run(rt, removeAda);
    expect(await current()).toMatchObject({ state: "backlog" });
    expect(count("SELECT COUNT(*) AS n FROM task_seat_releases WHERE task_id = ?", taskId)).toBe(1);
    await run(rt, restoreAda);
    expect(await current()).toMatchObject({ state: "assigned", assignee: ada });
    expect(count("SELECT COUNT(*) AS n FROM task_seat_releases WHERE task_id = ?", taskId)).toBe(0);
    // Judged rulings are logged on the canvas's authority; direct ones are not.
    expect(count("SELECT COUNT(*) AS n FROM canvas_log WHERE canvas_name = ? AND kind = 'ruling'", NAME) > 0).toBe(authority);
  });

  it("a task is on disk once submit returns, and behind the authority submit refuses a caller's transaction", async () => {
    const rt = await boot(authority);
    const create = (taskId: TaskId) => Effect.gen(function* () {
      const canvas = yield* readSeeded(NAME);
      const writer = yield* (yield* MachineRepository).installationId;
      return yield* (yield* TaskRepository).submit(
        writer,
        { opId: mintOpId(), canvasName: NAME, actor: { kind: "operator" }, target: { kind: "task", nodeId: board }, basis: null, after: [], op: { kind: "create", taskId, title: "fix tabs" } },
        taskRulingContext(canvas),
        taskCanvasEnv(canvas),
      );
    });
    const first = mintItemId();
    await rt.runPromise(create(first));
    expect(count("SELECT COUNT(*) AS n FROM task_heads WHERE task_id = ?", first)).toBe(1);
    const inside = await rt.runPromise(Effect.exit(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(create(mintItemId())))));
    expect(inside._tag).toBe(authority ? "Failure" : "Success");
  });

  it("the assigned seat gets its notice once", async () => {
    const rt = await boot(authority);
    await assignedTask(rt);
    expect(count("SELECT COUNT(*) AS n FROM work_messages WHERE canvas_name = ? AND node_id = ?", NAME, "ada")).toBe(1);
  });
});

describe("a seat release, behind the authority", () => {
  it("commits the removal first, and a failed unassign stays owed until the next heal releases it once", async () => {
    const rt = await boot(true);
    const { taskId, current } = await assignedTask(rt);
    await rt.runPromise(Effect.flatMap(withSubmit("fails"), (failing) =>
      commandReleasingSeats(removeAda, "operator").pipe(Effect.provideService(TaskRepository, failing))));
    // The seat is gone; its task is still held, and owed.
    expect((await rt.runPromise(readSeeded(NAME))).nodes.has(asNodeId("ada"))).toBe(false);
    expect(await current()).toMatchObject({ state: "assigned", assignee: ada });
    expect(count("SELECT COUNT(*) AS n FROM task_seat_releases")).toBe(0);
    // As at boot, or the next release: the owed unassign is judged once.
    expect(await rt.runPromise(healSeatReleases(NAME))).toMatchObject({ released: 1 });
    expect(await current()).toMatchObject({ state: "backlog" });
    expect(count("SELECT COUNT(*) AS n FROM task_seat_releases WHERE task_id = ?", taskId)).toBe(1);
    expect(await rt.runPromise(healSeatReleases(NAME))).toEqual({ released: 0, given: 0, kept: 0 });
  });

  it("logs a refused unassign and does not retry it in the pass; the next heal does", async () => {
    const rt = await boot(true);
    const { current } = await assignedTask(rt);
    const refused = await rt.runPromise(Effect.flatMap(withSubmit("refuses"), (refusing) =>
      Effect.andThen(
        commandReleasingSeats(removeAda, "operator"),
        healSeatReleases(NAME),
      ).pipe(Effect.provideService(TaskRepository, refusing))));
    expect(refused).toEqual({ released: 0, given: 0, kept: 0 });
    expect(await current()).toMatchObject({ state: "assigned", assignee: ada });
    expect(await rt.runPromise(healSeatReleases(NAME))).toMatchObject({ released: 1 });
    expect(await current()).toMatchObject({ state: "backlog" });
  });

  it("keeps a give-back owed until its assign is judged", async () => {
    const rt = await boot(true);
    const { taskId, current } = await assignedTask(rt);
    await run(rt, removeAda);
    const failingAssign = Effect.flatMap(TaskRepository, (repo) =>
      Effect.succeed(TaskRepository.of({
        ...repo,
        submit: (writer, command, context, env) =>
          command.op.kind === "assign"
            ? Effect.fail(TaskPersistenceError.make({ operation: "submit", message: "the machine went down", cause: undefined }))
            : repo.submit(writer, command, context, env),
      })));
    await rt.runPromise(Effect.flatMap(failingAssign, (failing) =>
      commandReleasingSeats(restoreAda, "operator").pipe(Effect.provideService(TaskRepository, failing))));
    expect(await current()).toMatchObject({ state: "backlog" });
    expect(count("SELECT COUNT(*) AS n FROM task_seat_releases WHERE task_id = ?", taskId)).toBe(1);
    expect(await rt.runPromise(healSeatReleases(NAME))).toMatchObject({ given: 1 });
    expect(await current()).toMatchObject({ state: "assigned", assignee: ada });
    expect(count("SELECT COUNT(*) AS n FROM task_seat_releases WHERE task_id = ?", taskId)).toBe(0);
  });
});
