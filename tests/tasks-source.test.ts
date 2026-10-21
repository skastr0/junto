import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { mintItemId } from "../src/shared/resource-command";
import { seatNodeId, taskNodeId } from "../src/shared/task-model";
import { makeLocalTasksSource } from "../src/renderer/lib/tasks-source";
import {
  layerSummary,
  listedTasks,
  numberLabel,
  numberOfTask,
  openCount,
  taskContextFor,
  visibleTasks,
} from "../src/renderer/components/tasks/tasks-pane-model";

const ada = seatNodeId(asNodeId("seat-ada"));
const bo = seatNodeId(asNodeId("seat-bo"));
const build = taskNodeId(asNodeId("tasks-build"));
const qa = taskNodeId(asNodeId("tasks-qa"));
const CANVAS = "factory";

const sourceWith = (downstream: ReadonlyArray<typeof qa> = []) =>
  makeLocalTasksSource({
    downstream: (node) => (node === build ? downstream : []),
    stampDefaultOf: () => ({ required: 0 }),
    seatReaches: () => true,
  });

const create = async (source: ReturnType<typeof sourceWith>, title: string) => {
  const taskId = mintItemId();
  const ruling = await source.apply(CANVAS, build, taskId, { kind: "create", taskId, title });
  expect(ruling.ok).toBe(true);
  return taskId;
};

describe("local tasks source", () => {
  it("mints numbers in order and lists what sits on the node", async () => {
    const source = sourceWith();
    await create(source, "first");
    await create(source, "second");
    const views = await source.list(CANVAS, build);
    expect(views.map((view) => [numberLabel(view), view.title, view.current.state])).toEqual([
      ["#1", "first", "backlog"],
      ["#2", "second", "backlog"],
    ]);
    expect(await source.list(CANVAS, qa)).toEqual([]);
  });

  it("refuses a second open task for one seat, naming the task it holds", async () => {
    const source = sourceWith();
    const one = await create(source, "one");
    const two = await create(source, "two");
    expect((await source.apply(CANVAS, build, one, { kind: "assign", seat: ada })).ok).toBe(true);
    const refused = await source.apply(CANVAS, build, two, { kind: "assign", seat: ada });
    expect(refused).toMatchObject({ ok: false, refusal: { detail: { kind: "seat-busy", seat: ada, taskId: one } } });
    const all = await source.all(CANVAS);
    expect(numberOfTask(all, one)).toBe("#1");
  });

  it("notifies subscribers on a ruled write and not on a refused one", async () => {
    const source = sourceWith();
    let calls = 0;
    source.subscribe(() => (calls += 1));
    const id = await create(source, "x");
    expect(calls).toBe(1);
    await source.apply(CANVAS, build, id, { kind: "start" });
    expect(calls).toBe(1);
  });

  it("sends a finished task on, unassigned in backlog on the next node, and keeps its closed layer", async () => {
    const source = sourceWith([qa]);
    const id = await create(source, "ship");
    await source.apply(CANVAS, build, id, { kind: "assign", seat: ada });
    // The operator may not start; the assignee does.
    expect(await source.apply(CANVAS, build, id, { kind: "start" })).toMatchObject({ ok: false });
    const asAda = source.as({ kind: "seat", seat: ada });
    expect((await asAda.apply(CANVAS, build, id, { kind: "start" })).ok).toBe(true);
    expect((await asAda.apply(CANVAS, build, id, { kind: "finish" })).ok).toBe(true);
    expect(await source.list(CANVAS, build)).toEqual([]);
    const [moved] = await source.list(CANVAS, qa);
    expect(moved?.current).toMatchObject({ state: "backlog", node: qa });
    expect(moved?.current.assignee).toBeUndefined();
    expect(moved?.layers.map((layer) => [layer.node, layer.state, layer.assignee])).toEqual([[build, "done", ada]]);
  });

  it("filters and orders the sidebar: open work first, then backlog, then what is over", async () => {
    const source = sourceWith();
    const a = await create(source, "alpha");
    const b = await create(source, "beta");
    await create(source, "gamma");
    await source.apply(CANVAS, build, a, { kind: "assign", seat: ada });
    await source.apply(CANVAS, build, b, { kind: "cancel" });
    const views = await source.list(CANVAS, build);
    expect(visibleTasks(views, { state: "all", query: "" }).map((v) => v.title)).toEqual(["alpha", "gamma", "beta"]);
    expect(visibleTasks(views, { state: "open", query: "" }).map((v) => v.title)).toEqual(["alpha"]);
    expect(visibleTasks(views, { state: "backlog", query: "" }).map((v) => v.title)).toEqual(["gamma"]);
    expect(visibleTasks(views, { state: "closed", query: "" }).map((v) => v.title)).toEqual(["beta"]);
    expect(visibleTasks(views, { state: "all", query: "#3" }).map((v) => v.title)).toEqual(["gamma"]);
    expect(visibleTasks(views, { state: "all", query: "ALP" }).map((v) => v.title)).toEqual(["alpha"]);
    expect(openCount(views)).toBe(1);
  });

  it("keeps the open detail in the list when the filter hides it, so list and detail agree", async () => {
    const source = sourceWith();
    const a = await create(source, "alpha");
    await create(source, "beta");
    await source.apply(CANVAS, build, a, { kind: "cancel" });
    const views = await source.list(CANVAS, build);
    const visible = visibleTasks(views, { state: "open", query: "" });
    expect(visible).toEqual([]);
    const canceled = views.find((view) => view.taskId === a)!;
    expect(listedTasks(visible, canceled).map((view) => view.title)).toEqual(["alpha"]);
    const backlog = visibleTasks(views, { state: "backlog", query: "" });
    expect(listedTasks(backlog, backlog[0]!)).toBe(backlog);
    expect(listedTasks(backlog, null)).toBe(backlog);
  });

  it("builds the ruler's context from the canvas's tasks", async () => {
    const source = sourceWith([qa]);
    const one = await create(source, "one");
    await source.apply(CANVAS, build, one, { kind: "assign", seat: bo });
    const all = await source.all(CANVAS);
    const ctx = taskContextFor(all[0]!, all, {
      downstream: () => [qa],
      stampDefaultOf: () => ({ required: 1 }),
      seatReaches: (seat) => seat === ada,
    }, 5);
    expect(ctx.openTaskOf(bo)).toBe(one);
    expect(ctx.openTaskOf(ada)).toBeUndefined();
    expect(ctx.downstream).toEqual([qa]);
    expect(ctx.seatReaches(bo)).toBe(false);
  });

  it("summarises a closed layer", () => {
    expect(
      layerSummary({
        state: "done",
        node: build,
        assignee: ada,
        epoch: 0,
        stampPolicy: { required: 1 },
        reviewers: [],
        stamps: [{ reviewer: { kind: "seat", seat: bo }, verdict: "approve", epoch: 0, at: 1 }],
        closedAt: 9,
      }),
    ).toEqual({ node: build, assignee: ada, approvals: 1, required: 1, closedAt: 9 });
  });
});
