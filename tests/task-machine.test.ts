import { describe, expect, expectTypeOf, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { emptyRuled, mintOpId, rule, type ResourceCommand, type RulingContext } from "../src/shared/resource-command";
import { InstallationId } from "../src/shared/installation-id";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  currentApprovals,
  emptyTaskBoard,
  oneOpenTaskViolations,
  ruleTaskBoardCommand,
  ruleTaskCommand,
  taskDomain,
  taskRefusalMessage,
  type TaskBoardState,
  type TaskDomainEnv,
  type TaskFact,
  type TaskRecord,
  type TaskRecordRuling,
} from "../src/shared/task-machine";
import {
  TASK_STATES,
  isOpenTaskState,
  seatNodeId,
  taskNodeId,
  taskNumber,
  type Reviewer,
  type SeatNodeId,
  type TaskActor,
  type TaskCommand,
  type TaskId,
  type TaskNodeId,
  type TaskRefusalDetail,
  type TaskState,
} from "../src/shared/task-model";
import { ItemId } from "../src/shared/work-ids";

const ada = seatNodeId(asNodeId("seat-ada"));
const bo = seatNodeId(asNodeId("seat-bo"));
const cy = seatNodeId(asNodeId("seat-cy"));
const build = taskNodeId(asNodeId("tasks-build"));
const qa = taskNodeId(asNodeId("tasks-qa"));
const ship = taskNodeId(asNodeId("tasks-ship"));

const T1 = ItemId.make("01JZ0000000000000000000001");
const T2 = ItemId.make("01JZ0000000000000000000002");
const T3 = ItemId.make("01JZ0000000000000000000003");

const seat = (id: SeatNodeId): TaskActor => ({ kind: "seat", seat: id });
const operator: TaskActor = { kind: "operator" };
const asSeat = (id: SeatNodeId): Reviewer => ({ kind: "seat", seat: id });

const record = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: T1,
  number: taskNumber(1)!,
  title: "ship it",
  dependsOn: [],
  state: "backlog",
  node: build,
  epoch: 0,
  stampPolicy: { required: 0 },
  reviewers: [],
  stamps: [],
  ...over,
});

const board = (...tasks: ReadonlyArray<TaskRecord>): TaskBoardState => ({
  tasks: new Map(tasks.map((task) => [task.id, task])),
  nextNumber: taskNumber(tasks.length + 1)!,
});

const env = (over: Partial<TaskDomainEnv> = {}): TaskDomainEnv => ({
  at: 1_000,
  downstream: () => [],
  stampDefaultOf: () => ({ required: 0 }),
  seatReaches: () => true,
  ...over,
});

const ok = (ruling: TaskRecordRuling) => {
  if (!ruling.ok) throw new Error(`refused: ${JSON.stringify(ruling.refusal)}`);
  return ruling;
};
const refused = (ruling: TaskRecordRuling): TaskRefusalDetail => {
  if (ruling.ok) throw new Error(`ruled: ${ruling.task.state}`);
  return ruling.refusal.detail;
};

/** Rule one command on a board holding `task` (and `others`). */
const one = (
  task: TaskRecord,
  actor: TaskActor,
  command: TaskCommand,
  context: TaskDomainEnv = env(),
  others: ReadonlyArray<TaskRecord> = [],
) => ruleTaskBoardCommand(board(task, ...others), { node: task.node, taskId: task.id }, actor, command, context);

/** Rule a sequence of writes, each on the last ruling's task. */
const run = (
  start: TaskRecord,
  steps: ReadonlyArray<readonly [TaskActor, TaskCommand]>,
  context: TaskDomainEnv = env(),
): TaskRecord => steps.reduce((current, [actor, command]) => ok(one(current, actor, command, context)).task, start);

