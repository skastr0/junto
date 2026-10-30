import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { coreOpBody } from "../src/main/core-process/ops";
import "../src/main/core-process/ops/ipc-automation";
import { subscribe as subscribePushes } from "../src/main/core-process/push";
import { AutomationRunnerLive, AutomationRunnerService } from "../src/main/junto/automation/live";
import type {
  AutomationApplyResponse,
  AutomationCodePutResponse,
  AutomationCodeReadResponse,
  AutomationFiringsResponse,
  AutomationListResponse,
} from "../src/shared/automation";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { taskCanvasEnv } from "../src/main/junto/work/task-control";
import { rulingContextOf } from "../src/shared/ruling-context";
import { checkTaskCommand } from "../src/shared/task-model";
import { ItemId } from "../src/shared/work-ids";
import { liveAutomationPorts } from "../src/main/junto/work/automation-control";
import { asNodeId } from "../src/shared/physics/schema";
import { OpId } from "../src/shared/work-ids";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { TaskRepository, TaskRepositoryLive } from "../src/main/junto/work/task-repository";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";
import { seat } from "./support/model-nodes";
import { Firing, type AutomationDefinition, type AutomationsChanged, type FiringOutcome } from "../src/shared/automation";
import { Command } from "../src/shared/model";
import { Artifacts, Automations, TaskBoard } from "../src/shared/model/kinds";
import { WorkService, type WorkServiceShape } from "../src/main/junto/work/service";
import { makeUserMessage } from "../src/shared/task";
import type { Message } from "../src/shared/work-model";
import { threadSubjectMetadata } from "../src/shared/thread-subject";

const command = Schema.decodeUnknownSync(Command);
const NODE = "automations-1";
const ID = "01M5ESKJFC1A88R1MH1NEZWJ2Q";
const TASKS = "tasks-1";
const ARTIFACTS = "artifacts-1";
const SEAT = "agent-a";

const definition: AutomationDefinition = {
  name: "Standup",
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  then: [{ kind: "create-task", node: TASKS as never, title: "Plan the day" }],
  limits: { minIntervalMs: 60_000, maxPerHour: 12 },
};

// The real recorder: a ruling's row and its fact, whose seq is the order change triggers read rulings in.
const recorder = Layer.provideMerge(RulingRecorderLive, WorkRepositoryLive);

/** The pane's client as main has it: every answer is the core operation of that name. */
const automationOps = (run: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>) => {
  const call = <A>(name: string, input: unknown): Promise<A> => {
    const body = coreOpBody(name);
    if (body === undefined) throw new Error(`no core operation named ${name}`);
    return run(body(input as never) as Effect.Effect<A, never, never>);
  };
  return {
    list: (canvasName: unknown, input: unknown) =>
      call<AutomationListResponse>("ipc.automation.list", { canvasName, input }),
    firings: (canvasName: unknown, input: unknown) =>
      call<AutomationFiringsResponse>("ipc.automation.firings", { canvasName, input }),
    apply: (canvasName: unknown, input: unknown) =>
      call<AutomationApplyResponse>("ipc.automation.apply", { canvasName, input }),
    codePut: (canvasName: unknown, input: unknown) =>
      call<AutomationCodePutResponse>("ipc.automation.codePut", { canvasName, input }),
    codeRead: (canvasName: unknown, input: unknown) =>
      call<AutomationCodeReadResponse>("ipc.automation.codeRead", { canvasName, input }),
  };
};

