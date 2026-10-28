/**
 * The fold equals the ruler (docs/plans/0.11/06-fleet-state.md, "F1 and F2"):
 * fleet state's authority judges a batch, rolls it back and applies the
 * rulings at commit through `foldRuling`, and every replica already reaches
 * its tables through that fold today. So for any sequence of commands, three
 * stores must hold the same resource tables:
 *
 * - direct: the ruler writes its projection, as the editing machine does now;
 * - judged: the ruler runs inside a transaction that is rolled back, and its
 *   recorded rulings are then written and folded, as the authority will;
 * - replica: another machine folds the rulings the direct store recorded.
 *
 * A difference is a bug today as well, because replicas depend on it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { FastCheck as fc } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { submitAutomationCommand } from "../src/main/junto/automation/ruler";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { PausePlaneLive } from "../src/main/junto/pause-plane";
import { FactoryPauseRepositoryLive } from "../src/main/junto/pause/repository";
import { ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import { SeatGuidanceRepositoryLive } from "../src/main/junto/seat-guidance/repository";
import { makeSettingsLive } from "../src/main/junto/settings/service";
import { AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import type { AutomationDefinition, AutomationOp } from "../src/shared/automation";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ArtifactRepository, ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { REVIEW_VERDICTS_SCHEMA_SQL } from "../src/main/junto/state/migrate-review-stamps";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { RESOURCE_RULINGS_STATE_SCHEMA_SQL } from "../src/main/junto/work/resource-rulings-schema";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { foldRuling } from "../src/main/junto/work/ruling-projection";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { TaskRepository, TaskRepositoryLive, type TaskCanvasEnv } from "../src/main/junto/work/task-repository";
import { TASKS_STATE_SCHEMA_SQL } from "../src/main/junto/work/task-state-schema";
import { rulingRowOf, type RulingAppliedResult } from "../src/shared/command-row";
import type { RecordRulingInput } from "../src/main/junto/work/repository";
import type { ArtifactOp, ArtifactVersion } from "../src/shared/artifact";
import { artifacts, automations, seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvasRows } from "./support/seed-canvas";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import type { OpId, ResourceActor, ResourceCommand, RulingContext } from "../src/shared/resource-command";
import { seatNodeId, taskNodeId, type TaskCommand, type TaskId } from "../src/shared/task-model";

const CANVAS = "factory";
const WRITER = "mini" as InstallationId;
const START = Date.parse("2026-10-28T12:00:00.000Z");

/** One store: its own database, the ruler's runtime, and every ruling the ruler handed its recorder. */
type Store = {
  readonly database: DatabaseSync;
  readonly sql: SqlClient.SqlClient;
  readonly runtime: ManagedRuntime.ManagedRuntime<TaskRepository | SqlClient.SqlClient, unknown>;
  readonly recorded: Array<RecordRulingInput>;
};

const stores: Array<Store> = [];

const makeStore = async (installation: string): Promise<Store> => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(TASKS_STATE_SCHEMA_SQL);
  database.exec(RESOURCE_RULINGS_STATE_SCHEMA_SQL);
  database.exec("CREATE TABLE installation (singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL)");
  database.exec(`INSERT INTO installation VALUES (1, '${installation}')`);
  database.exec("CREATE TABLE work_canvas_revisions (canvas_name TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT");
  database.exec(REVIEW_VERDICTS_SCHEMA_SQL);
  const recorded: Array<RecordRulingInput> = [];
  const client = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  // The ruling's row as the recorder writes it; its exchange fact needs the whole work store and folds nothing.
  const recorder = Layer.effect(
    RulingRecorder,
    Effect.map(SqlClient.SqlClient, (sql) =>
      RulingRecorder.of({
        record: (input) =>
          writeRuling(sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(
            Effect.tap(() => Effect.sync(() => recorded.push(input))),
            Effect.asVoid,
            Effect.orDie,
          ),
      })),
  );
  const runtime = ManagedRuntime.make(Layer.provideMerge(TaskRepositoryLive.pipe(Layer.provide(recorder)), client));
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  const store = { database, sql, runtime, recorded };
  stores.push(store);
  return store;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    await store.runtime.dispose();
    store.database.close();
  }
});

