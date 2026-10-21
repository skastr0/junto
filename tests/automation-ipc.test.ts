import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { automationIpcHandlers } from "../src/main/junto/automation/ipc";
import { AutomationRunnerLive, AutomationRunnerService } from "../src/main/junto/automation/live";
import { taskCanvasEnv } from "../src/main/junto/work/task-control";
import { rulingContextOf } from "../src/shared/ruling-context";
import { checkTaskCommand } from "../src/shared/task-model";
import { ItemId } from "../src/shared/work-ids";
import { liveAutomationPorts } from "../src/main/junto/work/automation-control";
import { asNodeId } from "../src/shared/physics/schema";
import { OpId } from "../src/shared/work-ids";
import { makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { TaskRepository, TaskRepositoryLive } from "../src/main/junto/work/task-repository";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";
import { seat } from "./support/model-nodes";
import type { AutomationDefinition, AutomationsChanged } from "../src/shared/automation";
import { Command } from "../src/shared/model";
import { Automations, TaskBoard } from "../src/shared/model/kinds";

const command = Schema.decodeUnknownSync(Command);
const NODE = "automations-1";
const ID = "01M5ESKJFC1A88R1MH1NEZWJ2Q";
const TASKS = "tasks-1";
const SEAT = "agent-a";

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
  test: (
    handlers: ReturnType<typeof automationIpcHandlers>,
    changed: AutomationsChanged[],
    sql: (statement: string) => Promise<void>,
    inApp: <A, E>(effect: Effect.Effect<A, E, TaskRepository | AutomationRunnerService | ModelService>) => Promise<A>,
  ) => Promise<void>,
) => {
  const home = await mkdtemp(join(tmpdir(), "junto-automation-ipc-"));
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      AutomationRunnerLive,
      Layer.mergeAll(
        Layer.provide(ModelLive, ModelDependents.empty),
        makeAutomationRepositoryLive(),
        recorder,
        Layer.provide(TaskRepositoryLive, recorder),
        makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
      ),
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
          // The machine repository may already have minted this machine's id; keep it.
          yield* sql`INSERT OR IGNORE INTO known_installations(installation_id,registered_at) VALUES ('mini',${at})`;
          yield* sql`INSERT OR IGNORE INTO installation(singleton,installation_id,created_at) VALUES (1,'mini',${at})`;
          // This machine's name, so a seat it hosts resolves.
          yield* sql`INSERT OR IGNORE INTO machine_configuration(singleton,machine_name,supervised_preferred,configured_at) VALUES (1,${THIS_MACHINE},0,${at})`;
        }));
        const model = yield* ModelService;
        yield* model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator");
        const node = Schema.decodeUnknownSync(Automations)({ kind: "automations", id: NODE, x: 0, y: 0, width: 240, height: 160, z: 0 });
        const tasks = Schema.decodeUnknownSync(TaskBoard)({ kind: "task", id: TASKS, x: 300, y: 0, width: 240, height: 160, z: 0 });
        yield* model.command(command({ _tag: "Add", canvas: "factory", nodes: [node, tasks, seat(SEAT)], wires: [] }), "operator");
      }),
    );
    const changed: AutomationsChanged[] = [];
    const exec = (statement: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(Effect.asVoid));
    await test(
      automationIpcHandlers((effect) => runtime.runPromise(effect), (event) => changed.push(event)),
      changed,
      exec,
      (effect) => runtime.runPromise(effect),
    );
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

  it("names the editing machine in the refusal, so the writer knows where to go", () =>
    run(async (handlers, _changed, sql) => {
      await sql("INSERT INTO known_installations(installation_id,registered_at) VALUES ('inst-atlas','2026-10-21T00:00:00Z')");
      await sql(`INSERT INTO machine_peers(machine_name,installation_id,bound_at) VALUES ('${OTHER_MACHINE}','inst-atlas','2026-10-21T00:00:00Z')`);
      await sql("UPDATE canvases SET editor_installation_id = 'inst-atlas' WHERE canvas_name = 'factory'");
      const create = { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition } };
      const refused = await handlers.apply("factory", create);
      expect(refused).toMatchObject({ kind: "refused", refusal: { reason: "not_available" } });
      expect(JSON.stringify(refused)).toContain(OTHER_MACHINE);
    }));

  it("fires a run now, files the task as the automation, and records each action's ruling", () =>
    run(async (handlers, _changed, _sql, inApp) => {
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: false, definition } });
      // A disabled automation still runs by hand.
      expect(await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "run" } })).toMatchObject({ kind: "applied" });
      const { firings } = await handlers.firings("factory", { automationId: ID });
      expect(firings.map((f) => [f.cause, f.outcome])).toEqual([
        [{ kind: "run" }, { kind: "fired", actions: [{ index: 0, ruling: "applied" }] }],
      ]);
      const { tasks } = await inApp(Effect.gen(function* () {
        return yield* (yield* TaskRepository).list("factory", { nodeIds: [asNodeId(TASKS)], limit: 10 });
      }));
      expect(tasks.map((task) => task.title)).toEqual(["Plan the day"]);
    }));
});