const run = async (
  test: (
    handlers: ReturnType<typeof automationOps>,
    changed: AutomationsChanged[],
    sql: (statement: string) => Promise<void>,
    inApp: <A, E>(effect: Effect.Effect<A, E, TaskRepository | AutomationRunnerService | ModelService | AutomationRepository>) => Promise<A>,
  ) => Promise<void>,
  /** A stand-in work service; without it the runner has none, as where it is not built. */
  work?: Partial<WorkServiceShape>,
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
        work === undefined ? Layer.empty : Layer.succeed(WorkService, work as WorkServiceShape),
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
        const artifacts = Schema.decodeUnknownSync(Artifacts)({ kind: "artifacts", id: ARTIFACTS, x: 600, y: 0, width: 240, height: 160, z: 0 });
        yield* model.command(command({ _tag: "Add", canvas: "factory", nodes: [node, tasks, artifacts, seat(SEAT)], wires: [] }), "operator");
      }),
    );
    const changed: AutomationsChanged[] = [];
    const stopPushes = subscribePushes(IPC_CHANNELS.automationsChanged, (event) => changed.push(event as AutomationsChanged));
    const exec = (statement: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(Effect.asVoid));
    try {
      await test(
        automationOps((effect) => runtime.runPromise(effect as Effect.Effect<never, never, never>)),
        changed,
        exec,
        (effect) => runtime.runPromise(effect),
      );
    } finally {
      stopPushes();
    }
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

  it("lists each automation's newest firing as its last outcome, failed when an action was refused", () =>
    run(async (handlers, _changed, _sql, inApp) => {
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition } });
      expect((await handlers.list("factory", { nodeId: NODE })).lastOutcomes).toEqual({});
      const firing = (firingId: string, outcome: FiringOutcome): Firing =>
        Schema.decodeUnknownSync(Firing)({ firingId, automationId: ID, at: 1_000, cause: { kind: "change", key: firingId }, outcome });
      const settle = (firingId: string, outcome: FiringOutcome) =>
        inApp(Effect.gen(function* () {
          const repository = yield* AutomationRepository;
          yield* repository.claimFiring("factory", firing(firingId, { kind: "claimed" }));
          yield* repository.settleFiring("factory", firing(firingId, { kind: "claimed" }), outcome);
        }));
      await settle("01M5FNN0000000000000000001", { kind: "fired", actions: [{ index: 0, ruling: "applied" }] });
      expect((await handlers.list("factory", { nodeId: NODE })).lastOutcomes).toEqual({ [ID]: "fired" });
      await settle("01M5FNN0000000000000000002", { kind: "fired", actions: [{ index: 0, ruling: "refused", reason: "invalid_input" }] });
      expect((await handlers.list("factory", { nodeId: NODE })).lastOutcomes).toEqual({ [ID]: "failed" });
      await settle("01M5FNN0000000000000000003", { kind: "skipped", reason: "min_interval" });
      expect((await handlers.list("factory", { nodeId: NODE })).lastOutcomes).toEqual({ [ID]: "skipped" });
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
  /** One task command, as the CLI or the pane would submit it. */
  const submit = (
    taskId: string,
    opId: string,
    wire: Parameters<typeof checkTaskCommand>[0],
    actor: { readonly kind: "operator" } | { readonly kind: "seat"; readonly seatId: string; readonly nodeId: ReturnType<typeof asNodeId> } = { kind: "operator" },
  ) =>
    Effect.gen(function* () {
      const canvas = yield* (yield* ModelService).canvas("factory");
      const checked = checkTaskCommand(wire, (id) => canvas.nodes.get(id)?.kind);
      if (!checked.ok) throw new Error(`the ${wire.kind} does not check`);
      const outcome = yield* (yield* TaskRepository).submit(
        "mini" as never,
        {
          opId: OpId.make(opId),
          canvasName: "factory",
          actor: actor as never,
          target: { kind: "task", nodeId: asNodeId(TASKS), itemId: ItemId.make(taskId) },
          basis: null,
          after: [],
          op: checked.command,
        },
        rulingContextOf(canvas, () => undefined),
        taskCanvasEnv(canvas),
      );
      if (outcome.kind !== "applied") throw new Error(`the ${wire.kind} was refused: ${JSON.stringify(outcome.error)}`);
      return outcome;
    });
  /** The operator files a task on the tasks node. */
  const operatorFiles = (taskId: string) => submit(taskId, taskId, { kind: "create", taskId: ItemId.make(taskId), title: "By hand" });
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

  it("fires every state a task passed through between two passes, in order: working then done fires working", () =>
    run(async (handlers, _changed, _sql, inApp) => {
      const onWorking = {
        ...definition,
        trigger: { kind: "change", on: { kind: "task", task: { node: TASKS }, becomes: "working" } },
      };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: onWorking as never } });
      const T = "01M5ESKJFC1A88R1MH1NEZWJ60";
      const seatActor = { kind: "seat", seatId: `seat_${"a".repeat(64)}`, nodeId: asNodeId(SEAT) } as const;
      await inApp(operatorFiles(T));
      await inApp(submit(T, "01M5ESKJFC1A88R1MH1NEZWJ61", { kind: "assign", seat: SEAT as never }));
      await inApp(wake); // the baseline: what came before the runner's first pass fires nothing

      // Two writes inside one pass: the task is working, then finished, before the runner looks.
      await inApp(submit(T, "01M5ESKJFC1A88R1MH1NEZWJ62", { kind: "start" }, seatActor));
      const finished = await inApp(submit(T, "01M5ESKJFC1A88R1MH1NEZWJ63", { kind: "finish" }, seatActor));
      expect(finished.task.state).not.toBe("working");
      await inApp(wake);
      await inApp(wake); // nothing new
      const { firings } = await handlers.firings("factory", { automationId: ID });
      expect(firings.map((f) => f.cause)).toEqual([{ kind: "change", key: `task:${T}:working:01M5ESKJFC1A88R1MH1NEZWJ62` }]);
    }));
});

