/**
 * The task and artifact ports on a machine that does not edit the canvas,
 * over the ruled state held here (plan 02 audit item 4): a write already
 * wrong for good is refused at once with the domain's refusal and is not
 * queued, and the check writes nothing; a write the editing machine might
 * rule otherwise is queued as before.
 */
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Reactivity } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactOp } from "../src/shared/artifact";
import type { OpState, QueuedCommand } from "../src/shared/command-row";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId, mintOpId, type OpId, type ResourceActor, type ResourceCommand, type RulingContext } from "../src/shared/resource-command";
import { seatNodeId, taskNodeId, type TaskCommand, type TaskId } from "../src/shared/task-model";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { TASKS_STATE_SCHEMA_SQL } from "../src/main/junto/work/task-state-schema";
import { REVIEW_VERDICTS_SCHEMA_SQL } from "../src/main/junto/state/migrate-review-stamps";
import { RESOURCE_RULINGS_STATE_SCHEMA_SQL } from "../src/main/junto/work/resource-rulings-schema";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { liveArtifactPorts, writeResult } from "../src/main/junto/work/artifact-control";
import { OpRepository } from "../src/main/junto/work/op-repository";
import { WorkRepository } from "../src/main/junto/work/repository";
import { ResourceSubmit } from "../src/main/junto/work/resource-submit";
import { liveTaskPorts, writeResultOf } from "../src/main/junto/work/task-control";
import { TaskRepository, TaskRepositoryLive, type TaskCanvasEnv } from "../src/main/junto/work/task-repository";

let database: DatabaseSync;
let runtime: ManagedRuntime.ManagedRuntime<TaskRepository, unknown>;
let recordedRulings = 0;

