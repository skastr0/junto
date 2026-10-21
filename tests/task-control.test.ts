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
  TASK_REFUSAL_REASON,
  seatNodeId,
  taskNodeId,
  taskRefusal,
  type TaskCommand,
  type TaskCommandKind,
  type TaskRefusalDetail,
  type TaskView,
} from "../src/shared/task-model";
import type { Canvas } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { ResourceCommand } from "../src/shared/resource-command";
import { REFUSAL } from "../src/shared/resource-command";
import type { WorkErrorBody } from "../src/shared/work-control";
import { ItemId, OpId, TaskNumber } from "../src/shared/work-ids";
import {
  describeTaskRefusal,
  handleTaskOp,
  taskLookupOf,
  taskRefusalError,
  type TaskCaller,
  type TaskPorts,
  type TaskSubmitOutcome,
} from "../src/main/junto/work/task-control";

const OP = OpId.make("01M5ESM1XHCJ7JYJDBC37MREBZ");
const ID = ItemId.make("01M5ESMQ2ZT55QZ073EWPH10SG");
const OTHER = ItemId.make("01M5ESMQ2ZT55QZ073EWPH10SH");

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

const seat = seatNodeId(asNodeId("seat-a"));
const tnode = taskNodeId(asNodeId("tasks-1"));

const details: ReadonlyArray<TaskRefusalDetail> = [
  { kind: "illegal-transition", from: "done", command: "cancel" },
  { kind: "not-assignee", assignee: seat },
  { kind: "not-assignee" },
  { kind: "already-assigned", assignee: seat },
  { kind: "seat-busy", seat, taskId: ID },
  { kind: "not-reviewer", reviewer: { kind: "operator" } },
  { kind: "own-task", seat },
  { kind: "stale-epoch", expected: 3 },
  { kind: "next-required", choices: [tnode] },
  { kind: "next-not-downstream", next: tnode, choices: [] },
  { kind: "invalid-policy", required: -1 },
  { kind: "dependency-cycle", through: [ID, OTHER] },
  { kind: "unknown-task", taskId: ID },
  { kind: "task-exists", taskId: ID },
  { kind: "cannot-review", actor: "automation" },
  { kind: "target-mismatch", target: ID, taskId: OTHER },
  { kind: "wrong-node", nodeId: tnode, expected: "agent" },
];

describe("task refusals", () => {
  it("covers every refusal kind", () => {
    expect(new Set(details.map((detail) => detail.kind))).toEqual(new Set(Object.keys(TASK_REFUSAL_REASON)));
  });

  it("maps each onto the work error its reason names, with the opId", () => {
    for (const detail of details) {
      const refusal = taskRefusal(detail);
      const error = taskRefusalError(refusal, OP);
      expect(error.type).toBe(REFUSAL[refusal.reason].type);
      expect(error.details?.reason).toBe(refusal.reason);
      expect(error.details?.retryable).toBe(REFUSAL[refusal.reason].retryable);
      expect(error.details?.opId).toBe(OP);
      expect(describeTaskRefusal(detail).message.length).toBeGreaterThan(0);
    }
  });

  it("sends a stale stamp back as retryable with the current epoch", () => {
    const error = taskRefusalError(taskRefusal({ kind: "stale-epoch", expected: 3 }), OP);
    expect(error.details?.retryable).toBe(true);
    expect(error.details?.expected).toBe(3);
  });
});

// A canvas with region R holding seats a and b and task node tasks-1, and a
// sibling region S holding seat c and task node tasks-2.
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
      { id: "tasks-2", kind: "task", name: "Other tasks", ...box(800, 200) },
    ].map((node) => [node.id, node]),
  ),
} as unknown as Canvas;

const caller: TaskCaller = {
  canvas,
  canvasName: "factory",
  actor: { kind: "seat", seatId: "seat-generation-a" as ActorSeatId, nodeId: asNodeId("seat-a") },
};

const summary = (current: Partial<TaskView["current"]> = {}): TaskView => ({
  taskId: ID,
  number: TaskNumber.make(42),
  title: "Ship it",
  current: { state: "backlog", node: tnode, epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [], ...current },
  layers: [],
  dependsOn: [],
  createdAt: 1,
  updatedAt: 1,
});