/** Every table's rows, in an order that does not depend on how they were written. */
const tablesOf = (store: Store, leaveOut: ReadonlySet<string> = new Set()): Record<string, ReadonlyArray<string>> => {
  const names = store.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !leaveOut.has(name));
  return Object.fromEntries(
    names.map((name) => [name, store.database.prepare(`SELECT * FROM "${name}"`).all().map((row) => JSON.stringify(row)).sort()]),
  );
};

/** The applied ruling's row, as every machine receives it. */
const appliedRow = (input: RecordRulingInput): RulingAppliedResult | undefined => {
  const row = rulingRowOf(input.writer, input.command, input.kind, input.ruling as never);
  return row.operation === "ruling.applied" ? row : undefined;
};

class Judged {
  readonly _tag = "Judged";
}

/** Judge in a transaction that rolls back, then write the ruling and fold it at commit: the authority's path. */
const judgeThenFold = <A, E>(store: Store, submit: Effect.Effect<A, E, TaskRepository>, at: number) =>
  store.runtime.runPromise(
    Effect.gen(function* () {
      const before = store.recorded.length;
      yield* store.sql.withTransaction(Effect.flatMap(submit, () => Effect.fail(new Judged()))).pipe(
        Effect.catchIf((error): error is Judged => error instanceof Judged, () => Effect.void),
      );
      const rulings = store.recorded.splice(before);
      yield* store.sql.withTransaction(
        Effect.forEach(rulings, (input) =>
          Effect.gen(function* () {
            // The facts first, then the ruling row, as the ruler writes them: the row stands on the count they moved.
            const applied = appliedRow(input);
            if (applied !== undefined) yield* foldRuling(store.sql, input.canvasName, applied, at);
            yield* writeRuling(store.sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record });
          }),
        ),
      );
      store.recorded.push(...rulings);
    }),
  );

/** Fold what the direct store ruled, as a replica takes it. */
const foldOnReplica = (store: Store, rulings: ReadonlyArray<{ readonly input: RecordRulingInput; readonly at: number }>) =>
  store.runtime.runPromise(
    Effect.forEach(rulings, ({ input, at }) => {
      const applied = appliedRow(input);
      return applied === undefined ? Effect.void : store.sql.withTransaction(foldRuling(store.sql, input.canvasName, applied, at));
    }),
  );

// ---------------------------------------------------------------------------
// Tasks

const build = taskNodeId(asNodeId("tasks-build"));
const qa = taskNodeId(asNodeId("tasks-qa"));
const ada = seatNodeId(asNodeId("seat-ada"));
const bob = seatNodeId(asNodeId("seat-bob"));
const TASK_IDS = ["01M62AT0000000000000000001", "01M62AT0000000000000000002", "01M62AT0000000000000000003"] as unknown as ReadonlyArray<TaskId>;
const actors: ReadonlyArray<ResourceActor> = [
  { kind: "operator" },
  { kind: "seat", seatId: `seat_${"a".repeat(64)}` as never, nodeId: ada },
  { kind: "seat", seatId: `seat_${"b".repeat(64)}` as never, nodeId: bob },
];
const everywhere: RulingContext = { inReach: () => true };
const taskEnv: TaskCanvasEnv = {
  downstream: () => [qa],
  stampDefaultOf: () => ({ required: 0 }),
  rulesUnmet: () => undefined,
  checksUnmet: () => undefined,
  derivesTo: () => [],
  seatReaches: () => true,
};

