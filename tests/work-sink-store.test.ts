import { describe, expect, it, vi } from "vitest";
import type { WorkSinkChanged, WorkSinkPage, WorkSinkQuery } from "../src/shared/work-sinks";
import { createWorkSinkStore } from "../src/renderer/lib/work-sink-store";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tasks = (ids: string[], nextBeforeId?: string): WorkSinkPage => ({ kind: "task",
  items: ids.map((id) => ({ id, state: "submitted", history: [] })),
  ...(nextBeforeId === undefined ? {} : { nextBeforeId }) });

describe("work sink store", () => {
  it("refreshes the addressed node only and rebases its loaded pages", async () => {
    let notify!: (event: WorkSinkChanged) => void;
    let ids = ["06", "05", "04", "03", "02", "01"];
    const off = vi.fn();
    const read = vi.fn(async (query: WorkSinkQuery): Promise<WorkSinkPage> => {
      if (query.kind === "pad") return { kind: "pad", glance: { revision: 1, shapeCount: 3, unreadPinCount: 0 } };
      const remaining = ids.filter((id) => query.beforeId === undefined || id < query.beforeId);
      return tasks(remaining.slice(0, 2), remaining.length > 2 ? remaining[1] : undefined);
    });
    const store = createWorkSinkStore(() => ({ workSinkPage: read, onWorkSinkChanged: (listener) => { notify = listener; return off; } }));
    const query = { canvasName: "factory", nodeId: "tasks", kind: "task" } as const;
    const releaseTask = store.retain(query);
    const releasePad = store.retain({ ...query, nodeId: "pad", kind: "pad" });
    await flush();
    await store.loadMore(query);
    ids = ["08", "07", ...ids];
    read.mockClear();
    notify({ canvasName: "factory", nodeId: "tasks" });
    await flush();
    expect(read.mock.calls.map(([query]) => [query.nodeId, query.beforeId])).toEqual([["tasks", undefined], ["tasks", "07"]]);
    expect(store.state(query).page.peek()).toEqual(tasks(["08", "07", "06", "05"], "05"));
    releaseTask(); releasePad();
    expect(off).toHaveBeenCalledOnce();
  });
  it("refuses a different kind returned for the requested sink", async () => {
    const store = createWorkSinkStore(() => ({ workSinkPage: async () => ({ kind: "pad" }), onWorkSinkChanged: () => () => {} }));
    const query = { canvasName: "factory", nodeId: "tasks", kind: "task" } as const;
    const release = store.retain(query);
    await flush();
    expect(store.state(query).error.peek()).toContain("kind differs");
    expect(store.state(query).page.peek()).toEqual(tasks([]));
    release();
  });
});
