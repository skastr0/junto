import { describe, expect, expectTypeOf, it } from "vitest";
import {
  TASK_PHASES,
  TASK_VERBS,
  assignRefusal,
  finishOutcomeOf,
  nodeId,
  phaseAfter,
  phaseLabel,
  reviewerCandidates,
  reviewersOwing,
  stampRefusal,
  stampTally,
  taskId,
  taskNumberLabel,
  taskVerbs,
  verbLabel,
  type AssignedTask,
  type NodeId,
  type OpenAssignedPhase,
  type Stamp,
  type TaskPhase,
  type TaskRecord,
  type TaskVerb,
  type UnassignedTask,
  type Viewer,
} from "../src/renderer/lib/task-model-standin";

const ada = nodeId("seat-ada");
const bo = nodeId("seat-bo");
const cy = nodeId("seat-cy");

let n = 0;
const task = (over: Partial<AssignedTask> & { phase: TaskPhase }): TaskRecord => {
  n += 1;
  return {
    id: taskId(`t${n}`),
    number: n,
    title: `Task ${n}`,
    epoch: 0,
    policy: { required: 0 },
    reviewers: [],
    stamps: [],
    layers: [],
    ...over,
  } as TaskRecord;
};

const stamp = (reviewer: NodeId, verdict: Stamp["verdict"], epoch = 0): Stamp => ({
  reviewer,
  verdict,
  epoch,
  at: 1,
});

const seat = (node: NodeId): Viewer => ({ kind: "seat", node });
const operator: Viewer = { kind: "operator" };

describe("task model contract (types)", () => {
  it("keeps ids and phases closed", () => {
    expectTypeOf<NodeId>().not.toEqualTypeOf<string>();
    expectTypeOf<string>().not.toExtend<NodeId>();
    expectTypeOf<NodeId>().not.toEqualTypeOf<ReturnType<typeof taskId>>();
    expectTypeOf<TaskPhase>().toEqualTypeOf<(typeof TASK_PHASES)[number]>();
    expectTypeOf<TaskVerb>().toEqualTypeOf<(typeof TASK_VERBS)[number]>();
  });

  it("gives every open state an assignee and backlog none", () => {
    expectTypeOf<AssignedTask["assignee"]>().toEqualTypeOf<NodeId>();
    expectTypeOf<AssignedTask["phase"]>().toEqualTypeOf<OpenAssignedPhase>();
    expectTypeOf<UnassignedTask["assignee"]>().toEqualTypeOf<undefined>();
    // @ts-expect-error a backlog task cannot be built with an assignee
    const bad: UnassignedTask = { ...(task({ phase: "backlog" }) as UnassignedTask), assignee: ada };
    void bad;
  });
});

describe("taskVerbs", () => {
  it("offers only assign and cancel on the backlog", () => {
    expect(taskVerbs(task({ phase: "backlog" }), operator)).toEqual(["assign", "cancel"]);
  });

  it("lets only the assignee start, pause, resume and finish", () => {
    const assigned = task({ phase: "assigned", assignee: ada });
    expect(taskVerbs(assigned, seat(ada))).toContain("start");
    expect(taskVerbs(assigned, seat(bo))).not.toContain("start");
    expect(taskVerbs(assigned, operator)).not.toContain("start");

    const working = task({ phase: "working", assignee: ada });
    expect(taskVerbs(working, seat(ada))).toEqual(["pause", "finish", "unassign", "cancel"]);
    expect(taskVerbs(working, seat(bo))).toEqual(["unassign", "cancel"]);

    const paused = task({ phase: "input-required", assignee: ada });
    expect(taskVerbs(paused, seat(ada))).toContain("resume");
    expect(taskVerbs(paused, operator)).not.toContain("resume");
  });

  it("lets anyone unassign and cancel an open task, and nobody act on a settled one", () => {
    for (const phase of ["assigned", "working", "input-required", "in-review"] as const) {
      const open = task({ phase, assignee: ada });
      expect(taskVerbs(open, operator)).toEqual(expect.arrayContaining(["unassign", "cancel"]));
    }
    for (const phase of ["done", "canceled", "archived"] as const) {
      expect(taskVerbs(task({ phase }), seat(ada))).toEqual([]);
    }
  });

  it("never offers a verb whose result is not a phase", () => {
    for (const phase of TASK_PHASES) {
      const record = task({ phase, assignee: ada });
      for (const verb of taskVerbs(record, seat(ada))) {
        expect(TASK_PHASES).toContain(phaseAfter(record, verb));
      }
    }
  });
});