const taskId = fc.constantFrom(...TASK_IDS);
const taskOp: fc.Arbitrary<{ readonly op: TaskCommand; readonly task: TaskId }> = fc.oneof(
  fc.record({ task: taskId, title: fc.constantFrom("Ship", "Fix", "Plan"), body: fc.option(fc.constantFrom("why", "how"), { nil: undefined }) }).map(
    ({ task, title, body }) => ({ task, op: { kind: "create", taskId: task, title, ...(body === undefined ? {} : { body }) } as TaskCommand }),
  ),
  fc.record({ task: taskId, title: fc.constantFrom("Ship it", "Fix it") }).map(({ task, title }) => ({ task, op: { kind: "edit", title } as TaskCommand })),
  fc.record({ task: taskId, seat: fc.constantFrom(ada, bob) }).map(({ task, seat }) => ({ task, op: { kind: "assign", seat } as TaskCommand })),
  fc.record({
    task: taskId,
    kind: fc.constantFrom("unassign", "start", "pause", "resume", "cancel", "archive"),
  }).map(({ task, kind }) => ({ task, op: { kind } as TaskCommand })),
  fc.record({ task: taskId, next: fc.option(fc.constant(qa), { nil: undefined }), handoff: fc.option(fc.constant("over to qa"), { nil: undefined }) }).map(
    ({ task, next, handoff }) => ({
      task,
      op: { kind: "finish", ...(next === undefined ? {} : { next }), ...(handoff === undefined ? {} : { handoff }) } as TaskCommand,
    }),
  ),
  fc.record({ task: taskId, on: taskId, kind: fc.constantFrom("depend", "undepend") }).map(({ task, on, kind }) => ({ task, op: { kind, on } as TaskCommand })),
  fc.record({ task: taskId, required: fc.integer({ min: 0, max: 2 }) }).map(({ task, required }) => ({ task, op: { kind: "stamp-policy", required } as TaskCommand })),
);
/** Each task lives on one node, so a command names it where it is. */
const nodeOf = (task: TaskId) => (task === TASK_IDS[2] ? qa : build);
const randomStep = fc.record({ actor: fc.constantFrom(...actors), op: taskOp }).map(
  (step): TaskStep => ({ ...step, node: nodeOf(step.op.task) }),
);
/** A task's working life, by its assignee: create, assign, start, maybe pause and resume, finish. */
const lifeOf = fc.record({ task: taskId, seat: fc.constantFrom(1, 2), paused: fc.boolean() }).map(({ task, seat, paused }): TaskStep[] => {
  const assignee = actors[seat]!;
  const at = (op: TaskCommand, actor: ResourceActor = assignee): TaskStep => ({ actor, op: { op, task }, node: nodeOf(task) });
  return [
    at({ kind: "create", taskId: task, title: "Life" } as TaskCommand, actors[0]),
    at({ kind: "assign", seat: (assignee as Extract<ResourceActor, { kind: "seat" }>).nodeId } as TaskCommand, actors[0]),
    at({ kind: "start" } as TaskCommand),
    ...(paused ? [at({ kind: "pause" } as TaskCommand), at({ kind: "resume" } as TaskCommand)] : []),
    at({ kind: "finish", handoff: "done" } as TaskCommand),
  ];
});
const taskSteps = fc.array(fc.oneof(randomStep.map((step) => [step]), lifeOf), { minLength: 1, maxLength: 12 }).map((runs) => runs.flat());

type TaskStep = { readonly actor: ResourceActor; readonly op: { readonly op: TaskCommand; readonly task: TaskId }; readonly node: typeof build };

const taskCommand = (index: number, step: TaskStep) =>
  ({
    opId: `01M62AT${String(index).padStart(19, "0")}` as OpId,
    canvasName: CANVAS,
    actor: step.actor,
    target: { kind: "task", nodeId: step.node, ...(step.op.op.kind === "create" ? {} : { itemId: step.op.task }) },
    basis: null,
    after: [],
    op: step.op.op,
  }) as ResourceCommand<TaskCommand>;

