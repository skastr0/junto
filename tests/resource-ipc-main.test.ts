import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { ArtifactBody, ArtifactOp } from "../src/shared/artifact";
import type { ResourceCommand } from "../src/shared/resource-command";
import { taskRefusalOf } from "../src/shared/resource-ipc";
import type { TaskRecord } from "../src/shared/task-machine";
import type { TaskCommand, TaskView } from "../src/shared/task-model";
import type { WorkErrorBody } from "../src/shared/work-control";
import { ItemId, OpId } from "../src/shared/work-ids";
import {
  allTasks,
  applyArtifact,
  applyTask,
  artifactHistory,
  listArtifacts,
  listTasks,
  taskContext,
  type ResourceIpcPorts,
} from "../src/main/junto/work/resource-ipc";
import { artifacts, canvasOf, region, seat, taskBoard, wire } from "./support/model-nodes";
import { asNodeId } from "../src/shared/model";

const board = canvasOf(
  [
    region("R", { x: 0, y: 0, width: 1000, height: 1000 }),
    seat("S", { x: 10, y: 10 }),
    taskBoard("T", { x: 300, y: 10 }),
    taskBoard("T2", { x: 300, y: 300 }),
    artifacts("A", { x: 600, y: 10 }),
  ],
  [wire("w1", "T", "T2", "feeds")],
);
const TASK = ItemId.make("01M5ESZPWMZZM3TZ88P6FVVK33");
const OP = OpId.make("01M5ESZPWMZZM3TZ88P6FVVK35");
const ART = ItemId.make("01M5ESR42S7P9YNR8FEH0TD2QC");
const OLD = ItemId.make("01M5ESR42S7P9YNR8FEH0TD2QD");

const view = (taskId: string, createdAt: number) => ({ taskId, createdAt }) as unknown as TaskView;
const body = (text: string) => ({ text }) as unknown as ArtifactBody;

type Calls = {
  submitted: Array<ResourceCommand<unknown>>;
  delivered: number;
  changed: Array<[string, string]>;
  listed: Array<unknown>;
};

const portsOf = (over: {
  readonly taskSubmit?: ResourceIpcPorts["tasks"]["submit"];
  readonly artifactSubmit?: ResourceIpcPorts["artifacts"]["submit"];
} = {}) => {
  const calls: Calls = { submitted: [], delivered: 0, changed: [], listed: [] };
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
      deliver: () =>
        Effect.sync(() => {
          calls.delivered += 1;
        }),
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
      body: (_canvas, _id, version) => Effect.succeed(version === 2 ? Option.none() : Option.some(body(`v${version}`))),
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
    },
    changed: (domain, canvasName) => {
      calls.changed.push([domain, canvasName]);
    },
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

  it("submits the operator's command with the caller's opId, delivers its mail and says it changed", async () => {
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
    expect(calls.delivered).toBe(1);
    expect(calls.changed).toEqual([["task", "factory"]]);
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

  it("answers a resend from the stored ruling without mail or a change, and a store failure as refused", async () => {
    const replay = portsOf({
      taskSubmit: (command) => Effect.succeed({ kind: "applied", opId: command.opId, task: {} as TaskRecord, effects: [], replay: true }),
    });
    expect(await run(applyTask(replay.ports, "factory", asNodeId("T"), TASK, OP, { kind: "start" }))).toEqual({ kind: "applied", opId: OP });
    expect(replay.calls.delivered).toBe(0);
    expect(replay.calls.changed).toEqual([]);
    const down: WorkErrorBody = { type: "InternalError", message: "the task store is down", details: { retryable: true } };
    const failing = portsOf({ taskSubmit: () => Effect.fail(down) });
    expect(await run(applyTask(failing.ports, "factory", asNodeId("T"), TASK, OP, { kind: "start" }))).toEqual({
      kind: "refused",
      opId: OP,
      error: down,
    });
  });
});

describe("artifacts over IPC", () => {
  it("lists live and archived heads, newest change first", async () => {
    const { ports } = portsOf();
    expect((await run(listArtifacts(ports, "factory", asNodeId("A")))).map((head) => head.artifact.artifactId)).toEqual([ART, OLD]);
  });

  it("reads each version's body, leaving out one the store lacks", async () => {
    const { ports } = portsOf();
    expect((await run(artifactHistory(ports, "factory", ART))).map((record) => [record.version, record.body])).toEqual([
      [3, body("v3")],
      [1, body("v1")],
    ]);
  });

  it("submits the operator's op and says it changed only when facts were made", async () => {
    const op = { op: "archive" } as unknown as ArtifactOp;
    const { ports, calls } = portsOf();
    const outcome = await run(applyArtifact(ports, "factory", asNodeId("A"), ART, OP, op));
    expect(outcome).toMatchObject({ kind: "applied", opId: OP, facts: [{ fact: "x" }] });
    expect(calls.submitted[0]).toMatchObject({ actor: { kind: "operator" }, target: { kind: "artifact", nodeId: "A", itemId: ART }, opId: OP });
    expect(calls.changed).toEqual([["artifact", "factory"]]);
    const replay = portsOf({
      artifactSubmit: (command) => Effect.succeed({ kind: "applied", opId: command.opId, artifactId: ART, version: 1, facts: [] } as never),
    });
    await run(applyArtifact(replay.ports, "factory", asNodeId("A"), ART, OP, op));
    expect(replay.calls.changed).toEqual([]);
  });
});
