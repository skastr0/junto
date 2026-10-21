import { describe, expect, expectTypeOf, it } from "vitest";
import {
  TASK_STATES,
  currentApprovals,
  isOpenTaskState,
  oneOpenTaskViolations,
  remapLegacyTaskState,
  ruleTaskCommand,
  seatNodeId,
  taskNodeId,
  type LegacyTaskState,
  type SeatNodeId,
  type TaskActor,
  type TaskCommand,
  type TaskContext,
  type TaskCore,
  type TaskNodeId,
  type TaskRuling,
  type TaskState,
} from "../src/shared/task-machine";

const ada = seatNodeId("seat-ada");
const bo = seatNodeId("seat-bo");
const cy = seatNodeId("seat-cy");
const build = taskNodeId("tasks-build");
const qa = taskNodeId("tasks-qa");
const ship = taskNodeId("tasks-ship");

const seat = (id: SeatNodeId, inReach = true): TaskActor => ({ kind: "seat", seat: id, inReach });
const operator: TaskActor = { kind: "operator" };

const task = (over: Partial<TaskCore> = {}): TaskCore => ({
  state: "backlog",
  node: build,
  epoch: 0,
  stampPolicy: { required: 0 },
  reviewers: [],
  stamps: [],
  ...over,
});

const ctx = (over: Partial<TaskContext> = {}): TaskContext => ({
  taskId: "task-1",
  at: 1_000,
  openTaskOf: () => undefined,
  downstream: [],
  stampDefaultOf: () => ({ required: 0 }),
  ...over,
});

const ok = (ruling: TaskRuling) => {
  if (!ruling.ok) throw new Error(`refused: ${JSON.stringify(ruling.refusal)}`);
  return ruling;
};
const refusal = (ruling: TaskRuling) => {
  if (ruling.ok) throw new Error(`ruled: ${ruling.task.state}`);
  return ruling.refusal;
};

/** Rule a sequence of writes, each on the last ruling's task. */
const run = (
  start: TaskCore,
  steps: ReadonlyArray<readonly [TaskActor, TaskCommand]>,
  context: TaskContext = ctx(),
): TaskCore => steps.reduce((current, [actor, command]) => ok(ruleTaskCommand(current, actor, command, context)).task, start);

describe("task states", () => {
  it("holds exactly the 0.10 set", () => {
    expect(TASK_STATES).toEqual([
      "backlog",
      "assigned",
      "working",
      "input-required",
      "in-review",
      "done",
      "canceled",
      "archived",
    ]);
  });

  it("counts assigned, working, input-required and in-review as open", () => {
    expect(TASK_STATES.filter(isOpenTaskState)).toEqual(["assigned", "working", "input-required", "in-review"]);
  });
});

describe("assignment", () => {
  it("assigns a backlog task and mails the seat a notice", () => {
    const ruled = ok(ruleTaskCommand(task(), seat(ada), { kind: "assign", seat: bo }, ctx()));
    expect(ruled.task).toMatchObject({ state: "assigned", assignee: bo });
    expect(ruled.effects).toEqual([{ kind: "assignment-notice", seat: bo }]);
  });

  it("lets a seat assign itself, and the operator assign anyone", () => {
    expect(ok(ruleTaskCommand(task(), seat(ada), { kind: "assign", seat: ada }, ctx())).task.assignee).toBe(ada);
    expect(ok(ruleTaskCommand(task(), operator, { kind: "assign", seat: ada }, ctx())).task.assignee).toBe(ada);
  });

  it("holds one assignee: an assigned task is not assigned again", () => {
    const assigned = task({ state: "working", assignee: ada });
    expect(refusal(ruleTaskCommand(assigned, seat(bo), { kind: "assign", seat: bo }, ctx()))).toEqual({
      reason: "already-assigned",
      assignee: ada,
    });
  });

  it("refuses a seat that already holds an open task anywhere on the canvas", () => {
    const context = ctx({ openTaskOf: (s) => (s === bo ? "task-elsewhere" : undefined) });
    expect(refusal(ruleTaskCommand(task(), seat(ada), { kind: "assign", seat: bo }, context))).toEqual({
      reason: "seat-busy",
      seat: bo,
      taskId: "task-elsewhere",
    });
  });

  it("does not assign closed tasks", () => {
    for (const state of ["done", "canceled", "archived"] as const) {
      expect(refusal(ruleTaskCommand(task({ state }), operator, { kind: "assign", seat: ada }, ctx())).reason).toBe(
        "illegal-transition",
      );
    }
  });

  it("unassign from any open state returns to backlog and clears the assignee", () => {
    for (const state of ["assigned", "working", "input-required", "in-review"] as const) {
      const ruled = ok(
        ruleTaskCommand(task({ state, assignee: ada, next: qa }), seat(bo), { kind: "unassign" }, ctx()),
      );
      expect(ruled.task.state).toBe("backlog");
      expect(ruled.task).not.toHaveProperty("assignee");
      expect(ruled.task).not.toHaveProperty("next");
    }
    expect(refusal(ruleTaskCommand(task(), operator, { kind: "unassign" }, ctx())).reason).toBe("illegal-transition");
  });
});