describe("the fold equals the ruler", () => {
  it("for tasks: directly, judged then folded, and on a replica", async () => {
    // Which op kinds were applied across every run: the property is not vacuous.
    const applied = new Set<string>();
    await fc.assert(
      fc.asyncProperty(taskSteps, async (steps) => {
        const direct = await makeStore(WRITER);
        const judged = await makeStore(WRITER);
        const replica = await makeStore("replica");
        const ruled: Array<{ input: RecordRulingInput; at: number }> = [];
        for (const [index, step] of steps.entries()) {
          const at = START + index * 1000;
          vi.setSystemTime(at);
          const command = taskCommand(index, step);
          const submit = Effect.flatMap(TaskRepository, (repo) => repo.submit(WRITER, command, everywhere, taskEnv));
          const before = direct.recorded.length;
          await direct.runtime.runPromise(submit);
          for (const input of direct.recorded.slice(before)) {
            ruled.push({ input, at });
            if (input.ruling.kind === "applied") applied.add(command.op.kind);
          }
          await judgeThenFold(judged, submit, at);
        }
        await foldOnReplica(replica, ruled);
        const held = tablesOf(direct);
        expect(tablesOf(judged)).toEqual(held);
        // A replica holds no ruling rows of its own here: the exchange keeps those as facts.
        const resources = new Set(["resource_rulings", "installation"]);
        expect(tablesOf(replica, resources)).toEqual(tablesOf(direct, resources));
        for (const store of stores.splice(0)) {
          await store.runtime.dispose();
          store.database.close();
        }
      }),
      { numRuns: 60, seed: 20261028 },
    );
    expect([...applied].sort()).toEqual(expect.arrayContaining(["assign", "create", "depend", "edit", "finish", "pause", "resume", "start"]));
  });
});

// ---------------------------------------------------------------------------
// Artifacts: their fold reads the work log and the content store, so each store is a whole state engine.

type EngineStore = {
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<ArtifactRepository | WorkRepository | ContentService | SqlClient.SqlClient | RulingRecorder, unknown>;
  readonly recorded: Array<RecordRulingInput>;
};
const engines: Array<EngineStore> = [];
const ARTS = asNodeId("arts");

const makeEngineStore = async (installation: string): Promise<EngineStore> => {
  const root = await mkdtemp(join(tmpdir(), `junto-fold-${installation}-`));
  const recorded: Array<RecordRulingInput> = [];
  // The ruling's row and its fact, as the real recorder writes them; notices are left out on every store alike.
  const recorder = Layer.effect(
    RulingRecorder,
    Effect.map(WorkRepository, (work) =>
      RulingRecorder.of({
        record: (input) => work.recordRuling(input).pipe(Effect.tap(() => Effect.sync(() => recorded.push(input))), Effect.asVoid, Effect.orDie),
      })),
  );
  const content = makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true });
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(ArtifactRepositoryLive, Layer.provideMerge(recorder, Layer.provideMerge(WorkRepositoryLive, content))).pipe(
      Layer.provideMerge(Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db")))),
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const machine of new Set([WRITER, installation])) {
            yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${new Date(START).toISOString()})`;
          }
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${installation}, ${new Date(START).toISOString()})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([[CANVAS, { nodes: [artifacts("arts")] }]]) });
          // The writer's machine edits the canvas on every store: a replica is a machine that does not.
          yield* sql`UPDATE canvases SET editor_installation_id = ${WRITER} WHERE canvas_name = ${CANVAS}`;
        }),
      );
    }),
  );
  const store = { root, runtime, recorded };
  engines.push(store);
  return store;
};

const closeEngines = async () => {
  for (const store of engines.splice(0)) {
    await store.runtime.dispose();
    await rm(store.root, { recursive: true, force: true });
  }
};

/** Every resource table of an engine store, leaving out the log and what only a ruler keeps. */
const engineTablesOf = (store: EngineStore, leaveOut: ReadonlySet<string>) =>
  store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const names = (yield* sql.unsafe<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
        .map((row) => row.name)
        .filter((name) => !leaveOut.has(name) && ![...leaveOut].some((prefix) => prefix.endsWith("*") && name.startsWith(prefix.slice(0, -1))));
      const tables: Record<string, ReadonlyArray<string>> = {};
      for (const name of names) {
        const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`);
        // A content ref's id is drawn fresh at each put: an identity, not state.
        if (rows.length > 0) tables[name] = rows.map(({ ref_id: _refId, ...row }) => JSON.stringify(row)).sort();
      }
      return tables;
    }),
  );

