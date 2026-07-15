import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { resetWatcherMemory } from "../src/main/vellum/kernel/evaluate";
import {
  __resetKernelMemoryForTest,
  __resetPulseLogForTest,
  __setDeliveryDepsForTest,
  __setSnapshotsForTest,
  checkTimers,
  deliverPulse,
  getArmed,
  getNextFire,
  getPulseLog,
  getWatchers,
  purgeCanvasMemory,
  reconcileLiveCanvasMemory,
  runEvaluationCycle,
  setArmed,
  setDocs,
  type PulseDeliverDeps,
} from "../src/main/vellum/kernel/cycle";

// sdk-kernel-build fix 3 (arming is operator intent, survives canvas deletion
// in-session) and fix 7 (stale watcher/timer entries on a STILL-LIVE canvas are
// swept, arming is never touched).

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

const watcherNode = (id: string) => ({
  id,
  type: "text" as const,
  text: "watch",
  x: 0,
  y: 0,
  width: 120,
  height: 40,
  ether: { watch: { kind: "stat_threshold" as const, source: "tower" as const, key: "proj", stat: "signals", op: "gt" as const, value: 10 } },
});

const timerNode = (id: string) => ({
  id,
  type: "text" as const,
  text: "timer",
  x: 0,
  y: 200,
  width: 120,
  height: 40,
  ether: { timer: { everyMinutes: 10 } },
});

const plainNode = (id: string) => ({ id, type: "text" as const, text: "note", x: 0, y: 400, width: 120, height: 40 });

beforeEach(() => {
  __resetKernelMemoryForTest();
  __resetPulseLogForTest();
  resetWatcherMemory();
  __setSnapshotsForTest(snapshotsWithStat("signals", 3)); // below threshold -> pending
});

afterEach(() => {
  __setDeliveryDepsForTest(undefined);
});

describe("fix 3 — arming survives canvas deletion; derived state does not", () => {
  it("purgeCanvasMemory drops watchers/nextFire but preserves the armed intent", async () => {
    const doc: CanvasDoc = { nodes: [watcherNode("f3-w1"), timerNode("f3-t1")], edges: [] };
    setDocs(new Map([["f3-canvas", doc]]));
    await runEvaluationCycle(); // populates watchers["f3-canvas::f3-w1"]
    await checkTimers(); // populates nextFire["f3-canvas::f3-t1"]
    setArmed("f3-canvas::f3-r1", true);

    expect(getWatchers().has("f3-canvas::f3-w1")).toBe(true);
    expect(getNextFire().has("f3-canvas::f3-t1")).toBe(true);

    purgeCanvasMemory("f3-canvas");

    // Derived state gone; operator intent kept (was previously armed.delete'd).
    expect(getWatchers().has("f3-canvas::f3-w1")).toBe(false);
    expect(getNextFire().has("f3-canvas::f3-t1")).toBe(false);
    expect(getArmed().get("f3-canvas::f3-r1")).toBe(true);
  });

  it("a delete+recreate under the same name resumes armed — a live delivery, not dry", async () => {
    setArmed("f3-resume::region1", true);
    purgeCanvasMemory("f3-resume"); // canvas deleted; arming preserved

    // Canvas recreated under the same name, same region node id, an agent inside.
    const recreated: CanvasDoc = {
      nodes: [
        { id: "region1", type: "group", x: 0, y: 0, width: 400, height: 400 },
        {
          id: "agent-a",
          type: "text",
          text: "agent",
          x: 40,
          y: 40,
          width: 100,
          height: 50,
          ether: { bindings: [{ source: "hermes", ref: { type: "agent", key: "remote-a:vega" } }] },
        },
      ],
      edges: [],
    };
    setDocs(new Map([["f3-resume", recreated]]));

    const calls: string[] = [];
    const deps: PulseDeliverDeps = {
      isLive: () => false,
      openChat: async (key) => void calls.push(`open:${key}`),
      sendPrompt: async (key) => void calls.push(`send:${key}`),
    };
    await deliverPulse({ canvasName: "f3-resume", sourceNodeId: "region1", kind: "manual", regionId: "region1", summary: "resumed", deps });

    const record = getPulseLog()[0];
    expect(record?.dry).toBe(false); // armed intent resumed automatically
    expect(record?.delivered).toEqual(["remote-a:vega"]);
  });
});

describe("fix 7 — reconcile sweeps removed watchers/timers on a live canvas", () => {
  it("drops entries whose node/watch/timer is gone, keeps live ones, never touches arming", async () => {
    const before: CanvasDoc = { nodes: [watcherNode("f7-w1"), watcherNode("f7-w2"), timerNode("f7-t1")], edges: [] };
    setDocs(new Map([["f7-canvas", before]]));
    await runEvaluationCycle();
    await checkTimers();
    setArmed("f7-canvas::f7-r1", true);

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
    expect(getArmed().get("f7-canvas::f7-r1")).toBe(true); // arming untouched
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
