import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import {
  __resetDeliveryQueueForTest,
  __resetKernelMemoryForTest,
  __setDeliveryDepsForTest,
  __setDocsForTest,
  __setSnapshotsForTest,
  __setStationScopeForTest,
  getWatchers,
  runEvaluationCycle,
  setArmed,
  type PulseDeliverDeps,
} from "../src/main/vellum/kernel/cycle";

const stationHostId = "studio";
const localAgentKey = "studio:agent";
const commandCenterAgentKey = "command-center:agent";
const regionId = "operations";

const watcherDocument = (watchedAgentKey: string): CanvasDoc => ({
  nodes: [
    {
      id: regionId,
      type: "group",
      x: 0,
      y: 0,
      width: 500,
      height: 400,
      ether: { region: { instruction: "Continue local operations." } },
    },
    {
      id: "gateway-watch",
      type: "text",
      text: "agent gateway running",
      x: 40,
      y: 40,
      width: 180,
      height: 60,
      ether: {
        entity: { kind: "watcher" },
        host: stationHostId,
        watch: {
          kind: "stat_threshold",
          source: "hermes",
          key: watchedAgentKey,
          stat: "running",
          op: "eq",
          value: 1,
        },
      },
    },
    {
      id: "local-agent",
      type: "text",
      text: "local agent",
      x: 260,
      y: 40,
      width: 160,
      height: 60,
      ether: {
        entity: { kind: "agent", name: localAgentKey },
        terminal: {
          bindingId: "bind-local-agent",
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
        },
        host: stationHostId,
      },
    },
  ],
  edges: [{ id: "watch-to-agent", fromNode: "gateway-watch", toNode: "local-agent" }],
});

const fact = (
  key: string,
  running: number,
  stale: boolean,
  updatedAt: string,
) => ({
  source: "hermes" as const,
  key,
  kind: "agent",
  stats: { running },
  updatedAt,
  stale,
});

const partialSnapshot = (
  localRunning: number,
  remoteRunning: number,
  at: string,
): SnapshotState => ({
  bundles: [
    {
      source: "hermes",
      fetchedAt: at,
      ok: false,
      stale: true,
      error: "command center unreachable",
      entities: [
        fact(localAgentKey, localRunning, false, at),
        fact(commandCenterAgentKey, remoteRunning, true, "2026-07-23T09:00:00.000Z"),
      ],
    },
  ],
});

const freshFleetSnapshot = (remoteRunning: number, at: string): SnapshotState => ({
  bundles: [
    {
      source: "hermes",
      fetchedAt: at,
      ok: true,
      stale: false,
      entities: [fact(commandCenterAgentKey, remoteRunning, false, at)],
    },
  ],
});

describe("offline Remote watcher island", () => {
  const delivered: string[] = [];
  const delivery: PulseDeliverDeps = {
    sendManagedTerminal: async (bindingId) => {
      // Map binding back to agent key for assertions that still check keys
      delivered.push(bindingId);
      return true;
    },
  };

  beforeEach(() => {
    delivered.length = 0;
    __resetKernelMemoryForTest();
    __resetDeliveryQueueForTest();
    __setDeliveryDepsForTest(delivery);
    __setStationScopeForTest({ role: "remote", hostId: stationHostId });
  });

  afterEach(() => {
    __resetDeliveryQueueForTest();
    __resetKernelMemoryForTest();
    __setStationScopeForTest({ role: "command-center", hostId: "local" });
    vi.restoreAllMocks();
  });

  it("fires a local fresh 0→1 predicate to a same-host agent while fleet state is blind", async () => {
    const canvasName = "offline-local-island";
    setArmed(`${canvasName}::${regionId}`, true);
    __setDocsForTest(new Map([[canvasName, watcherDocument(localAgentKey)]]));

    __setSnapshotsForTest(partialSnapshot(0, 1, "2026-07-23T10:00:00.000Z"));
    await runEvaluationCycle();
    expect(getWatchers().get(`${canvasName}::gateway-watch`)).toMatchObject({
      status: "pending",
    });

    __setSnapshotsForTest(partialSnapshot(1, 1, "2026-07-23T10:01:00.000Z"));
    await runEvaluationCycle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(getWatchers().get(`${canvasName}::gateway-watch`)).toMatchObject({
      status: "satisfied",
      lastFiredAt: expect.any(Number),
    });
    expect(delivered).toEqual(["bind-local-agent"]);
  });

  it("does not fire a fleet predicate from a retained stale Command Center fact", async () => {
    const canvasName = "offline-fleet-island";
    setArmed(`${canvasName}::${regionId}`, true);
    __setDocsForTest(new Map([[canvasName, watcherDocument(commandCenterAgentKey)]]));

    __setSnapshotsForTest(freshFleetSnapshot(0, "2026-07-23T10:00:00.000Z"));
    await runEvaluationCycle();
    expect(getWatchers().get(`${canvasName}::gateway-watch`)).toMatchObject({
      status: "pending",
    });

    __setSnapshotsForTest(partialSnapshot(1, 1, "2026-07-23T10:01:00.000Z"));
    await runEvaluationCycle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(getWatchers().get(`${canvasName}::gateway-watch`)).toEqual({
      status: "unknown",
      detail: "hermes:command-center:agent unavailable or stale",
    });
    expect(delivered).toEqual([]);
  });
});