/**
 * What a replica holds where the ruler holds a body too large to ride inline
 * (v29): the version pending, with no bytes until a read fetches them by ref,
 * and the edit that made it unrecorded.
 * Every other row is the ruler's.
 */
const byRefPending = (tables: Record<string, ReadonlyArray<string>>): Record<string, ReadonlyArray<string>> => {
  const byRef = new Set<string>();
  const versions = (tables.artifact_versions ?? []).map((text) => {
    const row = JSON.parse(text) as { inline_body_json: string | null; body_ref_json: string; edit_json: string | null };
    if (row.inline_body_json === null || !row.inline_body_json.includes(LARGE)) return text;
    byRef.add((JSON.parse(row.body_ref_json) as { sha256: string }).sha256);
    const edit_json = row.edit_json === null ? null : JSON.stringify({ unrecorded: true });
    return JSON.stringify({ ...row, edit_json, inline_body_json: null });
  });
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const [name, rows] of Object.entries(tables)) {
    const kept = name === "artifact_versions"
      ? [...versions].sort()
      : name.startsWith("content_")
        ? rows.filter((text) => !byRef.has((JSON.parse(text) as { sha256: string }).sha256))
        : rows;
    if (kept.length > 0) out[name] = kept;
  }
  return out;
};

// A create names its artifact by its own op id: these are the first three steps', so later steps can name them.
const ARTIFACT_IDS = ["01M62AA0000000000000000000", "01M62AA0000000000000000001", "01M62AA0000000000000000002"] as const;
const artifactId = fc.constantFrom(...ARTIFACT_IDS);
// One body past the inline bound (48 KiB): its fact carries only the ref.
const LARGE = "x".repeat(50 * 1024);
const markdown = fc.constantFrom("v", "plan", "the plan, longer", "# Heading\n\nbody", LARGE);
const artifactOp: fc.Arbitrary<{ readonly op: ArtifactOp; readonly item: string | undefined }> = fc.oneof(
  // Weighted toward create, so the other ops find an artifact to act on.
  { weight: 3, arbitrary: fc.record({ item: artifactId, title: fc.constantFrom("Plan", "Notes"), body: markdown }).map(({ item, title, body }) => ({
    item,
    op: { op: "create", title, body: { type: "document", markdown: body } } as ArtifactOp,
  })) },
  fc.record({ item: artifactId, base: fc.integer({ min: 1, max: 2 }), body: markdown }).map(({ item, base, body }) => ({
    item,
    op: { op: "edit", edit: { kind: "replace", baseVersion: base as ArtifactVersion, body: { type: "document", markdown: body } } } as ArtifactOp,
  })),
  fc.record({ item: artifactId, title: fc.constantFrom("Plan 2", "Notes 2") }).map(({ item, title }) => ({ item, op: { op: "retitle", title } as ArtifactOp })),
  fc.record({ item: artifactId, labels: fc.subarray(["draft", "final"]) }).map(({ item, labels }) => ({ item, op: { op: "labels", labels } as ArtifactOp })),
  fc.record({ item: artifactId, kind: fc.constantFrom("archive", "restore") }).map(({ item, kind }) => ({ item, op: { op: kind } as ArtifactOp })),
  fc.record({ label: fc.constantFrom("draft", "final"), colour: fc.constantFrom(null, "red", "blue") }).map(({ label, colour }) => ({
    item: undefined,
    op: { op: "labelColour", label, colour } as unknown as ArtifactOp,
  })),
);