describe("comment triggers, read from each Artifacts node's mailbox", () => {
  const ARTIFACT = "01M5ESKJFC1A88R1MH1NEZWJ70";
  const comment = (messageId: string) =>
    makeUserMessage({
      messageId,
      text: "Looks good",
      contextId: "factory",
      metadata: threadSubjectMetadata({ kind: "artifact", nodeId: asNodeId(ARTIFACTS), artifactId: ItemId.make(ARTIFACT) }),
    });

  it("fire once per new comment after a failed read, never for the comments the node already held", () => {
    let mailbox = [comment("01M5ESKJFC1A88R1MH1NEZWJ71"), comment("01M5ESKJFC1A88R1MH1NEZWJ72")];
    let down = false;
    const work: Partial<WorkServiceShape> = {
      readMailbox: () => (down ? Effect.fail({ _tag: "WorkServiceError", message: "the mailbox is down" } as never) : Effect.succeed(mailbox)),
    };
    return run(async (handlers, _changed, _sql, inApp) => {
      const onComment = {
        ...definition,
        trigger: { kind: "change", on: { kind: "artifact", artifact: { kind: "artifact", nodeId: ARTIFACTS, artifactId: ARTIFACT }, event: "commented" } },
        limits: { minIntervalMs: 0, maxPerHour: 60 },
      };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: onComment as never } });
      const wake = Effect.gen(function* () {
        yield* (yield* AutomationRunnerService).wake("factory");
      });
      await inApp(wake); // the baseline: two old comments

      down = true;
      await inApp(wake); // the read fails: the node keeps its two
      down = false;
      mailbox = [...mailbox, comment("01M5ESKJFC1A88R1MH1NEZWJ73")];
      await inApp(wake);

      const { firings } = await handlers.firings("factory", { automationId: ID });
      expect(firings.map((f) => f.cause)).toEqual([{ kind: "change", key: `artifact:${ARTIFACT}:commented:01M5ESKJFC1A88R1MH1NEZWJ73` }]);
    }, work);
  });

  it("fire on the first comment after a canvas's first automation is saved: the save takes the baseline", () => {
    let mailbox = [comment("01M5ESKJFC1A88R1MH1NEZWJ71")];
    const work: Partial<WorkServiceShape> = { readMailbox: () => Effect.succeed(mailbox) };
    return run(async (handlers, _changed, _sql, inApp) => {
      const onComment = {
        ...definition,
        trigger: { kind: "change", on: { kind: "artifact", artifact: { kind: "artifact", nodeId: ARTIFACTS, artifactId: ARTIFACT }, event: "commented" } },
        limits: { minIntervalMs: 0, maxPerHour: 60 },
      };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: onComment as never } });
      // No pass between the save and the comment: the comment's own wake is the next one.
      mailbox = [...mailbox, comment("01M5ESKJFC1A88R1MH1NEZWJ73")];
      await inApp(Effect.gen(function* () {
        yield* (yield* AutomationRunnerService).wake("factory");
      }));
      const { firings } = await handlers.firings("factory", { automationId: ID });
      expect(firings.map((f) => f.cause)).toEqual([{ kind: "change", key: `artifact:${ARTIFACT}:commented:01M5ESKJFC1A88R1MH1NEZWJ73` }]);
    }, work);
  });

  it("still fire for one automation after another is saved beside it", () => {
    let mailbox = [comment("01M5ESKJFC1A88R1MH1NEZWJ71")];
    const work: Partial<WorkServiceShape> = { readMailbox: () => Effect.succeed(mailbox) };
    return run(async (handlers, _changed, _sql, inApp) => {
      const onComment = {
        ...definition,
        trigger: { kind: "change", on: { kind: "artifact", artifact: { kind: "artifact", nodeId: ARTIFACTS, artifactId: ARTIFACT }, event: "commented" } },
        limits: { minIntervalMs: 0, maxPerHour: 60 },
      };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: onComment as never } });
      const other = "01M5ESKJFC1A88R1MH1NEZWJ2R";
      await handlers.apply("factory", { nodeId: NODE, automationId: other, op: { kind: "create", automationId: other, enabled: true, definition: { ...onComment, name: "Other" } as never } });
      mailbox = [...mailbox, comment("01M5ESKJFC1A88R1MH1NEZWJ73")];
      await inApp(Effect.gen(function* () {
        yield* (yield* AutomationRunnerService).wake("factory");
      }));
      for (const automationId of [ID, other]) {
        const { firings } = await handlers.firings("factory", { automationId: automationId as never });
        expect(firings.map((f) => f.cause), automationId).toEqual([{ kind: "change", key: `artifact:${ARTIFACT}:commented:01M5ESKJFC1A88R1MH1NEZWJ73` }]);
      }
    }, work);
  });

  it("take a node's first good read as its baseline, when its read failed on the runner's first pass", () => {
    let mailbox = [comment("01M5ESKJFC1A88R1MH1NEZWJ71"), comment("01M5ESKJFC1A88R1MH1NEZWJ72")];
    let down = true;
    const work: Partial<WorkServiceShape> = {
      readMailbox: () => (down ? Effect.fail({ _tag: "WorkServiceError", message: "the mailbox is down" } as never) : Effect.succeed(mailbox)),
    };
    return run(async (handlers, _changed, _sql, inApp) => {
      const onComment = {
        ...definition,
        trigger: { kind: "change", on: { kind: "artifact", artifact: { kind: "artifact", nodeId: ARTIFACTS, artifactId: ARTIFACT }, event: "commented" } },
        limits: { minIntervalMs: 0, maxPerHour: 60 },
      };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: onComment as never } });
      const wake = Effect.gen(function* () {
        yield* (yield* AutomationRunnerService).wake("factory");
      });
      await inApp(wake); // a cold runner whose first read fails
      down = false;
      await inApp(wake); // the node's first good read: its baseline
      expect((await handlers.firings("factory", { automationId: ID })).firings).toEqual([]);

      mailbox = [...mailbox, comment("01M5ESKJFC1A88R1MH1NEZWJ73")];
      await inApp(wake);
      const { firings } = await handlers.firings("factory", { automationId: ID });
      expect(firings.map((f) => f.cause)).toEqual([{ kind: "change", key: `artifact:${ARTIFACT}:commented:01M5ESKJFC1A88R1MH1NEZWJ73` }]);
    }, work);
  });
});

