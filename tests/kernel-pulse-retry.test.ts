import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  __getPendingPulseDeliveryCountForTest,
  __resetDeliveryQueueForTest,
  __resetKernelMemoryForTest,
  __setDeliveryDepsForTest,
  __setDocsForTest,
  __setSnapshotsForTest,
  __setStationScopeForTest,
  __setTimerSchedulerForTest,
  checkTimers,
  getPulseLog,
  getWatchers,
  retryPendingPulseDeliveries,
  runEvaluationCycle,
  setArmed,
  setPausedLookup,
  type PulseDeliverDeps,
} from "../src/main/vellum/kernel/cycle";
import { makeInMemoryTimerScheduler } from "./helpers/in-memory-timer-scheduler";

const canvasName = "pulse-retry";
const regionId = "operations";
const agentId = "agent";
const agentKey = "local:agent";
const bindingId = "bind-local-agent";

const region = {
  id: regionId,
  type: "group" as const,
  x: 0,
  y: 0,
  width: 500,
  height: 400,
  ether: { region: { instruction: "Continue the release." } },
};

const agent = {
  id: agentId,
  type: "text" as const,
  text: "agent",
  x: 260,
  y: 40,
  width: 160,
  height: 60,
  ether: {
    entity: { kind: "agent", name: agentKey },
    terminal: {
      bindingId,
      harness: "claude" as const,
      launch: { kind: "harness" as const, argv: ["claude"] },
    },
  },
};

const timerDocument = (timerId: string): CanvasDoc => ({
  nodes: [
    region,
    {
      id: timerId,
      type: "text",
      text: "release timer",
      x: 40,
      y: 40,
      width: 180,
      height: 60,
      ether: {
        entity: { kind: "timer" },
        timer: { everyMinutes: 1 },
      },
    },
    agent,
  ],
  edges: [
    {
      id: "timer-to-agent",
      fromNode: timerId,
      toNode: agentId,
    },
  ],
});

const watcherDocument = (
  watcherId: string,
  connected = true,
): CanvasDoc => ({
  nodes: [
    region,
    {
      id: watcherId,
      type: "text",
      text: "release committed",
      x: 40,
      y: 40,
      width: 180,
      height: 60,
      ether: {
        entity: { kind: "watcher" },
        watch: {
          kind: "stat_threshold",
          source: "hermes",
          key: "proj",
          stat: "signals",
          op: "gt",
          value: 10,
        },
      },
    },
    agent,
  ],
  edges: connected
    ? [
        {
          id: "watcher-to-agent",
          fromNode: watcherId,
          toNode: agentId,
        },
      ]
    : [],
});