describe("create", () => {
  it("opens a numbered backlog task on the target node with the node's stamp default", () => {
    const ruled = ok(ruleTaskBoardCommand(
      emptyTaskBoard(),
      { node: qa, taskId: T1 },
      seat(ada),
      { kind: "create", taskId: T1, title: "check it" },
      env({ stampDefaultOf: () => ({ required: 2 }) }),
    ));
    expect(ruled.task).toEqual({
      id: T1,
      number: 1,
      title: "check it",
      dependsOn: [],
      state: "backlog",
      node: qa,
      epoch: 0,
      stampPolicy: { required: 2 },
      reviewers: [],
      stamps: [],
    });
    expect(ruled.effects).toEqual([{ kind: "number-minted", number: 1 }]);
  });

  it("refuses a task id that exists", () => {
    expect(refused(one(record(), seat(ada), { kind: "create", taskId: T1, title: "again" })).kind).toBe("task-exists");
  });

  it("names an unknown task, or one on another node", () => {
    expect(refused(ruleTaskBoardCommand(emptyTaskBoard(), { node: build, taskId: T2 }, operator, { kind: "start" }, env())))
      .toEqual({ kind: "unknown-task", taskId: T2 });
    expect(refused(ruleTaskBoardCommand(board(record()), { node: qa, taskId: T1 }, operator, { kind: "cancel" }, env())).kind)
      .toBe("unknown-task");
  });
});

describe("assignment", () => {
  it("assigns a backlog task and mails the seat a notice", () => {
    const ruled = ok(one(record(), seat(ada), { kind: "assign", seat: bo }));
    expect(ruled.task).toMatchObject({ state: "assigned", assignee: bo });
    expect(ruled.effects).toEqual([{ kind: "assignment-notice", seat: bo }]);
  });

  it("lets a seat assign itself, and the operator assign anyone", () => {
    expect(ok(one(record(), seat(ada), { kind: "assign", seat: ada })).task.assignee).toBe(ada);
    expect(ok(one(record(), operator, { kind: "assign", seat: ada })).task.assignee).toBe(ada);
  });

  it("holds one assignee: an assigned task is not assigned again", () => {
    expect(refused(one(record({ state: "working", assignee: ada }), seat(bo), { kind: "assign", seat: bo }))).toEqual({
      kind: "already-assigned",
      assignee: ada,
    });
  });

  it("refuses a seat that already holds an open task anywhere on the canvas", () => {
    const elsewhere = record({ id: T2, node: ship, state: "input-required", assignee: bo });
    expect(refused(one(record(), seat(ada), { kind: "assign", seat: bo }, env(), [elsewhere]))).toEqual({
      kind: "seat-busy",
      seat: bo,
      taskId: T2,
    });
    const closed = record({ id: T2, state: "done", assignee: bo });
    expect(one(record(), seat(ada), { kind: "assign", seat: bo }, env(), [closed]).ok).toBe(true);
  });

  it("unassign from any open state returns to backlog and clears the assignee", () => {
    for (const state of ["assigned", "working", "input-required", "in-review"] as const) {
      const ruled = ok(one(record({ state, assignee: ada, next: qa }), seat(bo), { kind: "unassign" }));
      expect(ruled.task.state).toBe("backlog");
      expect(ruled.task).not.toHaveProperty("assignee");
      expect(ruled.task).not.toHaveProperty("next");
    }
    expect(refused(one(record(), operator, { kind: "unassign" })).kind).toBe("illegal-transition");
  });
});

describe("only the assignee transitions its task", () => {
  it("refuses another seat, the operator and an automation", () => {
    const automation: TaskActor = { kind: "automation", automation: asNodeId("auto-1") };
    for (const command of [{ kind: "start" }, { kind: "pause" }, { kind: "resume" }, { kind: "finish" }] as const) {
      const working = record({ state: "working", assignee: ada });
      expect(refused(one(working, seat(bo), command))).toEqual({ kind: "not-assignee", assignee: ada });
      expect(refused(one(working, operator, command)).kind).toBe("not-assignee");
      expect(refused(one(working, automation, command)).kind).toBe("not-assignee");
    }
  });

  it("walks assigned, working, input-required, working, done", () => {
    const states: TaskState[] = [];
    const steps: ReadonlyArray<TaskCommand> = [{ kind: "start" }, { kind: "pause" }, { kind: "resume" }, { kind: "finish" }];
    steps.reduce((current, command) => {
      const next = ok(one(current, seat(ada), command)).task;
      states.push(next.state);
      return next;
    }, record({ state: "assigned", assignee: ada }));
    expect(states).toEqual(["working", "input-required", "working", "done"]);
  });

  it("refuses moves the diagram does not draw", () => {
    const at = (state: TaskState) => record({ state, assignee: ada });
    expect(refused(one(at("working"), seat(ada), { kind: "start" })).kind).toBe("illegal-transition");
    expect(refused(one(at("assigned"), seat(ada), { kind: "finish" })).kind).toBe("illegal-transition");
    expect(refused(one(at("input-required"), seat(ada), { kind: "finish" })).kind).toBe("illegal-transition");
  });
});