describe("an automation's comment", () => {
  const T = "01M5ESKJFC1A88R1MH1NEZWJ60";
  const ARTIFACT = "01M5ESKJFC1A88R1MH1NEZWJ70";
  const REVIEWER = "agent-b";
  /** A mailbox per node, and every notice written, as the work service would hold them. */
  const workStandIn = () => {
    const boxes = new Map<string, Array<Message>>();
    const notices: Array<{ readonly to: string; readonly kind: unknown }> = [];
    const work: Partial<WorkServiceShape> = {
      readMailbox: (_canvas, nodeId) => Effect.succeed(boxes.get(nodeId) ?? []),
      workSubjectRow: (_canvas, nodeId, message) =>
        Effect.sync(() => {
          boxes.set(nodeId, [...(boxes.get(nodeId) ?? []), message]);
          return { ok: true, data: { messageId: message.messageId, written: true }, disposition: "applied" } as const;
        }),
      workSubjectNotice: (_canvas, nodeId, message) =>
        Effect.sync(() => {
          notices.push({ to: nodeId, kind: message.metadata?.mailKind });
          return { ok: true, data: { messageId: message.messageId, written: true }, disposition: "applied" } as const;
        }),
    };
    return { work, notices };
  };
  const submit = (taskId: string, opId: string, wire: Parameters<typeof checkTaskCommand>[0]) =>
    Effect.gen(function* () {
      const canvas = yield* (yield* ModelService).canvas("factory");
      const checked = checkTaskCommand(wire, (id) => canvas.nodes.get(id)?.kind);
      if (!checked.ok) throw new Error(`the ${wire.kind} does not check`);
      const outcome = yield* (yield* TaskRepository).submit(
        "mini" as never,
        {
          opId: OpId.make(opId),
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
      if (outcome.kind !== "applied") throw new Error(`the ${wire.kind} was refused: ${JSON.stringify(outcome.error)}`);
    });

  it("tells the task's assignee and reviewers", () => {
    const { work, notices } = workStandIn();
    return run(async (handlers, _changed, _sql, inApp) => {
      await inApp(Effect.gen(function* () {
        yield* (yield* ModelService).command(command({ _tag: "Add", canvas: "factory", nodes: [seat(REVIEWER)], wires: [] }), "operator");
      }));
      await inApp(submit(T, T, { kind: "create", taskId: ItemId.make(T), title: "By hand" }));
      await inApp(submit(T, "01M5ESKJFC1A88R1MH1NEZWJ61", { kind: "assign", seat: SEAT as never }));
      await inApp(submit(T, "01M5ESKJFC1A88R1MH1NEZWJ62", { kind: "reviewer-add", reviewer: { kind: "seat", seat: REVIEWER as never } }));
      const nudge = { ...definition, then: [{ kind: "comment", on: { kind: "task", nodeId: TASKS, taskId: T }, text: "Status?" }] };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: false, definition: nudge as never } });
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "run" } });
      expect((await handlers.firings("factory", { automationId: ID })).firings[0]?.outcome).toEqual({
        kind: "fired",
        actions: [{ index: 0, ruling: "applied" }],
      });
      expect(notices.map((notice) => notice.to).sort()).toEqual([SEAT, REVIEWER].sort());
    }, work);
  });

  it("is refused on a task the node does not hold, and tells no one", () => {
    const { work, notices } = workStandIn();
    return run(async (handlers) => {
      const nudge = { ...definition, then: [{ kind: "comment", on: { kind: "task", nodeId: TASKS, taskId: T }, text: "Status?" }] };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: false, definition: nudge as never } });
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "run" } });
      expect((await handlers.firings("factory", { automationId: ID })).firings[0]?.outcome).toEqual({
        kind: "fired",
        actions: [{ index: 0, ruling: "refused", reason: "unknown_target" }],
      });
      expect(notices).toEqual([]);
    }, work);
  });

  it("never fires a commented trigger, its own included", () => {
    const { work } = workStandIn();
    return run(async (handlers, _changed, _sql, inApp) => {
      const OTHER = "01M5ESKJFC1A88R1MH1NEZWJ2R";
      const artifact = { kind: "artifact", nodeId: ARTIFACTS, artifactId: ARTIFACT };
      // On a comment on the artifact, comment on it: a loop if its own comment fired it.
      const echo = {
        ...definition,
        trigger: { kind: "change", on: { kind: "artifact", artifact, event: "commented" } },
        then: [{ kind: "comment", on: artifact, text: "Seen" }],
        limits: { minIntervalMs: 0, maxPerHour: 60 },
      };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: echo as never } });
      const wake = Effect.gen(function* () {
        yield* (yield* AutomationRunnerService).wake("factory");
      });
      await inApp(wake); // the baseline
      // Another automation comments by hand-run: an automation's comment, which fires nothing.
      const post = { ...definition, then: [{ kind: "comment", on: artifact, text: "Shipped" }] };
      await handlers.apply("factory", { nodeId: NODE, automationId: OTHER, op: { kind: "create", automationId: OTHER, enabled: false, definition: post as never } });
      await handlers.apply("factory", { nodeId: NODE, automationId: OTHER, op: { kind: "run" } });
      expect((await handlers.firings("factory", { automationId: OTHER })).firings[0]?.outcome).toEqual({
        kind: "fired",
        actions: [{ index: 0, ruling: "applied" }],
      });
      await inApp(wake);
      await inApp(wake);
      expect((await handlers.firings("factory", { automationId: ID })).firings).toEqual([]);
    }, work);
  });
});

