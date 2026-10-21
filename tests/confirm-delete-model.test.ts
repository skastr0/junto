// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { confirmNodeDelete, confirmEdgeDelete } from "../src/renderer/lib/confirm-delete";
import { answerConfirm, confirm$ } from "../src/renderer/lib/confirm";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { setTasksSource, tasksSource, type TasksSource } from "../src/renderer/lib/tasks-source";
import { TASKS_UNREAD_WARNING } from "../src/renderer/lib/deletion-impact";
import { taskBoard, wire } from "./support/model-nodes";
import { taskView } from "./support/seat-tasks";

const canvas = "native-delete-prompts";
const oldCanvas = state$.canvasName.peek();
const oldSource = tasksSource();
const read = vi.fn(async (_canvasName: string) => [taskView("build", { current: { state: "working" } })]);
beforeEach(() => {
  setTasksSource({ ...oldSource, all: read } as TasksSource);
  read.mockReset();
  read.mockImplementation(async () => [taskView("build", { current: { state: "working" } })]);
  state$.canvasName.set(canvas);
  for (const node of [taskBoard("build", { name: "Build" as never }), taskBoard("review", { name: "Review" as never })]) {
    modelStore.node$(canvas, node.id).set(node);
  }
  const path = wire("path", "build", "review", "flows");
  modelStore.wire$(canvas, path.id).set(path);
});
afterEach(() => {
  answerConfirm(false);
  modelStore.canvas$(canvas).nodes.set({}); modelStore.canvas$(canvas).wires.set({});
  state$.canvasName.set(oldCanvas); setTasksSource(oldSource);
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

it("deleting a native board reads its current tasks and counts its connected wires", async () => {
  const decision = confirmNodeDelete(["build"]);
  await flush();
  expect(read.mock.calls).toEqual([[canvas]]);
  expect(confirm$.pending.peek()).toMatchObject({ source: "node-delete", title: "Delete this node?", body: [
    "“Build” holds 1 live task.", "Connected edges (1) will also be removed.",
  ] });
  answerConfirm(false);
  expect(await decision).toBe(false);
});

it("deleting the native last Next board reports the affected live task at the gesture", async () => {
  const decision = confirmEdgeDelete(["path"]);
  await flush();
  expect(read).toHaveBeenCalledOnce();
  expect(confirm$.pending.peek()?.body).toEqual([
    "“Build” has 1 live task that will lose “Review” as its Next board.",
    "This removes “Build”’s last Next board, so tasks will complete here.",
  ]);
  answerConfirm(true);
  expect(await decision).toBe(true);
});

it("still asks when the tasks cannot be read, and says they are unknown", async () => {
  read.mockImplementation(async () => { throw new Error("main is gone"); });
  const decision = confirmNodeDelete(["build"]);
  await flush();
  expect(confirm$.pending.peek()?.body).toEqual([TASKS_UNREAD_WARNING, "Connected edges (1) will also be removed."]);
  answerConfirm(true);
  expect(await decision).toBe(true);
});

it("an already removed native selection needs no prompt or task read", async () => {
  expect(await confirmNodeDelete(["gone"])).toBe(true);
  expect(await confirmEdgeDelete(["gone"])).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(confirm$.pending.peek()).toBeNull();
});