const artifactCommand = (index: number, step: { readonly actor: ResourceActor; readonly op: { readonly op: ArtifactOp; readonly item: string | undefined } }) =>
  ({
    opId: `01M62AA${String(index).padStart(19, "0")}` as OpId,
    canvasName: CANVAS,
    actor: step.actor,
    target: { kind: "artifact", nodeId: ARTS, ...(step.op.item === undefined ? {} : { itemId: step.op.item }) },
    basis: null,
    after: [],
    op: step.op.op,
  }) as unknown as ResourceCommand<ArtifactOp>;

const submitArtifact = (command: ResourceCommand<ArtifactOp>) =>
  Effect.flatMap(ArtifactRepository, (repo) =>
    command.target.itemId === undefined ? repo.submitNode(WRITER, command, everywhere) : repo.submit(WRITER, command, everywhere));

describe("the fold equals the ruler, for artifacts", () => {
  afterEach(closeEngines);

  it("directly, judged then folded, and on a replica", async () => {
    const applied = new Set<string>();
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ actor: fc.constantFrom(...actors), op: artifactOp }), { minLength: 1, maxLength: 16 }), async (steps) => {
        const direct = await makeEngineStore(WRITER);
        const judged = await makeEngineStore(WRITER);
        const replica = await makeEngineStore("replica");
        const ruled: Array<{ input: RecordRulingInput; at: number }> = [];
        for (const [index, step] of steps.entries()) {
          const at = START + index * 1000;
          vi.setSystemTime(at);
          const command = artifactCommand(index, step);
          const before = direct.recorded.length;
          await direct.runtime.runPromise(submitArtifact(command));
          for (const input of direct.recorded.slice(before)) {
            ruled.push({ input, at });
            if (input.ruling.kind === "applied") applied.add(step.op.op.op);
          }
          // The authority's path: judge, roll back, then record and fold at commit.
          await judged.runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const work = yield* WorkRepository;
              const mark = judged.recorded.length;
              yield* sql.withTransaction(Effect.flatMap(submitArtifact(command), () => Effect.fail(new Judged()))).pipe(
                Effect.catchIf((error): error is Judged => error instanceof Judged, () => Effect.void),
              );
              const rulings = judged.recorded.splice(mark);
              yield* sql.withTransaction(
                Effect.forEach(rulings, (input) =>
                  Effect.gen(function* () {
                    const row = appliedRow(input);
                    if (row !== undefined) yield* foldRuling(sql, input.canvasName, row, at, { bodies: input.bodies, command: input.command as ResourceCommand<ArtifactOp> });
                    yield* work.recordRuling(input);
                  }),
                ),
              );
              judged.recorded.push(...rulings);
            }),
          );
        }
        await replica.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const { input, at } of ruled) {
              const row = appliedRow(input);
              // Each ruling folds as it arrives, so the content store stamps it then.
              yield* Effect.sync(() => vi.setSystemTime(at));
              if (row !== undefined) yield* sql.withTransaction(foldRuling(sql, input.canvasName, row, at));
            }
          }),
        );
        const sameEverywhere = new Set(["installation", "known_installations"]);
        expect(await engineTablesOf(judged, sameEverywhere)).toEqual(await engineTablesOf(direct, sameEverywhere));
        // A replica holds the rulings as exchange rows, not as its own log.
        const resourcesOnly = new Set([...sameEverywhere, "resource_rulings", "work_*"]);
        expect(await engineTablesOf(replica, resourcesOnly)).toEqual(byRefPending(await engineTablesOf(direct, resourcesOnly)));
        await closeEngines();
      }),
      { numRuns: 25, seed: 20261028 },
    );
    expect([...applied].sort()).toEqual(expect.arrayContaining(["create", "edit", "labelColour", "labels", "retitle"]));
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Automations: placing or moving one moves the canvas count through the model, so each store holds the real model.

type AutomationStore = {
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | WorkRepository | AutomationRepository | RulingRecorder, unknown>;
  readonly recorded: Array<RecordRulingInput>;
};
const automationStores: Array<AutomationStore> = [];
const ROUTINES = asNodeId("routines");

