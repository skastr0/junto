import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Reactivity } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import {
  mintItemId,
  mintOpId,
  type OpId,
  type ResourceActor,
  type ResourceCommand,
  type RulingContext,
} from "../src/shared/resource-command";
import { seatNodeId, taskNodeId, type TaskCommand, type TaskId } from "../src/shared/task-model";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { TASKS_STATE_SCHEMA_SQL } from "../src/main/junto/work/task-state-schema";
import { REVIEW_VERDICTS_SCHEMA_SQL } from "../src/main/junto/state/migrate-review-stamps";
import { RESOURCE_RULINGS_STATE_SCHEMA_SQL } from "../src/main/junto/work/resource-rulings-schema";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import {
  TaskRepository,
  TaskRepositoryLive,
  projectTaskFact,
  type TaskCanvasEnv,
  type TaskSubmitOutcome,
} from "../src/main/junto/work/task-repository";

let database: DatabaseSync;
let runtime: ManagedRuntime.ManagedRuntime<TaskRepository, unknown>;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(TASKS_STATE_SCHEMA_SQL);
  database.exec(RESOURCE_RULINGS_STATE_SCHEMA_SQL);
  database.exec("CREATE TABLE installation (singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL)");
  database.exec("INSERT INTO installation VALUES (1, 'mini')");
  database.exec("CREATE TABLE work_canvas_revisions (canvas_name TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT");
  database.exec(REVIEW_VERDICTS_SCHEMA_SQL);
  const client = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  // The ruling's row as the recorder writes it; its fact row needs the whole work store (tests/ruling-recorder.test.ts).
  const recorder = Layer.effect(
    RulingRecorder,
    Effect.map(SqlClient.SqlClient, (sql) =>
      RulingRecorder.of({
        record: (input) =>
          writeRuling(sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
      })),
  );
  runtime = ManagedRuntime.make(TaskRepositoryLive.pipe(Layer.provide(recorder), Layer.provide(client)));
});

afterEach(async () => {
  await runtime.dispose();
  database.close();
});

type Repo = TaskRepository["Service"];
const withRepo = <A, E>(use: (repo: Repo) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.gen(function* () {
    return yield* use(yield* TaskRepository);
  }));

const canvas = "factory";
const build = taskNodeId(asNodeId("tasks-build"));
const qa = taskNodeId(asNodeId("tasks-qa"));
const ada = seatNodeId(asNodeId("seat-ada"));
const mini = "mini" as InstallationId;
const operator: ResourceActor = { kind: "operator" };
const adaActor: ResourceActor = { kind: "seat", seatId: `seat_${"a".repeat(64)}` as never, nodeId: ada };
const everywhere: RulingContext = { inReach: () => true };
const env = (over: Partial<TaskCanvasEnv> = {}): TaskCanvasEnv => ({
  downstream: () => [],
  stampDefaultOf: () => ({ required: 0 }),
  seatReaches: () => true,
  ...over,
});

const command = (
  op: TaskCommand,
  itemId: TaskId | undefined,
  extra: { opId?: OpId; actor?: ResourceActor; after?: ReadonlyArray<OpId> } = {},
): ResourceCommand<TaskCommand> => ({
  opId: extra.opId ?? mintOpId(),
  canvasName: canvas,
  actor: extra.actor ?? operator,
  target: { kind: "task", nodeId: build, ...(itemId === undefined ? {} : { itemId }) },
  basis: null,
  after: extra.after ?? [],
  op,
});

const submit = (cmd: ResourceCommand<TaskCommand>, canvasEnv: TaskCanvasEnv = env()) =>
  withRepo((repo) => repo.submit(mini, cmd, everywhere, canvasEnv));

const applied = (outcome: TaskSubmitOutcome) => {
  if (outcome.kind !== "applied") throw new Error(`refused: ${outcome.error.message}`);
  return outcome;
};

const create = async (title: string) => {
  const taskId = mintItemId();
  const outcome = applied(await submit(command({ kind: "create", taskId, title }, undefined)));
  return { taskId, outcome };
};

