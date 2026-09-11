import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import {
  __resetKernelMemoryForTest,
  __setDocsForTest,
  __setSnapshotsForTest,
  __setStationScopeForTest,
  getWatchers,
  runEvaluationCycle,
} from "../src/main/vellum-command/kernel/cycle";

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
  beforeEach(() => {
    __resetKernelMemoryForTest();
    __setStationScopeForTest({ role: "remote", hostId: stationHostId });
  });

  afterEach(() => {
    __resetKernelMemoryForTest();
    __setStationScopeForTest({ role: "command-center", hostId: "local" });
    vi.restoreAllMocks();
  });

  it("evaluates a local fresh 0→1 predicate while fleet state is blind", async () => {
    const canvasName = "offline-local-island";
    __setDocsForTest(new Map([[canvasName, watcherDocument(localAgentKey)]]));

    __setSnapshotsForTest(partialSnapshot(0, 1, "2026-07-23T10:00:00.000Z"));
    await runEvaluationCycle();
    expect(getWatchers().get(`${canvasName}::gateway-watch`)).toMatchObject({
      status: "pending",
    });

    __setSnapshotsForTest(partialSnapshot(1, 1, "2026-07-23T10:01:00.000Z"));
    await runEvaluationCycle();

    // Rising edge is evaluation-only now — no pulse inject / lastFiredAt stamp.
    expect(getWatchers().get(`${canvasName}::gateway-watch`)).toMatchObject({
      status: "satisfied",
    });
  });

  it("does not satisfy a fleet predicate from a retained stale Command Center fact", async () => {
    const canvasName = "offline-fleet-island";
    __setDocsForTest(new Map([[canvasName, watcherDocument(commandCenterAgentKey)]]));

    __setSnapshotsForTest(freshFleetSnapshot(0, "2026-07-23T10:00:00.000Z"));
    await runEvaluationCycle();
    expect(getWatchers().get(`${canvasName}::gateway-watch`)).toMatchObject({
      status: "pending",
    });

    __setSnapshotsForTest(partialSnapshot(1, 1, "2026-07-23T10:01:00.000Z"));
    await runEvaluationCycle();

    expect(getWatchers().get(`${canvasName}::gateway-watch`)).toEqual({
      status: "unknown",
      detail: "hermes:command-center:agent unavailable or stale",
    });
  });
});