describe("only the assignee transitions its task", () => {
  const assignee: ReadonlyArray<TaskCommand> = [
    { kind: "start" },
    { kind: "pause" },
    { kind: "resume" },
    { kind: "finish" },
  ];

  it("refuses another seat and the operator", () => {
    for (const command of assignee) {
      const working = task({ state: "working", assignee: ada });
      expect(refusal(ruleTaskCommand(working, seat(bo), command, ctx()))).toEqual({
        reason: "not-assignee",
        assignee: ada,
      });
      expect(refusal(ruleTaskCommand(working, operator, command, ctx())).reason).toBe("not-assignee");
    }
  });

  it("walks assigned, working, input-required, working, done", () => {
    const steps: ReadonlyArray<readonly [TaskActor, TaskCommand]> = [
      [seat(ada), { kind: "start" }],
      [seat(ada), { kind: "pause" }],
      [seat(ada), { kind: "resume" }],
      [seat(ada), { kind: "finish" }],
    ];
    const states: TaskState[] = [];
    steps.reduce((current, [actor, command]) => {
      const next = ok(ruleTaskCommand(current, actor, command, ctx())).task;
      states.push(next.state);
      return next;
    }, task({ state: "assigned", assignee: ada }));
    expect(states).toEqual(["working", "input-required", "working", "done"]);
  });

  it("refuses moves the diagram does not draw", () => {
    const at = (state: TaskState) => task({ state, assignee: ada });
    expect(refusal(ruleTaskCommand(at("working"), seat(ada), { kind: "start" }, ctx())).reason).toBe(
      "illegal-transition",
    );
    expect(refusal(ruleTaskCommand(at("assigned"), seat(ada), { kind: "finish" }, ctx())).reason).toBe(
      "illegal-transition",
    );
    expect(refusal(ruleTaskCommand(at("input-required"), seat(ada), { kind: "finish" }, ctx())).reason).toBe(
      "illegal-transition",
    );
  });
});

describe("reach", () => {
  it("refuses a seat out of reach for everything but the assignee's own task", () => {
    expect(refusal(ruleTaskCommand(task(), seat(ada, false), { kind: "assign", seat: ada }, ctx()))).toEqual({
      reason: "out-of-reach",
    });
    expect(refusal(ruleTaskCommand(task(), seat(ada, false), { kind: "cancel" }, ctx())).reason).toBe("out-of-reach");
  });

  it("lets the assignment outlive a move: the assignee works, finishes and lets go out of reach", () => {
    const moved = seat(ada, false);
    const done = run(task({ state: "assigned", assignee: ada }), [
      [moved, { kind: "start" }],
      [moved, { kind: "pause" }],
      [moved, { kind: "resume" }],
      [moved, { kind: "finish" }],
    ]);
    expect(done.state).toBe("done");
    expect(ok(ruleTaskCommand(task({ state: "working", assignee: ada }), moved, { kind: "unassign" }, ctx())).task
      .state).toBe("backlog");
  });

  it("gives a former assignee nothing once the task is closed", () => {
    const done = task({ state: "done", assignee: ada });
    expect(refusal(ruleTaskCommand(done, seat(ada, false), { kind: "archive" }, ctx())).reason).toBe("out-of-reach");
  });

  it("needs no reach for the operator", () => {
    expect(ok(ruleTaskCommand(task(), operator, { kind: "cancel" }, ctx())).task.state).toBe("canceled");
  });
});

describe("cancel and archive", () => {
  it("cancels from every state but canceled and archived", () => {
    for (const state of TASK_STATES) {
      const ruling = ruleTaskCommand(task({ state }), operator, { kind: "cancel" }, ctx());
      expect(ruling.ok).toBe(state !== "canceled" && state !== "archived");
    }
  });

  it("archives only done and canceled", () => {
    for (const state of TASK_STATES) {
      const ruling = ruleTaskCommand(task({ state }), operator, { kind: "archive" }, ctx());
      expect(ruling.ok).toBe(state === "done" || state === "canceled");
    }
  });
});