describe("cancel, archive and edit", () => {
  it("cancels only from backlog and the open states, never from done", () => {
    for (const state of TASK_STATES) {
      expect(one(record({ state }), operator, { kind: "cancel" }).ok).toBe(state === "backlog" || isOpenTaskState(state));
    }
  });

  it("archives only done and canceled", () => {
    for (const state of TASK_STATES) {
      expect(one(record({ state }), operator, { kind: "archive" }).ok).toBe(state === "done" || state === "canceled");
    }
  });

  it("edits title and body until archived", () => {
    expect(ok(one(record(), seat(bo), { kind: "edit", body: "more" })).task).toMatchObject({ title: "ship it", body: "more" });
    expect(refused(one(record({ state: "archived" }), seat(bo), { kind: "edit", title: "x" })).kind).toBe(
      "illegal-transition",
    );
  });
});

describe("dependencies", () => {
  const t2 = record({ id: T2, number: taskNumber(2)! });
  const t3 = record({ id: T3, number: taskNumber(3)!, dependsOn: [T1] });

  it("adds and drops a dependency once", () => {
    const ruled = ok(one(record(), seat(ada), { kind: "depend", on: T2 }, env(), [t2]));
    expect(ruled.task.dependsOn).toEqual([T2]);
    expect(ok(one(ruled.task, seat(ada), { kind: "depend", on: T2 }, env(), [t2])).task.dependsOn).toEqual([T2]);
    expect(ok(one(ruled.task, seat(ada), { kind: "undepend", on: T2 }, env(), [t2])).task.dependsOn).toEqual([]);
  });

  it("refuses an unknown task and a cycle, itself included", () => {
    expect(refused(one(record(), seat(ada), { kind: "depend", on: T2 }))).toEqual({ kind: "unknown-task", taskId: T2 });
    expect(refused(one(record(), seat(ada), { kind: "depend", on: T1 }))).toEqual({
      kind: "dependency-cycle",
      through: [T1],
    });
    expect(refused(one(record(), seat(ada), { kind: "depend", on: T3 }, env(), [t3]))).toEqual({
      kind: "dependency-cycle",
      through: [T3, T1],
    });
  });
});