describe("when conditions, read on the editing machine", () => {
  it("skips a run whose task condition does not hold, then fires once it does", () =>
    run(async (handlers) => {
      // Fires only while some task on the tasks node is in the backlog.
      const gated = { ...definition, when: [{ kind: "task", task: { node: TASKS }, becomes: "backlog", holds: true }] };
      const OTHER = "01M5ESKJFC1A88R1MH1NEZWJ2R";
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: false, definition: gated as never } });
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "run" } });
      expect((await handlers.firings("factory", { automationId: ID })).firings.map((f) => f.outcome)).toEqual([
        { kind: "skipped", reason: "condition_unmet" },
      ]);

      // A second automation files a task in the backlog; now the first one's condition holds.
      await handlers.apply("factory", { nodeId: NODE, automationId: OTHER, op: { kind: "create", automationId: OTHER, enabled: false, definition } });
      await handlers.apply("factory", { nodeId: NODE, automationId: OTHER, op: { kind: "run" } });
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "run" } });
      expect((await handlers.firings("factory", { automationId: ID })).firings[0]?.outcome).toEqual({
        kind: "fired",
        actions: [{ index: 0, ruling: "applied" }],
      });
    }));
});

describe("change triggers, woken by a task write", () => {
  /** The operator files a task on the tasks node, as the CLI or the pane would. */
  const operatorFiles = (taskId: string) =>
    Effect.gen(function* () {
      const canvas = yield* (yield* ModelService).canvas("factory");
      const wire = { kind: "create", taskId: ItemId.make(taskId), title: "By hand" } as const;
      const checked = checkTaskCommand(wire, (id) => canvas.nodes.get(id)?.kind);
      if (!checked.ok) throw new Error("the create does not check");
      return yield* (yield* TaskRepository).submit(
        "mini" as never,
        {
          opId: OpId.make(taskId),
          canvasName: "factory",
          actor: { kind: "operator" },
          target: { kind: "task", nodeId: asNodeId(TASKS), itemId: ItemId.make(taskId) },
          basis: null,
          after: [],
          op: checked.command,
        },
        rulingContextOf(canvas, () => undefined),
        taskCanvasEnv(canvas),
      );
    });
  const wake = Effect.gen(function* () {
    yield* (yield* AutomationRunnerService).wake("factory");
  });

  it("fires on a task that came into the backlog, never on its own task, and once per change", () =>
    run(async (handlers, _changed, _sql, inApp) => {
      // On a new backlog task, file another: a loop if its own task fired it.
      const onBacklog = {
        ...definition,
        trigger: { kind: "change", on: { kind: "task", task: { node: TASKS }, becomes: "backlog" } },
      };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: onBacklog as never } });
      await inApp(wake); // the baseline

      await inApp(operatorFiles("01M5ESKJFC1A88R1MH1NEZWJ60"));
      await inApp(wake);
      await inApp(wake); // nothing new
      const { firings } = await handlers.firings("factory", { automationId: ID });
      expect(firings.map((f) => [f.cause.kind, f.outcome])).toEqual([["change", { kind: "fired", actions: [{ index: 0, ruling: "applied" }] }]]);

      // The task it filed came into the backlog too, written by the automation: no firing.
      expect((await handlers.firings("factory", { automationId: ID })).firings).toHaveLength(1);
      const { tasks } = await inApp(Effect.gen(function* () {
        return yield* (yield* TaskRepository).list("factory", { nodeIds: [asNodeId(TASKS)], limit: 10 });
      }));
      expect(tasks.map((task) => task.title).sort()).toEqual(["By hand", "Plan the day"]);
    }));
});

