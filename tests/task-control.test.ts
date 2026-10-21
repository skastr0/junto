import { describe, expect, expectTypeOf, it } from "vitest";
import { Effect, Exit, Result, Schema } from "effect";
import {
  TASK_ARGS,
  TASK_COMMAND_OPS,
  TASK_READ_OPS,
  TaskAssignArgs,
  TaskCreateArgs,
  TaskListArgs,
  TaskStampArgs,
  isTaskWriteOp,
  type TaskCommandsWithoutVerb,
  type TaskControlOp,
  type TaskWriteResult,
} from "../src/shared/task-control";
import {
  STAMPS_REQUIRED_MAX,
  seatNodeId,
  taskNodeId,
  type TaskCommand,
  type TaskCommandKind,
  type TaskView,
} from "../src/shared/task-model";
import type { TaskRecord } from "../src/shared/task-machine";
import type { Canvas } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { ResourceCommand } from "../src/shared/resource-command";
import type { WorkErrorBody } from "../src/shared/work-control";
import { ItemId, OpId, TaskNumber } from "../src/shared/work-ids";
import {
  handleTaskOp,
  taskCanvasEnv,
  taskLookupOf,
  taskRulingContext,
  type TaskCaller,
  type TaskPorts,
} from "../src/main/junto/work/task-control";
import type { TaskSubmitOutcome } from "../src/main/junto/work/task-repository";

const OP = OpId.make("01M5ESM1XHCJ7JYJDBC37MREBZ");
const ID = ItemId.make("01M5ESMQ2ZT55QZ073EWPH10SG");
const OTHER = ItemId.make("01M5ESMQ2ZT55QZ073EWPH10SH");
const HIDDEN = ItemId.make("01M5ESMQ2ZT55QZ073EWPH10SJ");

const refused = (schema: Schema.Top, value: unknown): boolean =>
  Result.isFailure(Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(value));

describe("task wire contract", () => {
  it("has a verb for every task command, and nothing else", () => {
    expectTypeOf<TaskCommandsWithoutVerb>().toEqualTypeOf<never>();
    const kinds = Object.values(TASK_COMMAND_OPS);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const [op, kind] of Object.entries(TASK_COMMAND_OPS)) expect(op).toBe(`task.${kind}`);
  });

  it("pairs every op with its own input", () => {
    const ops = Object.keys(TASK_ARGS) as ReadonlyArray<TaskControlOp>;
    expect(ops).toHaveLength(TASK_READ_OPS.length + Object.keys(TASK_COMMAND_OPS).length + 1);
    expect(ops.filter(isTaskWriteOp)).toHaveLength(ops.length - TASK_READ_OPS.length);
  });

  it("takes refs as text and ids as ULIDs", () => {
    expect(refused(TaskAssignArgs, { opId: OP, task: "#42" })).toBe(false);
    expect(refused(TaskAssignArgs, { opId: OP, task: "#42", seat: "@cli-lead" })).toBe(false);
    expect(refused(TaskAssignArgs, { opId: "not-a-ulid", task: "#42" })).toBe(true);
    expect(refused(TaskAssignArgs, { opId: OP, task: "" })).toBe(true);
    expect(refused(TaskCreateArgs, { opId: OP, taskId: ID, title: "Ship it" })).toBe(false);
    expect(refused(TaskCreateArgs, { opId: OP, taskId: "t1", title: "Ship it" })).toBe(true);
  });

  it("refuses fields a verb does not take", () => {
    expect(refused(TaskAssignArgs, { opId: OP, task: "#42", state: "working" })).toBe(true);
  });

  it("keeps stamps to approve or changes and states to the 0.10 set", () => {
    expect(refused(TaskStampArgs, { opId: OP, task: "#1", verdict: "approve" })).toBe(false);
    expect(refused(TaskStampArgs, { opId: OP, task: "#1", verdict: "green" })).toBe(true);
    expect(refused(TaskListArgs, { state: ["backlog", "in-review"] })).toBe(false);
    expect(refused(TaskListArgs, { state: ["submitted"] })).toBe(true);
    expect(refused(TaskCreateArgs, { opId: OP, taskId: ID, title: "x", stamps: STAMPS_REQUIRED_MAX + 1 })).toBe(true);
  });

  it("types the write result by disposition", () => {
    expectTypeOf<TaskWriteResult["disposition"]>().toEqualTypeOf<"applied" | "queued">();
    expectTypeOf<Extract<TaskWriteResult, { disposition: "queued" }>>().not.toHaveProperty("state");
  });
});