describe("review stamps", () => {
  const reviewing = (over: Partial<TaskRecord> = {}) =>
    record({ state: "working", assignee: ada, reviewers: [asSeat(bo), asSeat(cy)], stampPolicy: { required: 1 }, ...over });

  it("finishing with stamps required goes in review and asks every reviewer without a current stamp", () => {
    const ruled = ok(one(reviewing(), seat(ada), { kind: "finish" }));
    expect(ruled.task.state).toBe("in-review");
    expect(ruled.effects).toEqual([
      { kind: "stamp-request", reviewer: asSeat(bo) },
      { kind: "stamp-request", reviewer: asSeat(cy) },
    ]);
  });

  it("an approval at the current epoch meeting the count finishes the task", () => {
    const inReview = run(reviewing(), [[seat(ada), { kind: "finish" }]]);
    const ruled = ok(one(inReview, seat(bo), { kind: "stamp", verdict: "approve" }));
    expect(ruled.task.state).toBe("done");
    expect(ruled.task.stamps).toEqual([{ reviewer: asSeat(bo), verdict: "approve", epoch: 0, at: 1_000 }]);
  });

  it("counts the operator's approval, listed or not", () => {
    const inReview = run(reviewing({ stampPolicy: { required: 2 } }), [
      [seat(ada), { kind: "finish" }],
      [seat(bo), { kind: "stamp", verdict: "approve" }],
    ]);
    expect(inReview.state).toBe("in-review");
    expect(run(inReview, [[operator, { kind: "stamp", verdict: "approve" }]]).state).toBe("done");
  });

  it("changes asked sends the task back to work on a new epoch and files a defect", () => {
    const inReview = run(reviewing({ stampPolicy: { required: 2 } }), [
      [seat(ada), { kind: "finish" }],
      [seat(cy), { kind: "stamp", verdict: "approve" }],
    ]);
    const ruled = ok(one(inReview, seat(bo), { kind: "stamp", verdict: "changes", text: "flaky" }));
    expect(ruled.task).toMatchObject({ state: "working", epoch: 1, assignee: ada });
    expect(ruled.effects).toEqual([{ kind: "defect", epoch: 1, by: asSeat(bo), text: "flaky" }]);
    expect(currentApprovals(ruled.task)).toBe(0);
    const again = ok(one(ruled.task, seat(ada), { kind: "finish" }));
    expect(again.task.state).toBe("in-review");
    expect(again.effects).toHaveLength(2);
  });

  it("refuses the assignee's own stamp, a seat off the list and an automation", () => {
    const inReview = run(reviewing(), [[seat(ada), { kind: "finish" }]]);
    expect(refused(one(inReview, seat(ada), { kind: "stamp", verdict: "approve" })).kind).toBe("own-task");
    const dee = seatNodeId(asNodeId("seat-dee"));
    expect(refused(one(inReview, seat(dee), { kind: "stamp", verdict: "approve" }))).toEqual({
      kind: "not-reviewer",
      reviewer: asSeat(dee),
    });
    const automation: TaskActor = { kind: "automation", automation: asNodeId("auto-1") };
    expect(refused(one(inReview, automation, { kind: "stamp", verdict: "approve" }))).toEqual({
      kind: "cannot-review",
      actor: "automation",
    });
  });

  it("takes stamps only in review", () => {
    expect(refused(one(reviewing(), seat(bo), { kind: "stamp", verdict: "approve" })).kind).toBe("illegal-transition");
  });

  it("counts one approval per reviewer, the latest one, at the current epoch", () => {
    expect(currentApprovals(record({
      epoch: 2,
      reviewers: [asSeat(bo), asSeat(cy)],
      stamps: [
        { reviewer: asSeat(bo), verdict: "approve", epoch: 2, at: 1 },
        { reviewer: asSeat(bo), verdict: "approve", epoch: 2, at: 2 },
        { reviewer: asSeat(cy), verdict: "approve", epoch: 1, at: 3 },
      ],
    }))).toBe(1);
  });

  it("adds reviewers in reach, asking a late one in review, and never the assignee", () => {
    const inReview = run(reviewing({ reviewers: [] }), [[seat(ada), { kind: "finish" }]]);
    const added = ok(one(inReview, seat(bo), { kind: "reviewer-add", reviewer: asSeat(bo) }));
    expect(added.task.reviewers).toEqual([asSeat(bo)]);
    expect(added.effects).toEqual([{ kind: "stamp-request", reviewer: asSeat(bo) }]);
    expect(refused(one(inReview, seat(bo), { kind: "reviewer-add", reviewer: asSeat(ada) })).kind).toBe("own-task");
    const far = env({ seatReaches: (s) => s !== cy });
    expect(refused(one(inReview, seat(bo), { kind: "reviewer-add", reviewer: asSeat(cy) }, far)).kind).toBe(
      "not-reviewer",
    );
  });

  it("removing a reviewer or lowering the count in review can finish the task", () => {
    const inReview = run(reviewing({ stampPolicy: { required: 2 } }), [
      [seat(ada), { kind: "finish" }],
      [seat(bo), { kind: "stamp", verdict: "approve" }],
    ]);
    expect(run(inReview, [[operator, { kind: "stamp-policy", required: 1 }]]).state).toBe("done");
    expect(refused(one(inReview, operator, { kind: "stamp-policy", required: -1 })).kind).toBe("invalid-policy");
    // Removing the only approver drops its approval: the count is no longer met.
    expect(run(inReview, [[operator, { kind: "reviewer-remove", reviewer: asSeat(bo) }]]).state).toBe("in-review");
  });
});