const flushDelivery = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("scheduled pulse retry after a managed seat is unavailable", () => {
  let transportReady = false;
  let attempts = 0;
  let successfulWrites = 0;
  let holdReadyWrite = false;
  let releaseReadyWrite: ((accepted: boolean) => void) | undefined;

  const delivery: PulseDeliverDeps = {
    sendManagedTerminal: async () => {
      attempts += 1;
      if (!transportReady) return false;
      if (holdReadyWrite) {
        return new Promise<boolean>((resolve) => {
          releaseReadyWrite = (accepted) => {
            if (accepted) successfulWrites += 1;
            resolve(accepted);
          };
        });
      }
      successfulWrites += 1;
      return true;
    },
  };

  beforeEach(() => {
    transportReady = false;
    attempts = 0;
    successfulWrites = 0;
    holdReadyWrite = false;
    releaseReadyWrite = undefined;
    __resetKernelMemoryForTest();
    __resetDeliveryQueueForTest();
    __setStationScopeForTest({
      hostId: "local",
      role: "command-center",
    });
    __setDeliveryDepsForTest(delivery);
    setPausedLookup(() => false);
    setArmed(`${canvasName}::${regionId}`, true);
  });

  afterEach(() => {
    __resetDeliveryQueueForTest();
    __resetKernelMemoryForTest();
    setPausedLookup(() => false);
  });

  it("retains a stat-threshold pulse until a later cycle can drive it once", async () => {
    const watcherId = "release-entered";
    __setDocsForTest(
      new Map([[canvasName, watcherDocument(watcherId)]]),
    );

    const pendingSnap = {
      bundles: [{
        source: "hermes" as const,
        fetchedAt: new Date().toISOString(),
        ok: true,
        entities: [{
          source: "hermes" as const,
          key: "proj",
          kind: "project",
          stats: { signals: 3 },
          updatedAt: new Date().toISOString(),
        }],
      }],
    };
    const satisfiedSnap = {
      bundles: [{
        source: "hermes" as const,
        fetchedAt: new Date().toISOString(),
        ok: true,
        entities: [{
          source: "hermes" as const,
          key: "proj",
          kind: "project",
          stats: { signals: 34 },
          updatedAt: new Date().toISOString(),
        }],
      }],
    };

    __setSnapshotsForTest(pendingSnap);
    await runEvaluationCycle();
    __setSnapshotsForTest(satisfiedSnap);
    await runEvaluationCycle();
    await flushDelivery();

    expect(attempts).toBe(1);
    expect(successfulWrites).toBe(0);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(1);
    expect(
      getPulseLog().filter((record) => record.canvasName === canvasName && !record.dry),
    ).toEqual([]);
    expect(
      getWatchers().get(`${canvasName}::${watcherId}`)?.lastFiredAt,
    ).toBeUndefined();

    transportReady = true;
    retryPendingPulseDeliveries();
    await flushDelivery();

    expect(attempts).toBe(2);
    expect(successfulWrites).toBe(1);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(0);
    expect(
      getPulseLog().filter((record) => record.canvasName === canvasName && !record.dry),
    ).toHaveLength(1);
    expect(
      getWatchers().get(`${canvasName}::${watcherId}`)?.lastFiredAt,
    ).toEqual(expect.any(Number));

    retryPendingPulseDeliveries();
    await runEvaluationCycle();
    await flushDelivery();

    expect(attempts).toBe(2);
    expect(successfulWrites).toBe(1);
  });

  it("does not retain a one-shot watcher event until an edge is drawn later", async () => {
    const watcherId = "unconnected-entered";
    __setDocsForTest(
      new Map([[canvasName, watcherDocument(watcherId, false)]]),
    );

    const pendingSnap = {
      bundles: [{
        source: "hermes" as const,
        fetchedAt: new Date().toISOString(),
        ok: true,
        entities: [{
          source: "hermes" as const,
          key: "proj",
          kind: "project",
          stats: { signals: 3 },
          updatedAt: new Date().toISOString(),
        }],
      }],
    };
    const satisfiedSnap = {
      bundles: [{
        source: "hermes" as const,
        fetchedAt: new Date().toISOString(),
        ok: true,
        entities: [{
          source: "hermes" as const,
          key: "proj",
          kind: "project",
          stats: { signals: 34 },
          updatedAt: new Date().toISOString(),
        }],
      }],
    };

    __setSnapshotsForTest(pendingSnap);
    await runEvaluationCycle();
    __setSnapshotsForTest(satisfiedSnap);
    await runEvaluationCycle();
    await flushDelivery();

    expect(attempts).toBe(0);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(0);

    // A later authorial edge only authorizes future events. It cannot replay
    // the already-consumed one-shot transition.
    transportReady = true;
    __setDocsForTest(
      new Map([[canvasName, watcherDocument(watcherId, true)]]),
    );
    retryPendingPulseDeliveries();
    await runEvaluationCycle();
    await flushDelivery();

    expect(attempts).toBe(0);
    expect(successfulWrites).toBe(0);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(0);
  });

  it("retains a claimed timer pulse without re-claiming or duplicating success", async () => {
    const timerId = "release-timer";
    __setDocsForTest(
      new Map([[canvasName, timerDocument(timerId)]]),
    );
    __setTimerSchedulerForTest(makeInMemoryTimerScheduler());

    await checkTimers(1_000_000);
    await checkTimers(1_060_000);
    await flushDelivery();

    expect(attempts).toBe(1);
    expect(successfulWrites).toBe(0);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(1);
    expect(
      getPulseLog().filter((record) => record.canvasName === canvasName && !record.dry),
    ).toEqual([]);

    transportReady = true;
    retryPendingPulseDeliveries();
    await flushDelivery();

    expect(attempts).toBe(2);
    expect(successfulWrites).toBe(1);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(0);
    expect(
      getPulseLog().filter((record) => record.canvasName === canvasName && !record.dry),
    ).toHaveLength(1);

    retryPendingPulseDeliveries();
    await checkTimers(1_060_000);
    await flushDelivery();

    expect(attempts).toBe(2);
    expect(successfulWrites).toBe(1);
  });

  it("cancels a refused scheduled delivery when its edge is deleted before retry", async () => {
    const timerId = "revoked-timer";
    const connected = timerDocument(timerId);
    __setDocsForTest(new Map([[canvasName, connected]]));
    __setTimerSchedulerForTest(makeInMemoryTimerScheduler());

    await checkTimers(1_000_000);
    await checkTimers(1_060_000);
    await flushDelivery();

    expect(attempts).toBe(1);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(1);

    __setDocsForTest(
      new Map([
        [
          canvasName,
          {
            ...connected,
            edges: [],
          },
        ],
      ]),
    );
    transportReady = true;
    retryPendingPulseDeliveries();
    await flushDelivery();

    expect(attempts).toBe(1);
    expect(successfulWrites).toBe(0);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(0);
  });

  it("holds the source key until an in-flight retry settles", async () => {
    const timerId = "in-flight-timer";
    __setDocsForTest(
      new Map([[canvasName, timerDocument(timerId)]]),
    );
    __setTimerSchedulerForTest(makeInMemoryTimerScheduler());

    await checkTimers(1_000_000);
    await checkTimers(1_060_000);
    await flushDelivery();
    expect(attempts).toBe(1);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(1);

    transportReady = true;
    holdReadyWrite = true;
    retryPendingPulseDeliveries();
    await flushDelivery();

    expect(attempts).toBe(2);
    expect(releaseReadyWrite).toBeDefined();

    // A later kernel cycle sees both another due timer slot and the retry
    // trigger while the first retry is unresolved. Both must coalesce behind
    // the in-flight source key rather than enqueueing a second activation.
    await checkTimers(1_120_000);
    retryPendingPulseDeliveries();
    releaseReadyWrite?.(true);
    await flushDelivery();
    await flushDelivery();

    expect(attempts).toBe(2);
    expect(successfulWrites).toBe(1);
    expect(__getPendingPulseDeliveryCountForTest()).toBe(0);
    const records = getPulseLog().filter(
      (record) => record.canvasName === canvasName,
    );
    expect(records).toHaveLength(2);
    expect(records.filter((record) => !record.dry)).toHaveLength(1);
  });
});
