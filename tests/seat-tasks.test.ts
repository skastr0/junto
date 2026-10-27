import { beforeEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { mintItemId } from "../src/shared/resource-command";
import { seatNodeId, taskNodeId, type TaskId } from "../src/shared/task-model";
import { makeLocalTasksSource, setTasksSource } from "../src/renderer/lib/tasks-source";
import {
  buildSeatTaskIndex,
  publishSeatTaskIndex,
  refreshSeatTasks,
  seatTasks$,
} from "../src/renderer/lib/seat-tasks";

const ada = seatNodeId(asNodeId("seat-ada"));
const bo = seatNodeId(asNodeId("seat-bo"));
const build = taskNodeId(asNodeId("tasks-build"));
const CANVAS = "factory";

const source = () => makeLocalTasksSource({ downstream: () => [], stampDefaultOf: () => ({ required: 0 }), seatReaches: () => true });

beforeEach(() => {
  publishSeatTaskIndex({});
});

const make = async (s: ReturnType<typeof source>, title: string): Promise<TaskId> => {
  const taskId = mintItemId();
  await s.apply(CANVAS, build, taskId, { kind: "create", taskId, title });
  return taskId;
};

describe("seat task index", () => {
  it("maps each assignee to its open task, with number, title, state and blocked", async () => {
    const s = source();
    const a = await make(s, "alpha");
    const b = await make(s, "beta");
    await make(s, "gamma");
    await s.apply(CANVAS, build, a, { kind: "assign", seat: ada });
    await s.as({ kind: "seat", seat: ada }).apply(CANVAS, build, a, { kind: "start" });
    await s.apply(CANVAS, build, b, { kind: "assign", seat: bo });
    await s.as({ kind: "seat", seat: bo }).apply(CANVAS, build, b, { kind: "start" });
    await s.as({ kind: "seat", seat: bo }).apply(CANVAS, build, b, { kind: "pause" });
    const index = buildSeatTaskIndex(await s.all(CANVAS));
    expect(Object.keys(index).sort()).toEqual([ada, bo]);
    expect(index[ada]).toMatchObject({ label: "#1", title: "alpha", state: "working", blocked: false });
    expect(index[bo]).toMatchObject({ label: "#2", title: "beta", state: "input-required", blocked: true });
  });

  it("carries when the current state began, kept by a write that leaves the state as it is", async () => {
    let clock = 1_000;
    const s = makeLocalTasksSource(
      { downstream: () => [], stampDefaultOf: () => ({ required: 0 }), seatReaches: () => true },
      { kind: "operator" },
      () => clock,
    );
    const a = await make(s, "alpha");
    clock = 2_000;
    await s.apply(CANVAS, build, a, { kind: "assign", seat: ada });
    clock = 3_000;
    await s.apply(CANVAS, build, a, { kind: "reviewer-add", reviewer: { kind: "seat", seat: bo } });
    expect(buildSeatTaskIndex(await s.all(CANVAS))[ada]).toMatchObject({ state: "assigned", since: 2_000 });
    clock = 4_000;
    await s.as({ kind: "seat", seat: ada }).apply(CANVAS, build, a, { kind: "start" });
    expect(buildSeatTaskIndex(await s.all(CANVAS))[ada]).toMatchObject({ state: "working", since: 4_000 });
  });

  it("holds every open task of a seat, a blocked one leading, so the seat reads blocked", async () => {
    const s = source();
    const a = await make(s, "alpha");
    const b = await make(s, "beta");
    const c = await make(s, "gamma");
    const asAda = s.as({ kind: "seat", seat: ada });
    for (const id of [a, b, c]) await s.apply(CANVAS, build, id, { kind: "assign", seat: ada });
    await asAda.apply(CANVAS, build, a, { kind: "start" });
    await asAda.apply(CANVAS, build, b, { kind: "start" });
    await asAda.apply(CANVAS, build, b, { kind: "pause" });
    const held = buildSeatTaskIndex(await s.all(CANVAS))[ada]!;
    expect(held).toMatchObject({ title: "beta", state: "input-required", blocked: true });
    expect(held.tasks.map((task) => task.title).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(held.tasks[0]!.taskId).toBe(held.taskId);
  });

  it("orders a seat's tasks the same whatever order the views come in", async () => {
    const s = source();
    for (const title of ["alpha", "beta", "gamma"]) await s.apply(CANVAS, build, await make(s, title), { kind: "assign", seat: ada });
    const all = await s.all(CANVAS);
    expect(buildSeatTaskIndex([...all].reverse())[ada]).toEqual(buildSeatTaskIndex(all)[ada]);
  });

  it("leaves out an unassigned task and one that is no longer open", async () => {
    const s = source();
    const a = await make(s, "alpha");
    await make(s, "beta");
    await s.apply(CANVAS, build, a, { kind: "assign", seat: ada });
    await s.apply(CANVAS, build, a, { kind: "cancel" });
    expect(buildSeatTaskIndex(await s.all(CANVAS))).toEqual({});
  });

  it("publishes only the keys that moved and drops a seat that let go", async () => {
    const s = source();
    setTasksSource(s);
    const a = await make(s, "alpha");
    await s.apply(CANVAS, build, a, { kind: "assign", seat: ada });
    await refreshSeatTasks(CANVAS);
    const first = seatTasks$.bySeat[ada].peek();
    expect(first).toMatchObject({ title: "alpha", state: "assigned" });
    await refreshSeatTasks(CANVAS);
    expect(seatTasks$.bySeat[ada].peek()).toBe(first);
    await s.apply(CANVAS, build, a, { kind: "unassign" });
    await refreshSeatTasks(CANVAS);
    expect(seatTasks$.bySeat[ada].peek()).toBeUndefined();
  });

  it("clears for no canvas", async () => {
    publishSeatTaskIndex({
      x: { taskId: mintItemId(), label: "#1", title: "t", state: "working", node: build, blocked: false, tasks: [] },
    });
    await refreshSeatTasks("");
    expect(seatTasks$.bySeat.peek()).toEqual({});
  });
});
