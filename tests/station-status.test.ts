import { describe, expect, it } from "vitest";
import {
  assessStationDoctor,
  configureRecordFromResult,
  defaultStationStatus,
  deployRecordFromResult,
  pullRecordFromResult,
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
    });
    expect(check.status).toBe("ok");
    expect(check.metadata?.role).toBe("command-center");
    expect(check.metadata?.workControlReady).toBe("true");
  });

  it("warns Remote without pull history", () => {
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
    expect(check.detail).toMatch(/no canvas pull/i);
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
    const check = assessStationDoctor({
      role: "remote",
      hostId: "remote-a",
      commandCenterRef: "laptop",
      supervisedPreferred: true,
      supervisedInstalled: "installed",
      status: { version: 1, lastPull: pull, lastConfigure: configure },
      workControlReady: true,
    });
    expect(check.status).toBe("ok");
    expect(check.metadata?.lastPullStatus).toBe("ok");
    expect(check.metadata?.lastConfigureOk).toBe("true");
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
    const check = assessStationDoctor({
      role: "command-center",
      hostId: "local",
      commandCenterRef: "",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
      status: { version: 1, deployments: { studio: deployment } },
      workControlReady: true,
    });

    expect(check.status).toBe("ok");
    expect(check.detail).toMatch(
      /Remote studio \(studio-box\): last observed package present · role remote · version 0\.1\.0 · last seen 2026-07-22T20:00:00\.000Z · attempt ready/u,
    );
    expect(check.metadata).toMatchObject({
      deploymentCount: "1",
      lastDeployHostId: "studio",
      lastDeployOutcome: "ready",
      lastDeployPackageState: "present",
      lastDeployRole: "remote",
      lastDeployVersion: "0.1.0",
      lastDeployLastSeen: "2026-07-22T20:00:00.000Z",
    });
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
