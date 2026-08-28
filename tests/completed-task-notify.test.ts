import { afterEach, describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import type { Task } from "../src/shared/work-model";
import {
  activateCompletedTaskNotify,
  clearCompletedNotifyPersistForTests,
  collectTaskSnapshots,
  completedTaskNotify$,
  dismissAllCompletedNotify,
  dismissCompletedNotify,
  emptyCompletedNotifyPersist,
  emptyCompletedNotifyState,
  hydrateNotifyStateFromPersist,
  markAllCompletedNotifyRead,
  observeCompletedTasks,
  persistFromNotifyState,
  resetCompletedTaskNotify,
  setCompletedNotifyStorageForTests,
  syncCompletedTaskNotifyFromDoc,
  type CompletedNotifyState,
  type CompletedNotifyStorage,
} from "../src/renderer/lib/completed-task-notify";
import { state$ } from "../src/renderer/lib/state";

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

const memoryStore = (): CompletedNotifyStorage & { data: ReturnType<typeof emptyCompletedNotifyPersist> } => {
  let data = emptyCompletedNotifyPersist();
  return {
    get data() {
      return data;
    },
    load: () => data,
    save: (next) => {
      data = {
        dismissed: [...next.dismissed],
        completedSeen: [...next.completedSeen],
      };
    },
  };
};

describe("completed-task-notify", () => {
  afterEach(() => {
    clearCompletedNotifyPersistForTests();
  });

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

  it("does not baseline an empty opening snapshot (EMPTY_DOC boot)", () => {
    const empty = observeCompletedTasks(
      emptyCompletedNotifyState(),
      collectTaskSnapshots([]),
      1,
    );
    expect(empty.baselined).toBe(false);
    expect(empty.stack).toEqual([]);
    expect(empty.known).toEqual({});
  });

  it("empty-then-full cold open does not replay already-completed rows", () => {
    let state = observeCompletedTasks(
      emptyCompletedNotifyState(),
      collectTaskSnapshots([]),
      1,
    );
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [
          { id: "t1", state: "completed", brief: "Say hi 4" },
          { id: "t2", state: "completed", brief: "Say hi another time" },
        ]),
      ]),
      2,
    );
    expect(state.baselined).toBe(true);
    expect(state.stack).toEqual([]);
    expect(state.known.t1).toBe("completed");
    expect(state.known.t2).toBe("completed");
  });

  it("still rises for a live completion after empty-then-full baseline", () => {
    let state = observeCompletedTasks(
      emptyCompletedNotifyState(),
      collectTaskSnapshots([]),
      1,
    );
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "working", brief: "Ship it" }]),
      ]),
      2,
    );
    expect(state.stack).toEqual([]);
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "Ship it" }]),
      ]),
      3,
    );
    expect(state.stack.map((item) => item.id)).toEqual(["t1"]);
  });

  it("click-cleared notify does not replay after empty-then-full restart", () => {
    let state = observeCompletedTasks(
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

    // Renderer restart: memory gone, boot EMPTY_DOC, then same completed row.
    let cold = observeCompletedTasks(
      emptyCompletedNotifyState(),
      collectTaskSnapshots([]),
      3,
    );
    cold = observeCompletedTasks(
      cold,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      4,
    );
    expect(cold.stack).toEqual([]);
    expect(cold.known.t1).toBe("completed");
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

    state = observeCompletedTasks(state, collectTaskSnapshots([]), 3);
    expect(state.dismissed.t1).toBe(true);
    expect(state.known.t1).toBe("completed");

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
    expect(state.stack).toEqual([]);
  });

  it("baseline preserves hydrated dismiss (cold open after click)", () => {
    const hydrated = hydrateNotifyStateFromPersist({
      dismissed: ["t1"],
      completedSeen: ["t1"],
    });
    expect(hydrated.dismissed.t1).toBe(true);
    expect(hydrated.known.t1).toBe("completed");

    const baselined = observeCompletedTasks(
      hydrated,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      1,
    );
    expect(baselined.stack).toEqual([]);
    expect(baselined.dismissed.t1).toBe(true);

    // Still quiet after baseline when rows keep flowing.
    const again = observeCompletedTasks(
      baselined,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      2,
    );
    expect(again.stack).toEqual([]);
  });

  it("persist + hydrate round-trip keeps dismiss", () => {
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
    const persist = persistFromNotifyState(state);
    expect(persist.dismissed).toContain("t1");
    expect(persist.completedSeen).toContain("t1");

    const cold = hydrateNotifyStateFromPersist(persist);
    const after = observeCompletedTasks(
      cold,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      3,
    );
    expect(after.stack).toEqual([]);
  });

  it("activate clears the stack and a cold EMPTY_DOC boot does not replay it", () => {
    clearCompletedNotifyPersistForTests();
    const working = [
      taskNode("sink", [{ id: "t1", state: "working", brief: "A" }]),
    ];
    const done = [
      taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
    ];
    syncCompletedTaskNotifyFromDoc(working, 1);
    syncCompletedTaskNotifyFromDoc(done, 2);
    activateCompletedTaskNotify({
      id: "t1",
      nodeId: "sink",
      brief: "A",
      at: 2,
    });
    expect(completedTaskNotify$.items.peek()).toEqual([]);

    // Renderer process restart: persist is gone; first tick is EMPTY_DOC.
    clearCompletedNotifyPersistForTests();
    resetCompletedTaskNotify();
    syncCompletedTaskNotifyFromDoc([], 3);
    expect(completedTaskNotify$.items.peek()).toEqual([]);
    syncCompletedTaskNotifyFromDoc(done, 4);
    expect(completedTaskNotify$.items.peek()).toEqual([]);
  });

  it("activateCompletedTaskNotify writes durable dismiss and survives re-hydrate", () => {
    const store = memoryStore();
    const restore = setCompletedNotifyStorageForTests(store);
    try {
      clearCompletedNotifyPersistForTests();
      const working = [
        taskNode("sink", [{ id: "t1", state: "working", brief: "A" }]),
      ];
      const done = [
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ];
      state$.doc.set({ nodes: working, edges: [] });
      syncCompletedTaskNotifyFromDoc(working, 1);
      state$.doc.set({ nodes: done, edges: [] });
      syncCompletedTaskNotifyFromDoc(done, 2);

      activateCompletedTaskNotify({
        id: "t1",
        nodeId: "sink",
        brief: "A",
        at: 2,
      });
      expect(store.data.dismissed).toContain("t1");
      expect(store.data.completedSeen).toContain("t1");
      expect(completedTaskNotify$.items.peek()).toEqual([]);

      // Cold process: re-hydrate from durable store, re-sync same completed.
      resetCompletedTaskNotify();
      syncCompletedTaskNotifyFromDoc(done, 3);
      expect(completedTaskNotify$.items.peek()).toEqual([]);
      expect(store.data.dismissed).toContain("t1");
    } finally {
      restore();
      clearCompletedNotifyPersistForTests();
    }
  });
  it("mark all read clears the whole stack and holds every id dismissed", () => {
    let state = observeCompletedTasks(
      emptyCompletedNotifyState(),
      collectTaskSnapshots([
        taskNode("sink", [
          { id: "t1", state: "working", brief: "A" },
          { id: "t2", state: "working", brief: "B" },
        ]),
      ]),
      1,
    );
    const done = [
      taskNode("sink", [
        { id: "t1", state: "completed", brief: "A" },
        { id: "t2", state: "completed", brief: "B" },
      ]),
    ];
    state = observeCompletedTasks(state, collectTaskSnapshots(done), 2);
    expect(state.stack).toHaveLength(2);

    state = dismissAllCompletedNotify(state);
    expect(state.stack).toEqual([]);
    expect(Object.keys(state.dismissed).sort()).toEqual(["t1", "t2"]);

    // Same rows keep arriving completed — nothing comes back.
    state = observeCompletedTasks(state, collectTaskSnapshots(done), 3);
    expect(state.stack).toEqual([]);
  });

  it("mark all read survives a projection gap, and a re-completion still rises", () => {
    let state = observeCompletedTasks(
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
    state = dismissAllCompletedNotify(state);

    // Gap tick (row absent) must not re-raise it.
    state = observeCompletedTasks(state, collectTaskSnapshots([]), 3);
    expect(state.stack).toEqual([]);

    // Reopened, then completed again: an observed non-completed state clears
    // the dismiss, so the second completion is a real rising edge.
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "working", brief: "A" }]),
      ]),
      4,
    );
    state = observeCompletedTasks(
      state,
      collectTaskSnapshots([
        taskNode("sink", [{ id: "t1", state: "completed", brief: "A" }]),
      ]),
      5,
    );
    expect(state.stack.map((item) => item.id)).toEqual(["t1"]);
  });

  it("mark all read on an empty stack is a no-op", () => {
    const state = emptyCompletedNotifyState();
    expect(dismissAllCompletedNotify(state)).toBe(state);
  });

  it("markAllCompletedNotifyRead empties the live stack and persists it", () => {
    const store = { data: emptyCompletedNotifyPersist() };
    const storage: CompletedNotifyStorage = {
      load: () => store.data,
      save: (next) => {
        store.data = next;
      },
    };
    const restore = setCompletedNotifyStorageForTests(storage);
    try {
      resetCompletedTaskNotify();
      const working = [
        taskNode("sink", [
          { id: "t1", state: "working", brief: "A" },
          { id: "t2", state: "working", brief: "B" },
        ]),
      ];
      const done = [
        taskNode("sink", [
          { id: "t1", state: "completed", brief: "A" },
          { id: "t2", state: "completed", brief: "B" },
        ]),
      ];
      state$.doc.set({ nodes: working, edges: [] });
      syncCompletedTaskNotifyFromDoc(working, 1);
      state$.doc.set({ nodes: done, edges: [] });
      syncCompletedTaskNotifyFromDoc(done, 2);
      expect(completedTaskNotify$.items.peek()).toHaveLength(2);

      markAllCompletedNotifyRead();
      expect(completedTaskNotify$.items.peek()).toEqual([]);
      expect([...store.data.dismissed].sort()).toEqual(["t1", "t2"]);

      // Cold process: the durable dismiss holds.
      resetCompletedTaskNotify();
      syncCompletedTaskNotifyFromDoc(done, 3);
      expect(completedTaskNotify$.items.peek()).toEqual([]);
    } finally {
      restore();
      clearCompletedNotifyPersistForTests();
    }
  });
});
