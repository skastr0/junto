import { expect, it, vi } from "vitest";
import type { WorkLaneRow, WorkSinkChanged } from "../src/shared/work-sinks";
import { createWorkTaskPolicyStore, taskPolicyRead } from "../src/renderer/lib/work-task-policy-store";
import { boardRemovalWarnings, wireRemovalWarnings } from "../src/renderer/lib/deletion-impact";
import { dependencyScopeTasks } from "../src/shared/task-dep-scope";
import { canvasOf, taskBoard, wire } from "./support/model-nodes";

const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

it("refreshes only changed policy rows and clears rows when their board is deleted", async () => {
  let notify!: (event: WorkSinkChanged) => void;
  let rows: WorkLaneRow[] = [
    { nodeId: "a", item: { id: "a1", state: "submitted", history: [] } },
    { nodeId: "b", item: { id: "b1", state: "completed", history: [] } },
  ];
  const read = vi.fn(async (query: { canvasName: string; nodeId?: string }) =>
    rows.filter((row) => query.nodeId === undefined || row.nodeId === query.nodeId));
  const off = vi.fn();
  const store = createWorkTaskPolicyStore(() => ({ workTaskPolicy: read,
    onWorkSinkChanged: (listener) => { notify = listener; return off; },
  }));
  const release = store.retain("factory");
  await flush();
  expect(store.state("factory").rows.peek()).toEqual(rows);
  rows = rows.filter((row) => row.nodeId !== "a");
  read.mockClear();
  notify({ canvasName: "another", nodeId: "b" });
  notify({ canvasName: "factory", nodeId: "a" });
  await flush();
  expect(read.mock.calls).toEqual([[{ canvasName: "factory", nodeId: "a" }]]);
  expect(store.state("factory").rows.peek()).toEqual(rows);
  release();
  expect(off).toHaveBeenCalledOnce();
});

it("keeps dependency choices and deletion consequences when topology carries no Work items", () => {
  const canvas = canvasOf([taskBoard("first"), taskBoard("next")], [wire("path", "first", "next", "feeds")]);
  const policy = taskPolicyRead([
    { nodeId: "first", item: { id: "live", state: "working", history: [],
      visits: [{ board: "next", enteredAt: "2026-10-07", epoch: 0 }] } },
    { nodeId: "next", item: { id: "done", state: "completed", history: [] } },
  ]);
  expect(dependencyScopeTasks(canvas, policy, "first").map((task) => task.id)).toEqual(["live", "done"]);
  expect(boardRemovalWarnings(canvas, new Set(["first"]), policy)).toEqual(["“Tasks first” holds 1 live task."]);
  expect(boardRemovalWarnings(canvas, new Set(["next"]), policy)).toHaveLength(1);
  expect(wireRemovalWarnings(canvas, [...canvas.wires.values()], policy)[0]).toContain("1 live task");
});
