import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { automationIpcHandlers } from "../src/main/junto/automation/ipc";
import { AutomationRunnerLive } from "../src/main/junto/automation/live";
import { makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import type { AutomationDefinition, AutomationsChanged } from "../src/shared/automation";
import { Command } from "../src/shared/model";
import { Automations, TaskBoard } from "../src/shared/model/kinds";

const command = Schema.decodeUnknownSync(Command);
const NODE = "automations-1";
const ID = "01M5ESKJFC1A88R1MH1NEZWJ2Q";
const TASKS = "tasks-1";

const definition: AutomationDefinition = {
  name: "Standup",
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  then: [{ kind: "create-task", node: TASKS as never, title: "Plan the day" }],
  limits: { minIntervalMs: 60_000, maxPerHour: 12 },
};

// The real recorder also writes the exchange fact; this one writes the ruling row.
const recorder = Layer.effect(
  RulingRecorder,
  Effect.map(SqlClient.SqlClient, (sql) =>
    RulingRecorder.of({
      record: (input) =>
        writeRuling(sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
    }),
  ),
);

const run = async (
  test: (handlers: ReturnType<typeof automationIpcHandlers>, changed: AutomationsChanged[], sql: (statement: string) => Promise<void>) => Promise<void>,
) => {
  const home = await mkdtemp(join(tmpdir(), "junto-automation-ipc-"));
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      AutomationRunnerLive,
      Layer.mergeAll(Layer.provide(ModelLive, ModelDependents.empty), makeAutomationRepositoryLive(), recorder),
    ).pipe(
      Layer.provideMerge(makeStateEngineLive(join(home, "junto.db"))),
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const at = new Date().toISOString();
        // This machine, the writer of the operator's commands.
        yield* sql.withTransaction(Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id,registered_at) VALUES ('mini',${at})`;
          yield* sql`INSERT INTO installation(singleton,installation_id,created_at) VALUES (1,'mini',${at})`;
        }));
        const model = yield* ModelService;
        yield* model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator");
        const node = Schema.decodeUnknownSync(Automations)({ kind: "automations", id: NODE, x: 0, y: 0, width: 240, height: 160, z: 0 });
        const tasks = Schema.decodeUnknownSync(TaskBoard)({ kind: "task", id: TASKS, x: 300, y: 0, width: 240, height: 160, z: 0 });
        yield* model.command(command({ _tag: "Add", canvas: "factory", nodes: [node, tasks], wires: [] }), "operator");
      }),
    );
    const changed: AutomationsChanged[] = [];
    const exec = (statement: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(Effect.asVoid));
    await test(automationIpcHandlers((effect) => runtime.runPromise(effect), (event) => changed.push(event)), changed, exec);
  } finally {
    await runtime.dispose();
    await rm(home, { recursive: true, force: true });
  }
};

describe("automation IPC", () => {
  it("creates as the operator, lists it, and tells every window", () =>
    run(async (handlers, changed) => {
      const created = await handlers.apply("factory", {
        nodeId: NODE,
        automationId: ID,
        op: { kind: "create", automationId: ID, enabled: true, definition },
      });
      expect(created).toMatchObject({ kind: "applied", automation: { automationId: ID, author: { kind: "operator" } } });
      expect(changed).toEqual([{ canvasName: "factory", nodeId: NODE }]);
      expect((await handlers.list("factory", { nodeId: NODE })).automations.map((a) => a.name)).toEqual(["Standup"]);
      expect(await handlers.firings("factory", { automationId: ID })).toEqual({ firings: [] });
    }));

  it("answers a refusal with its reason and tells no one", () =>
    run(async (handlers, changed) => {
      const create = { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition } };
      await handlers.apply("factory", create);
      expect(await handlers.apply("factory", create)).toMatchObject({ kind: "refused", refusal: { reason: "invalid_input" } });
      expect(changed).toHaveLength(1);
    }));

  it("archives, and the list no longer holds it", () =>
    run(async (handlers) => {
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition } });
      expect(await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "archive" } })).toEqual({ kind: "applied" });
      expect((await handlers.list("factory", { nodeId: NODE })).automations).toEqual([]);
    }));

  it("rejects input that does not decode", () =>
    run(async (handlers) => {
      await expect(handlers.list("factory", { nodeId: NODE, extra: 1 })).rejects.toBeDefined();
      await expect(handlers.list("", { nodeId: NODE })).rejects.toBeDefined();
    }));

  it("refuses a write on a machine that holds the canvas as a copy", () =>
    run(async (handlers, changed, sql) => {
      await sql("INSERT INTO known_installations(installation_id,registered_at) VALUES ('studio','2026-10-21T00:00:00Z')");
      await sql("UPDATE canvases SET editor_installation_id = 'studio' WHERE canvas_name = 'factory'");
      const create = { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition } };
      expect(await handlers.apply("factory", create)).toMatchObject({ kind: "refused", refusal: { reason: "not_available" } });
      expect(changed).toEqual([]);
      expect((await handlers.list("factory", { nodeId: NODE })).automations).toEqual([]);
    }));

  it("fires a run now, as the automation, and records what each action was ruled", () =>
    run(async (handlers) => {
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: false, definition } });
      expect(await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "run" } })).toMatchObject({ kind: "applied" });
      const { firings } = await handlers.firings("factory", { automationId: ID });
      // A disabled automation still runs by hand; create-task's port has not landed, so it is refused, never fired as done.
      expect(firings.map((f) => [f.cause, f.outcome])).toEqual([
        [{ kind: "run" }, { kind: "fired", actions: [{ index: 0, ruling: "refused", reason: "not_available" }] }],
      ]);
    }));
});