describe("review stamps", () => {
  const reviewing = (over: Partial<TaskCore> = {}) =>
    task({ state: "working", assignee: ada, reviewers: [bo, cy], stampPolicy: { required: 1 }, ...over });

  it("finishing with stamps required goes in review and asks every reviewer without a current stamp", () => {
    const ruled = ok(ruleTaskCommand(reviewing(), seat(ada), { kind: "finish" }, ctx()));
    expect(ruled.task.state).toBe("in-review");
    expect(ruled.effects).toEqual([
      { kind: "stamp-request", reviewer: bo },
      { kind: "stamp-request", reviewer: cy },
    ]);
  });

  it("an approval at the current epoch meeting the count finishes the task", () => {
    const inReview = run(reviewing(), [[seat(ada), { kind: "finish" }]]);
    const ruled = ok(ruleTaskCommand(inReview, seat(bo), { kind: "stamp", verdict: "approve" }, ctx()));
    expect(ruled.task.state).toBe("done");
    expect(ruled.task.stamps).toEqual([{ reviewer: bo, verdict: "approve", epoch: 0, at: 1_000 }]);
  });

  it("waits until the count is met", () => {
    const inReview = run(reviewing({ stampPolicy: { required: 2 } }), [
      [seat(ada), { kind: "finish" }],
      [seat(bo), { kind: "stamp", verdict: "approve" }],
    ]);
    expect(inReview.state).toBe("in-review");
    expect(run(inReview, [[seat(cy), { kind: "stamp", verdict: "approve" }]]).state).toBe("done");
  });

  it("changes asked sends the task back to work on a new epoch and files a defect", () => {
    const inReview = run(reviewing({ stampPolicy: { required: 2 } }), [
      [seat(ada), { kind: "finish" }],
      [seat(cy), { kind: "stamp", verdict: "approve" }],
    ]);
    const ruled = ok(ruleTaskCommand(inReview, seat(bo), { kind: "stamp", verdict: "changes", text: "flaky" }, ctx()));
    expect(ruled.task).toMatchObject({ state: "working", epoch: 1, assignee: ada });
    expect(ruled.effects).toEqual([{ kind: "defect", epoch: 1, by: bo, text: "flaky" }]);
    // Every earlier stamp stops counting.
    expect(currentApprovals(ruled.task)).toBe(0);
    const again = ok(ruleTaskCommand(ruled.task, seat(ada), { kind: "finish" }, ctx()));
    expect(again.task.state).toBe("in-review");
    expect(again.effects).toHaveLength(2);
  });

  it("refuses the assignee's own stamp, a seat off the list and the operator", () => {
    const inReview = run(reviewing(), [[seat(ada), { kind: "finish" }]]);
    expect(refusal(ruleTaskCommand(inReview, seat(ada), { kind: "stamp", verdict: "approve" }, ctx())).reason).toBe(
      "own-task",
    );
    const dee = seatNodeId("seat-dee");
    expect(refusal(ruleTaskCommand(inReview, seat(dee), { kind: "stamp", verdict: "approve" }, ctx()))).toEqual({
      reason: "not-reviewer",
      seat: dee,
    });
    expect(refusal(ruleTaskCommand(inReview, operator, { kind: "stamp", verdict: "approve" }, ctx())).reason).toBe(
      "operator-cannot-stamp",
    );
  });

  it("takes stamps only in review", () => {
    expect(refusal(ruleTaskCommand(reviewing(), seat(bo), { kind: "stamp", verdict: "approve" }, ctx())).reason).toBe(
      "illegal-transition",
    );
  });

  it("counts one approval per reviewer, the latest one", () => {
    const counted = currentApprovals(task({
      epoch: 2,
      reviewers: [bo, cy],
      stamps: [
        { reviewer: bo, verdict: "approve", epoch: 2, at: 1 },
        { reviewer: bo, verdict: "approve", epoch: 2, at: 2 },
        { reviewer: cy, verdict: "approve", epoch: 1, at: 3 },
      ],
    }));
    expect(counted).toBe(1);
  });

  it("adds reviewers, asking a late one in review, and never the assignee", () => {
    const inReview = run(reviewing({ reviewers: [], stampPolicy: { required: 1 } }), [[seat(ada), { kind: "finish" }]]);
    expect(inReview.state).toBe("in-review");
    const added = ok(ruleTaskCommand(inReview, seat(bo), { kind: "reviewer-add", seat: bo }, ctx()));
    expect(added.task.reviewers).toEqual([bo]);
    expect(added.effects).toEqual([{ kind: "stamp-request", reviewer: bo }]);
    expect(refusal(ruleTaskCommand(inReview, seat(bo), { kind: "reviewer-add", seat: ada }, ctx())).reason).toBe(
      "own-task",
    );
  });

  it("lowering the count in review can finish the task", () => {
    const inReview = run(reviewing({ stampPolicy: { required: 2 } }), [
      [seat(ada), { kind: "finish" }],
      [seat(bo), { kind: "stamp", verdict: "approve" }],
    ]);
    expect(run(inReview, [[operator, { kind: "stamp-policy", required: 1 }]]).state).toBe("done");
    expect(refusal(ruleTaskCommand(inReview, operator, { kind: "stamp-policy", required: -1 }, ctx())).reason).toBe(
      "invalid-policy",
    );
  });
});

