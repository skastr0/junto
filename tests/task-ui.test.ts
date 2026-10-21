import { describe, expect, expectTypeOf, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import type { TaskContext } from "../src/shared/task-machine";
import {
  seatNodeId,
  taskNodeId,
  type Reviewer,
  type Stamp,
  type TaskActor,
  type TaskCommandKind,
  type TaskCore,
} from "../src/shared/task-model";
import { ItemId } from "../src/shared/work-ids";
import {
  TASK_VERBS,
  assignChoices,
  nextChoices,
  offeredStamps,
  offeredVerbs,
  operatorMayReview,
  reviewTally,
  reviewerChoices,
  earlierStampOf,
  stampOf,
  stateLabel,
  verbLabel,
  type SeatChoice,
  type TaskVerb,
} from "../src/renderer/lib/task-ui";
import { TASK_STATES } from "../src/shared/task-model";

const ada = seatNodeId(asNodeId("seat-ada"));
const bo = seatNodeId(asNodeId("seat-bo"));
const cy = seatNodeId(asNodeId("seat-cy"));
const build = taskNodeId(asNodeId("tasks-build"));
const qa = taskNodeId(asNodeId("tasks-qa"));
const ship = taskNodeId(asNodeId("tasks-ship"));
const T1 = ItemId.make("01JZ0000000000000000000001");
const T9 = ItemId.make("01JZ0000000000000000000009");

const operator: TaskActor = { kind: "operator" };
const seat = (s: typeof ada): TaskActor => ({ kind: "seat", seat: s });
const asSeat = (s: typeof ada): Reviewer => ({ kind: "seat", seat: s });

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
  taskId: T1,
  at: 1,
  openTaskOf: () => undefined,
  downstream: [],
  stampDefaultOf: () => ({ required: 0 }),
  seatReaches: () => true,
  ...over,
});
const seats: ReadonlyArray<SeatChoice> = [
  { node: ada, name: "Ada" },
  { node: bo, name: "Bo" },
  { node: cy, name: "Cy" },
];
const approve = (reviewer: Reviewer, epoch = 0, at = 1): Stamp => ({ reviewer, verdict: "approve", epoch, at });

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
    const many = ctx({ downstream: [qa, ship] });
    expect(offeredVerbs(core({ state: "working", assignee: ada }), seat(ada), many)).toContain("finish");
    expect(nextChoices(many)).toEqual([qa, ship]);
  });

  it("offers cancel on backlog and open states, archive on done and canceled, nothing on archived", () => {
    expect(offeredVerbs(core({ state: "done" }), operator, ctx())).toEqual(["archive"]);
    expect(offeredVerbs(core({ state: "canceled" }), operator, ctx())).toEqual(["archive"]);
    expect(offeredVerbs(core({ state: "archived" }), operator, ctx())).toEqual([]);
  });

  it("is not blocked by the probe seat standing for a busy seat", () => {
    expect(offeredVerbs(core(), operator, ctx({ openTaskOf: () => T9 }))).toContain("assign");
  });
});

describe("assign and reviewer choices", () => {
  it("marks a seat that holds another open task with the task it holds", () => {
    const busy = ctx({ openTaskOf: (s) => (s === bo ? T9 : undefined) });
    const choices = assignChoices(core(), operator, busy, seats);
    expect(choices.map((c) => [c.name, c.refusal?.kind])).toEqual([
      ["Ada", undefined],
      ["Bo", "seat-busy"],
      ["Cy", undefined],
    ]);
  });

  it("offers every seat in reach but the assignee and current reviewers as reviewers", () => {
    const task = core({ state: "working", assignee: ada, reviewers: [asSeat(bo)] });
    expect(reviewerChoices(task, operator, ctx(), seats).map((s) => s.name)).toEqual(["Cy"]);
    const far = ctx({ seatReaches: (s) => s !== cy });
    expect(reviewerChoices(core({ state: "working", assignee: ada }), operator, far, seats).map((s) => s.name)).toEqual([
      "Bo",
    ]);
  });

  it("lets the operator list itself once, while the task is open", () => {
    expect(operatorMayReview(core({ state: "working", assignee: ada }), ctx())).toBe(true);
    expect(operatorMayReview(core({ reviewers: [{ kind: "operator" }] }), ctx())).toBe(false);
    expect(operatorMayReview(core({ state: "done" }), ctx())).toBe(false);
  });
});