describe("task repository", () => {
  it("creates numbered tasks and reads them back", async () => {
    const first = await create("one");
    const second = await create("two");
    expect(first.outcome.task.number).toBe(1);
    expect(second.outcome.task.number).toBe(2);
    expect(first.outcome.effects).toEqual([{ kind: "number-minted", number: 1 }]);
    const read = Option.getOrThrow(await withRepo((repo) => repo.get(canvas, first.taskId)));
    const { id: _id, number: _number, title: _title, dependsOn: _deps, ...current } = first.outcome.task;
    expect(read).toMatchObject({ taskId: first.taskId, number: 1, title: "one", dependsOn: [], layers: [], current });
    expect(read.createdAt).toBe(read.updatedAt);
    const listed = await withRepo((repo) => repo.list(canvas, { nodeIds: [build], limit: 10 }));
    expect(listed.tasks.map((task) => task.title).sort()).toEqual(["one", "two"]);
  });

  it("answers a retried command with its first ruling and owes no mail again", async () => {
    const { taskId } = await create("one");
    const opId = mintOpId();
    const first = applied(await submit(command({ kind: "assign", seat: ada }, taskId, { opId })));
    expect(first.effects).toEqual([{ kind: "assignment-notice", seat: ada }]);
    const again = applied(await submit(command({ kind: "assign", seat: ada }, taskId, { opId })));
    expect(again).toMatchObject({ replay: true, effects: [] });
    expect(again.task.assignee).toBe(ada);
  });

  it("holds one open task per seat across the canvas", async () => {
    const one = await create("one");
    const two = await create("two");
    applied(await submit(command({ kind: "assign", seat: ada }, one.taskId)));
    const refused = await submit(command({ kind: "assign", seat: ada }, two.taskId));
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") expect(refused.error.details).toMatchObject({ reason: "already_held" });
  });

  it("refuses a command built on a refused one", async () => {
    const { taskId } = await create("one");
    const bad = mintOpId();
    expect((await submit(command({ kind: "start" }, taskId, { opId: bad }))).kind).toBe("refused");
    const after = await submit(command({ kind: "cancel" }, taskId, { after: [bad] }));
    expect(after.kind === "refused" && after.error.details?.reason).toBe("depends_on_refused");
  });

  it("keeps the closed layer when a task is sent on", async () => {
    const { taskId } = await create("one");
    const flows = env({ downstream: (node) => (node === build ? [qa] : []) });
    for (const op of [{ kind: "assign", seat: ada }, { kind: "start" }, { kind: "finish" }] as const) {
      const actor = op.kind === "assign" ? operator : adaActor;
      applied(await submit(command(op, taskId, { actor }), flows));
    }
    const view = Option.getOrThrow(await withRepo((repo) => repo.get(canvas, taskId)));
    expect(view.current).toMatchObject({ state: "backlog", node: qa });
    expect(view.current.assignee).toBeUndefined();
    expect(view.layers).toEqual([
      {
        state: "done",
        node: build,
        assignee: ada,
        epoch: 0,
        stampPolicy: { required: 0 },
        reviewers: [],
        stamps: [],
        closedAt: expect.any(Number),
      },
    ]);
  });

  it("fails a write rather than rule around a row that does not decode", async () => {
    const { taskId } = await create("one");
    database.prepare("UPDATE task_heads SET reviewers_json = '{\"not\":\"a list\"}' WHERE task_id = ?").run(taskId);
    await expect(submit(command({ kind: "create", taskId: mintItemId(), title: "two" }, undefined))).rejects.toThrow(
      /does not decode/,
    );
  });

  it("fails a replay whose applied task no longer reads", async () => {
    const { taskId } = await create("one");
    const opId = mintOpId();
    applied(await submit(command({ kind: "cancel" }, taskId, { opId })));
    database.prepare("UPDATE task_heads SET depends_on_json = '1' WHERE task_id = ?").run(taskId);
    await expect(submit(command({ kind: "cancel" }, taskId, { opId }))).rejects.toThrow(/does not decode/);
  });

  it("keeps stamps as verdict rows keyed by the reviewer's node, and folds them once", async () => {
    const { taskId } = await create("one");
    const adaCommand = (op: TaskCommand) => command(op, taskId, { actor: adaActor });
    applied(await submit(command({ kind: "stamp-policy", required: 1 }, taskId)));
    applied(await submit(command({ kind: "assign", seat: ada }, taskId)));
    applied(await submit(adaCommand({ kind: "start" })));
    applied(await submit(adaCommand({ kind: "finish" })));
    const stamped = applied(await submit(command({ kind: "stamp", verdict: "approve", text: "ship it" }, taskId)));
    expect(stamped.task.state).toBe("done");

    const rows = database.prepare(
      "SELECT kind, reviewer_kind, reviewer_seat_id, reviewer_node_id, author_seat_id, subject_task_item, findings_json FROM work_review_verdicts",
    ).all();
    expect(rows).toEqual([{
      kind: "green",
      reviewer_kind: "operator",
      reviewer_seat_id: null,
      reviewer_node_id: null,
      author_seat_id: null,
      subject_task_item: taskId,
      findings_json: JSON.stringify(["ship it"]),
    }]);
    const view = await withRepo((repo) => repo.get(canvas, taskId));
    expect(Option.getOrThrow(view).current.stamps).toEqual([stamped.task.stamps[0]]);
    expect(stamped.task.stamps[0]).toMatchObject({ reviewer: { kind: "operator" }, verdict: "approve", text: "ship it" });
    expect(stamped.task.stamps[0]).not.toHaveProperty("subjectHash");

    // A replica folding the same ruling again writes nothing new.
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* projectTaskFact(sql, canvas, { kind: "task", task: stamped.task, effects: [] }, Date.now());
    }).pipe(Effect.provide(Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer)))));
    expect(database.prepare("SELECT count(*) AS n FROM work_review_verdicts").get()).toEqual({ n: 1 });
  });

  it("lists by state, archived left out by default", async () => {
    const { taskId } = await create("one");
    applied(await submit(command({ kind: "cancel" }, taskId)));
    applied(await submit(command({ kind: "archive" }, taskId)));
    expect((await withRepo((repo) => repo.list(canvas, { nodeIds: [build], limit: 10 }))).tasks).toEqual([]);
    const archived = await withRepo((repo) => repo.list(canvas, { nodeIds: [build], states: ["archived"], limit: 10 }));
    expect(archived.tasks.map((task) => task.taskId)).toEqual([taskId]);
  });
});
