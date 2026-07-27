import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { TowerGlyphRow } from "../src/shared/ipc";
import {
  __getPendingPulseDeliveryCountForTest,
  __resetDeliveryQueueForTest,
  __resetKernelMemoryForTest,
  __setDeliveryDepsForTest,
  __setDocsForTest,
  __setGlyphFetcherForTest,
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

const glyphRow = (state: string): TowerGlyphRow => ({
  glyphId: "release",
  orbit: "forge",
  title: "Release",
  state,
  updatedAt: Date.now(),
});

const flushDelivery = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("scheduled pulse retry after a managed seat is unavailable", () => {
  let transportReady = false;
  let attempts = 0;
  let successfulWrites = 0;

  const delivery: PulseDeliverDeps = {
    sendManagedTerminal: async () => {
      attempts += 1;
      if (!transportReady) return false;
      successfulWrites += 1;
      return true;
    },
  };

  beforeEach(() => {
    transportReady = false;
    attempts = 0;
    successfulWrites = 0;
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

  it("retains a glyph-entered-state pulse until a later cycle can drive it once", async () => {
    const watcherId = "release-entered";
    const doc: CanvasDoc = {
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
              kind: "glyphs_entered_state",
              project: "vellum",
              state: "committed",
            },
          },
        },
        agent,
      ],
      edges: [
        {
          id: "watcher-to-agent",
          fromNode: watcherId,
          toNode: agentId,
        },
      ],
    };
    __setDocsForTest(new Map([[canvasName, doc]]));

    let glyphState = "building";
    __setGlyphFetcherForTest(async () => [glyphRow(glyphState)]);

    await runEvaluationCycle();
    glyphState = "committed";
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

  it("retains a claimed timer pulse without re-claiming or duplicating success", async () => {
    const timerId = "release-timer";
    const doc: CanvasDoc = {
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
    };
    __setDocsForTest(new Map([[canvasName, doc]]));
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
});
