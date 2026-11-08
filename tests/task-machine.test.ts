import { describe, expect, expectTypeOf, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { emptyRuled, mintOpId, rule, type ResourceCommand, type RulingContext } from "../src/shared/resource-command";
import { InstallationId } from "../src/shared/installation-id";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  currentApprovals,
  emptyTaskBoard,
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
import type { CompletionEvidence, Rule } from "../src/shared/work-model";
import { evaluateRules, type RuleInForce } from "../src/shared/rules";

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
  automationReaches: () => true,
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

  it("assigns a seat that already holds an open task anywhere on the canvas", () => {
    const elsewhere = record({ id: T2, node: ship, state: "input-required", assignee: bo });
    expect(ok(one(record(), seat(ada), { kind: "assign", seat: bo }, env(), [elsewhere])).task.assignee).toBe(bo);
  });

  it("assigns only a seat that reaches the task node, unless the operator assigns", () => {
    const reach = env({ seatReaches: (who) => who !== cy });
    expect(refused(one(record(), seat(ada), { kind: "assign", seat: cy }, reach))).toEqual({ kind: "not-in-reach", nodeId: cy });
    expect(refused(one(record(), { kind: "automation", automation: asNodeId("nightly") }, { kind: "assign", seat: cy }, reach)).kind)
      .toBe("not-in-reach");
    expect(ok(one(record(), operator, { kind: "assign", seat: cy }, reach)).task.assignee).toBe(cy);
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

describe("finish waits on dependencies", () => {
  const working = record({ state: "working", assignee: ada, dependsOn: [T2] });
  const on = (over: Partial<TaskRecord>) => record({ id: T2, number: taskNumber(2)!, ...over });
  const finish = (task: TaskRecord, dep: TaskRecord) => one(task, seat(ada), { kind: "finish" }, env(), [dep]);

  it("finishes when each dependency is done, or archived after it was done", () => {
    expect(ok(finish(working, on({ state: "done" }))).task.state).toBe("done");
    const archived = ok(one(on({ state: "done" }), operator, { kind: "archive" })).task;
    expect(archived).toMatchObject({ state: "archived", archivedFrom: "done" });
    expect(ok(finish(working, archived)).task.state).toBe("done");
  });

  it("refuses while a dependency is open, naming it by number and state", () => {
    const ruled = finish(working, on({ state: "working", assignee: bo }));
    expect(refused(ruled)).toEqual({ kind: "deps-unmet", unfinished: [{ taskId: T2, number: 2, state: "working" }] });
    expect(ruled.ok ? undefined : ruled.refusal.reason).toBe("invalid_transition");
    expect(taskRefusalMessage(refused(ruled))).toBe(
      "This task depends on work not done yet: #2 is in progress. Finish it once each is done, or remove the dependency",
    );
  });

  it("refuses while a dependency is canceled, or archived after it was canceled", () => {
    expect(refused(finish(working, on({ state: "canceled" })))).toEqual({
      kind: "deps-unmet",
      unfinished: [{ taskId: T2, number: 2, state: "canceled" }],
    });
    const archived = ok(one(on({ state: "canceled" }), operator, { kind: "archive" })).task;
    expect(archived.archivedFrom).toBe("canceled");
    expect(refused(finish(working, archived)).kind).toBe("deps-unmet");
    // Archived before what it closed from was kept: nothing says it was done.
    expect(refused(finish(working, on({ state: "archived" }))).kind).toBe("deps-unmet");
  });

  it("names every unfinished dependency, in dependency order, and skips the met ones", () => {
    const t3 = record({ id: T3, number: taskNumber(3)!, state: "backlog" });
    const task = { ...working, dependsOn: [T3, T2] };
    const ruled = ruleTaskBoardCommand(
      board(task, on({ state: "done" }), t3),
      { node: build, taskId: T1 },
      seat(ada),
      { kind: "finish" },
      env(),
    );
    expect(refused(ruled)).toEqual({ kind: "deps-unmet", unfinished: [{ taskId: T3, number: 3, state: "backlog" }] });
    expect(taskRefusalMessage(refused(ruled))).toContain("#3 is in the backlog");
  });

  it("finishes once the unmet dependency is removed", () => {
    const dep = on({ state: "input-required", assignee: bo });
    expect(refused(finish(working, dep)).kind).toBe("deps-unmet");
    const undepended = ok(one(working, seat(bo), { kind: "undepend", on: T2 }, env(), [dep])).task;
    expect(undepended.dependsOn).toEqual([]);
    expect(ok(finish(undepended, dep)).task.state).toBe("done");
  });
});

describe("finish keeps its evidence and handoff note", () => {
  const evidence: CompletionEvidence = { artifacts: [], git: { commits: ["2e219a5ca"] } };
  const handoff = "the parser is done; the CLI flag is next";
  const reviewing = record({ state: "working", assignee: ada, reviewers: [asSeat(bo)], stampPolicy: { required: 1 } });
  const finished = run(reviewing, [[seat(ada), { kind: "finish", evidence, handoff }]]);

  it("sets both on the finish that rules, and keeps them through review to done", () => {
    expect(finished).toMatchObject({ state: "in-review", evidence, handoff });
    expect(run(finished, [[seat(bo), { kind: "stamp", verdict: "approve" }]])).toMatchObject({ state: "done", evidence, handoff });
  });

  it("leaves neither when the finish carries neither, and a refused finish sets nothing", () => {
    const bare = run(reviewing, [[seat(ada), { kind: "finish" }]]);
    expect(bare.evidence).toBeUndefined();
    expect(bare.handoff).toBeUndefined();
    const ruled = one({ ...reviewing, dependsOn: [T2] }, seat(ada), { kind: "finish", evidence, handoff }, env(), [
      record({ id: T2, number: taskNumber(2)! }),
    ]);
    expect(refused(ruled).kind).toBe("deps-unmet");
  });

  it("clears both when changes are asked, so the next finish answers again", () => {
    const changed = run(finished, [[seat(bo), { kind: "stamp", verdict: "changes", text: "add a test" }]]);
    expect(changed.state).toBe("working");
    expect(changed.evidence).toBeUndefined();
    expect(changed.handoff).toBeUndefined();
    const again = run(changed, [[seat(ada), { kind: "finish", handoff: "tested" }]]);
    expect(again).toMatchObject({ state: "in-review", handoff: "tested" });
    expect(again.evidence).toBeUndefined();
  });

  it("clears both when the task is unassigned", () => {
    const back = run(finished, [[operator, { kind: "unassign" }]]);
    expect(back.state).toBe("backlog");
    expect(back.evidence).toBeUndefined();
    expect(back.handoff).toBeUndefined();
  });

  it("rides onto the layer that closes when the task is sent on, and the next layer starts without", () => {
    const flowing = env({ downstream: (node) => (node === build ? [qa] : []) });
    const ruled = ok(one(record({ state: "working", assignee: ada }), seat(ada), { kind: "finish", evidence, handoff }, flowing));
    expect(ruled.task).toMatchObject({ state: "backlog", node: qa });
    expect(ruled.task.evidence).toBeUndefined();
    expect(ruled.task.handoff).toBeUndefined();
    const sent = ruled.effects.find((effect) => effect.kind === "sent-on");
    expect(sent?.kind === "sent-on" ? sent.layer : undefined).toMatchObject({ state: "done", node: build, evidence, handoff });
  });
});

describe("dependency reach", () => {
  const far = record({ id: T2, number: taskNumber(2)!, node: ship });
  const reach = env({ seatReaches: (_, node) => node !== ship });

  it("depends a seat only on a task whose node it reaches; the operator on any", () => {
    expect(refused(one(record(), seat(ada), { kind: "depend", on: T2 }, reach, [far]))).toEqual({
      kind: "not-in-reach",
      nodeId: ship,
    });
    expect(ok(one(record(), operator, { kind: "depend", on: T2 }, reach, [far])).task.dependsOn).toEqual([T2]);
  });

  it("depends an automation only on a task whose node is among its targets", () => {
    const nightly: TaskActor = { kind: "automation", automation: asNodeId("nightly") };
    const targets = env({ automationReaches: (_, node) => node === build });
    expect(refused(one(record(), nightly, { kind: "depend", on: T2 }, targets, [far]))).toEqual({
      kind: "not-in-reach",
      nodeId: ship,
    });
    const near = record({ id: T2, number: taskNumber(2)! });
    expect(ok(one(record(), nightly, { kind: "depend", on: T2 }, targets, [near])).task.dependsOn).toEqual([T2]);
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

  it("never counts a seat's approval toward work it is assigned", () => {
    // bo approves ada's work, then the task is unassigned and handed to bo.
    const approved = run(reviewing({ stampPolicy: { required: 2 } }), [
      [seat(ada), { kind: "finish" }],
      [seat(bo), { kind: "stamp", verdict: "approve" }],
    ]);
    const handed = run(approved, [
      [operator, { kind: "unassign" }],
      [operator, { kind: "reviewer-remove", reviewer: asSeat(bo) }],
      [operator, { kind: "reviewer-add", reviewer: asSeat(bo) }],
      [operator, { kind: "stamp-policy", required: 1 }],
      [operator, { kind: "assign", seat: bo }],
    ]);
    expect(currentApprovals(handed)).toBe(0);
    const finished = run(handed, [[seat(bo), { kind: "start" }], [seat(bo), { kind: "finish" }]]);
    expect(finished.state).toBe("in-review");
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
    expect(ruled.task).toMatchObject({ state: "backlog", node: qa, epoch: 1, stampPolicy: { required: 2 }, reviewers: [], stamps: [] });
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

describe("derives: closing a task makes a new one on each target", () => {
  const derives = env({ derivesTo: (node) => (node === build ? [qa, ship] : []) });

  it("waits for the last approval, then derives on every target and keeps the origin done where it is", () => {
    const working = record({ state: "working", assignee: ada, reviewers: [asSeat(bo)], stampPolicy: { required: 1 }, body: "why" });
    const inReview = ok(one(working, seat(ada), { kind: "finish" }, derives));
    expect(inReview.task.state).toBe("in-review");
    expect(inReview.derived).toBeUndefined();
    const ruled = ok(one(inReview.task, seat(bo), { kind: "stamp", verdict: "approve" }, derives));
    expect(ruled.task).toMatchObject({ id: T1, state: "done", node: build });
    expect(ruled.derived?.map(({ id: _id, ...task }) => task)).toEqual([
      { number: 2, title: "ship it", dependsOn: [], derivedFrom: T1, state: "backlog", node: qa, epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [] },
      { number: 3, title: "ship it", dependsOn: [], derivedFrom: T1, state: "backlog", node: ship, epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [] },
    ]);
    expect(new Set(ruled.derived?.map((task) => task.id)).size).toBe(2);
  });

  it("derives nothing on cancel, on archive of a done task, or where the node derives into nothing", () => {
    expect(ok(one(record({ state: "working", assignee: ada }), operator, { kind: "cancel" }, derives)).derived).toBeUndefined();
    expect(ok(one(record({ state: "done" }), operator, { kind: "archive" }, derives)).derived).toBeUndefined();
    expect(ok(one(record({ state: "working", assignee: ada, node: qa }), seat(ada), { kind: "finish" }, derives)).derived).toBeUndefined();
  });

  it("puts each derived task's fact before the ruled task's, so the last fact is still the task ruled", () => {
    const domain = taskDomain(derives);
    const verdict = domain.rule(board(record({ state: "working", assignee: ada })), {
      opId: mintOpId(),
      canvasName: "factory",
      actor: { kind: "seat", seatId: `seat_${"a".repeat(64)}` as never, nodeId: ada },
      target: { kind: "task", nodeId: build, itemId: T1 },
      basis: null,
      after: [],
      op: { kind: "finish" },
    });
    if (verdict.kind !== "apply") throw new Error("refused");
    expect(verdict.facts.map((fact) => [fact.task.node, fact.task.state])).toEqual([[qa, "backlog"], [ship, "backlog"], [build, "done"]]);
    const after = verdict.facts.reduce(domain.apply, board(record()));
    expect(after.nextNumber).toBe(4);
  });
});

describe("finish against the rules in force", () => {
  // Board rules in force on the build node, judged by the real evaluator, as main's env does.
  const inForce = (...rules: ReadonlyArray<Rule>): ReadonlyArray<RuleInForce> =>
    rules.map((rule) => ({ rule, provenance: { kind: "board", boardId: build } }));
  const rulesOn = (rules: ReadonlyArray<RuleInForce>) =>
    env({
      rulesUnmet: (node, _taskId, evidence) => {
        const failure = node === build ? evaluateRules({ rules, evidence }) : undefined;
        return failure === undefined
          ? undefined
          : {
            missing: failure.missing,
            message: failure.message,
            nextStep: failure.next_step,
            ...(failure.ruleId === undefined ? {} : { ruleId: failure.ruleId }),
          };
      },
    });
  const statement = rulesOn(inForce({ id: "r1", text: "tests pass" }));
  const working = record({ state: "working", assignee: ada });

  it("refuses rules-unmet when the evidence leaves a statement rule unanswered", () => {
    expect(refused(one(working, seat(ada), { kind: "finish" }, statement))).toMatchObject({
      kind: "rules-unmet",
      missing: "claims",
      ruleId: "r1",
    });
  });

  it("finishes when a claim answers it", () => {
    const evidence: CompletionEvidence = { artifacts: [], claims: [{ ruleId: "r1", text: "they pass" }] };
    expect(ok(one(working, seat(ada), { kind: "finish", evidence }, statement)).task.state).toBe("done");
  });

  it("leaves a requires-review rule to the stamps", () => {
    const review = rulesOn(inForce({ id: "r2", text: "a second pair of eyes", kind: "requires-review" }));
    const reviewed = record({ ...working, reviewers: [asSeat(bo)], stampPolicy: { required: 1 } });
    expect(ok(one(reviewed, seat(ada), { kind: "finish" }, review)).task.state).toBe("in-review");
  });
});

describe("check runs", () => {
  // The build node's outgoing "unit" and qa's incoming "smoke", judged as main's env judges them.
  const checked = env({
    downstream: (node) => (node === build ? [qa] : []),
    checksUnmet: (node, next, runs) => {
      const needs = [
        ...(node === build ? [{ id: "unit", side: "outgoing" as const }] : []),
        ...(next === qa ? [{ id: "smoke", side: "incoming" as const }] : []),
      ];
      const runOf = (need: (typeof needs)[number]) => runs.find((run) => run.checkId === need.id && run.side === need.side);
      const red = needs.filter((need) => (runOf(need)?.exitCode ?? 0) !== 0).map((need) => need.id);
      const missing = needs.filter((need) => runOf(need) === undefined).map((need) => need.id);
      return red.length === 0 && missing.length === 0 ? undefined : { red, missing };
    },
  });
  const working = record({ state: "working", assignee: ada });
  const unit = (exitCode: number) => ({ checkId: "unit", side: "outgoing" as const, command: "bun test", exitCode, outputTail: "" });
  const smoke = { checkId: "smoke", side: "incoming" as const, command: "./smoke", exitCode: 0, outputTail: "" };

  it("takes the assignee's runs while working, at the current epoch, the newer replacing the older", () => {
    const ran = run(working, [
      [seat(ada), { kind: "check", results: [unit(1)] }],
      [seat(ada), { kind: "check", results: [unit(0), smoke] }],
    ], checked);
    expect(ran.checks).toEqual([
      { ...unit(0), epoch: 0, at: 1_000 },
      { ...smoke, epoch: 0, at: 1_000, destination: qa },
    ]);
    expect(refused(one(working, seat(bo), { kind: "check", results: [unit(0)] }, checked))).toMatchObject({ kind: "not-assignee" });
    expect(refused(one(record({ state: "assigned", assignee: ada }), seat(ada), { kind: "check", results: [unit(0)] }, checked)))
      .toMatchObject({ kind: "illegal-transition", from: "assigned", command: "check" });
  });

  it("refuses a finish with a required check red or not run, after the rules", () => {
    expect(refused(one(working, seat(ada), { kind: "finish" }, checked))).toEqual({ kind: "checks-unmet", red: [], missing: ["unit", "smoke"] });
    const red = run(working, [[seat(ada), { kind: "check", results: [unit(1), smoke] }]], checked);
    expect(refused(one(red, seat(ada), { kind: "finish" }, checked))).toEqual({ kind: "checks-unmet", red: ["unit"], missing: [] });
    const rules = env({ ...checked, rulesUnmet: () => ({ missing: "claims", message: "Rule r1 needs a claim", nextStep: "claim it" }) });
    expect(refused(one(working, seat(ada), { kind: "finish" }, rules)).kind).toBe("rules-unmet");
    const green = run(working, [[seat(ada), { kind: "check", results: [unit(0), smoke] }]], checked);
    expect(ok(one(green, seat(ada), { kind: "finish" }, checked)).task).toMatchObject({ node: qa, state: "backlog", epoch: 1 });
  });

  it("starts each new epoch with no checks: sent on, and changes asked", () => {
    const green = run(working, [[seat(ada), { kind: "check", results: [unit(0), smoke] }]], checked);
    const sent = ok(one(green, seat(ada), { kind: "finish" }, checked));
    expect(sent.task.checks).toBeUndefined();
    expect(sent.effects).toEqual([expect.objectContaining({ kind: "sent-on", layer: expect.objectContaining({ checks: green.checks }) })]);
    const reviewed = run(record({ state: "working", assignee: ada, reviewers: [asSeat(bo)], stampPolicy: { required: 1 } }), [
      [seat(ada), { kind: "check", results: [unit(0), smoke] }],
      [seat(ada), { kind: "finish" }],
      [seat(bo), { kind: "stamp", verdict: "changes" }],
    ], checked);
    expect(reviewed).toMatchObject({ state: "working", epoch: 1 });
    expect(reviewed.checks).toBeUndefined();
    expect(refused(one(reviewed, seat(ada), { kind: "finish" }, checked))).toEqual({ kind: "checks-unmet", red: [], missing: ["unit", "smoke"] });
  });
});

describe("a return trip", () => {
  it("arrives back on a node it passed at a later epoch, with none of its old approvals current", () => {
    const there = env({ downstream: (node) => (node === build ? [qa] : [build]), stampDefaultOf: () => ({ required: 1 }) });
    const approved = run(
      record({ state: "working", assignee: ada, reviewers: [asSeat(bo)], stampPolicy: { required: 1 } }),
      [
        [seat(ada), { kind: "check", results: [{ checkId: "unit", side: "outgoing", command: "bun test", exitCode: 0, outputTail: "" }] }],
        [seat(ada), { kind: "finish" }],
      ],
      there,
    );
    expect(approved.checks).toHaveLength(1);
    const atQa = ok(one(approved, seat(bo), { kind: "stamp", verdict: "approve" }, there)).task;
    expect(atQa).toMatchObject({ node: qa, epoch: 1 });
    const back = run(atQa, [
      [operator, { kind: "assign", seat: cy }],
      [seat(cy), { kind: "start" }],
      [seat(cy), { kind: "finish" }],
      [operator, { kind: "stamp", verdict: "approve" }],
    ], there);
    expect(back).toMatchObject({ node: build, epoch: 2, state: "backlog" });
    // It arrives with no check runs: the first pass's do not answer this epoch.
    expect(back.checks).toBeUndefined();
    // Even with the first pass's stamp put back, it is not current here.
    expect(currentApprovals({ ...back, reviewers: [asSeat(bo)], stamps: approved.stamps.concat(
      { reviewer: asSeat(bo), verdict: "approve", epoch: 0, at: 1 },
    ) })).toBe(0);
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

  it("says what to do next when a task has no assignee, or its assignee is another seat", () => {
    const domain = taskDomain(env());
    const context: RulingContext = { inReach: () => true };
    const none = rule(domain, emptyRuled(board(record())), writer, command(adaActor, { kind: "start" }, T1), context);
    expect(none.ruling.kind === "refused" && none.ruling.error.details?.next_step).toContain("junto task assign");
    const held = rule(domain, emptyRuled(board(record({ state: "working", assignee: bo }))), writer, command(adaActor, { kind: "pause" }, T1), context);
    expect(held.ruling.kind === "refused" && held.ruling.error.details?.next_step).toContain(bo);
    expect(held.ruling.kind === "refused" && held.ruling.error.details?.next_step).toContain("junto task unassign");
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
      downstream: [],
      stampDefaultOf: () => ({ required: 0 }),
      seatReaches: () => true,
    };
    const shaped = { state: "assigned" as const, node: build, assignee: ada, epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [], label: "kept" };
    const ruled = ruleTaskCommand(shaped, seat(ada), { kind: "start" }, ctx);
    expect(ruled.ok && ruled.task).toEqual({ ...shaped, state: "working" });
    expect(ruleTaskCommand(shaped, seat(ada), { kind: "assign", seat: ada }, ctx).ok).toBe(false);
  });
});

describe("many open tasks per seat across the canvas", () => {
  it("lets a seat holding open tasks in every open state take one more, by itself or from another", () => {
    const held = [
      record({ id: T2, state: "working", assignee: ada }),
      record({ id: T3, node: ship, state: "in-review", assignee: ada }),
    ];
    expect(ok(one(record(), seat(ada), { kind: "assign", seat: ada }, env(), held)).task).toMatchObject({ state: "assigned", assignee: ada });
    expect(ok(one(record(), seat(bo), { kind: "assign", seat: ada }, env(), held)).task.assignee).toBe(ada);
  });
});

describe("refusal text", () => {
  it("says something for every refusal", () => {
    const details: ReadonlyArray<TaskRefusalDetail> = [
      { kind: "illegal-transition", from: "done", command: "start" },
      { kind: "not-assignee" },
      { kind: "already-assigned", assignee: ada },
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
      { kind: "not-in-reach", nodeId: ship },
    ];
    for (const detail of details) expect(taskRefusalMessage(detail)).not.toBe("");
    expect(taskRefusalMessage({ kind: "illegal-transition", from: "done", command: "start" })).toBe("This task is done, so it cannot be started");
    expect(taskRefusalMessage({ kind: "illegal-transition", from: "input-required", command: "finish" })).toBe("This task is waiting for input, so it cannot be finished");
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