describe("stamps", () => {
  const inReview = core({
    state: "in-review",
    assignee: ada,
    reviewers: [asSeat(bo)],
    stampPolicy: { required: 1 },
  });

  it("lets the operator stamp a task in review, listed or not, and only then", () => {
    expect(offeredStamps(inReview, operator, ctx())).toEqual(["approve", "changes"]);
    expect(offeredStamps(core({ state: "working", assignee: ada }), operator, ctx())).toEqual([]);
  });

  it("lets a listed seat stamp and refuses the assignee", () => {
    expect(offeredStamps(inReview, seat(bo), ctx())).toEqual(["approve", "changes"]);
    expect(offeredStamps(inReview, seat(ada), ctx())).toEqual([]);
    expect(offeredStamps(inReview, seat(cy), ctx())).toEqual([]);
  });

  it("counts what the ruler counts: the operator unlisted, a removed seat not, the latest stamp once", () => {
    const task = core({
      ...inReview,
      stampPolicy: { required: 2 },
      stamps: [
        approve(asSeat(bo), 0, 1),
        approve(asSeat(bo), 0, 2),
        approve({ kind: "operator" }, 0, 3),
        approve(asSeat(cy), 0, 4),
      ],
    });
    const tally = reviewTally(task);
    expect(tally.approved).toBe(2);
    expect(tally.met).toBe(true);
    expect(tally.slots).toEqual(["approved", "approved"]);
  });

  it("draws earlier rounds as stale and a missing approval as waiting", () => {
    const task = core({
      ...inReview,
      epoch: 1,
      stampPolicy: { required: 2 },
      stamps: [approve(asSeat(bo), 0)],
    });
    expect(reviewTally(task)).toMatchObject({ approved: 0, met: false, slots: ["waiting", "waiting", "stale"] });
  });

  it("finds a reviewer's stamp at the current epoch only", () => {
    const task = core({ ...inReview, epoch: 1, stamps: [approve(asSeat(bo), 0)] });
    expect(stampOf(task, asSeat(bo))).toBeUndefined();
    expect(stampOf({ ...task, epoch: 0 }, asSeat(bo))?.verdict).toBe("approve");
  });
});

describe("rounds", () => {
  it("shows a reviewer's ask for changes as the earlier round once the task is working again", () => {
    const task = core({
      state: "working",
      assignee: ada,
      epoch: 1,
      reviewers: [asSeat(bo)],
      stamps: [{ reviewer: asSeat(bo), verdict: "changes", epoch: 0, at: 1 }],
    });
    expect(stampOf(task, asSeat(bo))).toBeUndefined();
    expect(earlierStampOf(task, asSeat(bo))?.verdict).toBe("changes");
    expect(reviewTally(task).slots).toEqual(["stale"]);
  });

  it("has no earlier stamp for a reviewer who stamped this round or never did", () => {
    const task = core({ state: "in-review", assignee: ada, reviewers: [asSeat(bo), asSeat(cy)], stamps: [approve(asSeat(bo))] });
    expect(earlierStampOf(task, asSeat(bo))).toBeUndefined();
    expect(earlierStampOf(task, asSeat(cy))).toBeUndefined();
  });
});

describe("words", () => {
  it("names every state and verb", () => {
    for (const state of TASK_STATES) expect(stateLabel(state)).not.toBe("");
    for (const verb of TASK_VERBS) expect(verbLabel(verb)).not.toBe("");
  });
});