const makeAutomationStore = async (installation: string): Promise<AutomationStore> => {
  const root = await mkdtemp(join(tmpdir(), `junto-fold-auto-${installation}-`));
  const recorded: Array<RecordRulingInput> = [];
  const recorder = Layer.effect(
    RulingRecorder,
    Effect.map(WorkRepository, (work) =>
      RulingRecorder.of({
        record: (input) => work.recordRuling(input).pipe(Effect.tap(() => Effect.sync(() => recorded.push(input))), Effect.asVoid, Effect.orDie),
      })),
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(makeAutomationRepositoryLive(), recorder),
      Layer.provideMerge(
        ModelStoresLive,
        Layer.provideMerge(
          Layer.mergeAll(
            WorkRepositoryLive,
            CrewRepositoryLive,
            makeSettingsLive(),
            makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
            SeatGuidanceRepositoryLive,
            AgentSignalRepositoryLive,
            ReferencesRepositoryLive,
            Layer.provideMerge(PausePlaneLive, FactoryPauseRepositoryLive),
            makeMachineRepositoryLive({ defaultName: () => installation, makeInstallationId: () => installation as InstallationId }),
          ),
          Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
        ),
      ),
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const machine of new Set([WRITER, installation])) {
            yield* sql`INSERT OR IGNORE INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${new Date(START).toISOString()})`;
          }
          yield* sql`INSERT OR IGNORE INTO installation(singleton, installation_id, created_at) VALUES (1, ${installation}, ${new Date(START).toISOString()})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([[CANVAS, { nodes: [automations("routines"), seat("lead")] }]]) });
          yield* sql`UPDATE canvases SET editor_installation_id = ${WRITER} WHERE canvas_name = ${CANVAS}`;
        }),
      );
    }),
  );
  const store = { root, runtime, recorded };
  automationStores.push(store);
  return store;
};

const closeAutomationStores = async () => {
  for (const store of automationStores.splice(0)) {
    await store.runtime.dispose();
    await rm(store.root, { recursive: true, force: true });
  }
};

const AUTOMATION_IDS = ["01M62AV0000000000000000001", "01M62AV0000000000000000002"] as const;
const automationDefinition = (text: string): AutomationDefinition => ({
  name: "Nightly",
  trigger: { kind: "schedule", cron: "0 2 * * *", timezone: "UTC" },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("lead") }, text }],
  limits: { minIntervalMs: 60_000, maxPerHour: 12 },
});
const machineName = fc.constantFrom(undefined, "mini", "studio");
const automationOp: fc.Arbitrary<{ readonly op: AutomationOp; readonly item: string }> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ item: fc.constantFrom(...AUTOMATION_IDS), enabled: fc.boolean(), machine: machineName, text: fc.constantFrom("Done?", "Status?") }).map(
    ({ item, enabled, machine, text }) => ({
      item,
      op: { kind: "create", automationId: item, enabled, ...(machine === undefined ? {} : { machine }), definition: automationDefinition(text) } as unknown as AutomationOp,
    })) },
  fc.record({ item: fc.constantFrom(...AUTOMATION_IDS), base: fc.integer({ min: 1, max: 2 }), text: fc.constantFrom("Done?", "Report") }).map(({ item, base, text }) => ({
    item,
    op: { kind: "edit", baseVersion: base, definition: automationDefinition(text) } as unknown as AutomationOp,
  })),
  fc.record({ item: fc.constantFrom(...AUTOMATION_IDS), enabled: fc.boolean() }).map(({ item, enabled }) => ({ item, op: { kind: "set-enabled", enabled } as AutomationOp })),
  fc.record({ item: fc.constantFrom(...AUTOMATION_IDS), machine: fc.constantFrom("mini", "studio") }).map(({ item, machine }) => ({
    item,
    op: { kind: "set-machine", machine } as unknown as AutomationOp,
  })),
  fc.record({ item: fc.constantFrom(...AUTOMATION_IDS), kind: fc.constantFrom("archive", "run") }).map(({ item, kind }) => ({ item, op: { kind } as AutomationOp })),
);

const automationEnv = { targetsOf: () => new Set([asNodeId("lead")]), isOverseer: () => false };
const submitAutomation = (index: number, step: { readonly op: AutomationOp; readonly item: string }) =>
  submitAutomationCommand(
    WRITER,
    {
      opId: `01M62AV${String(index).padStart(19, "0")}`,
      canvasName: CANVAS,
      actor: { kind: "operator" },
      target: { kind: "automation", nodeId: ROUTINES, ...(step.op.kind === "create" ? {} : { itemId: step.item }) },
      basis: null,
      after: [],
      op: step.op,
    } as unknown as ResourceCommand<AutomationOp>,
    everywhere,
    automationEnv as never,
  );

describe("the fold equals the ruler, for automations", () => {
  afterEach(closeAutomationStores);

  it("directly, judged then folded, and on a replica", async () => {
    const applied = new Set<string>();
    await fc.assert(
      fc.asyncProperty(fc.array(automationOp, { minLength: 1, maxLength: 12 }), async (steps) => {
        const direct = await makeAutomationStore(WRITER);
        const judged = await makeAutomationStore(WRITER);
        const replica = await makeAutomationStore("replica");
        const ruled: Array<{ input: RecordRulingInput; at: number }> = [];
        for (const [index, step] of steps.entries()) {
          const at = START + index * 1000;
          vi.setSystemTime(at);
          const before = direct.recorded.length;
          await direct.runtime.runPromise(submitAutomation(index, step));
          for (const input of direct.recorded.slice(before)) {
            ruled.push({ input, at });
            if (input.ruling.kind === "applied") applied.add(step.op.kind);
          }
          await judged.runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const work = yield* WorkRepository;
              const mark = judged.recorded.length;
              yield* sql.withTransaction(Effect.flatMap(submitAutomation(index, step), () => Effect.fail(new Judged()))).pipe(
                Effect.catchIf((error): error is Judged => error instanceof Judged, () => Effect.void),
              );
              const rulings = judged.recorded.splice(mark);
              yield* sql.withTransaction(
                Effect.forEach(rulings, (input) =>
                  Effect.gen(function* () {
                    // The facts first, then the ruling row: a placement moves the count the row stands on.
                    const row = appliedRow(input);
                    if (row !== undefined) yield* foldRuling(sql, input.canvasName, row, at, { command: input.command as ResourceCommand<AutomationOp> });
                    yield* work.recordRuling(input);
                  }),
                ),
              );
              judged.recorded.push(...rulings);
            }),
          );
        }
        await replica.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const { input, at } of ruled) {
              const row = appliedRow(input);
              yield* Effect.sync(() => vi.setSystemTime(at));
              if (row !== undefined) yield* sql.withTransaction(foldRuling(sql, input.canvasName, row, at));
            }
          }),
        );
        const tablesOfStore = (store: AutomationStore, leaveOut: ReadonlySet<string>) => engineTablesOf(store as unknown as EngineStore, leaveOut);
        const sameEverywhere = new Set(["installation", "known_installations", "machine_configuration"]);
        expect(await tablesOfStore(judged, sameEverywhere)).toEqual(await tablesOfStore(direct, sameEverywhere));
        // A replica holds the rulings as exchange rows, and takes the canvas count from the copy, never the fold.
        const resourcesOnly = new Set([...sameEverywhere, "resource_rulings", "work_*", "canvases"]);
        expect(await tablesOfStore(replica, resourcesOnly)).toEqual(await tablesOfStore(direct, resourcesOnly));
        await closeAutomationStores();
      }),
      { numRuns: 25, seed: 20261028 },
    );
    expect([...applied].sort()).toEqual(expect.arrayContaining(["archive", "create", "edit", "set-enabled", "set-machine"]));
  }, 120_000);
});