describe("signal and seat-state triggers", () => {
  it("fire once per raised signal from a seat in reach", () =>
    run(async (handlers, _changed, _sql, inApp) => {
      const onBlocked = { ...definition, trigger: { kind: "change", on: { kind: "signal", signal: "blocked" } } };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: onBlocked as never } });
      const raised = { kind: "signal", key: "signal:sig-1", seat: asNodeId(SEAT), signal: "blocked" } as const;
      const heard = Effect.gen(function* () {
        yield* (yield* AutomationRunnerService).heard("factory", raised);
      });
      await inApp(heard);
      await inApp(heard); // the same signal heard again
      const { firings } = await handlers.firings("factory", { automationId: ID });
      expect(firings.map((f) => [f.cause, f.outcome.kind])).toEqual([[{ kind: "change", key: "signal:sig-1" }, "fired"]]);
    }));

  it("fire once per seat-state firing, found by the seat's binding id", () =>
    run(async (handlers, _changed, _sql, inApp) => {
      const onIdle = { ...definition, trigger: { kind: "change", on: { kind: "seat", seat: { kind: "seat", nodeId: SEAT }, becomes: "idle" } } };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: onIdle as never } });
      const firing = { key: "agent-a:e1:idle:5", seat: `binding-${SEAT}`, epoch: "e1", becomes: "idle", since: 5, at: 30_005, reason: "turn ended" };
      const fired = Effect.gen(function* () {
        yield* (yield* AutomationRunnerService).seatFired(firing as never);
      });
      await inApp(fired);
      await inApp(fired);
      // A binding no seat on an edited canvas holds is dropped.
      await inApp(Effect.gen(function* () {
        yield* (yield* AutomationRunnerService).seatFired({ ...firing, key: "other", seat: "binding-gone" } as never);
      }));
      const { firings } = await handlers.firings("factory", { automationId: ID });
      expect(firings.map((f) => [f.cause, f.outcome.kind])).toEqual([[{ kind: "change", key: firing.key }, "fired"]]);
    }));
});

describe("the CLI's live automation ports", () => {
  const OVERSEER_RUN = OpId.make("01M5ESKJFC1A88R1MH1NEZWJ40");

  it("read the store, write through the one path, and tell every window", () =>
    run(async (handlers, changed, _sql, inApp) => {
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: false, definition } });
      const listed = await inApp(liveAutomationPorts.automations("factory", asNodeId(NODE)));
      expect(listed.map((a) => a.name)).toEqual(["Standup"]);

      const ran = await inApp(liveAutomationPorts.submit({
        opId: OVERSEER_RUN,
        canvasName: "factory",
        actor: { kind: "operator" },
        target: { kind: "automation", nodeId: asNodeId(NODE), itemId: ID as never },
        basis: null,
        after: [],
        op: { kind: "run" },
      }));
      expect(ran).toMatchObject({ disposition: "applied", opId: OVERSEER_RUN, automationId: ID });
      expect(changed).toHaveLength(2);

      // Node-wide history: every automation on the node, newest first.
      const firings = await inApp(liveAutomationPorts.firings("factory", asNodeId(NODE), { limit: 10 }));
      expect(firings.map((f) => f.cause)).toEqual([{ kind: "run" }]);
    }));

  it("refuse as not built where the automation store is not", async () => {
    const exit = await Effect.runPromiseExit(liveAutomationPorts.automations("factory", asNodeId(NODE)));
    expect(JSON.stringify(exit)).toContain("not_available");
  });
});