describe("flows: finishing sends the task on", () => {
  it("arrives on the one downstream node in backlog, unassigned, with that node's stamp default", () => {
    const context = env({ downstream: () => [qa], stampDefaultOf: (node) => ({ required: node === qa ? 2 : 0 }) });
    const ruled = ok(one(record({ state: "working", assignee: ada, reviewers: [asSeat(bo)] }), seat(ada), { kind: "finish" }, context));
    expect(ruled.task).toMatchObject({ state: "backlog", node: qa, stampPolicy: { required: 2 }, reviewers: [], stamps: [] });
    expect(ruled.task).not.toHaveProperty("assignee");
    expect(ruled.effects).toEqual([{
      kind: "sent-on",
      from: build,
      to: qa,
      layer: { state: "done", node: build, assignee: ada, epoch: 0, stampPolicy: { required: 0 }, reviewers: [asSeat(bo)], stamps: [] },
    }]);
  });

  it("needs the next node named when several are downstream, and only a downstream one", () => {
    const context = env({ downstream: () => [qa, ship] });
    const working = record({ state: "working", assignee: ada });
    expect(refused(one(working, seat(ada), { kind: "finish" }, context))).toEqual({ kind: "next-required", choices: [qa, ship] });
    expect(refused(one(working, seat(ada), { kind: "finish", next: build }, context)).kind).toBe("next-not-downstream");
    expect(ok(one(working, seat(ada), { kind: "finish", next: ship }, context)).task.node).toBe(ship);
  });

  it("holds the named next node through review and sends on when stamps are met", () => {
    const context = env({ downstream: () => [qa, ship] });
    const inReview = ok(one(
      record({ state: "working", assignee: ada, reviewers: [asSeat(bo)], stampPolicy: { required: 1 } }),
      seat(ada),
      { kind: "finish", next: ship },
      context,
    )).task;
    expect(inReview).toMatchObject({ state: "in-review", next: ship });
    const ruled = ok(one(inReview, seat(bo), { kind: "stamp", verdict: "approve" }, context));
    expect(ruled.task).toMatchObject({ state: "backlog", node: ship });
    expect(ruled.effects.map((effect) => effect.kind)).toEqual(["sent-on"]);
  });
});

describe("the task domain under the ruler", () => {
  const writer = InstallationId.make("inst-a");
  const seatId = ActorSeatId.make(`seat_${"a".repeat(64)}`);
  const command = (actor: ResourceCommand<TaskCommand>["actor"], op: TaskCommand, itemId?: TaskId): ResourceCommand<TaskCommand> => ({
    opId: mintOpId(),
    canvasName: "factory",
    actor,
    target: { kind: "task", nodeId: build, ...(itemId === undefined ? {} : { itemId }) },
    basis: null,
    after: [],
    op,
  });
  const adaActor = { kind: "seat" as const, seatId, nodeId: ada };

  it("mints numbers in ruling order and folds each fact into the board", () => {
    const domain = taskDomain(env());
    const context: RulingContext = { inReach: () => true };
    const first = rule(domain, emptyRuled(emptyTaskBoard()), writer, command({ kind: "operator" }, { kind: "create", taskId: T1, title: "a" }), context);
    const second = rule(domain, first.ruled, writer, command({ kind: "operator" }, { kind: "create", taskId: T2, title: "b" }), context);
    expect(second.ruling.kind).toBe("applied");
    expect([...second.ruled.state.tasks.values()].map((task) => task.number)).toEqual([1, 2]);
    expect(second.ruled.state.nextNumber).toBe(3);
  });

  it("lets the assignee move its own task out of reach and refuses it everything else", () => {
    const domain = taskDomain(env());
    const away: RulingContext = { inReach: (actor) => actor.kind !== "seat" };
    const assigned = emptyRuled<TaskBoardState, TaskFact>(board(record({ state: "assigned", assignee: ada })));
    const started = rule(domain, assigned, writer, command(adaActor, { kind: "start" }, T1), away);
    expect(started.ruling.kind).toBe("applied");
    const edit = rule(domain, started.ruled, writer, command(adaActor, { kind: "edit", title: "x" }, T1), away);
    expect(edit.ruling.kind === "refused" && edit.ruling.error.details?.reason).toBe("not_in_reach");
  });

  it("carries a task refusal under the shared reason with its detail", () => {
    const domain = taskDomain(env());
    const ruled = rule(domain, emptyRuled(board(record())), writer, command({ kind: "operator" }, { kind: "start" }, T1), { inReach: () => true });
    expect(ruled.ruling.kind).toBe("refused");
    if (ruled.ruling.kind !== "refused") return;
    expect(ruled.ruling.error.type).toBe("InvalidTransition");
    expect(ruled.ruling.error.details).toMatchObject({ reason: "invalid_transition", expected: { kind: "not-assignee" } });
  });

  it("refuses a create whose target names another task", () => {
    const create = { ...command({ kind: "operator" }, { kind: "create", taskId: T1, title: "a" }, T2) };
    const ruled = rule(taskDomain(env()), emptyRuled(emptyTaskBoard()), writer, create, { inReach: () => true });
    expect(ruled.ruling.kind === "refused" && ruled.ruling.error.details).toMatchObject({
      reason: "invalid_input",
      expected: { kind: "target-mismatch", target: T2, taskId: T1 },
    });
  });

  it("refuses a command that names no task", () => {
    const ruled = rule(taskDomain(env()), emptyRuled(emptyTaskBoard()), writer, command({ kind: "operator" }, { kind: "start" }), { inReach: () => true });
    expect(ruled.ruling.kind === "refused" && ruled.ruling.error.details?.reason).toBe("unknown_target");
  });
});

