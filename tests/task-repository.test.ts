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
import type { RecordRulingInput } from "../src/main/junto/work/repository";
import { rulingRowOf } from "../src/shared/command-row";
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
/** Every ruling the repository handed the recorder. */
const recorded: Array<RecordRulingInput> = [];

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
        record: (input) => {
          recorded.push(input);
          return writeRuling(sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(
            Effect.asVoid,
            Effect.orDie,
          );
        },
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
  rulesUnmet: () => undefined,
  checksUnmet: () => undefined,
  derivesTo: () => [],
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

  it("lists a page at a time without bodies, filtered by assignee, and walks on from a page's last task", async () => {
    const [one, two, three] = [await create("one"), await create("two"), await create("three")];
    applied(await submit(command({ kind: "edit", body: "a long body" }, two.taskId)));
    applied(await submit(command({ kind: "assign", seat: ada }, three.taskId)));
    const first = await withRepo((repo) => repo.list(canvas, { nodeIds: [build], limit: 2, brief: true }));
    expect(first.more).toBe(true);
    expect(first.tasks.every((task) => task.body === undefined)).toBe(true);
    const last = first.tasks.at(-1)!;
    const rest = await withRepo((repo) =>
      repo.list(canvas, { nodeIds: [build], limit: 2, brief: true, after: { updatedAt: last.updatedAt, taskId: last.taskId } }));
    expect(rest.more).toBe(false);
    expect([...first.tasks, ...rest.tasks].map((task) => task.taskId).sort()).toEqual([one.taskId, two.taskId, three.taskId].sort());
    expect((await withRepo((repo) => repo.get(canvas, two.taskId))).pipe(Option.map((task) => task.body))).toEqual(Option.some("a long body"));
    const held = await withRepo((repo) => repo.list(canvas, { nodeIds: [build], assignee: ada, limit: 10 }));
    expect(held.tasks.map((task) => task.taskId)).toEqual([three.taskId]);
  });

  it("reads only what since shows a seat, and counts the changes its limit cut", async () => {
    const bob = seatNodeId(asNodeId("seat-bob"));
    const bobActor: ResourceActor = { kind: "seat", seatId: `seat_${"b".repeat(64)}` as never, nodeId: bob };
    const flows = env({ downstream: (node) => (node === build ? [qa] : []) });
    const run = async (taskId: TaskId, ops: ReadonlyArray<readonly [TaskCommand, ResourceActor]>, canvasEnv = env()) => {
      for (const [op, actor] of ops) applied(await submit(command(op, taskId, { actor }), canvasEnv));
    };
    const work = (seat: typeof ada, actor: ResourceActor) =>
      [[{ kind: "assign", seat }, operator], [{ kind: "start" }, actor], [{ kind: "finish" }, actor]] as const;
    const open = await create("open");
    await run(open.taskId, [[{ kind: "assign", seat: ada }, operator]]);
    const done = [await create("done one"), await create("done two")];
    for (const { taskId } of done) await run(taskId, work(ada, adaActor));
    const sentOn = await create("sent on");
    await run(sentOn.taskId, work(ada, adaActor), flows);
    const review = await create("review");
    await run(review.taskId, [
      [{ kind: "stamp-policy", required: 1 }, operator],
      [{ kind: "reviewer-add", reviewer: { kind: "seat", seat: ada } }, operator],
      ...work(bob, bobActor),
    ]);
    await create("someone else's");
    const read = (query: { readonly since?: number; readonly limit: number }) =>
      withRepo((repo) => repo.seatTasks(canvas, { nodeIds: [build, qa], seat: ada, ...query }));

    const all = await read({ limit: Number.POSITIVE_INFINITY });
    expect(all.tasks.map((task) => task.title).sort()).toEqual(["done one", "done two", "open", "review", "sent on"]);
    expect(all.leftOut).toBe(0);
    expect(all.tasks.every((task) => task.body === undefined)).toBe(true);
    expect(all.tasks.find((task) => task.title === "sent on")?.layers).toHaveLength(1);

    // One of the two done tasks, the newer change (two can share a millisecond; the id breaks it).
    const capped = await read({ limit: 1 });
    expect(capped.tasks.filter((task) => task.title.startsWith("done"))).toHaveLength(1);
    expect(capped.tasks.map((task) => task.title).filter((title) => !title.startsWith("done")).sort()).toEqual(["open", "review", "sent on"]);
    expect(capped.leftOut).toBe(1);

    const later = await read({ since: Date.now() + 60_000, limit: 1 });
    expect(later.tasks.map((task) => task.title).sort()).toEqual(["open", "review"]);
    expect(later.leftOut).toBe(0);
  });

  it("reads a seat's open tasks newest change first, so since's cap keeps the newest", async () => {
    const open = [await create("first"), await create("second"), await create("third")];
    for (const { taskId } of open) applied(await submit(command({ kind: "assign", seat: ada }, taskId)));
    // The middle one changes last; the index alone would hand them back by id.
    applied(await submit(command({ kind: "edit", title: "second, edited" }, open[1]!.taskId)));
    const read = await withRepo((repo) => repo.seatTasks(canvas, { nodeIds: [build], seat: ada, limit: 1 }));
    // Writes can share a millisecond; the id breaks the tie, as since's order does. Id order alone never matches.
    const newestFirst = [...read.tasks].sort((a, b) => b.updatedAt - a.updatedAt || (a.taskId < b.taskId ? 1 : -1));
    expect(read.tasks).toHaveLength(3);
    expect(read.tasks.map((task) => task.taskId)).toEqual(newestFirst.map((task) => task.taskId));
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

  it("lets one seat hold many open tasks across the canvas", async () => {
    const tasks = [await create("one"), await create("two"), await create("three")];
    for (const { taskId } of tasks) expect(applied(await submit(command({ kind: "assign", seat: ada }, taskId))).task.assignee).toBe(ada);
  });

  it("records a refused transition's detail on its ruling row as a token the seat's machine words", async () => {
    const { taskId } = await create("one");
    // The seat is assigned and queues its start; the operator cancels first.
    expect((await submit(command({ kind: "assign", seat: ada }, taskId))).kind).toBe("applied");
    expect((await submit(command({ kind: "cancel" }, taskId))).kind).toBe("applied");
    const start = command({ kind: "start" }, taskId, { actor: adaActor });
    expect((await submit(start)).kind).toBe("refused");
    const input = recorded.at(-1)!;
    expect(rulingRowOf(input.writer, start, "task", input.ruling as never)).toMatchObject({ reason: "invalid_transition", expected: "from:canceled" });
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

  it("derives a new task on every derives target when one closes done, linked both ways, and nothing else of it", async () => {
    const docs = taskNodeId(asNodeId("tasks-docs"));
    const { taskId } = await create("ship the parser");
    const derives = env({
      downstream: (node) => (node === build ? [qa] : []),
      derivesTo: (node) => (node === build ? [qa, docs] : []),
      stampDefaultOf: (node) => ({ required: node === docs ? 1 : 0 }),
    });
    applied(await submit(command({ kind: "edit", body: "@ada knows why" }, taskId), derives));
    applied(await submit(command({ kind: "assign", seat: ada }, taskId), derives));
    applied(await submit(command({ kind: "start" }, taskId, { actor: adaActor }), derives));
    // Cancel or a plain write derives nothing: only a close does.
    expect((await withRepo((repo) => repo.list(canvas, { nodeIds: [qa, docs], limit: 10 }))).tasks).toEqual([]);
    const finishOp = mintOpId();
    const finished = applied(await submit(command({ kind: "finish", next: qa, handoff: "parser is in" }, taskId, { actor: adaActor, opId: finishOp }), derives));
    // The ruled task is still the one the outcome names, and it flowed on as before.
    expect(finished.task).toMatchObject({ id: taskId, node: qa, state: "backlog" });
    expect(finished.effects.filter((effect) => effect.kind === "number-minted")).toHaveLength(2);

    const derived = (await withRepo((repo) => repo.list(canvas, { nodeIds: [qa, docs], limit: 10 }))).tasks
      .filter((task) => task.taskId !== taskId)
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    expect(derived.map((task) => [task.number, task.current.node, task.current.state, task.title])).toEqual([
      [2, qa, "backlog", "ship the parser"],
      [3, docs, "backlog", "ship the parser"],
    ]);
    for (const task of derived) {
      expect(task.body).toBeUndefined();
      expect(task.dependsOn).toEqual([]);
      expect(task.current.assignee).toBeUndefined();
      expect(task.current.reviewers).toEqual([]);
      expect(task.current.handoff).toBeUndefined();
      expect(task.derivedFrom).toEqual({ taskId, number: 1, node: qa });
    }
    // The ruling names each derived task as the new task it is, so change triggers fire on its board.
    const row = database.prepare("SELECT ruling_json FROM resource_rulings WHERE op_id = ?").get(finishOp) as { ruling_json: string };
    expect(JSON.parse(row.ruling_json)).toMatchObject({
      taskId,
      node: qa,
      became: "backlog",
      derived: derived.map((task) => ({ taskId: task.taskId, node: task.current.node, became: "backlog" })),
    });
    expect(derived[1]!.current.stampPolicy).toEqual({ required: 1 });

    const origin = Option.getOrThrow(await withRepo((repo) => repo.get(canvas, taskId)));
    expect(origin.derived).toEqual(derived.map((task) => ({ taskId: task.taskId, number: task.number, node: task.current.node })));
    expect(origin.derivedFrom).toBeUndefined();
    // The next task created takes the next number after the derived ones.
    expect((await create("after")).outcome.task.number).toBe(4);
  });

  it("derives nothing when a task is canceled", async () => {
    const { taskId } = await create("one");
    const derives = env({ derivesTo: (node) => (node === build ? [qa] : []) });
    applied(await submit(command({ kind: "cancel" }, taskId), derives));
    expect((await withRepo((repo) => repo.list(canvas, { nodeIds: [qa], limit: 10 }))).tasks).toEqual([]);
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

  it("keeps each defect as the changes stamp that filed it, listed with its epoch after the task moves on", async () => {
    const { taskId } = await create("one");
    const adaCommand = (op: TaskCommand) => command(op, taskId, { actor: adaActor });
    applied(await submit(command({ kind: "stamp-policy", required: 1 }, taskId)));
    applied(await submit(command({ kind: "assign", seat: ada }, taskId)));
    applied(await submit(adaCommand({ kind: "start" })));
    applied(await submit(adaCommand({ kind: "finish" })));
    const asked = applied(await submit(command({ kind: "stamp", verdict: "changes", text: "add a test" }, taskId)));
    expect(asked.effects).toEqual([{ kind: "defect", epoch: 1, by: { kind: "operator" }, text: "add a test" }]);
    applied(await submit(adaCommand({ kind: "finish" })));
    applied(await submit(command({ kind: "stamp", verdict: "approve" }, taskId)));

    const view = Option.getOrThrow(await withRepo((repo) => repo.get(canvas, taskId)));
    expect(view.current).toMatchObject({ state: "done", epoch: 1 });
    // The defect that opened epoch 1 is the changes stamp at epoch 0: same reviewer, same text.
    expect(view.current.stamps.map(({ verdict, epoch, text }) => ({ verdict, epoch, text }))).toEqual([
      { verdict: "changes", epoch: 0, text: "add a test" },
      { verdict: "approve", epoch: 1, text: undefined },
    ]);
  });

  it("shows a task back on a node it passed none of that node's old stamps", async () => {
    const { taskId } = await create("one");
    const there = env({ downstream: (node) => (node === build ? [qa] : [build]), stampDefaultOf: () => ({ required: 1 }) });
    const at = (node: typeof build, op: TaskCommand, actor: ResourceActor = operator) =>
      submit({ ...command(op, taskId, { actor }), target: { kind: "task", nodeId: node, itemId: taskId } }, there);
    applied(await at(build, { kind: "stamp-policy", required: 1 }));
    applied(await at(build, { kind: "assign", seat: ada }));
    applied(await at(build, { kind: "start" }, adaActor));
    applied(await at(build, { kind: "finish" }, adaActor));
    expect(applied(await at(build, { kind: "stamp", verdict: "approve" })).task).toMatchObject({ node: qa, epoch: 1 });
    applied(await at(qa, { kind: "assign", seat: ada }));
    applied(await at(qa, { kind: "start" }, adaActor));
    applied(await at(qa, { kind: "finish" }, adaActor));
    const back = applied(await at(qa, { kind: "stamp", verdict: "approve" })).task;
    expect(back).toMatchObject({ node: build, epoch: 2, state: "backlog", stamps: [] });
    expect(Option.getOrThrow(await withRepo((repo) => repo.get(canvas, taskId))).current.stamps).toEqual([]);
  });

  it("fails the write when a stamp row breaks a CHECK, rather than drop the stamp", async () => {
    const { taskId } = await create("one");
    applied(await submit(command({ kind: "stamp-policy", required: 1 }, taskId)));
    applied(await submit(command({ kind: "assign", seat: ada }, taskId)));
    applied(await submit(command({ kind: "start" }, taskId, { actor: adaActor })));
    applied(await submit(command({ kind: "finish" }, taskId, { actor: adaActor })));
    database.exec("DELETE FROM installation");
    await expect(submit(command({ kind: "stamp", verdict: "approve" }, taskId))).rejects.toThrow(/NOT NULL|CHECK/);
    expect(Option.getOrThrow(await withRepo((repo) => repo.get(canvas, taskId))).current.state).toBe("in-review");
  });

  it("keeps when the state began across writes that leave it, and moves it when the state changes", async () => {
    const { taskId } = await create("one");
    const since = async () => Option.getOrThrow(await withRepo((repo) => repo.get(canvas, taskId))).stateSince;
    const created = await since();
    database.prepare("UPDATE task_heads SET created_at = 0, state_since = 0 WHERE task_id = ?").run(taskId);
    applied(await submit(command({ kind: "edit", title: "renamed" }, taskId)));
    expect(await since()).toBe(0);
    applied(await submit(command({ kind: "assign", seat: ada }, taskId)));
    expect(await since()).toBeGreaterThanOrEqual(created);
  });

  it("keeps the check runs on the head and reads them back", async () => {
    const { taskId } = await create("checked");
    applied(await submit(command({ kind: "assign", seat: ada }, taskId)));
    applied(await submit(command({ kind: "start" }, taskId, { actor: adaActor })));
    const run = { checkId: "unit", side: "outgoing" as const, command: "bun test", exitCode: 0, outputTail: "ok" };
    applied(await submit(command({ kind: "check", results: [run] }, taskId, { actor: adaActor })));
    const read = Option.getOrThrow(await withRepo((repo) => repo.get(canvas, taskId)));
    expect(read.current.checks).toEqual([{ ...run, epoch: 0, at: expect.any(Number) }]);
  });

  it("lists by state, archived left out by default", async () => {
    const { taskId } = await create("one");
    applied(await submit(command({ kind: "cancel" }, taskId)));
    applied(await submit(command({ kind: "archive" }, taskId)));
    expect((await withRepo((repo) => repo.list(canvas, { nodeIds: [build], limit: 10 }))).tasks).toEqual([]);
    const archived = await withRepo((repo) => repo.list(canvas, { nodeIds: [build], states: ["archived"], limit: 10 }));
    expect(archived.tasks.map((task) => task.taskId)).toEqual([taskId]);
    expect(archived.tasks[0]!.current.archivedFrom).toBe("canceled");
  });

  it("keeps a finish's evidence and handoff note on the head, and on the layer it closes", async () => {
    const { taskId } = await create("noted");
    applied(await submit(command({ kind: "assign", seat: ada }, taskId)));
    applied(await submit(command({ kind: "start" }, taskId, { actor: adaActor })));
    const evidence = { artifacts: [], git: { commits: ["2e219a5ca"] } };
    const flowing = env({ downstream: () => [qa] });
    applied(await submit(command({ kind: "finish", evidence, handoff: "over to qa" }, taskId, { actor: adaActor }), flowing));
    const read = Option.getOrThrow(await withRepo((repo) => repo.get(canvas, taskId)));
    expect(read.current.evidence).toBeUndefined();
    expect(read.layers).toHaveLength(1);
    expect(read.layers[0]).toMatchObject({ state: "done", evidence, handoff: "over to qa" });
  });

  it("refuses a finish while a dependency is unfinished, and admits it once that is done", async () => {
    const bo = seatNodeId(asNodeId("seat-bo"));
    const boActor: ResourceActor = { kind: "seat", seatId: `seat_${"b".repeat(64)}` as never, nodeId: bo };
    const { taskId: dep } = await create("upstream");
    const { taskId } = await create("downstream");
    applied(await submit(command({ kind: "depend", on: dep }, taskId)));
    applied(await submit(command({ kind: "assign", seat: ada }, taskId)));
    applied(await submit(command({ kind: "start" }, taskId, { actor: adaActor })));
    const outcome = await submit(command({ kind: "finish" }, taskId, { actor: adaActor }));
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" ? outcome.error.message : "").toBe(
      "This task depends on work not done yet: #1 is in the backlog. Finish it once each is done, or remove the dependency",
    );
    applied(await submit(command({ kind: "assign", seat: bo }, dep)));
    applied(await submit(command({ kind: "start" }, dep, { actor: boActor })));
    applied(await submit(command({ kind: "finish" }, dep, { actor: boActor })));
    applied(await submit(command({ kind: "archive" }, dep)));
    expect(Option.getOrThrow(await withRepo((repo) => repo.get(canvas, dep))).current.archivedFrom).toBe("done");
    const done = applied(await submit(command({ kind: "finish", handoff: "both landed" }, taskId, { actor: adaActor })));
    expect(done.task.state).toBe("done");
    expect(Option.getOrThrow(await withRepo((repo) => repo.get(canvas, taskId))).current.handoff).toBe("both landed");
  });
});
