/**
 * A thread on a task is listed as the task (`#7 fix tabs`). The name is read
 * once per task version and held, so a mail change costs no task read; a task
 * write announces itself and the name is read again.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model/base";
import type { TaskRecord } from "../src/shared/task-machine";
import { taskNodeId, taskNumber, type TaskId } from "../src/shared/task-model";
import { ItemId } from "../src/shared/work-ids";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { ModelService } from "../src/core/model/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { makeContentServiceLive } from "../src/core/content/service";
import { RulingRecorderLive } from "../src/core/work/ruling-recorder";
import { TaskRepositoryLive, projectTaskFact } from "../src/core/work/task-repository";
import { noteResourceChanged } from "../src/core/work/resource-changes";
import { subjectNamesAt } from "../src/core/work/subject-people";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { taskBoard } from "./support/model-nodes";
import { nameThisMachine } from "./support/name-this-machine";

const CANVAS = "names";
const BOARD = "board";
const TASK = ItemId.make("01M5F000000000000000000001") as TaskId;
const SUBJECT = { kind: "task", nodeId: asNodeId(BOARD), taskId: TASK } as const;
const KEY = `task:${BOARD}:${TASK}`;

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const tasksLive = Layer.provide(TaskRepositoryLive, RulingRecorderLive);
  return ManagedRuntime.make(Layer.provideMerge(Layer.mergeAll(ModelStoresLive, tasksLive), repositoriesLive));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-subject-names-"));
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(seedCanvas(CANVAS, [taskBoard(BOARD, { x: 0, y: 0, width: 200, height: 120 })], []));
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

/** A task on the board, folded into the store as a ruling would: the whole task, at the state it is in. */
const seedTask = (over: Pick<TaskRecord, "state" | "title">) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      projectTaskFact(
        sql,
        CANVAS,
        {
          kind: "task",
          task: {
            id: TASK,
            number: taskNumber(7),
            node: taskNodeId(asNodeId(BOARD)),
            epoch: 1,
            stampPolicy: { required: 0 },
            reviewers: [],
            stamps: [],
            dependsOn: [],
            ...over,
          } as TaskRecord,
          effects: [],
        },
        Date.now(),
      ),
    ),
  );

/** The name a task thread is listed under, as a thread read asks for it. */
const nameOfTask = () =>
  runtime.runPromise(
    Effect.flatMap(ModelService, (model) =>
      Effect.flatMap(model.canvas(CANVAS), (board) => Effect.map(subjectNamesAt(board, CANVAS, [[KEY, SUBJECT]]), (names) => names.get(KEY))),
    ),
  );

describe("subject names", () => {
  it("names a task thread as the task, and reads the name again once the task has moved", async () => {
    await seedTask({ state: "backlog", title: "fix tabs" });
    expect(await nameOfTask()).toBe("#7 fix tabs");

    // A task write: the store projects it and announces it, as every ruled command does.
    await seedTask({ state: "backlog", title: "fix tabs, again" });
    noteResourceChanged("task", CANVAS);
    expect(await nameOfTask()).toBe("#7 fix tabs, again");
  });

  it("leaves a subject with no task row unnamed, so its label stands in", async () => {
    expect(await nameOfTask()).toBeUndefined();
  });
});
