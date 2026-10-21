import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { ArtifactBody, ArtifactOp } from "../src/shared/artifact";
import type { ResourceCommand } from "../src/shared/resource-command";
import { RESOURCE_IPC_CHANNELS, taskRefusalOf } from "../src/shared/resource-ipc";
import type { TaskRecord } from "../src/shared/task-machine";
import type { TaskCommand, TaskView } from "../src/shared/task-model";
import type { WorkErrorBody } from "../src/shared/work-control";
import { ItemId, OpId } from "../src/shared/work-ids";
import { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { liveArtifactPorts } from "../src/main/junto/work/artifact-control";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { noteResourceChanged, onResourceChanged } from "../src/main/junto/work/resource-changes";
import { liveTaskPorts } from "../src/main/junto/work/task-control";
import { TaskRepository } from "../src/main/junto/work/task-repository";
import {
  allTasks,
  applyArtifact,
  applyTask,
  artifactHistory,
  listArtifacts,
  listTasks,
  pendingArtifacts,
  pendingTasks,
  registerResourceIpc,
  taskContext,
  type ResourceIpcPorts,
} from "../src/main/junto/work/resource-ipc";
import { artifacts, canvasOf, region, seat, taskBoard, wire } from "./support/model-nodes";
import { asNodeId } from "../src/shared/model";
import { ARTIFACTS_ENABLED, TASKS_ENABLED } from "../src/shared/features";

const board = canvasOf(
  [
    region("R", { x: 0, y: 0, width: 1000, height: 1000 }),
    seat("S", { x: 10, y: 10 }),
    taskBoard("T", { x: 300, y: 10 }),
    taskBoard("T2", { x: 300, y: 300 }),
    artifacts("A", { x: 600, y: 10 }),
  ],
  [wire("w1", "T", "T2", "flows")],
);
const TASK = ItemId.make("01M5ESZPWMZZM3TZ88P6FVVK33");
const OP = OpId.make("01M5ESZPWMZZM3TZ88P6FVVK35");
const ART = ItemId.make("01M5ESR42S7P9YNR8FEH0TD2QC");
const OLD = ItemId.make("01M5ESR42S7P9YNR8FEH0TD2QD");

const view = (taskId: string, createdAt: number) => ({ taskId, createdAt }) as unknown as TaskView;
const body = (text: string) => ({ text }) as unknown as ArtifactBody;

type Calls = {
  pulled: Array<unknown>;
  submitted: Array<ResourceCommand<unknown>>;
  listed: Array<unknown>;
};

const portsOf = (over: {
  readonly taskSubmit?: ResourceIpcPorts["tasks"]["submit"];
  readonly artifactSubmit?: ResourceIpcPorts["artifacts"]["submit"];
  readonly queue?: ResourceIpcPorts["queue"];
} = {}) => {
  const calls: Calls = { pulled: [], submitted: [], listed: [] };
  const ports: ResourceIpcPorts = {
    topology: () => Effect.succeed(board),
    tasks: {
      list: (_canvas, query) => {
        calls.listed.push(query);
        return Effect.succeed({ tasks: [view("b", 2), view("a", 1)], more: false });
      },
      submit: (command, context, env) => {
        calls.submitted.push(command as ResourceCommand<unknown>);
        return over.taskSubmit?.(command, context, env) ??
          Effect.succeed({ kind: "applied", opId: command.opId, task: {} as TaskRecord, effects: [], replay: false });
      },
      find: () => Effect.succeed(undefined),
      comment: () => Effect.die("no comment in this suite"),
    },
    artifacts: {
      list: (_canvas, query) =>
        Effect.succeed({
          artifacts: query.archived
            ? [{ artifactId: OLD, updatedAt: 5 }]
            : [{ artifactId: ART, updatedAt: 9 }],
          more: false,
        } as never),
      head: (_canvas, id) =>
        Effect.succeed(Option.some({ artifact: { artifactId: id }, body: null, bodyRef: { sha256: id } } as never)),
      body: (_canvas, _id, version) =>
        Effect.succeed(version === 2 ? Option.none() : Option.some({ body: body(`v${version}`), bodyRef: { sha256: `v${version}` } } as never)),
      pull: (input) => Effect.sync(() => void calls.pulled.push(input)),
      history: () =>
        Effect.succeed({
          versions: [3, 2, 1].map((version) => ({ version, author: { kind: "operator" }, at: version })),
          more: false,
        } as never),
      submit: (command, context) => {
        calls.submitted.push(command as ResourceCommand<unknown>);
        return over.artifactSubmit?.(command, context) ??
          Effect.succeed({ kind: "applied", opId: command.opId, artifactId: ART, version: 1, facts: [{ fact: "x" }] } as never);
      },
      comment: () => Effect.die("no comment in this suite"),
    },
    mailbox: () => Effect.succeed([]),
    queue: over.queue ?? (() => Effect.succeed(undefined)),
  };
  return { ports, calls };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("tasks over IPC", () => {
  it("lists a node's tasks, archived too, oldest first; all reads every task node", async () => {
    const { ports, calls } = portsOf();
    expect((await run(listTasks(ports, "factory", asNodeId("T")))).map((task) => task.taskId)).toEqual(["a", "b"]);
    expect(calls.listed[0]).toMatchObject({ nodeIds: ["T"], states: expect.arrayContaining(["archived"]) });
    await run(allTasks(ports, "factory"));
    expect(calls.listed[1]).toEqual({ nodeIds: ["T", "T2"], limit: 10_000 });
  });

  it("gives the ruler's context as data", async () => {
    const { ports } = portsOf();
    const facts = await run(taskContext(ports, "factory"));
    expect(facts.downstream).toEqual({ T: ["T2"], T2: [] });
    expect(facts.seatReach).toEqual({ S: ["T", "T2"] });
  });

  it("submits the operator's command with the caller's opId and delivers its mail", async () => {
    const { ports, calls } = portsOf();
    const start: TaskCommand = { kind: "start" };
    expect(await run(applyTask(ports, "factory", asNodeId("T"), TASK, OP, start))).toEqual({ kind: "applied", opId: OP });
    expect(calls.submitted).toEqual([
      {
        opId: OP,
        canvasName: "factory",
        actor: { kind: "operator" },
        target: { kind: "task", nodeId: "T", itemId: TASK },
        basis: null,
        after: [],
        op: start,
      },
    ]);
  });

  it("refuses a seat that is not an agent before the ruler, in the domain's words", async () => {
    const { ports, calls } = portsOf();
    const outcome = await run(applyTask(ports, "factory", asNodeId("T"), TASK, OP, { kind: "assign", seat: asNodeId("T2") }));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(taskRefusalOf(outcome.error)?.detail).toEqual({ kind: "wrong-node", nodeId: "T2", expected: "agent" });
    }
    expect(calls.submitted).toEqual([]);
  });

  it("answers a resend from the stored ruling, and a store failure as refused", async () => {
    const replay = portsOf({
      taskSubmit: (command) => Effect.succeed({ kind: "applied", opId: command.opId, task: {} as TaskRecord, effects: [], replay: true }),
    });
    expect(await run(applyTask(replay.ports, "factory", asNodeId("T"), TASK, OP, { kind: "start" }))).toEqual({ kind: "applied", opId: OP });
    const down: WorkErrorBody = { type: "InternalError", message: "the task store is down", details: { retryable: true } };
    const failing = portsOf({ taskSubmit: () => Effect.fail(down) });
    expect(await run(applyTask(failing.ports, "factory", asNodeId("T"), TASK, OP, { kind: "start" }))).toEqual({
      kind: "refused",
      opId: OP,
      error: down,
    });
  });
});

describe("what a write may name", () => {
  it("refuses a task on a node that is not a task node, or an artifact on one that is not an Artifacts node", async () => {
    const { ports, calls } = portsOf();
    const onSeat = await run(applyTask(ports, "factory", asNodeId("S"), TASK, OP, { kind: "create", taskId: TASK, title: "Import" }));
    expect(onSeat).toMatchObject({ kind: "refused", error: { details: { reason: "invalid_input" } } });
    const nowhere = await run(applyTask(ports, "factory", asNodeId("GONE"), TASK, OP, { kind: "start" }));
    expect(nowhere).toMatchObject({ kind: "refused", error: { details: { reason: "unknown_target" } } });
    const onBoard = await run(applyArtifact(ports, "factory", asNodeId("T"), ART, OP, { op: "archive" } as unknown as ArtifactOp));
    expect(onBoard).toMatchObject({ kind: "refused", error: { details: { reason: "invalid_input" } } });
    expect(calls.submitted).toEqual([]);
  });
});

describe("artifacts over IPC", () => {
  it("lists live and archived heads, newest change first, and pulls a pending body on the operator's reach", async () => {
    const { ports, calls } = portsOf();
    expect((await run(listArtifacts(ports, "factory", asNodeId("A")))).map((head) => head.artifact.artifactId)).toEqual([ART, OLD]);
    expect(calls.pulled).toEqual([ART, OLD].map((id) => expect.objectContaining({
      ref: { sha256: id },
      reached: { canvasName: "factory", resourceId: "A" },
      owner: expect.objectContaining({ kind: "artifact", canvasName: "factory", nodeId: "A" }),
    })));
  });

  it("reads each version's body, leaving out one the store lacks", async () => {
    const { ports } = portsOf();
    expect((await run(artifactHistory(ports, "factory", ART))).map((record) => [record.version, record.body])).toEqual([
      [3, body("v3")],
      [1, body("v1")],
    ]);
  });

  it("submits the operator's op", async () => {
    const op = { op: "archive" } as unknown as ArtifactOp;
    const { ports, calls } = portsOf();
    const outcome = await run(applyArtifact(ports, "factory", asNodeId("A"), ART, OP, op));
    expect(outcome).toMatchObject({ kind: "applied", opId: OP, facts: [{ fact: "x" }] });
    expect(calls.submitted[0]).toMatchObject({ actor: { kind: "operator" }, target: { kind: "artifact", nodeId: "A", itemId: ART }, opId: OP });
  });
});

describe("pending writes over IPC", () => {
  const queued = (opId: string, kind: "task" | "artifact", nodeId: string, itemId: string | undefined, op: unknown) => ({
    opId: OpId.make(opId),
    canvasName: "factory",
    actor: { kind: "operator" },
    target: { kind, nodeId: asNodeId(nodeId), ...(itemId === undefined ? {} : { itemId: ItemId.make(itemId) }) },
    basis: null,
    after: [],
    op,
  }) as never;
  const retitle: ArtifactOp = { op: "retitle", title: "Notes" };
  const A1 = "01M5F2A0000000000000000001";
  const A2 = "01M5F2A0000000000000000002";
  const A3 = "01M5F2A0000000000000000003";
  const A4 = "01M5F2A0000000000000000004";
  const A5 = "01M5F2A0000000000000000005";
  const atRisk = { status: "at_risk", refusal: { reason: "stale", message: "moved" } } as const;
  const queue: ResourceIpcPorts["queue"] = (canvasName, canvas) => {
    expect([canvasName, canvas]).toEqual(["factory", board]);
    return Effect.succeed({
      commands: [
        queued(A1, "artifact", "A", ART, retitle),
        queued(A2, "task", "T", TASK, { kind: "start" }),
        queued(A3, "artifact", "A", OLD, { op: "archive" }),
        queued(A4, "artifact", "B", ART, { op: "archive" }),
        queued(A5, "artifact", "A", ART, { op: "explode" }),
      ],
      overlays: new Map<string, object>([[OpId.make(A1), { status: "pending" }], [OpId.make(A3), atRisk]]) as never,
    });
  };

  it("gives the node's unruled artifact writes in queue order, with op list's overlay, and only that node's", async () => {
    const { ports } = portsOf({ queue });
    expect(await run(pendingArtifacts(ports, "factory", asNodeId("A")))).toEqual([
      { opId: A1, artifactId: ART, op: retitle, overlay: { status: "pending" } },
      { opId: A3, artifactId: OLD, op: { op: "archive" }, overlay: atRisk },
    ]);
  });

  it("gives the node's unruled task writes, with no overlay where the build has none", async () => {
    const { ports } = portsOf({ queue });
    expect(await run(pendingTasks(ports, "factory", asNodeId("T")))).toEqual([{ opId: A2, taskId: TASK, command: { kind: "start" } }]);
    expect(await run(pendingTasks(ports, "factory", asNodeId("T2")))).toEqual([]);
  });

  it("is empty when this machine holds no queue", async () => {
    const { ports } = portsOf();
    expect(await run(pendingArtifacts(ports, "factory", asNodeId("A")))).toEqual([]);
  });
});

describe("change notices", () => {
  const taskCommand = (opId = OP): ResourceCommand<TaskCommand> => ({
    opId,
    canvasName: "factory",
    actor: { kind: "operator" },
    target: { kind: "task", nodeId: asNodeId("T"), itemId: TASK },
    basis: null,
    after: [],
    op: { kind: "start" },
  });
  const heard = () => {
    const notices: Array<[string, string]> = [];
    const stop = onResourceChanged((domain, canvasName) => notices.push([domain, canvasName]));
    return { notices, stop };
  };

  it("are said by the task store port for every applied write but a replay, whoever wrote", async () => {
    const { notices, stop } = heard();
    const repo = (replay: boolean) =>
      ({ submit: (_writer: unknown, command: ResourceCommand<TaskCommand>) => Effect.succeed({ kind: "applied", opId: command.opId, task: {}, effects: [], replay }) }) as never;
    const submit = (replay: boolean) =>
      run(
        liveTaskPorts.submit(taskCommand(), { inReach: () => true }, {} as never).pipe(
          Effect.provideService(TaskRepository, repo(replay)),
          Effect.provideService(MachineRepository, { installationId: Effect.succeed("w") } as never),
        ),
      );
    await submit(false);
    await submit(true);
    stop();
    await submit(false);
    expect(notices).toEqual([["task", "factory"]]);
  });

  it("are said by the artifact store port only when the ruling made facts", async () => {
    const { notices, stop } = heard();
    const repo = (facts: ReadonlyArray<unknown>) =>
      ({
        localWriter: () => Effect.succeed(Option.some("w")),
        submit: (_writer: unknown, command: ResourceCommand<ArtifactOp>) =>
          Effect.succeed({ kind: "applied", opId: command.opId, artifactId: ART, version: 1, facts }),
      }) as never;
    const command = { ...taskCommand(), target: { kind: "artifact", nodeId: asNodeId("A"), itemId: ART }, op: {} } as never;
    for (const facts of [[{ fact: "x" }], []]) {
      await run(liveArtifactPorts.submit(command, { inReach: () => true }).pipe(Effect.provideService(ArtifactRepository, repo(facts))));
    }
    stop();
    expect(notices).toEqual([["artifact", "factory"]]);
  });

  it.runIf(!TASKS_ENABLED && !ARTIFACTS_ENABLED)("in a build with tasks and artifacts off, registers no channel even when asked to", () => {
    const handlers = new Map<string, unknown>();
    const stop = registerResourceIpc(
      { handle: (channel: string, listener: unknown) => handlers.set(channel, listener) } as never,
      (effect) => Effect.runPromise(effect as Effect.Effect<never>),
      portsOf().ports,
      () => undefined,
      { task: true, artifact: true },
      { task: (operation) => operation(), artifact: (operation) => operation(), thread: (operation) => operation() },
    );
    stop();
    expect([...handlers.keys()]).toEqual([]);
  });

  it.runIf(TASKS_ENABLED)("reach the windows for the domains this build has, and the handlers are registered the same way", async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
    const sent: Array<[string, unknown]> = [];
    const authored: string[] = [];
    const { ports } = portsOf();
    const stop = registerResourceIpc(
      { handle: (channel: string, listener: (event: unknown, input: unknown) => unknown) => handlers.set(channel, listener) } as never,
      (effect) => Effect.runPromise(effect as Effect.Effect<never>),
      ports,
      (channel, payload) => sent.push([channel, payload]),
      { task: true, artifact: false },
      { task: (operation) => (authored.push("task"), operation()), artifact: (operation) => operation(), thread: (operation) => operation() },
    );
    expect([...handlers.keys()].sort()).toEqual(
      [...Object.values(RESOURCE_IPC_CHANNELS.task), RESOURCE_IPC_CHANNELS.thread.list, RESOURCE_IPC_CHANNELS.thread.post]
        .filter((channel) => !channel.endsWith("changed"))
        .sort(),
    );
    noteResourceChanged("task", "factory");
    noteResourceChanged("artifact", "factory");
    stop();
    noteResourceChanged("task", "factory");
    expect(sent).toEqual([
      [RESOURCE_IPC_CHANNELS.task.changed, { canvasName: "factory" }],
      [RESOURCE_IPC_CHANNELS.thread.changed, { canvasName: "factory", kind: "task" }],
    ]);
    const apply = handlers.get(RESOURCE_IPC_CHANNELS.task.apply)!;
    expect(await apply(undefined, { canvasName: "factory", nodeId: "T", taskId: TASK, opId: OP, command: { kind: "start" } })).toEqual({
      kind: "applied",
      opId: OP,
    });
    expect(authored).toEqual(["task"]);
    await expect(apply(undefined, { canvasName: "factory", nodeId: "T", taskId: TASK, opId: OP, command: { kind: "start" }, actor: {} }))
      .rejects.toThrow();
  });
});
