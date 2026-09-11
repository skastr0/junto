import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { resetWatcherMemory } from "../src/main/vellum-command/kernel/evaluate";
import {
  __resetKernelMemoryForTest,
  __setAutomationGateForTest,
  __setDocsForTest,
  __setSnapshotsForTest,
  __setStationScopeForTest,
  __setTimerSchedulerForTest,
  checkTimers,
  getNextFire,
  getWatchers,
  runEvaluationCycle,
} from "../src/main/vellum-command/kernel/cycle";
import { __setSchedulerEffectDepsForTest } from "../src/main/vellum-command/kernel/effects";
import { makeInMemoryTimerScheduler } from "./helpers/in-memory-timer-scheduler";
import { planConnectToTarget } from "../src/renderer/lib/edge-mutations";
import { compileVerb } from "../src/shared/physics";

const hermesSnapshots = (value: number): SnapshotState => ({
  bundles: [
    {
      source: "hermes",
      fetchedAt: new Date().toISOString(),
      ok: true,
      entities: [
        {
          source: "hermes",
          key: "local:agent",
          kind: "agent",
          stats: { running: value },
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  ],
});

const gaugeAndTask = (): CanvasDoc =>
  ({
    nodes: [
      {
        id: "g1",
        type: "text",
        text: "gauge",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        ether: {
          entity: { kind: "watcher" },
          host: "local",
          watch: {
            kind: "stat_threshold",
            source: "hermes",
            key: "local:agent",
            stat: "running",
            op: "eq",
            value: 1,
          },
        },
      },
      {
        id: "t1",
        type: "text",
        text: "tasks",
        x: 200,
        y: 0,
        width: 100,
        height: 40,
        ether: { entity: { kind: "task" }, tasks: { items: [] } },
      },
      {
        id: "c1",
        type: "text",
        text: "cron",
        x: 0,
        y: 100,
        width: 100,
        height: 40,
        ether: {
          entity: { kind: "cron" },
          host: "local",
          timer: { everyMinutes: 30 },
        },
      },
    ],
    edges: [
      { id: "e1", fromNode: "g1", toNode: "t1", ether: { verb: "enqueues" } },
    ],
  }) as CanvasDoc;

describe("scheduler automation gate", () => {
  beforeEach(() => {
    __resetKernelMemoryForTest();
    resetWatcherMemory();
    __setStationScopeForTest({ hostId: "local", role: "command-center" });
    __setTimerSchedulerForTest(makeInMemoryTimerScheduler());
  });

  afterEach(() => {
    __setTimerSchedulerForTest(undefined);
    __setAutomationGateForTest(undefined);
    __setSchedulerEffectDepsForTest(undefined);
  });

  it("when paused, does not fire gauge effects and preserves rising edge for later", async () => {
    const enqueues: string[] = [];
    __setAutomationGateForTest({
      canAutomateCanvas: () => false,
      canApplyFlagEffects: () => true,
    });
    __setSchedulerEffectDepsForTest({
      canAutomateCanvas: () => false,
      canApplyFlagEffects: () => true,
      hasReceipt: () => false,
      recordReceipt: () => undefined,
      enqueueTask: async ({ payload }) => {
        enqueues.push(payload.brief);
        return { ok: true };
      },
      setFlag: async () => ({ ok: true }),
    });

    __setDocsForTest(new Map([["board", gaugeAndTask()]]));
    // Baseline pending (running=0)
    __setSnapshotsForTest(hermesSnapshots(0));
    await runEvaluationCycle();
    expect(getWatchers().get("board::g1")?.status).toBe("pending");
    expect(enqueues).toEqual([]);

    // Rising edge while paused — status updates, no fire, no memory consume
    __setSnapshotsForTest(hermesSnapshots(1));
    await runEvaluationCycle();
    expect(getWatchers().get("board::g1")?.status).toBe("satisfied");
    expect(enqueues).toEqual([]);

    // Resume automation — edge still available, fires once
    __setAutomationGateForTest({
      canAutomateCanvas: () => true,
      canApplyFlagEffects: () => true,
    });
    __setSchedulerEffectDepsForTest({
      canAutomateCanvas: () => true,
      canApplyFlagEffects: () => true,
      hasReceipt: () => false,
      recordReceipt: () => undefined,
      enqueueTask: async ({ payload }) => {
        enqueues.push(payload.brief);
        return { ok: true };
      },
      setFlag: async () => ({ ok: true }),
    });
    await runEvaluationCycle();
    expect(enqueues).toEqual(["From gauge"]);
  });

  it("when paused, cron still projects nextFire without claiming fire", async () => {
    __setAutomationGateForTest({
      canAutomateCanvas: () => false,
      canApplyFlagEffects: () => false,
    });
    __setDocsForTest(new Map([["board", gaugeAndTask()]]));
    const t0 = 1_700_000_000_000;
    await checkTimers(t0);
    // Initialized: next due is t0 + 30m
    expect(getNextFire().get("board::c1")).toBe(t0 + 30 * 60_000);

    // Far in the future while still paused — still due (coalesce shows latest
    // due slot) without advancing durable cursor.
    const later = t0 + 60 * 60_000;
    await checkTimers(later);
    const due = getNextFire().get("board::c1");
    expect(due).toBeDefined();
    expect(due!).toBeLessThanOrEqual(later);
    // Cursor still unconsumed: re-peek at same time yields same due projection.
    await checkTimers(later);
    expect(getNextFire().get("board::c1")).toBe(due);
  });
});

describe("multi-connect effect parity", () => {
  it("plans enqueues when connecting scheduler sources to a task sink", () => {
    const nodes = gaugeAndTask().nodes;
    const plan = planConnectToTarget(["c1", "g1"], "t1", nodes, []);
    expect(plan.toAdd).toHaveLength(2);
    expect(plan.toAdd.every((c) => c.verb === "enqueues")).toBe(true);
    for (const candidate of plan.toAdd) {
      expect(
        compileVerb(candidate.verb, "cron", "task")?.does?.mode,
      ).toBe("enqueue_task");
    }
  });
});
