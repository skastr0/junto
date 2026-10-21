/**
 * A removed seat lets go of its task (seat-release.ts): each open task it held
 * goes back to the backlog through the ruler's own unassign, in the delete's
 * transaction, with a line in the task's thread. Putting the seat back gives
 * each task back, unless a command ruled on it since. A region delete takes
 * the region alone, and a terminal that exits leaves its node: neither
 * releases anything.
 */
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Reactivity } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asCanvasName, type Canvas, type Command, type Node } from "../src/shared/model";
import { canvasAfter } from "../src/renderer/lib/model-undo";
import type { InstallationId } from "../src/shared/installation-id";
import { mintItemId, mintOpId, type ResourceActor, type ResourceCommand } from "../src/shared/resource-command";
import { seatNodeId, taskNodeId, type TaskCommand, type TaskId, type TaskState } from "../src/shared/task-model";
import { asNodeId } from "../src/shared/physics/schema";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { REVIEW_VERDICTS_SCHEMA_SQL } from "../src/main/junto/state/migrate-review-stamps";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { RESOURCE_RULINGS_STATE_SCHEMA_SQL } from "../src/main/junto/work/resource-rulings-schema";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { commandReleasingSeats, SEAT_RELEASE_LINE } from "../src/main/junto/work/seat-release";
import { taskCanvasEnv, taskRulingContext } from "../src/main/junto/work/task-control";
import { TaskRepository, TaskRepositoryLive } from "../src/main/junto/work/task-repository";
import { TASK_SEAT_RELEASES_SQL, TASKS_STATE_SCHEMA_SQL } from "../src/main/junto/work/task-state-schema";
import { canvasOf, region, seat, taskBoard } from "./support/model-nodes";

const posted = vi.hoisted(() => [] as Array<{ readonly taskId: string; readonly text: string }>);
vi.mock("../src/main/junto/work/subject-comment", () => ({
  postSubjectComment: (input: { readonly subject: { readonly taskId: string }; readonly text: string }) => {
    posted.push({ taskId: input.subject.taskId, text: input.text });
    return Effect.succeed({ threadId: input.subject.taskId, messageId: input.subject.taskId, notified: [] });
  },
}));

const NAME = "factory";
const mini = "mini" as InstallationId;
const board = taskNodeId(asNodeId("board"));
const ada = seatNodeId(asNodeId("ada"));

let database: DatabaseSync;
let canvas: Canvas;
let runtime: ManagedRuntime.ManagedRuntime<TaskRepository | ModelService | MachineRepository | SqlClient.SqlClient, never>;

/** The canvas as the model would hold it, changed by each command as main changes it. */
const modelStub = Layer.succeed(ModelService, {
  canvas: () => Effect.sync(() => canvas),
  command: (command: Command) =>
    Effect.sync(() => {
      canvas = canvasAfter(canvas, command);
      return { seq: 1 };
    }),
} as never);