describe("flows: finishing sends the task on", () => {
  it("arrives on the one downstream node in backlog, unassigned, with that node's stamp default", () => {
    const context = ctx({ downstream: [qa], stampDefaultOf: (node) => ({ required: node === qa ? 2 : 0 }) });
    const ruled = ok(
      ruleTaskCommand(task({ state: "working", assignee: ada, reviewers: [bo] }), seat(ada), { kind: "finish" }, context),
    );
    expect(ruled.task).toEqual({
      state: "backlog",
      node: qa,
      epoch: 0,
      stampPolicy: { required: 2 },
      reviewers: [],
      stamps: [],
    });
    expect(ruled.effects).toEqual([{
      kind: "sent-on",
      from: build,
      to: qa,
      layer: { state: "done", node: build, assignee: ada, epoch: 0, stampPolicy: { required: 0 }, reviewers: [bo], stamps: [] },
    }]);
  });

  it("needs the next node named when several are downstream, and only a downstream one", () => {
    const context = ctx({ downstream: [qa, ship] });
    const working = task({ state: "working", assignee: ada });
    expect(refusal(ruleTaskCommand(working, seat(ada), { kind: "finish" }, context))).toEqual({
      reason: "next-required",
      choices: [qa, ship],
    });
    expect(refusal(ruleTaskCommand(working, seat(ada), { kind: "finish", next: build }, context)).reason).toBe(
      "next-not-downstream",
    );
    expect(ok(ruleTaskCommand(working, seat(ada), { kind: "finish", next: ship }, context)).task.node).toBe(ship);
  });

  it("holds the named next node through review and sends on when stamps are met", () => {
    const context = ctx({ downstream: [qa, ship] });
    const inReview = ok(ruleTaskCommand(
      task({ state: "working", assignee: ada, reviewers: [bo], stampPolicy: { required: 1 } }),
      seat(ada),
      { kind: "finish", next: ship },
      context,
    )).task;
    expect(inReview).toMatchObject({ state: "in-review", next: ship });
    const ruled = ok(ruleTaskCommand(inReview, seat(bo), { kind: "stamp", verdict: "approve" }, context));
    expect(ruled.task).toMatchObject({ state: "backlog", node: ship });
    expect(ruled.effects.map((effect) => effect.kind)).toEqual(["sent-on"]);
  });
});

describe("one open task per seat across the canvas", () => {
  it("names every seat holding two open tasks; reviews and closed tasks do not count", () => {
    expect(oneOpenTaskViolations([
      { id: "a", state: "working", assignee: ada },
      { id: "b", state: "in-review", assignee: ada },
      { id: "c", state: "done", assignee: bo },
      { id: "d", state: "assigned", assignee: bo },
      { id: "e", state: "backlog" },
    ])).toEqual([{ seat: ada, taskIds: ["a", "b"] }]);
  });
});

describe("v28 state remap", () => {
  it("maps every stored state", () => {
    const cases: ReadonlyArray<readonly [LegacyTaskState, boolean, TaskState]> = [
      ["submitted", false, "backlog"],
      ["submitted", true, "assigned"],
      ["working", true, "working"],
      ["input-required", true, "input-required"],
      ["auth-required", true, "input-required"],
      ["completed", true, "done"],
      ["canceled", false, "canceled"],
      ["failed", true, "canceled"],
      ["rejected", false, "canceled"],
      ["archived", false, "archived"],
    ];
    for (const [legacy, assigned, next] of cases) expect(remapLegacyTaskState(legacy, assigned)).toBe(next);
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

  it("closes the state and command sets", () => {
    // @ts-expect-error: submitted is a pre-0.10 state.
    const old: TaskState = "submitted";
    // @ts-expect-error: claim is deleted; assignment is explicit.
    const claim: TaskCommand = { kind: "claim" };
    // @ts-expect-error: finish names a task node, never a seat.
    const wrongNext: TaskCommand = { kind: "finish", next: ada };
    expect([old, claim, wrongNext]).toHaveLength(3);
  });

  it("gives the operator no seat to stamp with", () => {
    // @ts-expect-error: the operator carries no seat or reach.
    const op: TaskActor = { kind: "operator", seat: ada };
    expect(op).toBeDefined();
  });
});
