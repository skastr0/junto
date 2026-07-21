import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { resetWatcherMemory } from "../src/main/vellum/kernel/evaluate";
import {
  __setDocsForTest,
  __setFlagWriterForTest,
  __setSnapshotsForTest,
  runEvaluationCycle,
  type FlagWriterDeps,
} from "../src/main/vellum/kernel/cycle";

// sdk-kernel-build fix 5 — JSON Canvas node ids are DOCUMENT-LOCAL: the same id
// on two canvases is legitimate. The flag-mirror write is now routed by
// (canvasName, nodeId), so a colliding id reaches the RIGHT document on each
// canvas — the previous behavior (drop the id from a global index, disabling
// flag writes for all 250 colliding real nodes) is gone.

const snapshotsWithStat = (stat: string, value: number): SnapshotState => ({
  bundles: [
    {
      source: "tower",
      fetchedAt: new Date().toISOString(),
      ok: true,
      entities: [{ source: "tower", key: "proj", kind: "project", stats: { [stat]: value }, updatedAt: new Date().toISOString() }],
    },
  ],
});

// A watcher node with a given id. stat_threshold (below the threshold ->
// pending) + flagOnUnsatisfied drives the blocker flag write. No existing
// blocker flag, so pending -> the write fires.
const docWithWatcher = (nodeId: string): CanvasDoc => ({
  nodes: [
    {
      id: nodeId,
      type: "text",
      text: "watch",
      x: 0,
      y: 0,
      width: 120,
      height: 40,
      ether: {
        entity: { kind: "watcher" },
        watch: { kind: "stat_threshold", source: "tower", key: "proj", stat: "signals", op: "gt", value: 10, flagOnUnsatisfied: true },
      },
    },
  ],
  edges: [],
});

describe("flag-mirror routing by (canvasName, nodeId)", () => {
  const writes: Array<{ canvasName: string; nodeId: string; flag: string; enabled: boolean }> = [];

  beforeEach(() => {
    resetWatcherMemory();
    writes.length = 0;
    const capture: FlagWriterDeps = {
      setFlag: (canvasName, nodeId, flag, enabled) => {
        writes.push({ canvasName, nodeId, flag, enabled });
      },
    };
    __setFlagWriterForTest(capture);
    __setSnapshotsForTest(snapshotsWithStat("signals", 3)); // below 10 -> pending
  });

  afterEach(() => {
    __setFlagWriterForTest(undefined);
  });

  it("a node id shared across two canvases routes a flag write to EACH canvas — never dropped", async () => {
    __setDocsForTest(
      new Map([
        ["canvas-a", docWithWatcher("shared-node")],
        ["canvas-b", docWithWatcher("shared-node")],
      ]),
    );

    await runEvaluationCycle();

    // Both canvases got their own write for the same node id — the old
    // collision-exclusion would have produced ZERO writes here.
    expect(writes).toContainEqual({ canvasName: "canvas-a", nodeId: "shared-node", flag: "blocker", enabled: true });
    expect(writes).toContainEqual({ canvasName: "canvas-b", nodeId: "shared-node", flag: "blocker", enabled: true });
    expect(writes).toHaveLength(2);
  });

  it("routes to the single owning canvas when ids are unique", async () => {
    __setDocsForTest(
      new Map([
        ["canvas-a", docWithWatcher("shared-node")],
        ["canvas-b", docWithWatcher("only-b")],
      ]),
    );

    await runEvaluationCycle();

    expect(writes).toContainEqual({ canvasName: "canvas-a", nodeId: "shared-node", flag: "blocker", enabled: true });
    expect(writes).toContainEqual({ canvasName: "canvas-b", nodeId: "only-b", flag: "blocker", enabled: true });
    expect(writes).toHaveLength(2);
  });
});
