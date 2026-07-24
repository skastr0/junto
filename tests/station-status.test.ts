import { describe, expect, it } from "vitest";
import {
  assessStationDoctor,
  configureRecordFromResult,
  defaultStationStatus,
  deployRecordFromResult,
  kernelRecordFromSnapshot,
  projectionRecordFromResult,
  pullRecordFromResult,
  STATION_KERNEL_STALE_AFTER_MS,
  STATION_PULL_STALE_AFTER_MS,
  type StationRemoteObservation,
} from "../src/shared/station-status";
import { canvasPullResult } from "../src/shared/canvas-pull";
import {
  agentKeysForWatcher,
  DEFAULT_STATION_HOST_ID,
  isNodeEligibleOnStation,
  resolveNodeHostId,
} from "../src/shared/station";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";

describe("station status doctor", () => {
  const now = Date.parse("2026-07-23T12:00:00.000Z");

  const observedRemote = (
    input: Partial<StationRemoteObservation> = {},
  ): StationRemoteObservation => ({
    hostId: "studio",
    endpoint: "studio-box",
    reachability: "reachable",
    settingsState: "observed",
    stationRole: "remote",
    stationHostId: "studio",
    statusState: "observed",
    status: defaultStationStatus(),
    ...input,
  });

  it("warns when role is unset", () => {
    const check = assessStationDoctor({
      role: "",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: defaultStationStatus(),
      workControlReady: true,
    });
    expect(check.id).toBe("station");
    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/role unset/i);
  });

  it("ok for Command Center with work control", () => {
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: defaultStationStatus(),
      workControlReady: true,
      version: "0.1.0",
      kernel: {
        observedAt: "2026-07-23T11:59:30.000Z",
        armedRegionCount: 0,
        orphanedArmingCount: 0,
      },
      now,
    });
    expect(check.status).toBe("ok");
    expect(check.metadata?.role).toBe("command-center");
    expect(check.metadata?.workControlReady).toBe("true");
    expect(check.detail).toContain(
      "Local station: installed yes · role command-center · version 0.1.0 · hostId local · last pull n/a · armed no (0) · last fire never · errors none",
    );
  });

  it("warns Remote without projection history when projection capability is on", () => {
    const check = assessStationDoctor({
      role: "remote",
      hostId: "remote-a",
      commandCenterRef: "laptop",
      supervisedPreferred: true,
      supervisedInstalled: "installed",
      status: defaultStationStatus(),
      workControlReady: true,
    });
    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/no projection apply/i);
  });

  it("records pull and configure into doctor metadata", () => {
    const pull = pullRecordFromResult(
      canvasPullResult({
        ok: true,
        status: "ok",
        detail: "pulled 2",
        commandCenterRef: "laptop",
        pulled: [
          { name: "a", bytes: 1, changed: true },
          { name: "b", bytes: 2, changed: false },
        ],
        failed: [],
        keptLocal: false,
      }),
    );
    const configure = configureRecordFromResult({
      ok: true,
      hostId: "remote-a",
      detail: "configured",
    });
    const projection = projectionRecordFromResult({
      hostId: "remote-a",
      generation: "1",
      manifestSha256: "a".repeat(64),
      status: "applied",
      detail: "applied",
      at: "2026-07-23T11:00:00.000Z",
    });
    const check = assessStationDoctor({
      role: "remote",
      hostId: "remote-a",
      commandCenterRef: "laptop",
      supervisedPreferred: true,
      supervisedInstalled: "installed",
      status: {
        version: 1,
        lastPull: pull,
        lastConfigure: configure,
        lastProjection: projection,
      },
      workControlReady: true,
    });
    expect(check.status).toBe("ok");
    expect(check.metadata?.lastPullStatus).toBe("ok");
    expect(check.metadata?.lastConfigureOk).toBe("true");
    expect(check.metadata?.lastProjectionStatus).toBe("applied");
  });

  it("warns when work control is down", () => {
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: defaultStationStatus(),
      workControlReady: false,
    });
    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/work control not ready/i);
  });

  it("reports a ready Remote package, role, version, and last-seen receipt", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      lastSeen: "2026-07-22T20:00:00.000Z",
      rollback: "not-required",
      configurationOk: true,
      detail: "ready",
      at: "2026-07-22T20:00:00.000Z",
    });
    const projection = projectionRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      generation: "3",
      manifestSha256: "a".repeat(64),
      frameSha256: "b".repeat(64),
      status: "applied",
      detail: "applied",
      at: "2026-07-23T11:45:00.000Z",
    });
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: {
        version: 1,
        deployments: { studio: deployment },
        projections: { studio: projection },
        lastProjection: projection,
      },
      remoteObservations: [
        observedRemote({
          status: {
            version: 1,
            lastPull: {
              at: "2026-07-23T11:45:00.000Z",
              status: "ok",
              ok: true,
              detail: "pulled 2",
              commandCenterRef: "local",
              keptLocal: false,
              pulledCount: 2,
              failedCount: 0,
            },
            kernel: {
              observedAt: "2026-07-23T11:59:30.000Z",
              armedRegionCount: 1,
              lastFireAt: "2026-07-23T11:58:00.000Z",
              lastFireKind: "watcher",
              lastFireDry: false,
              orphanedArmingCount: 0,
            },
          },
        }),
      ],
      workControlReady: true,
      now,
    });

    expect(check.status).toBe("ok");
    expect(check.detail).toMatch(
      /Remote studio \(studio-box\): installed yes · role remote · version 0\.1\.0 · hostId studio · delivery proj applied gen 3 · armed yes \(1\) · last fire 2026-07-23T11:58:00\.000Z watcher live · reachability reachable · errors none/u,
    );
    expect(check.metadata).toMatchObject({
      deploymentCount: "1",
      lastDeployHostId: "studio",
      lastDeployOutcome: "ready",
      lastDeployPackageState: "present",
      lastDeployRole: "remote",
      lastDeployVersion: "0.1.0",
      lastDeployLastSeen: "2026-07-22T20:00:00.000Z",
      remoteCount: "1",
      remoteFleetBlindCount: "0",
      remoteStaleCount: "0",
      "remote.studio.installed": "yes",
      "remote.studio.role": "remote",
      "remote.studio.version": "0.1.0",
      "remote.studio.lastPullStatus": "ok",
      "remote.studio.armed": "true",
      "remote.studio.lastFireAt": "2026-07-23T11:58:00.000Z",
      "remote.studio.reachability": "reachable",
    });
  });

  it("lists a registered Remote without a managed install receipt instead of omitting it", () => {
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: defaultStationStatus(),
      registeredRemoteEndpoints: { studio: "studio-box" },
      remoteObservations: [
        observedRemote({
          settingsState: "unavailable",
          statusState: "unavailable",
          observationError: "station status files unavailable",
        }),
      ],
      workControlReady: true,
      now,
    });

    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(
      /Remote studio \(studio-box\): installed no \(no managed install receipt\) · role unknown · version unknown · hostId studio · delivery unknown · armed unknown · last fire unknown · reachability reachable · errors registered but not installed by Command Center; fleet-blind: station status files unavailable/u,
    );
    expect(check.metadata).toMatchObject({
      remoteCount: "1",
      remoteFleetBlindCount: "1",
      "remote.studio.installed": "no",
      "remote.studio.state": "fleet-blind",
    });
  });

  it("reports an unreachable registered Remote without treating its deploy receipt as live health", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      lastSeen: "2026-07-23T11:55:00.000Z",
      rollback: "not-required",
      configurationOk: true,
      detail: "ready",
      at: "2026-07-23T11:55:00.000Z",
    });
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: { version: 1, deployments: { studio: deployment } },
      remoteObservations: [
        observedRemote({
          reachability: "unreachable",
          reachabilityError: "Timeout — host unreachable",
          settingsState: "unavailable",
          statusState: "unavailable",
          stationRole: undefined,
          stationHostId: undefined,
          status: undefined,
        }),
      ],
      workControlReady: true,
      now,
    });

    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/reachability unreachable/u);
    expect(check.detail).toMatch(/fleet-blind: Timeout — host unreachable/u);
    expect(check.metadata).toMatchObject({
      "remote.studio.installed": "yes",
      "remote.studio.reachability": "unreachable",
      "remote.studio.state": "error",
    });
  });

  it("defines and reports pull and kernel freshness independently", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      lastSeen: new Date(now - 60_000).toISOString(),
      rollback: "not-required",
      configurationOk: true,
      detail: "ready",
      at: new Date(now - 60_000).toISOString(),
    });
    const stalePullAt = new Date(now - STATION_PULL_STALE_AFTER_MS - 1).toISOString();
    const staleKernelAt = new Date(now - STATION_KERNEL_STALE_AFTER_MS - 1).toISOString();
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: { version: 1, deployments: { studio: deployment } },
      remoteObservations: [
        observedRemote({
          status: {
            version: 1,
            lastPull: {
              at: stalePullAt,
              status: "ok",
              ok: true,
              detail: "pulled",
              commandCenterRef: "local",
              keptLocal: false,
              pulledCount: 1,
              failedCount: 0,
            },
            kernel: {
              observedAt: staleKernelAt,
              armedRegionCount: 0,
              orphanedArmingCount: 0,
            },
          },
        }),
      ],
      workControlReady: true,
      now,
    });

    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/delivery proj never/u);
    expect(check.detail).toMatch(/armed no \(0, stale\)/u);
    expect(check.detail).toMatch(/no projection delivery recorded/u);
    expect(check.detail).toMatch(/pull stale \(residual\)/u);
    expect(check.detail).toMatch(/kernel status stale/u);
    expect(check.detail).toMatch(/Remote not armed/u);
    expect(check.metadata).toMatchObject({
      remoteStaleCount: "1",
      "remote.studio.lastPullStale": "true",
      "remote.studio.kernelStale": "true",
      "remote.studio.state": "stale",
    });
  });

  it("projects only bounded kernel facts into the station mirror", () => {
    const record = kernelRecordFromSnapshot(
      {
        canvases: {
          alpha: {
            watchers: {},
            armed: { one: true, two: false },
            nextFire: {},
          },
          beta: {
            watchers: {},
            armed: { three: true },
            nextFire: {},
          },
        },
        pulseLog: [
          {
            id: "pulse-secret",
            at: Date.parse("2026-07-23T11:58:00.000Z"),
            canvasName: "private-canvas",
            sourceNodeId: "private-node",
            regionId: "private-region",
            kind: "watcher",
            summary: "private instruction",
            delivered: ["private:agent"],
            dry: false,
          },
        ],
        fault: "arming store unreadable",
        orphanedArming: ["private-canvas::private-region"],
      },
      "2026-07-23T12:00:00.000Z",
    );

    expect(record).toEqual({
      observedAt: "2026-07-23T12:00:00.000Z",
      armedRegionCount: 2,
      lastFireAt: "2026-07-23T11:58:00.000Z",
      lastFireKind: "watcher",
      lastFireDry: false,
      fault: "arming store unreadable",
      orphanedArmingCount: 1,
    });
    expect(JSON.stringify(record)).not.toMatch(
      /private-canvas|private-node|private-region|private:agent|private instruction/u,
    );
  });

  it("fails closed on an indeterminate deploy receipt", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: false,
      outcome: "indeterminate",
      packageState: "unknown",
      role: "unknown",
      rollback: "failed",
      configurationOk: true,
      detail: "inspect host",
    });
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: { version: 1, deployments: { studio: deployment } },
      workControlReady: true,
    });

    expect(check.status).toBe("error");
    expect(check.metadata?.lastDeployOutcome).toBe("indeterminate");
    expect(check.detail).toMatch(/last seen never/u);
  });

  it("does not attribute a receipt to a removed or repointed host", () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "old-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      lastSeen: "2026-07-22T20:00:00.000Z",
      rollback: "not-required",
      configurationOk: true,
      detail: "ready",
    });
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: { version: 1, deployments: { studio: deployment } },
      registeredRemoteEndpoints: { studio: "new-box" },
      workControlReady: true,
    });

    expect(check.status).toBe("warning");
    expect(check.detail).toMatch(/stale deployment receipt/u);
    expect(check.detail).not.toMatch(/version 0\.1\.0/u);
    expect(check.metadata).toMatchObject({
      deploymentCount: "0",
      staleDeploymentCount: "1",
    });
  });
});