describe("task refs", () => {
  it("reads #42, 42, an id and a junto:// ref", () => {
    expect(taskLookupOf("#42")).toEqual({ kind: "number", number: 42 });
    expect(taskLookupOf(" 7 ")).toEqual({ kind: "number", number: 7 });
    expect(taskLookupOf(ID)).toEqual({ kind: "id", taskId: ID });
    expect(taskLookupOf(`junto://canvas/factory?node=tasks-1&item=${ID}`)).toEqual({ kind: "id", taskId: ID });
  });

  it("names nothing for a node ref, T-42 or #0", () => {
    expect(taskLookupOf("junto://canvas/factory?node=tasks-1")).toBeUndefined();
    expect(taskLookupOf("T-42")).toBeUndefined();
    expect(taskLookupOf("#0")).toBeUndefined();
  });
});

// Region R holds seats alpha and beta and task nodes "CLI tasks" (tasks-1)
// and "Review" (tasks-3); tasks-1 feeds tasks-3. Sibling region S holds seat
// gamma and its own node also named "CLI tasks" (tasks-2).
const box = (x: number, y: number, width = 50, height = 50) => ({ x, y, width, height });
const canvas = {
  nodes: new Map(
    [
      { id: "R", kind: "region", label: "R", ...box(0, 0, 500, 500) },
      { id: "S", kind: "region", label: "S", ...box(600, 0, 500, 500) },
      { id: "seat-a", kind: "agent", label: "alpha", agentKey: "a", ...box(10, 10) },
      { id: "seat-b", kind: "agent", label: "beta", agentKey: "b", ...box(100, 10) },
      { id: "seat-c", kind: "agent", label: "gamma", agentKey: "c", ...box(610, 10) },
      { id: "tasks-1", kind: "task", name: "CLI tasks", ...box(200, 200) },
      { id: "tasks-3", kind: "task", name: "Review", ...box(300, 300) },
      { id: "tasks-2", kind: "task", name: "CLI tasks", ...box(800, 200) },
    ].map((node) => [node.id, node]),
  ),
  wires: new Map([["w1", { id: "w1", from: "tasks-1", to: "tasks-3", verb: "feeds" }]]),
} as unknown as Canvas;

const caller: TaskCaller = {
  canvas,
  canvasName: "factory",
  actor: { kind: "seat", seatId: "seat-generation-a" as ActorSeatId, nodeId: asNodeId("seat-a") },
};

const tnode = taskNodeId(asNodeId("tasks-1"));

const view = (taskId: ItemId, number: number, node = tnode, current: Partial<TaskView["current"]> = {}): TaskView => ({
  taskId,
  number: TaskNumber.make(number),
  title: "Ship it",
  current: { state: "backlog", node, epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [], ...current },
  layers: [],
  dependsOn: [],
  createdAt: 1,
  updatedAt: 1,
});

// #42 and #43 sit on tasks-1, in reach; #44 sits on tasks-2, out of it.
const tasks = [view(ID, 42), view(OTHER, 43), view(HIDDEN, 44, taskNodeId(asNodeId("tasks-2")))];

const record = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: ID,
  number: TaskNumber.make(42),
  title: "Ship it",
  dependsOn: [],
  state: "assigned",
  node: tnode,
  epoch: 0,
  stampPolicy: { required: 0 },
  reviewers: [],
  stamps: [],
  ...overrides,
});

const applied = (overrides: Partial<TaskRecord> = {}): TaskSubmitOutcome => ({
  kind: "applied",
  opId: OP,
  task: record(overrides),
  effects: [],
  replay: false,
});

