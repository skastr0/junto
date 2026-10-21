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
import {
  TaskRepository,
  TaskRepositoryLive,
  type TaskCanvasEnv,
  type TaskSubmitOutcome,
} from "../src/main/junto/work/task-repository";

let database: DatabaseSync;
let runtime: ManagedRuntime.ManagedRuntime<TaskRepository, unknown>;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(TASKS_STATE_SCHEMA_SQL);
  // The shared ruling store (02); its schema lands with cli-identity's step.
  database.exec(`CREATE TABLE resource_rulings (
    canvas_name TEXT NOT NULL, writer TEXT NOT NULL, op_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('applied', 'refused')), ruling_json TEXT NOT NULL CHECK (json_valid(ruling_json)),
    PRIMARY KEY (canvas_name, writer, op_id)
  ) STRICT, WITHOUT ROWID`);
  const client = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  runtime = ManagedRuntime.make(TaskRepositoryLive.pipe(Layer.provide(client)));
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

  it("lists by state, archived left out by default", async () => {
    const { taskId } = await create("one");
    applied(await submit(command({ kind: "cancel" }, taskId)));
    applied(await submit(command({ kind: "archive" }, taskId)));
    expect((await withRepo((repo) => repo.list(canvas, { nodeIds: [build], limit: 10 }))).tasks).toEqual([]);
    const archived = await withRepo((repo) => repo.list(canvas, { nodeIds: [build], states: ["archived"], limit: 10 }));
    expect(archived.tasks.map((task) => task.taskId)).toEqual([taskId]);
  });
});
