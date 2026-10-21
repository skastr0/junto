import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assignChoices,
  offeredVerbs,
  refusalText,
  reviewerChoices,
  stateLabel,
  taskNumberLabel,
  verbLabel,
  TASK_VERBS,
  type SeatChoice,
  type TaskVerb,
} from "../src/renderer/lib/task-ui";
import {
  TASK_STATES,
  seatNodeId,
  taskNodeId,
  type Stamp,
  type TaskActor,
  type TaskContext,
  type TaskCore,
  type TaskCommandKind,
} from "../src/shared/task-machine";

const ada = seatNodeId("seat-ada");
const bo = seatNodeId("seat-bo");
const cy = seatNodeId("seat-cy");
const build = taskNodeId("tasks-build");
const operator: TaskActor = { kind: "operator" };
const seat = (s: typeof ada): TaskActor => ({ kind: "seat", seat: s, inReach: true });

const core = (over: Partial<TaskCore> = {}): TaskCore => ({
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
  at: 1,
  openTaskOf: () => undefined,
  downstream: [],
  stampDefaultOf: () => ({ required: 0 }),
  ...over,
});
const seats: ReadonlyArray<SeatChoice> = [
  { node: ada, name: "Ada" },
  { node: bo, name: "Bo" },
  { node: cy, name: "Cy" },
];
const approve = (reviewer: typeof ada, epoch = 0): Stamp => ({ reviewer, verdict: "approve", epoch, at: 1 });

describe("verbs are the ruler's answer", () => {
  it("is a subset of the command kinds", () => {
    expectTypeOf<TaskVerb>().toExtend<TaskCommandKind>();
  });

  it("gives the operator assign and cancel on the backlog", () => {
    expect(offeredVerbs(core(), operator, ctx())).toEqual(["assign", "cancel"]);
  });

  it("gives the operator only unassign and cancel on an open task, never the assignee's verbs", () => {
    for (const state of ["assigned", "working", "input-required"] as const) {
      expect(offeredVerbs(core({ state, assignee: ada }), operator, ctx())).toEqual(["unassign", "cancel"]);
    }
  });

  it("gives the assignee its own verbs", () => {
    expect(offeredVerbs(core({ state: "assigned", assignee: ada }), seat(ada), ctx())).toEqual([
      "start",
      "unassign",
      "cancel",
    ]);
    expect(offeredVerbs(core({ state: "working", assignee: ada }), seat(ada), ctx())).toEqual([
      "pause",
      "finish",
      "unassign",
      "cancel",
    ]);
    expect(offeredVerbs(core({ state: "input-required", assignee: ada }), seat(ada), ctx())).toEqual([
      "resume",
      "unassign",
      "cancel",
    ]);
  });

  it("still offers finish when several nodes are downstream and the assignee must choose", () => {
    const many = ctx({ downstream: [taskNodeId("a"), taskNodeId("b")] });
    expect(offeredVerbs(core({ state: "working", assignee: ada }), seat(ada), many)).toContain("finish");
  });

  it("offers archive on done and canceled, cancel on done too, and nothing on archived", () => {
    expect(offeredVerbs(core({ state: "done" }), operator, ctx())).toEqual(["cancel", "archive"]);
    expect(offeredVerbs(core({ state: "canceled" }), operator, ctx())).toEqual(["archive"]);
    expect(offeredVerbs(core({ state: "archived" }), operator, ctx())).toEqual([]);
  });

  it("is not blocked by the seat the probe stands for being busy", () => {
    const busy = ctx({ openTaskOf: () => "other" });
    expect(offeredVerbs(core(), operator, busy)).toContain("assign");
  });
});

describe("assign and reviewer choices", () => {
  it("marks a seat that holds another open task with the task it holds", () => {
    const busy = ctx({ openTaskOf: (s) => (s === bo ? "task-9" : undefined) });
    const choices = assignChoices(core(), operator, busy, seats);
    expect(choices.map((c) => [c.name, c.refusal?.reason])).toEqual([
      ["Ada", undefined],
      ["Bo", "seat-busy"],
      ["Cy", undefined],
    ]);
  });

  it("offers every seat but the assignee and current reviewers as reviewers", () => {
    const task = core({ state: "working", assignee: ada, reviewers: [bo] });
    expect(reviewerChoices(task, operator, ctx(), seats).map((s) => s.name)).toEqual(["Cy"]);
  });
});

describe("words", () => {
  it("names every state, verb and refusal", () => {
    for (const state of TASK_STATES) expect(stateLabel(state)).not.toBe("");
    for (const verb of TASK_VERBS) expect(verbLabel(verb)).not.toBe("");
    expect(taskNumberLabel({ number: 42 })).toBe("#42");
    const name = (s: typeof ada) => (s === ada ? "Ada" : "Bo");
    expect(refusalText({ reason: "seat-busy", seat: bo, taskId: "t" }, name, () => "#4")).toBe("Bo holds #4.");
    expect(refusalText({ reason: "own-task", seat: ada }, name, () => undefined)).toBe(
      "Ada cannot review its own task.",
    );
    expect(refusalText({ reason: "operator-cannot-stamp" }, name, () => undefined)).toContain("reviewing seats");
  });
});
