import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import type { Task } from "../src/shared/work-model";
import {
  collectTaskSnapshots,
  dismissCompletedNotify,
  emptyCompletedNotifyState,
  observeCompletedTasks,
  type CompletedNotifyState,
} from "../src/renderer/lib/completed-task-notify";

const taskNode = (
  nodeId: string,
  tasks: ReadonlyArray<Pick<Task, "id" | "state"> & { brief?: string }>,
): CanvasNode =>
  ({
    id: nodeId,
    type: "text",
    text: "tasks",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    ether: {
      entity: { kind: "task" },
      tasks: {
        items: tasks.map((t) => ({
          id: t.id,
          state: t.state,
          history: [
            {
              messageId: `${t.id}-brief`,
              role: "user" as const,
              parts: [{ kind: "text" as const, text: t.brief ?? t.id }],
              taskId: t.id,
            },
          ],
        })),
      },
    },
  }) as CanvasNode;

describe("completed-task-notify", () => {
  it("baselines existing completed without stacking", () => {
    const snaps = collectTaskSnapshots([
      taskNode("sink", [
        { id: "t1", state: "completed", brief: "old done" },
        { id: "t2", state: "working", brief: "live" },
      ]),
    ]);
    const next = observeCompletedTasks(emptyCompletedNotifyState(), snaps, 1);
    expect(next.baselined).toBe(true);
    expect(next.stack).toEqual([]);
    expect(next.known.t1).toBe("completed");
  });

  it("rises when a task becomes completed after baseline", () => {
    let state: CompletedNotifyState = observeCompletedTasks(
      emptyCompletedNotifyState(),
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "working", brief: "Ship it" }]),
      ]),
      1,
    );
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "Ship it" }]),
      ]),
      2,
    );
    expect(state.stack).toEqual([
      expect.objectContaining({
        id: "t1",
        nodeId: "sink",
        brief: "Ship it",
        at: 2,
      }),
    ]);
  });

  it("dismiss removes from stack and stays quiet while still completed", () => {
    let state: CompletedNotifyState = observeCompletedTasks(
      emptyCompletedNotifyState(),
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "working", brief: "A" }]),
      ]),
      1,
    );
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      2,
    );
    state = dismissCompletedNotify(state, "t1");
    expect(state.stack).toEqual([]);
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      3,
    );
    expect(state.stack).toEqual([]);
  });

  it("re-notifies after a task leaves completed then completes again", () => {
    let state: CompletedNotifyState = observeCompletedTasks(
      emptyCompletedNotifyState(),
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "working", brief: "A" }]),
      ]),
      1,
    );
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      2,
    );
    state = dismissCompletedNotify(state, "t1");
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "submitted", brief: "A" }]),
      ]),
      3,
    );
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      4,
    );
    expect(state.stack.map((i) => i.id)).toEqual(["t1"]);
  });
});