describe("one task on its own", () => {
  it("rules the layer for any task shape, as the UI asks it", () => {
    const ctx = {
      taskId: T1,
      at: 5,
      openTaskOf: () => undefined,
      downstream: [],
      stampDefaultOf: () => ({ required: 0 }),
      seatReaches: () => true,
    };
    const shaped = { state: "assigned" as const, node: build, assignee: ada, epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [], label: "kept" };
    const ruled = ruleTaskCommand(shaped, seat(ada), { kind: "start" }, ctx);
    expect(ruled.ok && ruled.task).toEqual({ ...shaped, state: "working" });
    expect(ruleTaskCommand(shaped, seat(ada), { kind: "assign", seat: ada }, { ...ctx, openTaskOf: () => T1 }).ok).toBe(false);
  });
});

describe("one open task per seat across the canvas", () => {
  it("names every seat holding two open tasks; closed tasks do not count", () => {
    expect(oneOpenTaskViolations([
      { id: T1, state: "working", assignee: ada },
      { id: T2, state: "in-review", assignee: ada },
      { id: T3, state: "done", assignee: bo },
    ])).toEqual([{ seat: ada, taskIds: [T1, T2] }]);
  });
});

describe("refusal text", () => {
  it("says something for every refusal", () => {
    const details: ReadonlyArray<TaskRefusalDetail> = [
      { kind: "illegal-transition", from: "done", command: "start" },
      { kind: "not-assignee" },
      { kind: "already-assigned", assignee: ada },
      { kind: "seat-busy", seat: ada, taskId: T1 },
      { kind: "not-reviewer", reviewer: { kind: "operator" } },
      { kind: "own-task", seat: ada },
      { kind: "stale-epoch", expected: 2 },
      { kind: "next-required", choices: [qa] },
      { kind: "next-not-downstream", next: qa, choices: [] },
      { kind: "invalid-policy", required: -1 },
      { kind: "dependency-cycle", through: [T1] },
      { kind: "unknown-task", taskId: T1 },
      { kind: "task-exists", taskId: T1 },
      { kind: "cannot-review", actor: "automation" },
      { kind: "target-mismatch", target: T1, taskId: T2 },
      { kind: "wrong-node", nodeId: build, expected: "agent" },
    ];
    for (const detail of details) expect(taskRefusalMessage(detail)).not.toBe("");
    expect(taskRefusalMessage({ kind: "illegal-transition", from: "done", command: "start" })).toBe("A done task cannot start");
  });
});

describe("types", () => {
  it("brands seat and task node ids apart", () => {
    expectTypeOf<SeatNodeId>().not.toEqualTypeOf<TaskNodeId>();
    // @ts-expect-error: a bare string is not a seat.
    const bare: SeatNodeId = "seat-ada";
    // @ts-expect-error: a task node is not a seat.
    const crossed: SeatNodeId = build;
    expect([bare, crossed]).toHaveLength(2);
  });

  it("closes the command set to the contract", () => {
    // @ts-expect-error: claim is deleted; assignment is explicit.
    const claim: TaskCommand = { kind: "claim" };
    // @ts-expect-error: finish names a task node, never a seat.
    const wrongNext: TaskCommand = { kind: "finish", next: ada };
    expect([claim, wrongNext]).toHaveLength(2);
  });
});