describe("foundation smoke — host scope + edges still compose", () => {
  it("local-only Command Center path: local watcher→agent edge", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "w",
          type: "text",
          text: "w",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "watcher" },
            host: DEFAULT_STATION_HOST_ID,
            watch: { kind: "glyphs_done" },
          },
        },
        {
          id: "a",
          type: "text",
          text: "a",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:codex" },
            host: DEFAULT_STATION_HOST_ID,
          },
        },
      ],
      edges: [{ id: "e", fromNode: "w", toNode: "a" }],
    };
    const watcher = doc.nodes[0] as CanvasNode;
    expect(isNodeEligibleOnStation(watcher, "local")).toBe(true);
    expect(resolveNodeHostId(doc.nodes[1]!)).toBe("local");
    expect(agentKeysForWatcher(doc, "w", "command-center", "local")).toEqual([
      "local:codex",
    ]);
  });

  it("Remote does not deliver cross-host agents", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "w",
          type: "text",
          text: "w",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "watcher" },
            host: "remote-a",
            watch: { kind: "glyphs_done" },
          },
        },
        {
          id: "a",
          type: "text",
          text: "a",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:codex" },
            host: "local",
          },
        },
      ],
      edges: [{ id: "e", fromNode: "w", toNode: "a" }],
    };
    expect(agentKeysForWatcher(doc, "w", "remote", "remote-a")).toEqual([]);
  });
});
