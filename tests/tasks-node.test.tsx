/**
 * The Tasks node's selected-task pane on the 0.10 model: what it draws is the
 * task's view and the ruler's answer, nothing from the factory era.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { mintItemId } from "../src/shared/resource-command";
import { seatNodeId, taskNodeId, type ClosedTaskLayer, type TaskId, type TaskView } from "../src/shared/task-model";
import { GALLERY_BUILD, GALLERY_CANVAS, GALLERY_QA, seed } from "../src/renderer/components/gallery/TasksNodeGallery";
import { makeLocalTasksSource, tasksSource } from "../src/renderer/lib/tasks-source";
import { seatChoicesInReach } from "../src/renderer/components/tasks/tasks-canvas";
import type { ReachCanvas, ReachNode } from "../src/shared/region-reach";
import { SelectedTask } from "../src/renderer/components/tasks/TasksNode";
import type { TaskCanvasFacts } from "../src/renderer/components/tasks/tasks-pane-model";

const ada = seatNodeId(asNodeId("seat-ada"));
const bo = seatNodeId(asNodeId("seat-bo"));
const build = taskNodeId(asNodeId("tasks-build"));
const qa = taskNodeId(asNodeId("tasks-qa"));
const seats = [
  { node: ada, name: "Ada" },
  { node: bo, name: "Bo" },
];
const facts: TaskCanvasFacts = {
  downstream: () => [],
  stampDefaultOf: () => ({ required: 0 }),
  seatReaches: () => true,
};
const view = (over: Partial<TaskView> = {}): TaskView => ({
  taskId: mintItemId() as TaskId,
  number: 42 as TaskView["number"],
  title: "Ship the board",
  current: { state: "backlog", node: build, epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [] },
  layers: [],
  dependsOn: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const draw = (v: TaskView, all: ReadonlyArray<TaskView> = [v]) =>
  renderToStaticMarkup(
    <SelectedTask
      view={v}
      all={all}
      seats={seats}
      facts={facts}
      nodeName={(node) => (node === qa ? "QA board" : "Build board")}
      seatName={(id) => (id === ada ? "Ada" : "Bo")}
      now={10_000}
      error={null}
      apply={async () => undefined}
    />,
  );

describe("SelectedTask", () => {
  it("draws the number, the title, the state and no assignee on a backlog task", () => {
    const html = draw(view());
    expect(html).toContain("#42");
    expect(html).toContain('value="Ship the board"');
    expect(html).toContain("Backlog");
    expect(html).toContain("No assignee");
    expect(html).toContain("task-verb-assign");
  });

  it("names the assignee and offers the operator unassign and cancel on a working task", () => {
    const working = view({
      current: { state: "working", node: build, assignee: ada, epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [] },
    });
    const html = draw(working);
    expect(html).toContain("@Ada");
    expect(html).toContain("task-verb-unassign");
    expect(html).not.toContain("task-verb-start");
  });

  it("says a write stands when its mail did not go, and tells the operator not to repeat it", () => {
    const html = renderToStaticMarkup(
      <SelectedTask
        view={view()}
        all={[view()]}
        seats={seats}
        facts={facts}
        nodeName={() => "Build board"}
        seatName={() => "Ada"}
        now={10_000}
        error={null}
        notice="the seat is not running"
        apply={async () => undefined}
      />,
    );
    expect(html).toContain("its mail did not go: the seat is not running");
    expect(html).toContain("Do not do it again");
  });

  it("says queued while a create waits for its number", () => {
    const html = draw(view({ number: undefined, pending: { opId: "op" } }));
    expect(html).toContain("queued");
    expect(html).not.toContain("#42");
  });

  it("lists earlier layers with the node, the holder and the stamps", () => {
    const layer: ClosedTaskLayer = {
      state: "done",
      node: qa,
      assignee: bo,
      epoch: 0,
      stampPolicy: { required: 1 },
      reviewers: [{ kind: "seat", seat: ada }],
      stamps: [{ reviewer: { kind: "seat", seat: ada }, verdict: "approve", epoch: 0, at: 1 }],
      closedAt: 5_000,
    };
    const html = draw(view({ layers: [layer] }));
    expect(html).toContain("Earlier layers, 1");
    expect(html).toContain("QA board");
    expect(html).toContain("1 of 1 approved");
  });

  it("draws a dependency as a task chip, and a missing one as unavailable", () => {
    const dep = view({ taskId: mintItemId() as TaskId, number: 7 as TaskView["number"], title: "Land the contract" });
    const other = view({ taskId: mintItemId() as TaskId, number: 8 as TaskView["number"], title: "Another" });
    const html = draw(view({ dependsOn: [dep.taskId, mintItemId() as TaskId] }), [dep, other]);
    expect(html).toContain("Land the contract");
    expect(html).toContain("Unavailable");
    expect(html).toContain("Add dependency");
    expect(html).toContain("Stop depending on Land the contract");
  });
});

describe("dependencies through the source", () => {
  it("adds one, refuses a cycle by name, and removes it", async () => {
    const source = makeLocalTasksSource({ downstream: () => [], stampDefaultOf: () => ({ required: 0 }), seatReaches: () => true });
    const node = taskNodeId(asNodeId("tasks-deps"));
    const a = mintItemId() as TaskId;
    const b = mintItemId() as TaskId;
    await source.apply("c", node, a, { kind: "create", taskId: a, title: "a" });
    await source.apply("c", node, b, { kind: "create", taskId: b, title: "b" });
    expect((await source.apply("c", node, a, { kind: "depend", on: b })).ok).toBe(true);
    const cycle = await source.apply("c", node, b, { kind: "depend", on: a });
    expect(cycle).toMatchObject({ ok: false, refusal: { detail: { kind: "dependency-cycle" } } });
    expect((await source.apply("c", node, a, { kind: "undepend", on: b })).ok).toBe(true);
    expect((await source.list("c", node)).find((v) => v.taskId === a)?.dependsOn).toEqual([]);
  });
});

describe("Tasks node gallery seed", () => {
  it("rules every seeded write: a task sent on, one working, one in review, two in backlog", async () => {
    await seed();
    const build = await tasksSource().list(GALLERY_CANVAS, GALLERY_BUILD);
    expect(build.map((v) => v.current.state).sort()).toEqual(["backlog", "backlog", "in-review", "working"]);
    const review = build.find((v) => v.current.state === "in-review");
    expect(review?.current.stamps).toHaveLength(1);
    const qa = await tasksSource().list(GALLERY_CANVAS, GALLERY_QA);
    expect(qa).toHaveLength(1);
    expect(qa[0]?.layers).toHaveLength(1);
    expect(qa[0]?.current.stampPolicy.required).toBe(1);
  });
});

describe("seats in reach of a task node", () => {
  const at = (id: string, kind: ReachNode["kind"], x: number, y: number, w = 50, h = 50): ReachNode => ({
    id: asNodeId(id),
    kind,
    x,
    y,
    width: w,
    height: h,
  });
  const canvas: ReachCanvas = {
    nodes: new Map(
      [
        at("region-a", "region", 0, 0, 400, 400),
        at("region-b", "region", 600, 0, 400, 400),
        at("tasks-a", "task", 10, 10),
        at("seat-zed", "agent", 100, 10),
        at("seat-amy", "agent", 100, 100),
        at("seat-far", "agent", 700, 10),
        at("note-a", "note", 100, 200),
      ].map((n) => [n.id, n] as const),
    ),
  };

  it("lists the seats of the same region, named and sorted, and not seats elsewhere or other kinds", () => {
    const names: Record<string, string> = { "seat-zed": "Zed", "seat-amy": "Amy", "seat-far": "Far" };
    const found = seatChoicesInReach(canvas, taskNodeId(asNodeId("tasks-a")), (id) => names[id] ?? id);
    expect(found.map((seat) => seat.name)).toEqual(["Amy", "Zed"]);
  });
});