const portsWith = (outcome: TaskSubmitOutcome, submitted: Array<ResourceCommand<TaskCommand>> = []): TaskPorts => ({
  nodes: (c) => [...c.nodes.values()].filter((node) => node.kind === "task"),
  list: (_, query) => {
    const on = tasks.filter((task) => query.nodeIds.includes(task.current.node));
    return Effect.succeed({ tasks: on.slice(0, query.limit), more: on.length > query.limit });
  },
  find: (_c, _n, lookup) =>
    Effect.succeed(tasks.find((task) => (lookup.kind === "number" ? task.number === lookup.number : task.taskId === lookup.taskId))),
  submit: (command) => {
    submitted.push(command);
    return Effect.succeed(outcome);
  },
  deliver: () => Effect.void,
  comment: () => Effect.succeed({ messageId: "m1" }),
});

const run = (op: TaskControlOp, args: unknown, ports: TaskPorts) => Effect.runPromiseExit(handleTaskOp(op, args, caller, ports));

const failure = (exit: Exit.Exit<unknown, WorkErrorBody>): WorkErrorBody => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error === undefined) throw new Error("expected a typed failure");
  return (error as { readonly error: WorkErrorBody }).error;
};

describe("task verbs", () => {
  it("assigns to a seat named by @name in the task's reach", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    const exit = await run("task.assign", { opId: OP, task: "#42", seat: "@beta" }, portsWith(applied({ assignee: seatNodeId(asNodeId("seat-b")) }), submitted));
    expect(exit).toEqual(Exit.succeed({ disposition: "applied", opId: OP, taskId: ID, number: 42, state: "assigned" }));
    expect(submitted[0]?.op).toEqual({ kind: "assign", seat: "seat-b" });
    expect(submitted[0]?.target).toEqual({ kind: "task", nodeId: "tasks-1", itemId: ID });
    expect(submitted[0]?.opId).toBe(OP);
  });

  it("assigns to the caller when no seat is named, or when it names itself", async () => {
    for (const seat of [undefined, "@alpha", "seat-a"]) {
      const submitted: Array<ResourceCommand<TaskCommand>> = [];
      await run("task.assign", { opId: OP, task: ID, ...(seat === undefined ? {} : { seat }) }, portsWith(applied(), submitted));
      expect(submitted[0]?.op).toEqual({ kind: "assign", seat: "seat-a" });
    }
  });

  it("will not assign a seat in a sibling region", async () => {
    const exit = await run("task.assign", { opId: OP, task: "#42", seat: "@gamma" }, portsWith(applied()));
    expect(failure(exit).type).toBe("UnknownTarget");
  });

  it("stamps the opId on a refusal from any stage of the ruler", async () => {
    const error: WorkErrorBody = { type: "ScopeError", message: "The resource is not in this actor's reach", details: { reason: "not_in_reach", retryable: false } };
    const exit = await run("task.cancel", { opId: OP, task: "#42" }, portsWith({ kind: "refused", opId: OP, error, root: OP }));
    expect(failure(exit)).toEqual({ ...error, details: { ...error.details, opId: OP } });
  });

  it("creates on the one task node in reach, though a sibling node shares its name", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    await run("task.create", { opId: OP, taskId: ID, title: "Ship it", stamps: 1, node: "CLI tasks" }, portsWith(applied(), submitted));
    expect(submitted[0]?.target.nodeId).toBe("tasks-1");
    expect(submitted[0]?.op).toEqual({ kind: "create", taskId: ID, title: "Ship it", stampPolicy: { required: 1 } });
  });

  it("reads a task out of reach as missing, the same as one that is not there", async () => {
    const hidden = failure(await run("task.show", { task: "#44" }, portsWith(applied())));
    const missing = failure(await run("task.show", { task: "#7" }, portsWith(applied())));
    expect(hidden.type).toBe("UnknownTarget");
    expect(missing.type).toBe("UnknownTarget");
    expect(hidden.message).toBe("no task #44 in this seat's reach");
  });

  it("depends on another task by number, only within reach", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    await run("task.depend", { opId: OP, task: "#42", on: "#43" }, portsWith(applied(), submitted));
    expect(submitted[0]?.op).toEqual({ kind: "depend", on: OTHER });
    expect(failure(await run("task.depend", { opId: OP, task: "#42", on: "#44" }, portsWith(applied()))).type).toBe("UnknownTarget");
  });

  it("finishes on to a downstream node, and nowhere else", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    await run("task.finish", { opId: OP, task: "#42", next: "Review" }, portsWith(applied(), submitted));
    expect(submitted[0]?.op).toEqual({ kind: "finish", next: "tasks-3" });
    expect(failure(await run("task.finish", { opId: OP, task: "#42", next: "CLI tasks" }, portsWith(applied()))).type).toBe("UnknownTarget");
  });

  it("delivers a fresh ruling's mail as the actor's, and a replay's never", async () => {
    for (const replay of [false, true]) {
      const delivered: Array<Parameters<TaskPorts["deliver"]>[0]> = [];
      const ports = { ...portsWith({ kind: "applied", opId: OP, task: record(), effects: [{ kind: "number-minted", number: TaskNumber.make(42) }], replay }), deliver: (d: Parameters<TaskPorts["deliver"]>[0]) => {
        delivered.push(d);
        return Effect.void;
      } };
      await run("task.start", { opId: OP, task: "#42" }, ports);
      expect(delivered.map((d) => [d.opId, d.actor, d.canvasName, d.task.id, d.effects.length])).toEqual(
        replay ? [] : [[OP, caller.actor, "factory", ID, 1]],
      );
    }
  });

  it("names the operator as a reviewer", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    await run("task.reviewer-add", { opId: OP, task: "#42", reviewer: "operator" }, portsWith(applied(), submitted));
    expect(submitted[0]?.op).toEqual({ kind: "reviewer-add", reviewer: { kind: "operator" } });
  });

  it("refuses an edit that changes nothing", async () => {
    expect(failure(await run("task.edit", { opId: OP, task: "#42" }, portsWith(applied()))).type).toBe("InputError");
  });

  it("comments in the task's thread", async () => {
    const exit = await run("task.comment", { opId: OP, task: "#42", text: "Looks right" }, portsWith(applied()));
    expect(exit).toEqual(Exit.succeed({ disposition: "applied", opId: OP, taskId: ID, messageId: "m1" }));
  });

  it("lists the task nodes in reach and says when there are more", async () => {
    expect(await run("task.list", { limit: 1 }, portsWith(applied()))).toEqual(Exit.succeed({ tasks: [tasks[0]], more: true }));
    expect(await run("task.list", {}, portsWith(applied()))).toEqual(Exit.succeed({ tasks: tasks.slice(0, 2), more: false }));
  });

  it("lists by assignee, the caller's own name included", async () => {
    const exit = await run("task.list", { assignee: "@alpha" }, portsWith(applied()));
    expect(exit).toEqual(Exit.succeed({ tasks: [], more: false }));
  });
});

describe("what the ruler reads of the canvas", () => {
  it("sends on along feeds wires and checks seat reach", () => {
    const env = taskCanvasEnv(canvas);
    expect(env.downstream(tnode)).toEqual(["tasks-3"]);
    expect(env.seatReaches(seatNodeId(asNodeId("seat-b")), tnode)).toBe(true);
    expect(env.seatReaches(seatNodeId(asNodeId("seat-c")), tnode)).toBe(false);
  });

  it("puts a seat's reach and the operator's whole canvas in the ruling context", () => {
    const context = taskRulingContext(canvas);
    const target = { kind: "task" as const, nodeId: asNodeId("tasks-2") };
    expect(context.inReach(caller.actor, target)).toBe(false);
    expect(context.inReach({ kind: "operator" }, target)).toBe(true);
  });
});

// A verb's command kind is the model's, so a renamed kind fails here.
expectTypeOf<(typeof TASK_COMMAND_OPS)[keyof typeof TASK_COMMAND_OPS]>().toEqualTypeOf<TaskCommandKind>();