const portsWith = (outcome: TaskSubmitOutcome, submitted: Array<ResourceCommand<TaskCommand>>): TaskPorts => ({
  nodes: (c) => [...c.nodes.values()].filter((node) => node.kind === "task"),
  list: () => Effect.succeed([summary()]),
  find: (_, lookup) =>
    Effect.succeed(
      lookup.kind === "number" ? (lookup.number === 42 ? summary() : undefined) : lookup.taskId === ID ? summary() : undefined,
    ),
  show: (_, task) => Effect.succeed(task),
  submit: (command) => {
    submitted.push(command);
    return Effect.succeed(outcome);
  },
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
    const exit = await run("task.assign", { opId: OP, task: "#42", seat: "@beta" }, portsWith({ kind: "applied", task: summary({ state: "assigned", assignee: seatNodeId(asNodeId("seat-b")) }) }, submitted));
    expect(exit).toEqual(Exit.succeed({ disposition: "applied", opId: OP, taskId: ID, number: 42, state: "assigned" }));
    expect(submitted[0]?.op).toEqual({ kind: "assign", seat: "seat-b" });
    expect(submitted[0]?.target).toEqual({ kind: "task", nodeId: "tasks-1", itemId: ID });
    expect(submitted[0]?.opId).toBe(OP);
  });

  it("assigns to the caller when no seat is named", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    await run("task.assign", { opId: OP, task: ID }, portsWith({ kind: "queued" }, submitted));
    expect(submitted[0]?.op).toEqual({ kind: "assign", seat: "seat-a" });
  });

  it("will not assign a seat in a sibling region", async () => {
    const exit = await run("task.assign", { opId: OP, task: "#42", seat: "@gamma" }, portsWith({ kind: "queued" }, []));
    expect(failure(exit).type).toBe("UnknownTarget");
  });

  it("returns queued with the opId while the editing machine is away", async () => {
    const exit = await run("task.start", { opId: OP, task: "#42" }, portsWith({ kind: "queued" }, []));
    expect(exit).toEqual(Exit.succeed({ disposition: "queued", opId: OP, taskId: ID }));
  });

  it("maps a ruler's refusal onto the work error family", async () => {
    const exit = await run(
      "task.cancel",
      { opId: OP, task: "#42" },
      portsWith({ kind: "refused", refusal: taskRefusal({ kind: "illegal-transition", from: "done", command: "cancel" }) }, []),
    );
    const error = failure(exit);
    expect(error.type).toBe("InvalidTransition");
    expect(error.details?.reason).toBe("invalid_transition");
    expect(error.details?.opId).toBe(OP);
  });

  it("creates on the one task node in reach", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    await run("task.create", { opId: OP, taskId: ID, title: "Ship it", stamps: 1 }, portsWith({ kind: "queued" }, submitted));
    expect(submitted[0]?.target.nodeId).toBe("tasks-1");
    expect(submitted[0]?.op).toEqual({ kind: "create", taskId: ID, title: "Ship it", stampPolicy: { required: 1 } });
  });

  it("refuses to create on a task node out of reach", async () => {
    const exit = await run("task.create", { opId: OP, taskId: ID, title: "x", node: "Other tasks" }, portsWith({ kind: "queued" }, []));
    expect(failure(exit).details?.reason).toBe("not_in_reach");
  });

  it("names the operator as a reviewer", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    await run("task.reviewer-add", { opId: OP, task: "#42", reviewer: "operator" }, portsWith({ kind: "queued" }, submitted));
    expect(submitted[0]?.op).toEqual({ kind: "reviewer-add", reviewer: { kind: "operator" } });
  });

  it("depends on another task by number", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    await run("task.depend", { opId: OP, task: ID, on: "#42" }, portsWith({ kind: "queued" }, submitted));
    expect(submitted[0]?.op).toEqual({ kind: "depend", on: ID });
  });

  it("refuses an edit that changes nothing", async () => {
    const exit = await run("task.edit", { opId: OP, task: "#42" }, portsWith({ kind: "queued" }, []));
    expect(failure(exit).type).toBe("InputError");
  });

  it("reports an unknown task number", async () => {
    const exit = await run("task.start", { opId: OP, task: "#7" }, portsWith({ kind: "queued" }, []));
    expect(failure(exit).message).toBe("no task #7 on this canvas");
  });

  it("comments in the task's thread", async () => {
    const exit = await run("task.comment", { opId: OP, task: "#42", text: "Looks right" }, portsWith({ kind: "queued" }, []));
    expect(exit).toEqual(Exit.succeed({ disposition: "applied", opId: OP, taskId: ID, messageId: "m1" }));
  });

  it("lists every task node in reach, and says when there are more", async () => {
    const exit = await run("task.list", { limit: 1 }, portsWith({ kind: "queued" }, []));
    expect(exit).toEqual(Exit.succeed({ tasks: [summary()], more: false }));
  });
});

// A verb's command kind is the model's, so a renamed kind fails here.
expectTypeOf<(typeof TASK_COMMAND_OPS)[keyof typeof TASK_COMMAND_OPS]>().toEqualTypeOf<TaskCommandKind>();
