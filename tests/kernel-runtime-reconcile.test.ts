import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { resetWatcherMemory } from "../src/main/vellum/kernel/evaluate";
import {
  __resetKernelMemoryForTest,
  __setSnapshotsForTest,
  __setStationScopeForTest,
  __setTimerSchedulerForTest,
  checkTimers,
  getNextFire,
  getWatchers,
  purgeCanvasMemory,
  reconcileLiveCanvasMemory,
  runEvaluationCycle,
  setDocs,
} from "../src/main/vellum/kernel/cycle";
import { makeInMemoryTimerScheduler } from "./helpers/in-memory-timer-scheduler";

// purgeCanvasMemory / reconcileLiveCanvasMemory: derived watcher/timer state
// is swept; region-pulse arming product is retired.

const snapshotsWithStat = (stat: string, value: number): SnapshotState => ({
  bundles: [
    {
      source: "hermes",
      fetchedAt: new Date().toISOString(),
      ok: true,
      entities: [{ source: "hermes", key: "proj", kind: "project", stats: { [stat]: value }, updatedAt: new Date().toISOString() }],
    },
  ],
});

const watcherNode = (id: string) => ({
  id,
  type: "text" as const,
  text: "watch",
  x: 0,
  y: 0,
  width: 120,
  height: 40,
  ether: {
    entity: { kind: "watcher" as const },
    watch: { kind: "stat_threshold" as const, source: "hermes" as const, key: "proj", stat: "signals", op: "gt" as const, value: 10 },
  },
});

const timerNode = (id: string) => ({
  id,
  type: "text" as const,
  text: "timer",
  x: 0,
  y: 200,
  width: 120,
  height: 40,
  ether: { entity: { kind: "timer" as const }, timer: { everyMinutes: 10 } },
});

const plainNode = (id: string) => ({ id, type: "text" as const, text: "note", x: 0, y: 400, width: 120, height: 40 });

beforeEach(() => {
  __resetKernelMemoryForTest();
  resetWatcherMemory();
  __setStationScopeForTest({ hostId: "local", role: "command-center" });
  __setTimerSchedulerForTest(makeInMemoryTimerScheduler());
  __setSnapshotsForTest(snapshotsWithStat("signals", 3)); // below threshold -> pending
});

afterEach(() => {
  __setTimerSchedulerForTest(undefined);
});

describe("purgeCanvasMemory — drops derived watcher/timer state", () => {
  it("purgeCanvasMemory drops watchers and nextFire for the canvas", async () => {
    const doc: CanvasDoc = { nodes: [watcherNode("f3-w1"), timerNode("f3-t1")], edges: [] };
    setDocs(new Map([["f3-canvas", doc]]));
    await runEvaluationCycle(); // populates watchers["f3-canvas::f3-w1"]
    await checkTimers(); // populates nextFire["f3-canvas::f3-t1"]

    expect(getWatchers().has("f3-canvas::f3-w1")).toBe(true);
    expect(getNextFire().has("f3-canvas::f3-t1")).toBe(true);

    purgeCanvasMemory("f3-canvas");

    expect(getWatchers().has("f3-canvas::f3-w1")).toBe(false);
    expect(getNextFire().has("f3-canvas::f3-t1")).toBe(false);
  });
});

describe("reconcileLiveCanvasMemory — sweeps removed watchers/timers on a live canvas", () => {
  it("drops entries whose node/watch/timer is gone, keeps live ones", async () => {
    const before: CanvasDoc = { nodes: [watcherNode("f7-w1"), watcherNode("f7-w2"), timerNode("f7-t1")], edges: [] };
    setDocs(new Map([["f7-canvas", before]]));
    await runEvaluationCycle();
    await checkTimers();

    expect(getWatchers().has("f7-canvas::f7-w1")).toBe(true);
    expect(getWatchers().has("f7-canvas::f7-w2")).toBe(true);
    expect(getNextFire().has("f7-canvas::f7-t1")).toBe(true);

    // Canvas STILL exists, but w2 is deleted, w1 keeps its watch, and the timer
    // node loses its .timer (turned into a plain note).
    const after: CanvasDoc = { nodes: [watcherNode("f7-w1"), plainNode("f7-t1")], edges: [] };
    setDocs(new Map([["f7-canvas", after]]));
    reconcileLiveCanvasMemory();

    expect(getWatchers().has("f7-canvas::f7-w1")).toBe(true); // still present -> kept
    expect(getWatchers().has("f7-canvas::f7-w2")).toBe(false); // node gone -> swept
    expect(getNextFire().has("f7-canvas::f7-t1")).toBe(false); // timer removed -> swept
  });

  it("leaves entries for a NOT-hydrated canvas alone (that is purgeCanvasMemory's job)", async () => {
    const doc: CanvasDoc = { nodes: [watcherNode("f7b-w1")], edges: [] };
    setDocs(new Map([["f7b-canvas", doc]]));
    await runEvaluationCycle();
    expect(getWatchers().has("f7b-canvas::f7b-w1")).toBe(true);

    // Reconcile with the canvas NOT in docs — must not sweep (it may just be
    // un-hydrated, not deleted; only a real delete via purgeCanvasMemory drops it).
    setDocs(new Map());
    reconcileLiveCanvasMemory();
    expect(getWatchers().has("f7b-canvas::f7b-w1")).toBe(true);
  });
});
