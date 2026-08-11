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

  it("does not re-spam after a temporary projection gap (dismiss held)", () => {
    // Bug shape: work projection empty for a tick clears known+dismissed,
    // then completed rows reappear as "new" rising edges.
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

    // Gap: sink has no items this tick (or canvas briefly empty).
    state = observeCompletedTasks(state, collectTaskSnapshots([]), 3);
    expect(state.dismissed.t1).toBe(true);
    expect(state.known.t1).toBe("completed");

    // Same completed task returns — must stay quiet.
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      4,
    );
    expect(state.stack).toEqual([]);
    expect(state.dismissed.t1).toBe(true);
  });

  it("does not re-rise completed ids after a gap without dismiss", () => {
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
    expect(state.stack).toHaveLength(1);

    // Gap drops stack UI (not projected) but retains known completed.
    state = observeCompletedTasks(state, collectTaskSnapshots([]), 3);
    expect(state.stack).toEqual([]);
    expect(state.known.t1).toBe("completed");

    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      4,
    );
    // No second rise — operator already saw it this session; they can open the board.
    expect(state.stack).toEqual([]);
  });
});
