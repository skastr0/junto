import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { TASKS_ENABLED } from "../src/shared/features";
import { Effect, Exit, Result, Schema } from "effect";
import {
  TASK_ARGS,
  TASK_COMMAND_OPS,
  TASK_READ_OPS,
  TaskAssignArgs,
  TaskCreateArgs,
  TaskFinishArgs,
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
import { emptyTaskBoard, ruleTaskBoardCommand, taskDomain, type TaskRecord } from "../src/shared/task-machine";
import { emptyRuled, rule } from "../src/shared/resource-command";
import { rulingContextOf } from "../src/shared/ruling-context";
import type { Canvas } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { ResourceCommand } from "../src/shared/resource-command";
import type { MailMessageId } from "../src/shared/crew";
import type { WorkErrorBody } from "../src/shared/work-control";
import { ItemId, OpId, TaskNumber } from "../src/shared/work-ids";
import { mentionLink } from "../src/shared/mention";
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
// and "Review" (tasks-3); tasks-1 flows into tasks-3. Sibling region S holds seat
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
  wires: new Map([["w1", { id: "w1", from: "tasks-1", to: "tasks-3", verb: "flows" }]]),
} as unknown as Canvas;

const caller: TaskCaller = {
  canvas,
  canvasName: "factory",
  actor: { kind: "seat", seatId: "seat-generation-a" as ActorSeatId, nodeId: asNodeId("seat-a") },
};

/** alpha with the overseer flag on or off. */
const flagged = (overseer: boolean): TaskCaller => {
  const nodes = new Map(canvas.nodes);
  nodes.set(asNodeId("seat-a"), { ...canvas.nodes.get(asNodeId("seat-a"))!, overseer } as never);
  return { ...caller, canvas: { ...canvas, nodes } as unknown as Canvas };
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
  stateSince: 1,
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

const commented: Array<Parameters<TaskPorts["comment"]>[0]> = [];
const people: Array<ReadonlyArray<string>> = [];

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
  changes: () => () => undefined,
  now: () => 0,
  comment: (input, context) => {
    commented.push(input);
    people.push(context.people);
    return Effect.succeed({ threadId: "t1" as MailMessageId, messageId: "m1" as MailMessageId, notified: [] });
  },
});

const run = (op: TaskControlOp, args: unknown, ports: TaskPorts) => Effect.runPromiseExit(handleTaskOp(op, args, caller, ports));

const failure = (exit: Exit.Exit<unknown, WorkErrorBody>): WorkErrorBody => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error === undefined) throw new Error("expected a typed failure");
  return (error as { readonly error: WorkErrorBody }).error;
};