describe("signal and seat-state triggers", () => {
  it("fire once per raised signal from a seat in reach", () =>
    run(async (handlers, _changed, _sql, inApp) => {
      const onBlocked = { ...definition, trigger: { kind: "change", on: { kind: "signal", signal: "blocked" } } };
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: true, definition: onBlocked as never } });
      const raised = { kind: "signal", key: "signal:sig-1", seat: asNodeId(SEAT), signal: "blocked", text: "stuck" } as const;
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
      // The create and the run, then the run's firing claimed and settled (repository.ts firingChanged).
      expect(changed).toHaveLength(4);

      // Node-wide history: every automation on the node, newest first.
      const firings = await inApp(liveAutomationPorts.firings("factory", asNodeId(NODE), { limit: 10 }));
      expect(firings.map((f) => f.cause)).toEqual([{ kind: "run" }]);
    }));

  it("refuse reads and writes on a copy, naming the editing machine, and record nothing", () =>
    run(async (handlers, changed, sql, inApp) => {
      await handlers.apply("factory", { nodeId: NODE, automationId: ID, op: { kind: "create", automationId: ID, enabled: false, definition } });
      await sql("INSERT INTO known_installations(installation_id,registered_at) VALUES ('inst-atlas','2026-10-21T00:00:00Z')");
      await sql(`INSERT INTO machine_peers(machine_name,installation_id,bound_at) VALUES ('${OTHER_MACHINE}','inst-atlas','2026-10-21T00:00:00Z')`);
      await sql("UPDATE canvases SET editor_installation_id = 'inst-atlas' WHERE canvas_name = 'factory'");
      changed.length = 0;
      const refusal = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined);
      const nextStep = `Open "factory" on ${OTHER_MACHINE} to read or change its automations`;

      // The copy's store is not the record, so its reads refuse rather than answer nothing.
      const reads = [
        await inApp(Effect.exit(liveAutomationPorts.automations("factory", asNodeId(NODE)))),
        await inApp(Effect.exit(liveAutomationPorts.firings("factory", asNodeId(NODE), { limit: 10 }))),
      ];
      for (const read of reads) {
        expect(refusal(read)).toMatchObject({ type: "InputError", details: { reason: "not_available", next_step: nextStep } });
      }

      const ran = refusal(await inApp(Effect.exit(liveAutomationPorts.submit({
        opId: OVERSEER_RUN,
        canvasName: "factory",
        actor: { kind: "operator" },
        target: { kind: "automation", nodeId: asNodeId(NODE), itemId: ID as never },
        basis: null,
        after: [],
        op: { kind: "run" },
      }))));
      expect(ran).toMatchObject({
        type: "InputError",
        details: { reason: "not_available", next_step: `Open "factory" on ${OTHER_MACHINE} to change its automations` },
      });
      expect(changed).toEqual([]);
      expect((await handlers.firings("factory", { automationId: ID })).firings).toEqual([]);
    }));

  it("refuse as not built where the automation store is not", async () => {
    const exit = await Effect.runPromiseExit(liveAutomationPorts.automations("factory", asNodeId(NODE)));
    expect(JSON.stringify(exit)).toContain("not_available");
  });
});