beforeEach(() => {
  recordedRulings = 0;
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(TASKS_STATE_SCHEMA_SQL);
  database.exec(RESOURCE_RULINGS_STATE_SCHEMA_SQL);
  database.exec("CREATE TABLE installation (singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL)");
  database.exec("INSERT INTO installation VALUES (1, 'laptop')");
  database.exec("CREATE TABLE work_canvas_revisions (canvas_name TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT");
  database.exec(REVIEW_VERDICTS_SCHEMA_SQL);
  const client = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const recorder = Layer.effect(
    RulingRecorder,
    Effect.map(SqlClient.SqlClient, (sql) =>
      RulingRecorder.of({
        record: (input) => {
          recordedRulings += 1;
          return writeRuling(sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(Effect.asVoid, Effect.orDie);
        },
      })),
  );
  runtime = ManagedRuntime.make(TaskRepositoryLive.pipe(Layer.provide(recorder), Layer.provide(client)));
});

afterEach(async () => {
  await runtime.dispose();
  database.close();
});

const canvas = "factory";
const build = taskNodeId(asNodeId("tasks-build"));
const ada = seatNodeId(asNodeId("seat-ada"));
const editor = "mini" as InstallationId;
const laptop = "laptop" as InstallationId;
const operator: ResourceActor = { kind: "operator" };
const adaActor: ResourceActor = { kind: "seat", seatId: `seat_${"a".repeat(64)}` as never, nodeId: ada };
const everywhere: RulingContext = { inReach: () => true };
const env: TaskCanvasEnv = {
  downstream: () => [],
  stampDefaultOf: () => ({ required: 0 }),
  rulesUnmet: () => undefined,
  checksUnmet: () => undefined,
  seatReaches: () => true,
};

const command = (op: TaskCommand, itemId: TaskId, extra: { actor?: ResourceActor; after?: ReadonlyArray<OpId> } = {}): ResourceCommand<TaskCommand> => ({
  opId: mintOpId(),
  canvasName: canvas,
  actor: extra.actor ?? operator,
  target: { kind: "task", nodeId: build, itemId },
  basis: null,
  after: extra.after ?? [],
  op,
});

/** The ruled state this machine holds: rulings the editing machine made, folded here. */
const ruleHere = (op: TaskCommand, itemId: TaskId) =>
  runtime.runPromise(Effect.flatMap(TaskRepository, (repo) => repo.submit(editor, command(op, itemId), everywhere, env)));

const rows = (table: string) => (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/**
 * What became of each of this writer's commands, as the work store's ruling
 * rows say on a machine that does not edit the canvas; `resource_rulings`
 * holds none of them there. Unlisted: unknown.
 */
const workOf = (states: ReadonlyMap<OpId, OpState>) =>
  ({ commandState: (_canvas: string, writer: InstallationId, opId: OpId) => Effect.succeed(writer === laptop ? states.get(opId) ?? { kind: "unknown" } : { kind: "unknown" }) }) as never;

/** Write through the live port on a machine that does not edit the canvas, with `queue` as this machine's unruled queue. */
const write = async (
  written: ResourceCommand<TaskCommand>,
  queue: ReadonlyArray<ResourceCommand<TaskCommand>> = [],
  states: ReadonlyMap<OpId, OpState> = new Map(),
) => {
  const sent: Array<OpId> = [];
  const repo = await runtime.runPromise(TaskRepository);
  const exit = await Effect.runPromiseExit(
    liveTaskPorts.submit(written, everywhere, env).pipe(
      Effect.flatMap((outcome) => writeResultOf(outcome, written)),
      Effect.provideService(ResourceSubmit, ResourceSubmit.of({
        route: () => Effect.succeed({ kind: "editor", editor }),
        queue: (command) => Effect.sync(() => (sent.push(command.opId), { kind: "queued" as const })),
      })),
      Effect.provideService(OpRepository, OpRepository.of({
        show: () => Effect.die("not read"),
        list: () => Effect.die("not read"),
        unruled: () => Effect.succeed({ writer: laptop, commands: queue as ReadonlyArray<QueuedCommand> }),
      })),
      Effect.provideService(TaskRepository, repo),
      Effect.provideService(WorkRepository, workOf(states)),
    ),
  );
  return { exit, sent };
};

describe("a task write on a machine that does not edit the canvas", () => {
  it("is refused at once, unqueued, when the task held here is archived, and the check writes nothing", async () => {
    const taskId = mintItemId();
    await ruleHere({ kind: "create", taskId, title: "one" }, taskId);
    await ruleHere({ kind: "cancel" }, taskId);
    await ruleHere({ kind: "archive" }, taskId);
    const before = { rulings: rows("resource_rulings"), heads: rows("task_heads"), recorded: recordedRulings };
    const start = command({ kind: "assign", seat: ada }, taskId);
    const { exit, sent } = await write(start);
    expect(sent).toEqual([]);
    expect(exit._tag).toBe("Failure");
    const failure = JSON.stringify(exit);
    expect(failure).toContain("invalid_transition");
    expect(failure).toContain("This task is archived");
    expect(failure).toContain(start.opId);
    expect({ rulings: rows("resource_rulings"), heads: rows("task_heads"), recorded: recordedRulings }).toEqual(before);
  });

  it("refuses at once a write on the item of a queued write it refuses for good, with the after the queue gives it", async () => {
    const taskId = mintItemId();
    await ruleHere({ kind: "create", taskId, title: "one" }, taskId);
    await ruleHere({ kind: "cancel" }, taskId);
    const bad = command({ kind: "cancel" }, taskId);
    // No after from the caller: the queue builds it on the unruled write on the same item.
    const next = command({ kind: "edit", title: "renamed" }, taskId);
    const { exit, sent } = await write(next, [bad]);
    expect(sent).toEqual([]);
    expect(JSON.stringify(exit)).toContain("depends_on_refused");
    expect(JSON.stringify(exit)).toContain(bad.opId);
  });

  it("refuses at once a write built on a refusal held as a ruling row of the work store", async () => {
    const taskId = mintItemId();
    await ruleHere({ kind: "create", taskId, title: "one" }, taskId);
    const root = mintOpId();
    const refusedRow: OpState = {
      kind: "refused",
      ruling: { operation: "ruling.refused", writer: laptop, opId: root, actor: adaActor, reason: "invalid_transition", root } as never,
      error: { type: "InvalidTransition", message: "no", details: { reason: "invalid_transition" } },
    };
    const next = command({ kind: "edit", title: "renamed" }, taskId, { after: [root] });
    const { exit, sent } = await write(next, [], new Map([[root, refusedRow]]));
    expect(sent).toEqual([]);
    expect(JSON.stringify(exit)).toContain("depends_on_refused");
  });

  it("leaves a resend to the queue once a peer's ruling of it is folded here, though today's state would refuse it", async () => {
    const taskId = mintItemId();
    // The editing machine applied this create; its ruling row came back, and the task is held here.
    const create = command({ kind: "create", taskId, title: "one" }, taskId);
    await ruleHere({ kind: "create", taskId, title: "one" }, taskId);
    const appliedRow: OpState = { kind: "applied", ruling: { operation: "ruling.applied", writer: laptop, opId: create.opId } as never };
    const { sent } = await write(create, [], new Map([[create.opId, appliedRow]]));
    expect(sent).toEqual([create.opId]);
  });

  it("is queued when the editing machine might rule it otherwise", async () => {
    const taskId = mintItemId();
    await ruleHere({ kind: "create", taskId, title: "one" }, taskId);
    // Not assigned here, yet the editing machine may have assigned it to ada since.
    const start = command({ kind: "start" }, taskId, { actor: adaActor });
    const { exit, sent } = await write(start);
    expect(sent).toEqual([start.opId]);
    expect(exit).toMatchObject({ _tag: "Success", value: { disposition: "queued", opId: start.opId } });
  });

  it("is queued for a task not held here", async () => {
    const start = command({ kind: "start" }, mintItemId(), { actor: adaActor });
    const { sent } = await write(start);
    expect(sent).toEqual([start.opId]);
  });
});

describe("an artifact write on a machine that does not edit the canvas", () => {
  const item = mintItemId();
  const retitle = () => ({ ...command({ kind: "start" }, item), target: { kind: "artifact" as const, nodeId: asNodeId("docs"), itemId: item }, op: { op: "retitle", title: "x" } }) as never as ResourceCommand<ArtifactOp>;
  const created = retitle();
  const earlier = retitle();
  const run = (precheck: ArtifactRepository["Service"]["precheck"]) => {
    const sent: Array<OpId> = [];
    const seen: Array<ReadonlyArray<OpId>> = [];
    const after: Array<ReadonlyArray<OpId>> = [];
    return Effect.runPromiseExit(
      liveArtifactPorts.submit(created, everywhere).pipe(
        Effect.flatMap((outcome) => writeResult(outcome, created)),
        Effect.provideService(ResourceSubmit, ResourceSubmit.of({
          route: () => Effect.succeed({ kind: "editor", editor }),
          queue: (command) => Effect.sync(() => (sent.push(command.opId), { kind: "queued" as const })),
        })),
        Effect.provideService(OpRepository, OpRepository.of({
          show: () => Effect.die("not read"),
          list: () => Effect.die("not read"),
          unruled: () => Effect.succeed({ writer: laptop, commands: [earlier as never, command({ kind: "start" }, item) as never] }),
        })),
        Effect.provideService(WorkRepository, workOf(new Map())),
        Effect.provideService(ArtifactRepository, {
          precheck: (writer, queued, command, ...rest) => (
            seen.push([writer as never, ...queued.map(({ opId }) => opId)]), after.push(command.after), precheck(writer, queued, command, ...rest)
          ),
        } as ArtifactRepository["Service"]),
      ),
    ).then((exit) => ({ exit, sent, seen, after }));
  };

  it("is refused at once by the store's precheck over this writer's artifact commands, after the queue's after, and not queued", async () => {
    const error = { type: "InputError", message: "exists", details: { reason: "invalid_input" } } as const;
    const { exit, sent, seen, after } = await run(() => Effect.succeed(Option.some({ kind: "refused", opId: created.opId, error, root: created.opId })));
    expect(sent).toEqual([]);
    expect(seen).toEqual([[laptop, earlier.opId]]);
    expect(after).toEqual([[earlier.opId]]);
    expect(JSON.stringify(exit)).toContain("invalid_input");
  });

  it("is queued when the precheck refuses nothing", async () => {
    const { exit, sent } = await run(() => Effect.succeed(Option.none()));
    expect(sent).toEqual([created.opId]);
    expect(exit).toMatchObject({ _tag: "Success", value: { disposition: "queued" } });
  });
});
