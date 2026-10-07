// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { confirmNodeDelete, confirmEdgeDelete } from "../src/renderer/lib/confirm-delete";
import { answerConfirm, confirm$ } from "../src/renderer/lib/confirm";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { taskBoard, wire } from "./support/model-nodes";

const canvas = "native-delete-prompts";
const oldCanvas = state$.canvasName.peek();
const oldDoc = state$.doc.peek();
let oldApi: typeof window.junto;
const read = vi.fn(async () => [{ nodeId: "build", item: { id: "live", state: "working" as const, history: [] } }]);
beforeEach(() => {
  oldApi = window.junto;
  (window as unknown as { junto: unknown }).junto = { workTaskPolicy: read };
  read.mockClear();
  state$.canvasName.set(canvas);
  state$.doc.set({ nodes: [], edges: [] });
  for (const node of [taskBoard("build", { name: "Build" as never }), taskBoard("review", { name: "Review" as never })]) {
    modelStore.node$(canvas, node.id).set(node);
  }
  const path = wire("path", "build", "review", "feeds");
  modelStore.wire$(canvas, path.id).set(path);
});
afterEach(() => {
  answerConfirm(false);
  modelStore.canvas$(canvas).nodes.set({}); modelStore.canvas$(canvas).wires.set({});
  state$.canvasName.set(oldCanvas); state$.doc.set(oldDoc); (window as unknown as { junto: unknown }).junto = oldApi;
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

it("deleting a native board reads its current policy and counts its connected wires", async () => {
  const decision = confirmNodeDelete(["build"]);
  await flush();
  expect(read.mock.calls).toEqual([[{ canvasName: canvas }]]);
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

it("an already removed native selection needs no prompt or policy read", async () => {
  expect(await confirmNodeDelete(["gone"])).toBe(true);
  expect(await confirmEdgeDelete(["gone"])).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(confirm$.pending.peek()).toBeNull();
});