beforeEach(() => {
  posted.length = 0;
  canvas = canvasOf([seat("ada"), seat("bo", { x: 300 }), taskBoard("board", { x: 600 }), region("crew", { x: -50, y: -50, width: 500, height: 300 })], [], NAME);
  database = new DatabaseSync(":memory:");
  database.exec(TASKS_STATE_SCHEMA_SQL);
  database.exec(TASK_SEAT_RELEASES_SQL);
  database.exec(RESOURCE_RULINGS_STATE_SCHEMA_SQL);
  database.exec(REVIEW_VERDICTS_SCHEMA_SQL);
  const client = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const recorder = Layer.effect(
    RulingRecorder,
    Effect.map(SqlClient.SqlClient, (sql) =>
      RulingRecorder.of({
        record: (input) =>
          writeRuling(sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(Effect.asVoid, Effect.orDie),
      })),
  );
  const machines = Layer.succeed(MachineRepository, { installationId: Effect.succeed(mini) } as never);
  runtime = ManagedRuntime.make(
    Layer.mergeAll(TaskRepositoryLive.pipe(Layer.provide(recorder)), modelStub, machines).pipe(Layer.provideMerge(client)),
  );
});

afterEach(async () => {
  await runtime.dispose();
  database.close();
});

const adaActor: ResourceActor = { kind: "seat", seatId: `seat_${"a".repeat(64)}` as never, nodeId: ada };

const rule = (taskId: TaskId | undefined, op: TaskCommand, actor: ResourceActor = { kind: "operator" }) =>
  runtime.runPromise(Effect.gen(function* () {
    const repo = yield* TaskRepository;
    const command: ResourceCommand<TaskCommand> = {
      opId: mintOpId(), canvasName: NAME, actor,
      target: { kind: "task", nodeId: board, ...(taskId === undefined ? {} : { itemId: taskId }) },
      basis: null, after: [], op,
    };
    const outcome = yield* repo.submit(mini, command, taskRulingContext(canvas), taskCanvasEnv(canvas));
    if (outcome.kind !== "applied") throw new Error(outcome.error.message);
  }));

/** A task on the board, assigned to ada and taken to `state`; one in review waits on a stamp. */
const heldByAda = async (state: TaskState = "assigned"): Promise<TaskId> => {
  const taskId = mintItemId();
  await rule(undefined, { kind: "create", taskId, title: "fix tabs", ...(state === "in-review" ? { stampPolicy: { required: 1 } } : {}) });
  await rule(taskId, { kind: "assign", seat: ada });
  if (state === "working" || state === "input-required" || state === "in-review" || state === "done") await rule(taskId, { kind: "start" }, adaActor);
  if (state === "input-required") await rule(taskId, { kind: "pause" }, adaActor);
  if (state === "done" || state === "in-review") await rule(taskId, { kind: "finish" }, adaActor);
  return taskId;
};

const taskOf = async (taskId: TaskId) =>
  Option.getOrThrow(await runtime.runPromise(Effect.flatMap(TaskRepository, (repo) => repo.get(NAME, taskId)))).current;

const run = (command: Command) => runtime.runPromise(commandReleasingSeats(command, "operator"));
const remove = (...ids: string[]) => run({ _tag: "Remove", canvas: asCanvasName(NAME), nodes: ids.map(asNodeId), wires: [] });
const putBack = (node: Node) => run({ _tag: "Add", canvas: asCanvasName(NAME), nodes: [node], wires: [] });

describe("a removed seat lets go of its task", () => {
  it.each<TaskState>(["assigned", "working", "input-required", "in-review"])("a delete sends a task %s back to the backlog, with a line in its thread", async (state) => {
    const taskId = await heldByAda(state);
    await remove("ada");
    const task = await taskOf(taskId);
    expect(task.state).toBe("backlog");
    expect(task.assignee).toBeUndefined();
    expect(posted).toEqual([{ taskId, text: SEAT_RELEASE_LINE }]);
  });

  it("a closed task keeps its assignee as history", async () => {
    const taskId = await heldByAda("done");
    await remove("ada");
    expect(await taskOf(taskId)).toMatchObject({ state: "done", assignee: ada });
    expect(posted).toEqual([]);
  });

  it("undo gives the task back to the restored seat, as assigned", async () => {
    const taskId = await heldByAda("working");
    const node = canvas.nodes.get(asNodeId("ada"))!;
    await remove("ada");
    expect(await putBack(node)).toEqual({ seq: 1 });
    expect(await taskOf(taskId)).toMatchObject({ state: "assigned", assignee: ada });
  });

  it("undo after a later command leaves the task in the backlog, and says how many", async () => {
    const taskId = await heldByAda();
    const node = canvas.nodes.get(asNodeId("ada"))!;
    await remove("ada");
    await rule(taskId, { kind: "edit", title: "fix the tabs" });
    expect(await putBack(node)).toEqual({ seq: 1, tasksKept: 1 });
    expect(await taskOf(taskId)).toMatchObject({ state: "backlog" });
  });

  it("a region deleted with its selected seats releases them", async () => {
    const taskId = await heldByAda();
    await remove("crew", "ada", "bo");
    expect((await taskOf(taskId)).state).toBe("backlog");
  });

  it("a region deleted alone releases nothing: its seats stay", async () => {
    const taskId = await heldByAda();
    await remove("crew");
    expect(await taskOf(taskId)).toMatchObject({ state: "assigned", assignee: ada });
    expect(posted).toEqual([]);
  });

  it("a seat that stays on the canvas releases nothing, whatever its terminal does", async () => {
    // A terminal's exit changes no canvas row; only a command that removes the node releases.
    const taskId = await heldByAda("working");
    await run({ _tag: "Move", canvas: asCanvasName(NAME), moves: [{ id: asNodeId("ada"), x: 40, y: 40 }] });
    expect(await taskOf(taskId)).toMatchObject({ state: "working", assignee: ada });
  });
});