describe("phaseAfter", () => {
  it("sends finish to review only when stamps are required", () => {
    const free = task({ phase: "working", assignee: ada });
    const gated = task({ phase: "working", assignee: ada, policy: { required: 2 } });
    expect(finishOutcomeOf(free)).toBe("complete");
    expect(phaseAfter(free, "finish")).toBe("done");
    expect(finishOutcomeOf(gated)).toBe("review");
    expect(phaseAfter(gated, "finish")).toBe("in-review");
  });

  it("maps the rest of the verbs", () => {
    const t = task({ phase: "working", assignee: ada });
    expect(phaseAfter(t, "assign")).toBe("assigned");
    expect(phaseAfter(t, "unassign")).toBe("backlog");
    expect(phaseAfter(t, "start")).toBe("working");
    expect(phaseAfter(t, "resume")).toBe("working");
    expect(phaseAfter(t, "pause")).toBe("input-required");
    expect(phaseAfter(t, "cancel")).toBe("canceled");
  });
});

describe("assignRefusal", () => {
  it("refuses a seat that already holds an open task, but not a settled one", () => {
    const backlog = task({ phase: "backlog" });
    const holding = task({ phase: "working", assignee: ada });
    const settled = task({ phase: "done", assignee: bo });
    expect(assignRefusal(backlog, ada, [backlog, holding, settled])).toEqual({
      kind: "seat-busy",
      holding,
    });
    expect(assignRefusal(backlog, bo, [backlog, holding, settled])).toBeUndefined();
  });

  it("only assigns from the backlog", () => {
    const open = task({ phase: "working", assignee: ada });
    expect(assignRefusal(open, bo, [open])).toEqual({ kind: "not-in-backlog" });
  });
});

describe("stamps", () => {
  const review = (over: Partial<AssignedTask> = {}) =>
    task({
      phase: "in-review",
      assignee: ada,
      reviewers: [bo, cy],
      policy: { required: 2 },
      ...over,
    });

  it("counts approvals only at the current epoch", () => {
    const t = review({
      epoch: 1,
      stamps: [stamp(bo, "approve", 0), stamp(cy, "approve", 1)],
    });
    expect(stampTally(t)).toEqual({ approvals: 1, changes: 0, required: 2, met: false });
    const met = review({ stamps: [stamp(bo, "approve"), stamp(cy, "approve")] });
    expect(stampTally(met).met).toBe(true);
  });

  it("is met at once when no stamps are required", () => {
    expect(stampTally(task({ phase: "working", assignee: ada })).met).toBe(true);
  });

  it("keeps the assignee from stamping and stops double stamps", () => {
    const t = review({ stamps: [stamp(bo, "approve")] });
    expect(stampRefusal(t, ada)).toEqual({ kind: "own-task" });
    expect(stampRefusal(t, bo)).toEqual({ kind: "already-stamped" });
    expect(stampRefusal(t, nodeId("seat-dee"))).toEqual({ kind: "not-a-reviewer" });
    expect(stampRefusal(t, cy)).toBeUndefined();
    expect(stampRefusal(task({ phase: "working", assignee: ada, reviewers: [bo] }), bo)).toEqual({
      kind: "not-in-review",
    });
  });

  it("lists who still owes a stamp", () => {
    const t = review({ stamps: [stamp(bo, "changes", 0)], epoch: 1 });
    expect(reviewersOwing(t)).toEqual([bo, cy]);
    expect(reviewersOwing(review({ stamps: [stamp(bo, "approve")] }))).toEqual([cy]);
  });

  it("offers reviewer candidates without the assignee or existing reviewers", () => {
    const t = task({ phase: "working", assignee: ada, reviewers: [bo] });
    expect(reviewerCandidates(t, [ada, bo, cy])).toEqual([cy]);
  });
});

describe("labels", () => {
  it("names every phase and verb", () => {
    for (const phase of TASK_PHASES) expect(phaseLabel(phase)).not.toBe("");
    for (const verb of TASK_VERBS) expect(verbLabel(verb)).not.toBe("");
    expect(taskNumberLabel({ number: 42 })).toBe("#42");
  });
});
