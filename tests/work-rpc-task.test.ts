/**
 * The task.* and rulings ops as one contract on both sides of the work
 * socket: the CLI calls them through `callWorkRpc` with the contract's types,
 * and the core answers them from the contract's handlers, over the real
 * socket. Each answer the CLI decodes is the answer the core wrote, and the
 * core refuses what the contract does not name, in the words it used before.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Rulings,
  TaskArchive,
  TaskAssign,
  TaskCancel,
  TaskCheck,
  TaskComment,
  TaskCreate,
  TaskDepend,
  TaskEdit,
  TaskFinish,
  TaskList,
  TaskPause,
  TaskResume,
  TaskReviewerAdd,
  TaskReviewerRemove,
  TaskRules,
  TaskShow,
  TaskStamp,
  TaskStampPolicy,
  TaskStart,
  TaskUnassign,
  TaskUndepend,
  TaskWait,
} from "../src/contract/work/task";
import { WorkSocket, WorkSocketLive, callWorkRpc } from "../src/cli/core/socket";
import { TASKS_ENABLED } from "../src/shared/features";
import { mintItemId, mintOpId } from "../src/shared/resource-command";
import { TaskShowArgs } from "../src/shared/task-control";
import { WORK_TOKEN_ENV, encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode, taskBoard, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/core/work/control";
import { WorkLive } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/core/pause-plane";
import { createMainAuthoringGate } from "../src/node/main-authoring-gate";
import { RulingRecorderLive } from "../src/core/work/ruling-recorder";
import { TaskRepositoryLive } from "../src/core/work/task-repository";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const CANVAS = "contract";
const ME = "agent";
const PEER = "peer";
const BOARD = "board";

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
  const canvasesLive = Layer.provideMerge(Layer.mergeAll(ModelStoresLive, tasksLive), repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying, testLog.log.loggerLayer));
};

const seat = (id: string, x: number) =>
  seatNode(id, { x, y: 40, width: 120, height: 48, bindingId: `bind-${id}` as never, launch: { kind: "harness", argv: ["claude"] } });

const NODES = [
  region("team", { x: -40, y: -40, width: 900, height: 400 }, {
    label: "Team",
    contract: { rulings: [{ id: "ruling-1", text: "ship small", pinnedAt: "2026-11-07T00:00:00.000Z" }] },
  }),
  seat(ME, 0),
  seat(PEER, 160),
  taskBoard(BOARD, {
    x: 400,
    y: 40,
    width: 200,
    height: 100,
    contract: {
      rules: [{ id: "tests", text: "the tests pass" }],
      outgoing: { checks: [{ id: "unit", label: "unit tests", command: "bun run test" }] },
    },
  }),
];
const WIRES = [wire("edge", ME, PEER, "messages"), wire("back", PEER, ME, "messages")];

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-work-rpc-task-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(seedCanvas(CANVAS, NODES, WIRES));
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  for (const id of [ME, PEER]) tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
  delete process.env[WORK_TOKEN_ENV];
});

/** A v1 frame as a seat writes it by hand, and the frame the core answers. */
const raw = (as: string, op: string, args: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token: tokens[as]!, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

/** The CLI's typed call, as the seat whose credential is in its environment. */
const cli = <A, E>(as: string, call: Effect.Effect<A, E, WorkSocket>): Promise<A> => {
  process.env[WORK_TOKEN_ENV] = tokens[as]!;
  return Effect.runPromise(call.pipe(Effect.provide(WorkSocketLive)));
};

describe("the task contract across the work socket", () => {
  it.skipIf(!TASKS_ENABLED)("answers every op as the contract types it, decoded by the CLI as the core wrote it", async () => {
    const taskId = mintItemId();
    const created = await cli(ME, callWorkRpc(TaskCreate, { opId: mintOpId(), taskId, node: BOARD, title: "ship the task contract" }));
    expect(created).toMatchObject({ disposition: "applied", taskId, number: 1, state: "backlog" });
    const task = taskId as string;

    const moves = [
      [TaskEdit, { body: "every op through RPC" }, "backlog"],
      [TaskReviewerAdd, { reviewer: `@${PEER}` }, "backlog"],
      [TaskReviewerRemove, { reviewer: `@${PEER}` }, "backlog"],
      [TaskReviewerAdd, { reviewer: `@${PEER}` }, "backlog"],
      [TaskStampPolicy, { required: 1 }, "backlog"],
      [TaskAssign, { seat: "me" }, "assigned"],
      [TaskStart, {}, "working"],
      [TaskPause, {}, "input-required"],
      [TaskResume, {}, "working"],
      [TaskCheck, { results: [{ checkId: "unit", side: "outgoing", exitCode: 0, outputTail: "ok" }] }, "working"],
    ] as const;
    for (const [rpc, args, state] of moves) {
      const moved = await cli(ME, callWorkRpc(rpc as typeof TaskEdit, { opId: mintOpId(), task, ...args } as never));
      expect(moved, rpc._tag).toMatchObject({ disposition: "applied", taskId, state });
    }

    const rules = await cli(ME, callWorkRpc(TaskRules, { task }));
    expect(rules).toEqual((await raw(ME, "task.rules", { task })).data);
    expect(rules.task?.checks[0]?.checks.map((check) => [check.checkId, check.status])).toEqual([["unit", "green"]]);
    const nodeRules = await cli(ME, callWorkRpc(TaskRules, { node: BOARD }));
    expect(nodeRules).toEqual((await raw(ME, "task.rules", { node: BOARD })).data);
    expect(nodeRules.rules.map(({ rule }) => rule.id)).toEqual(["tests"]);

    const finished = await cli(ME, callWorkRpc(TaskFinish, {
      opId: mintOpId(),
      task,
      evidence: { artifacts: [], claims: [{ ruleId: "tests", text: "the unit suite passed" }] },
      handoff: "nothing left",
    }));
    expect(finished).toMatchObject({ disposition: "applied", state: "in-review" });
    const waited = await cli(ME, callWorkRpc(TaskWait, { task, until: "in-review", timeoutMs: 0 }));
    expect(waited).toMatchObject({ taskId, state: "in-review" });

    const commented = await cli(ME, callWorkRpc(TaskComment, { opId: mintOpId(), task, text: "ready for you" }));
    expect(commented).toMatchObject({ disposition: "applied", taskId, threadId: taskId });

    const stamped = await cli(PEER, callWorkRpc(TaskStamp, { opId: mintOpId(), task, verdict: "approve" }));
    expect(stamped).toMatchObject({ disposition: "applied", taskId });

    const shown = await cli(ME, callWorkRpc(TaskShow, { task }));
    expect(shown).toEqual((await raw(ME, "task.show", { task })).data);
    expect(shown.thread).toMatchObject({ threadId: taskId, comments: 1 });

    // A second task, to wait on the first and then close.
    const other = mintItemId() as string;
    await cli(ME, callWorkRpc(TaskCreate, { opId: mintOpId(), taskId: other as never, title: "after the contract" }));
    for (const [rpc, args, state] of [
      [TaskDepend, { on: task }, "backlog"],
      [TaskUndepend, { on: task }, "backlog"],
      [TaskAssign, {}, "assigned"],
      [TaskUnassign, {}, "backlog"],
      [TaskCancel, {}, "canceled"],
      [TaskArchive, {}, "archived"],
    ] as const) {
      const moved = await cli(ME, callWorkRpc(rpc as typeof TaskDepend, { opId: mintOpId(), task: other, ...args } as never));
      expect(moved, rpc._tag).toMatchObject({ disposition: "applied", taskId: other, state });
    }

    const listed = await cli(ME, callWorkRpc(TaskList, { state: ["in-review", "done", "archived"] }));
    expect(listed).toEqual((await raw(ME, "task.list", { state: ["in-review", "done", "archived"] })).data);
    expect(listed.tasks.map((item) => item.taskId).sort()).toEqual([task, other].sort());
  });

  it.skipIf(!TASKS_ENABLED)("answers rulings for the seat's region stack", async () => {
    const rulings = await cli(ME, callWorkRpc(Rulings, {}));
    expect(rulings).toEqual((await raw(ME, "rulings", {})).data);
    expect(rulings.regions.flatMap((group) => group.rulings.map((ruling) => ruling.id))).toEqual(["ruling-1"]);
  });

  it.skipIf(!TASKS_ENABLED)("refuses an argument the contract does not name", async () => {
    const refused = await raw(ME, "task.list", { bogus: true });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("InputError");
    expect(refused.error.details).toMatchObject({ path: "args", retryable: false });
  });

  it.skipIf(!TASKS_ENABLED)("refuses a task op's arguments in the words it used before", async () => {
    const decoded = Schema.decodeUnknownResult(TaskShowArgs, { onExcessProperty: "error" })({ task: "" });
    if (!Result.isFailure(decoded)) throw new Error("an empty task decoded");
    const refused = await raw(ME, "task.show", { task: "" });
    expect(refused.error).toEqual({
      type: "InputError",
      message: decoded.failure.message,
      details: { path: "args", hint: "junto schema show shows this command's input", retryable: false },
    });
  });

  it.skipIf(!TASKS_ENABLED)("refuses a task out of reach as missing, as the verb did", async () => {
    const missing = mintItemId();
    const refused = await raw(ME, "task.show", { task: missing });
    expect(refused.error).toMatchObject({ type: "UnknownTarget", message: `no task ${missing} in this seat's reach`, details: { path: "task", received: missing } });
  });
});
