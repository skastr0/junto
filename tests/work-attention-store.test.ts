import { describe, expect, it, vi } from "vitest";
import type { WorkAttentionQuery, WorkSinkChanged } from "../src/shared/work-sinks";
import type { WorkAttentionSnapshot } from "../src/shared/work-attention";
import { emptySinkGlance } from "../src/shared/work-attention";
import { createWorkAttentionStore } from "../src/renderer/lib/work-attention-store";

const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const snapshot = (nodeId: string, count: number): WorkAttentionSnapshot => ({ glances: [{ ...emptySinkGlance(nodeId), count }], items: [] });

describe("work attention store", () => {
  it("shares the initial read and refreshes only the changed sink", async () => {
    let changed!: (event: WorkSinkChanged) => void;
    const read = vi.fn(async (query: WorkAttentionQuery) => query.nodeId ? snapshot(query.nodeId, 3) : {
      glances: [snapshot("tasks", 1).glances[0]!, snapshot("asks", 2).glances[0]!], items: [],
    });
    const off = vi.fn();
    const store = createWorkAttentionStore(() => ({ workAttention: read, onWorkSinkChanged: (listener) => { changed = listener; return off; } }));
    const releaseFirst = store.retain("factory");
    const releaseSecond = store.retain("factory");
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    const asks = store.state("factory").byNodeId.asks.peek();
    changed({ canvasName: "other", nodeId: "tasks" });
    changed({ canvasName: "factory", nodeId: "tasks" });
    await flush();
    expect(read.mock.calls.map(([query]) => query)).toEqual([{ canvasName: "factory" }, { canvasName: "factory", nodeId: "tasks" }]);
    expect(store.state("factory").byNodeId.tasks.count.peek()).toBe(3);
    expect(store.state("factory").byNodeId.asks.peek()).toBe(asks);
    releaseFirst(); expect(off).not.toHaveBeenCalled();
    releaseSecond(); expect(off).toHaveBeenCalledOnce();
  });

  it("rechecks an event that arrived during an outstanding read", async () => {
    let changed!: (event: WorkSinkChanged) => void;
    let resolve!: (snapshot: WorkAttentionSnapshot) => void;
    const read = vi.fn((query: WorkAttentionQuery): Promise<WorkAttentionSnapshot> => query.nodeId
      ? Promise.resolve(snapshot(query.nodeId, 2))
      : new Promise((done) => { resolve = done; }));
    const store = createWorkAttentionStore(() => ({ workAttention: read, onWorkSinkChanged: (listener) => { changed = listener; return () => {}; } }));
    const release = store.retain("factory");
    await flush();
    changed({ canvasName: "factory", nodeId: "tasks" });
    resolve(snapshot("tasks", 1));
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.state("factory").byNodeId.tasks.count.peek()).toBe(2);
    release();
  });
});