describe.runIf(TASKS_ENABLED)("task verbs", () => {
  it("assigns to a seat named by @name in the task's reach", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    const exit = await run("task.assign", { opId: OP, task: "#42", seat: "@beta" }, portsWith(applied({ assignee: seatNodeId(asNodeId("seat-b")) }), submitted));
    expect(exit).toEqual(Exit.succeed({ disposition: "applied", opId: OP, taskId: ID, number: 42, state: "assigned" }));
    expect(submitted[0]?.op).toEqual({ kind: "assign", seat: "seat-b" });
    expect(submitted[0]?.target).toEqual({ kind: "task", nodeId: "tasks-1", itemId: ID });
    expect(submitted[0]?.opId).toBe(OP);
  });

  it("assigns to the caller when no seat is named, or when it names itself", async () => {
    for (const seat of [undefined, "@alpha", "seat-a", "me", "@me"]) {
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

  it("points a comment on a missing task number to the list of tasks in reach", async () => {
    const missing = failure(await run("task.comment", { opId: OP, task: "#9999", text: "hi" }, portsWith(applied())));
    expect(missing.type).toBe("UnknownTarget");
    expect(missing.details?.next_step).toBe("run junto task list to see the tasks in reach");
  });

  it("refuses rules, wait and check on a task or node out of reach, as missing", async () => {
    const ports = portsWith(applied());
    const byTask = failure(await run("task.rules", { task: "#44" }, ports));
    expect([byTask.type, byTask.message]).toEqual(["UnknownTarget", "no task #44 in this seat's reach"]);
    // tasks-2 shares its name with tasks-1; by name or by id, only the node in reach answers.
    const byNode = failure(await run("task.rules", { node: "tasks-2" }, ports));
    expect([byNode.type, byNode.details?.path]).toEqual(["UnknownTarget", "node"]);
    expect(Exit.isSuccess(await run("task.rules", { node: "CLI tasks" }, ports))).toBe(true);
    const waited = failure(await run("task.wait", { task: "#44", until: "done", timeoutMs: 0 }, ports));
    expect([waited.type, waited.message]).toEqual(["UnknownTarget", "no task #44 in this seat's reach"]);
    const checked = failure(await run("task.check", {
      opId: OP, task: "#44", results: [{ checkId: "c1", side: "outgoing", exitCode: 0, outputTail: "" }],
    }, ports));
    expect([checked.type, checked.message]).toEqual(["UnknownTarget", "no task #44 in this seat's reach"]);
  });

  it("lets a live overseer seat reach any Tasks node on its own canvas, with no edge", async () => {
    // tasks-2 sits in sibling region S, unwired.
    // A task whose node is on no node of this canvas: another canvas's.
    const elsewhere = view(HIDDEN, 45, taskNodeId(asNodeId("tasks-9")));
    const ports: TaskPorts = {
      ...portsWith(applied()),
      find: (_c, _n, lookup) => Effect.succeed([...tasks, elsewhere].find((task) => lookup.kind === "number" && task.number === lookup.number)),
    };
    const as = (who: TaskCaller, op: TaskControlOp, args: unknown) => Effect.runPromiseExit(handleTaskOp(op, args, who, ports));

    const on = flagged(true);
    expect(Exit.isSuccess(await as(on, "task.show", { task: "#44" }))).toBe(true);
    expect(Exit.isSuccess(await as(on, "task.rules", { node: "tasks-2" }))).toBe(true);
    const listed = await as(on, "task.list", {});
    expect(Exit.isSuccess(listed) && (listed.value as { tasks: ReadonlyArray<TaskView> }).tasks.map((task) => task.number)).toEqual([42, 43, 44]);
    expect(taskCanvasEnv(on.canvas).seatReaches(seatNodeId(asNodeId("seat-a")), taskNodeId(asNodeId("tasks-2")))).toBe(true);
    // Reach is not a seat: a non-task node is still no task node.
    expect(Exit.isFailure(await as(on, "task.rules", { node: "seat-c" }))).toBe(true);

    const off = flagged(false);
    expect(failure(await as(off, "task.show", { task: "#44" })).message).toBe("no task #44 in this seat's reach");
    expect(failure(await as(off, "task.rules", { node: "tasks-2" })).type).toBe("UnknownTarget");
    expect(taskCanvasEnv(off.canvas).seatReaches(seatNodeId(asNodeId("seat-a")), taskNodeId(asNodeId("tasks-2")))).toBe(false);

    expect(failure(await as(on, "task.show", { task: "#45" })).message).toBe("no task #45 in this seat's reach");
    // Reach is all it gains: the assignee's moves stay the assignee's.
    const far = taskNodeId(asNodeId("tasks-2"));
    const started = ruleTaskBoardCommand(
      { tasks: new Map([[ID, record({ node: far, state: "assigned", assignee: seatNodeId(asNodeId("seat-c")) })]]), nextNumber: TaskNumber.make(43) },
      { node: far, taskId: ID },
      { kind: "seat", seat: seatNodeId(asNodeId("seat-a")) },
      { kind: "start" },
      { ...taskCanvasEnv(on.canvas), at: 1 },
    );
    expect(started.ok).toBe(false);
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

  it("carries finish evidence into the command, with or without next", async () => {
    const evidence = { artifacts: [{ nodeId: "art-1", artifactId: "a1" }], git: { commits: ["abc123"] }, claims: [{ ruleId: "tests", text: "green" }] };
    for (const next of [undefined, "Review"]) {
      const submitted: Array<ResourceCommand<TaskCommand>> = [];
      await run("task.finish", { opId: OP, task: "#42", evidence, ...(next === undefined ? {} : { next }) }, portsWith(applied(), submitted));
      expect(submitted[0]?.op).toEqual({ kind: "finish", evidence, ...(next === undefined ? {} : { next: "tasks-3" }) });
    }
    expect(refused(TaskFinishArgs, { opId: OP, task: "#42", evidence: { claims: [] } })).toBe(true);
  });

  it("puts the opId on a refused comment", async () => {
    const ports = { ...portsWith(applied()), comment: () => Effect.fail<WorkErrorBody>({ type: "ScopeError", message: "not in reach", details: { reason: "not_in_reach" } }) };
    const error = failure(await run("task.comment", { opId: OP, task: "#42", text: "hi" }, ports));
    expect(error.details).toEqual({ reason: "not_in_reach", opId: OP });
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
    commented.length = 0;
    people.length = 0;
    const exit = await run("task.comment", { opId: OP, task: "#42", text: "Looks right" }, portsWith(applied()));
    expect(exit).toEqual(Exit.succeed({ disposition: "applied", opId: OP, taskId: ID, threadId: "t1", messageId: "m1", notified: [] }));
    expect(commented).toEqual([{ subject: { kind: "task", nodeId: "tasks-1", taskId: ID }, text: "Looks right", actor: caller.actor, opId: OP }]);
    expect(people).toEqual([[]]);
  });

  it("writes each @name in a comment as its mention link, and refuses a seat out of the task's reach", async () => {
    commented.length = 0;
    const exit = await run("task.comment", { opId: OP, task: "#42", text: "@beta see `@gamma`" }, portsWith(applied()));
    expect(Exit.isSuccess(exit)).toBe(true);
    const beta = mentionLink({ kind: "seat", nodeId: asNodeId("seat-b") }, "@beta", "factory");
    expect(commented.map((comment) => comment.text)).toEqual([`${beta} see \`@gamma\``]);
    const refused = failure(await run("task.comment", { opId: OP, task: "#42", text: "@gamma look" }, portsWith(applied())));
    expect(refused).toMatchObject({ type: "UnknownTarget", details: { path: "text", target: "@gamma", opId: OP } });
  });

  it("lists the task nodes in reach and says when there are more", async () => {
    expect(await run("task.list", { limit: 1 }, portsWith(applied()))).toEqual(Exit.succeed({ tasks: [tasks[0]], more: true }));
    expect(await run("task.list", {}, portsWith(applied()))).toEqual(Exit.succeed({ tasks: tasks.slice(0, 2), more: false }));
  });

  it("lists by assignee, the caller's own name included", async () => {
    const exit = await run("task.list", { assignee: "@alpha" }, portsWith(applied()));
    expect(exit).toEqual(Exit.succeed({ tasks: [], more: false }));
  });

  describe("by reviewer", () => {
    const alpha = { kind: "seat", seat: seatNodeId(asNodeId("seat-a")) } as const;
    const beta = { kind: "seat", seat: seatNodeId(asNodeId("seat-b")) } as const;
    const id = (n: number) => ItemId.make(`01M5ESMQ2ZT55QZ073EWPH10${n}`);
    const review = (n: number, since: number, current: Partial<TaskView["current"]>): TaskView => ({
      ...view(id(n), n, tnode, { state: "in-review", epoch: 1, ...current }),
      stateSince: since,
    });
    const reviews = [
      review(50, 1, { reviewers: [alpha], stamps: [{ reviewer: alpha, verdict: "approve", epoch: 1, at: 3 }] }),
      review(51, 5, { reviewers: [alpha, beta], stamps: [{ reviewer: alpha, verdict: "approve", epoch: 0, at: 2 }] }),
      review(52, 1, { reviewers: [beta] }),
      review(53, 2, { reviewers: [alpha] }),
      review(54, 1, { state: "working", reviewers: [alpha] }),
    ];
    const ports: TaskPorts = {
      ...portsWith(applied()),
      list: (_, query) => {
        const on = reviews.filter((task) => query.nodeIds.includes(task.current.node) && (query.states?.includes(task.current.state) ?? true));
        return Effect.succeed({ tasks: on.slice(0, query.limit), more: on.length > query.limit });
      },
    };
    const numbers = (exit: Exit.Exit<unknown, WorkErrorBody>) =>
      Exit.isSuccess(exit) ? (exit.value as { tasks: ReadonlyArray<TaskView> }).tasks.map((task) => task.number) : exit;

    it("lists the reviews this seat owes, longest waiting first, past an earlier epoch's stamp", async () => {
      expect(numbers(await run("task.list", { reviewer: "me" }, ports))).toEqual([53, 51]);
    });

    it("drops a review once stamped at the current epoch, and shows no other seat's", async () => {
      expect(numbers(await run("task.list", { reviewer: "@beta" }, ports))).toEqual([52, 51]);
      expect(numbers(await run("task.list", { reviewer: "me", state: ["working"] }, ports))).toEqual([]);
    });

    it("names a reviewer by the same reach as an assignee", async () => {
      expect(failure(await run("task.list", { reviewer: "@gamma" }, ports))).toMatchObject({ type: "UnknownTarget", details: { path: "reviewer" } });
    });
  });
});

describe.runIf(TASKS_ENABLED)("task rules and wait", () => {
  const ruled = { ...canvas, nodes: new Map<string, unknown>([...canvas.nodes].map(([id, node]) =>
    [id, id === "tasks-1" ? { ...(node as object), contract: { rules: [{ id: "tests", text: "Tests pass" }] } } : node])) } as unknown as Canvas;
  const at = (ports: TaskPorts) => (op: TaskControlOp, args: unknown) =>
    Effect.runPromiseExit(handleTaskOp(op, args, { ...caller, canvas: ruled }, ports));

  it("gives the rules in force where the task sits, each unanswered until its finish", async () => {
    const exit = await at(portsWith(applied()))("task.rules", { task: "#42" });
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toEqual({
      node: "tasks-1",
      rules: [{ rule: { id: "tests", text: "Tests pass" }, provenance: { kind: "board", boardId: "tasks-1" } }],
      task: { taskId: ID, unanswered: [{ ruleId: "tests", text: "Tests pass" }], checks: [{ destination: "tasks-3", checks: [] }] },
    });
    const node = await at(portsWith(applied()))("task.rules", { node: "tasks-3" });
    expect(Exit.isSuccess(node) ? node.value : undefined).toEqual({ node: "tasks-3", rules: [] });
    expect(failure(await at(portsWith(applied()))("task.rules", { task: "#44" }))).toMatchObject({ type: "UnknownTarget" });
  });

  it("answers at once when the task is already in the state, and refuses rejected", async () => {
    const exit = await at(portsWith(applied()))("task.wait", { task: "#42", until: "backlog" as never });
    expect(failure(exit)).toMatchObject({ type: "InputError" });
    const done = { ...portsWith(applied()), find: () => Effect.succeed({ ...tasks[0]!, current: { ...tasks[0]!.current, state: "done" as const } }) };
    const now = await at(done)("task.wait", { task: "#42", until: "done" });
    expect(Exit.isSuccess(now) ? now.value : undefined).toMatchObject({ taskId: ID, state: "done", epoch: 0 });
    expect(failure(await at(portsWith(applied()))("task.wait", { task: "#42", until: "rejected" }))).toMatchObject({ type: "InputError" });
  });

  it("wakes on a change to the canvas's tasks, and times out with the last state", async () => {
    let state: "working" | "in-review" = "working";
    const listeners = new Set<(canvasName: string) => void>();
    const ports: TaskPorts = {
      ...portsWith(applied()),
      find: () => Effect.succeed({ ...tasks[0]!, current: { ...tasks[0]!.current, state, assignee: seatNodeId(asNodeId("seat-a")) } }),
      changes: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      now: () => Date.now(),
    };
    const waiting = at(ports)("task.wait", { task: "#42", until: "in-review", timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const listener of listeners) listener("elsewhere");
    state = "in-review";
    for (const listener of [...listeners]) listener("factory");
    const woke = await waiting;
    expect(Exit.isSuccess(woke) ? woke.value : undefined).toMatchObject({ state: "in-review" });
    expect(listeners.size).toBe(0);

    // A woken wait leaves no deadline timer armed.
    vi.useFakeTimers();
    try {
      state = "working";
      const again = at(ports)("task.wait", { task: "#42", until: "in-review", timeoutMs: 600_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      state = "in-review";
      for (const listener of [...listeners]) listener("factory");
      expect(Exit.isSuccess(await again)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    state = "working";
    const timedOut = failure(await at(ports)("task.wait", { task: "#42", until: "done", timeoutMs: 30 }));
    expect(timedOut).toMatchObject({ type: "Timeout", details: { from: "working", to: "done" } });
  });
});

describe.runIf(TASKS_ENABLED)("task check", () => {
  // tasks-1 runs "unit" on the way out; tasks-3 runs "smoke" on the way in.
  const checked = { ...canvas, nodes: new Map<string, unknown>([...canvas.nodes].map(([id, node]) =>
    [id, id === "tasks-1"
      ? { ...(node as object), contract: { outgoing: { checks: [{ id: "unit", label: "Unit", command: "bun test" }] } } }
      : id === "tasks-3"
        ? { ...(node as object), contract: { incoming: { checks: [{ id: "smoke", label: "Smoke", command: "./smoke" }] } } }
        : node])) } as unknown as Canvas;
  const at = (ports: TaskPorts) => (op: TaskControlOp, args: unknown) =>
    Effect.runPromiseExit(handleTaskOp(op, args, { ...caller, canvas: checked }, ports));
  const unit = (exitCode: number) => ({ checkId: "unit", side: "outgoing" as const, exitCode, outputTail: "ok" });

  it("reports runs with the command the node names, the incoming ones toward the next node", async () => {
    const submitted: Array<ResourceCommand<TaskCommand>> = [];
    const exit = await at(portsWith(applied(), submitted))("task.check", {
      opId: OP, task: "#42", results: [unit(0), { checkId: "smoke", side: "incoming", exitCode: 1, outputTail: "x".repeat(20_000) }],
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    const sent = submitted[0]!.op as Extract<TaskCommand, { kind: "check" }>;
    expect(sent.kind).toBe("check");
    expect(sent.results[0]).toEqual({ checkId: "unit", side: "outgoing", command: "bun test", exitCode: 0, outputTail: "ok" });
    expect(sent.results[1]).toMatchObject({ checkId: "smoke", command: "./smoke", exitCode: 1 });
    expect(sent.results[1]!.outputTail).toHaveLength(8 * 1024);
  });

  it("refuses a check the node does not name", async () => {
    const exit = await at(portsWith(applied()))("task.check", { opId: OP, task: "#42", results: [{ ...unit(0), checkId: "lint" }] });
    expect(failure(exit)).toMatchObject({ type: "UnknownTarget", details: { path: "results.0.checkId", received: "lint" } });
  });

  it("finds each required check green, red, missing or stale toward the next node, and finish refuses until green", () => {
    const env = taskCanvasEnv(checked);
    const next = taskNodeId(asNodeId("tasks-3"));
    const run = (checkId: string, side: "outgoing" | "incoming", command: string, exitCode: number) =>
      ({ checkId, side, command, exitCode, outputTail: "", epoch: 0, at: 1, ...(side === "incoming" ? { destination: next } : {}) });
    expect(env.checksUnmet(tnode, next, [])).toEqual({ red: [], missing: ["unit", "smoke"] });
    expect(env.checksUnmet(tnode, next, [run("unit", "outgoing", "bun test", 1), run("smoke", "incoming", "./old-smoke", 0)]))
      .toEqual({ red: ["unit"], missing: ["smoke"] });
    expect(env.checksUnmet(tnode, next, [run("unit", "outgoing", "bun test", 0), run("smoke", "incoming", "./smoke", 0)])).toBeUndefined();
    // With nowhere to go, only the node's own outgoing checks are required.
    expect(env.checksUnmet(taskNodeId(asNodeId("tasks-3")), undefined, [])).toBeUndefined();
  });

  it("shows the checks in task rules with their status", async () => {
    const ran = { ...tasks[0]!, current: { ...tasks[0]!.current, state: "working" as const, checks: [
      { checkId: "unit", side: "outgoing" as const, command: "bun test", exitCode: 1, outputTail: "", epoch: 0, at: 1 },
    ] } };
    const exit = await at({ ...portsWith(applied()), find: () => Effect.succeed(ran) })("task.rules", { task: "#42" });
    expect(Exit.isSuccess(exit) ? (exit.value as { task: { checks: unknown } }).task.checks : undefined).toEqual([{
      destination: "tasks-3",
      checks: [
        { checkId: "unit", side: "outgoing", label: "Unit", command: "bun test", status: "red" },
        { checkId: "smoke", side: "incoming", label: "Smoke", command: "./smoke", status: "missing" },
      ],
    }]);
  });
});

describe("what the ruler reads of the canvas", () => {
  it("sends on along flows wires and checks seat reach", () => {
    const env = taskCanvasEnv(canvas);
    expect(env.downstream(tnode)).toEqual(["tasks-3"]);
    expect(env.seatReaches(seatNodeId(asNodeId("seat-b")), tnode)).toBe(true);
    expect(env.seatReaches(seatNodeId(asNodeId("seat-c")), tnode)).toBe(false);
  });

  it("reaches for an automation by its author, and not at all without one", () => {
    const automations = { ...canvas, nodes: new Map<string, unknown>([...canvas.nodes, ["auto", { id: "auto", kind: "automations", name: "Automations", ...box(400, 100) }]]) } as unknown as Canvas;
    const auto = asNodeId("auto");
    expect(taskCanvasEnv(automations).automationReaches?.(auto, tnode)).toBe(false);
    expect(taskCanvasEnv(automations, () => ({ kind: "operator" })).automationReaches?.(auto, tnode)).toBe(true);
    expect(taskCanvasEnv(automations, () => ({ kind: "operator" })).automationReaches?.(auto, taskNodeId(asNodeId("tasks-2")))).toBe(false);
  });

  it("gives a task node's stamp default from its contract, and none without one", () => {
    const stamped = { ...canvas, nodes: new Map<string, unknown>([...canvas.nodes].map(([id, node]) =>
      [id, id === "tasks-1" ? { ...(node as object), contract: { stampDefault: { required: 2 } } } : node])) } as unknown as Canvas;
    expect(taskCanvasEnv(stamped).stampDefaultOf(tnode)).toEqual({ required: 2 });
    expect(taskCanvasEnv(stamped).stampDefaultOf(taskNodeId(asNodeId("tasks-3")))).toEqual({ required: 0 });
  });

  it("refuses a finish that leaves a rule in force unanswered, and lets a claim through", () => {
    const ruled = { ...canvas, nodes: new Map<string, unknown>([...canvas.nodes].map(([id, node]) =>
      [id, id === "tasks-1" ? { ...(node as object), contract: { rules: [{ id: "tests", text: "Tests pass" }] } } : node])) } as unknown as Canvas;
    const finish = (evidence?: Record<string, unknown>) =>
      ruleTaskBoardCommand(
        { tasks: new Map([[ID, record({ state: "working", assignee: seatNodeId(asNodeId("seat-a")) })]]), nextNumber: TaskNumber.make(43) },
        { node: tnode, taskId: ID },
        { kind: "seat", seat: seatNodeId(asNodeId("seat-a")) },
        { kind: "finish", next: taskNodeId(asNodeId("tasks-3")), ...(evidence === undefined ? {} : { evidence: evidence as never }) },
        { ...taskCanvasEnv(ruled), at: 1 },
      );
    const unmet = finish();
    expect(unmet.ok ? undefined : unmet.refusal).toMatchObject({ detail: { kind: "rules-unmet", missing: "claims", ruleId: "tests" } });
    // A waiver answers a task's own rule on a path it left, never the node's.
    const waived = finish({ artifacts: [], waivers: [{ ruleId: "tests", reason: "n/a" }] });
    expect(waived.ok).toBe(false);
    expect(finish({ artifacts: [], claims: [{ ruleId: "tests", text: "vitest is green" }] }).ok).toBe(true);
    expect(taskCanvasEnv(canvas).rulesUnmet(tnode, ID, undefined)).toBeUndefined();
  });

  it("puts a seat's reach and the operator's whole canvas in the ruling context", () => {
    const context = taskRulingContext(canvas);
    const target = { kind: "task" as const, nodeId: asNodeId("tasks-2") };
    expect(context.inReach(caller.actor, target)).toBe(false);
    expect(context.inReach({ kind: "operator" }, target)).toBe(true);
  });

  it("rules an overseer's write on a far Tasks node applied, and the same seat's refused with the flag off", () => {
    // The real gate: rule() admits on the ruling context, then the task domain rules.
    const far = { kind: "task" as const, nodeId: asNodeId("tasks-2"), itemId: ID };
    const create = (on: boolean) => {
      const at = flagged(on).canvas;
      return rule(taskDomain({ ...taskCanvasEnv(at), at: 1 }), emptyRuled(emptyTaskBoard()), "install-1" as never, {
        opId: OP, canvasName: "factory", actor: caller.actor, target: far, basis: null, after: [],
        op: { kind: "create", taskId: ID, title: "Ship it" },
      }, taskRulingContext(at)).ruling;
    };
    expect(create(true).kind).toBe("applied");
    const off = create(false);
    expect(off.kind === "refused" && off.error.details?.reason).toBe("not_in_reach");
    // An artifact node stays plain reach, overseer or not.
    const artifact = { kind: "artifact" as const, nodeId: asNodeId("tasks-2") };
    expect(rulingContextOf({ nodes: new Map([...flagged(true).canvas.nodes].map(([id, node]) => [id, id === "tasks-2" ? { ...node, kind: "artifact" } : node])) } as never, () => undefined)
      .inReach(caller.actor, artifact)).toBe(false);
  });
});

describe.runIf(!TASKS_ENABLED)("a tasks-off build", () => {
  it("refuses every task op, for every seat, before it reads a task", async () => {
    // A canvas a tasks-on machine wrote still holds task nodes; none makes a task op runnable.
    const ports = { ...portsWith(applied()), find: () => Effect.die("read a task") } as TaskPorts;
    for (const who of [caller, flagged(true)]) {
      for (const op of Object.keys(TASK_ARGS) as ReadonlyArray<TaskControlOp>) {
        const refused = failure(await Effect.runPromiseExit(handleTaskOp(op, { task: "#42" }, who, ports)));
        expect([refused.type, refused.details?.missing, refused.details?.reason], op).toEqual(["ScopeError", "feature enabled in this build", op]);
      }
    }
  });
});

// A verb's command kind is the model's, so a renamed kind fails here.
expectTypeOf<(typeof TASK_COMMAND_OPS)[keyof typeof TASK_COMMAND_OPS]>().toEqualTypeOf<TaskCommandKind>();
